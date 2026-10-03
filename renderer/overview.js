/* «Обзор»: по окошку на каждый идущий запуск. Только читает то, что панель и так получает (события и сохранённое состояние), токены не тратит. */
const ov = { runs: new Map(), last: new Map(), timer: 0 };
const OV_KEEP_MS = 30 * 60 * 1000; // завершённый запуск остаётся в обзоре ещё 30 минут
const OV_DOT = { running: 'run', done: 'ok', merged: 'ok', failed: 'err', timeout: 'err', queued: 'idle', cancelled: 'idle', discarded: 'idle' };

function ovTrack(s) {
  if (!s || !s.runId) return;
  ov.runs.set(s.runId, s);
  const last = ov.last.get(s.runId);
  if (!last) {
    const run = [...(s.tasks ?? [])].reverse().find((t) => t.status === 'running' && t.log?.length);
    const line = run ? run.log[run.log.length - 1] : s.transcript?.length ? s.transcript[s.transcript.length - 1].text : '';
    if (line) ov.last.set(s.runId, { id: run?.id, line });
  }
}

/** Идёт ли работа: есть воркер в очереди или в работе (для запуска из панели — пока он не закончился). Открытая MCP-сессия без задач — это не работа. */
function ovWorking(s) {
  if ((s.tasks ?? []).some((t) => t.status === 'queued' || t.status === 'running')) return true;
  return s.source !== 'mcp' && s.status === 'running';
}
function ovActivity(s) {
  return Math.max(s.finishedAt ?? 0, ...(s.tasks ?? []).map((t) => Math.max(t.finishedAt ?? 0, t.startedAt ?? 0)));
}

function ovVisible() {
  const now = Date.now();
  return [...ov.runs.values()]
    .filter((s) => ovWorking(s) || (ovActivity(s) && now - ovActivity(s) < OV_KEEP_MS))
    .sort((a, b) => Number(ovWorking(b)) - Number(ovWorking(a)) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/** Для верхней плашки: сколько запусков и воркеров работает сейчас. */
window.ovSummary = () => {
  const live = [...ov.runs.values()].filter(ovWorking);
  const workers = live.reduce((a, s) => a + s.tasks.filter((t) => t.status === 'running').length, 0);
  const cost = live.reduce((a, s) => a + (s.orchestratorCostUsd ?? 0) + s.tasks.reduce((x, t) => x + (t.costUsd ?? 0), 0), 0);
  return { runs: live.length, workers, cost };
};

function ovCard(s) {
  const tasks = s.tasks ?? [];
  const done = tasks.filter((t) => t.status === 'done' || t.status === 'merged').length;
  const cost = (s.orchestratorCostUsd ?? 0) + tasks.reduce((a, t) => a + (t.costUsd ?? 0), 0);
  const name = (s.repo || '').split('/').filter(Boolean).pop() || s.runId;
  const end = s.finishedAt ?? (ovWorking(s) ? Date.now() : ovActivity(s) || Date.now());
  const last = ov.last.get(s.runId);
  const rows = tasks.map((t) => `
    <div class="ovTask s-${t.status}"><span class="dot ${OV_DOT[t.status] ?? 'idle'}"></span>
      <span class="ovId">${esc(t.id)}</span><span class="ovTitle" title="${esc(t.title)}">${esc(t.title)}</span>
      <span class="ovProv">${esc(t.providerId)}</span><span class="ovSt">${esc(STATUS_RU[t.status] ?? t.status)}</span></div>`).join('');
  const idle = s.status === 'running' && !ovWorking(s);
  return `<article class="ovCard st-${idle ? 'idle' : s.status}" data-run="${esc(s.runId)}" tabindex="0" title="Открыть запуск">
    <header><span class="pulse"></span><b class="ovName">${esc(name)}</b>
      <span class="ovRun">${esc(idle ? 'сессия открыта, задач нет' : RUN_RU[s.status] ?? s.status)}</span>
      <span class="ovMeta mono">${s.startedAt ? hms(end - s.startedAt) : '—'} · ${usd(cost)}</span></header>
    <div class="ovGoal">${esc(s.source === 'mcp' ? 'Внешний оркестратор (MCP)' : s.goal || '')}</div>
    <div class="bar"><div style="width:${tasks.length ? Math.round((done / tasks.length) * 100) : 0}%"></div></div>
    <div class="ovCount">${tasks.length ? `готово ${done} из ${tasks.length}` : 'задач пока нет'}</div>
    <div class="ovTasks">${rows}</div>
    <footer class="mono">${last ? `${last.id ? esc(last.id) + ': ' : ''}${esc(String(last.line).slice(0, 160))}` : '&nbsp;'}</footer>
  </article>`;
}

let ovQueued = 0;
function ovRender() {
  ovQueued = 0;
  const list = ovVisible();
  $('#overviewCount').textContent = String(list.filter(ovWorking).length);
  renderRunChip();
  const grid = $('#ovGrid');
  $('#ovEmpty').hidden = list.length > 0;
  grid.dataset.n = String(Math.min(list.length, 5));
  if (!$('#tab-overview').classList.contains('active')) return;
  grid.innerHTML = list.map(ovCard).join('');
  grid.querySelectorAll('.ovCard').forEach((el) => {
    const go = () => ovOpen(el.dataset.run);
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}
function ovSoon() { if (!ovQueued) ovQueued = setTimeout(ovRender, 300); }

async function ovOpen(runId) {
  try {
    const s = await orch.getState(runId);
    if (!s) return;
    state.viewing = null;
    $('#viewing').hidden = true;
    state.watch = runId;
    showRun(s);
    showTab('orchestrator');
  } catch (e) { toast(e.message ?? String(e), 'error'); }
}

window.ovEvent = (ev) => {
  if (!ev.runId) return;
  if (ev.type === 'state') ovTrack(ev.state);
  else {
    const s = ov.runs.get(ev.runId);
    if (!s) { ovSync(); return; }
    if (ev.type === 'task') {
      const i = s.tasks.findIndex((x) => x.id === ev.task.id);
      if (i >= 0) s.tasks[i] = ev.task; else s.tasks.push(ev.task);
    } else if (ev.type === 'task_log') ov.last.set(ev.runId, { id: ev.taskId, line: ev.line });
    else if (ev.type === 'transcript') ov.last.set(ev.runId, { id: '', line: ev.entry.text });
  }
  ovSoon();
};

/** Подтянуть идущие запуски (при старте и раз в полминуты: вдруг пропустили событие или запуск завис). */
async function ovSync() {
  try {
    const list = await orch.listRuns();
    const live = new Set(list.filter((r) => r.status === 'running').map((r) => r.runId));
    for (const id of live) if (!ov.runs.has(id)) ovTrack(await orch.getState(id));
    for (const [id, s] of ov.runs) if (s.status === 'running' && !live.has(id)) { const f = await orch.getState(id); if (f) ov.runs.set(id, f); }
    ovSoon();
  } catch (e) { /* панель живёт и без обзора */ }
}

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab === 'overview') ovRender(); }));
ovSync();
setInterval(ovSync, 30000);
setInterval(() => { if ($('#tab-overview').classList.contains('active')) ovSoon(); }, 5000); // бегущее время
