/* global orch */
const $ = (s) => document.querySelector(s);
const state = { run: null, tasks: new Map(), config: null, roles: [], plan: null, viewing: null, history: [], catalog: [], health: {}, watch: null, choice: null, choiceLabel: '' };

const STATUS_RU = {
  queued: 'в очереди', running: 'работает', done: 'готово', failed: 'ошибка', timeout: 'таймаут',
  cancelled: 'отменено', merged: 'слито', discarded: 'отброшено',
};
const RUN_RU = {
  idle: 'ожидание', running: 'идёт', done: 'завершён', failed: 'ошибка', cancelled: 'отменён',
  interrupted: 'прерван', stopped: 'остановлен по бюджету',
};
function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}
function usd(x) { return '$' + (x ?? 0).toFixed(2); }

// ---------- helpers ----------
function toast(text, level = 'info', cls = '') {
  const el = document.createElement('div');
  el.className = `toast ${level} ${cls}`.trim();
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), level === 'error' ? 9000 : 4000);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function hms(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function roleLabel(id) {
  return state.roles.find((r) => r.id === id)?.label ?? id ?? '';
}
function colorDiff(diff) {
  return diff.split('\n').map((l) => {
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@')) return `<span class="hunk">${esc(l)}</span>`;
    if (l.startsWith('+')) return `<span class="add">${esc(l)}</span>`;
    if (l.startsWith('-')) return `<span class="del">${esc(l)}</span>`;
    return esc(l);
  }).join('\n');
}
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- transcript ----------
function addEntry(e) {
  const el = document.createElement('div');
  el.className = `entry ${e.kind}`;
  el.innerHTML = `<span class="ts">${fmtTime(e.ts)}</span>${esc(e.text)}`;
  const box = $('#transcript');
  $('#transcriptEmpty').hidden = true;
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.appendChild(el);
  if (stick) box.scrollTop = box.scrollHeight;
}

// ---------- worker cards ----------
function renderTask(t) {
  let el = document.getElementById(`task-${t.id}`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'task';
    el.id = `task-${t.id}`;
    $('#tasks').appendChild(el);
  }
  const elapsed = t.startedAt ? hms((t.finishedAt ?? Date.now()) - t.startedAt) : '—';
  // Saved runs can be merged/discarded too: the hub rebuilds their engine.
  const canMerge = ['done', 'failed', 'timeout'].includes(t.status) && t.diffStat;
  const canDiscard = !['merged', 'discarded'].includes(t.status);
  el.className = `task s-${t.status}`;
  el.innerHTML = `
    <header>
      <div>
        <h3><span class="tid">${esc(t.id)}</span>${esc(t.title)}${t.role ? `<span class="role-tag">${esc(roleLabel(t.role))}</span>` : ''}</h3>
        <div class="who"><span class="prov">${esc(t.providerId)}</span><span class="model">${esc(t.model)}</span><span class="branch">${esc(t.branch ?? '')}</span></div>
      </div>
      <span class="status ${t.status}">${STATUS_RU[t.status] ?? t.status}</span>
    </header>
    <div class="metrics">
      <div class="metric"><div class="k">Время</div><div class="v" data-m="time">${elapsed}</div></div>
      <div class="metric"><div class="k">Стоимость</div><div class="v">${costCell(t)}</div></div>
      <div class="metric"><div class="k">Токены</div><div class="v">${t.tokensIn != null ? `${Math.round(t.tokensIn / 1000)}k<small> → </small>${Math.round((t.tokensOut ?? 0) / 1000)}k` : '—'}</div></div>
    </div>
    ${t.error ? `<div class="errLine">${esc(t.error)}</div>` : ''}
    <details><summary>Бриф</summary><pre>${esc(t.spec)}</pre></details>
    <details ${t.status === 'running' ? 'open' : ''}><summary>Лог воркера (${t.log.length})</summary><pre class="log" id="log-${t.id}">${esc(t.log.join('\n'))}</pre></details>
    ${t.result ? `<details><summary>Отчёт воркера</summary><pre>${esc(t.result)}</pre></details>` : ''}
    ${t.diffStat ? `<details><summary>Изменения</summary><pre>${esc(t.diffStat)}</pre><pre class="diff">${colorDiff(t.diff || '')}</pre></details>` : ''}
    <div class="actions">
      <button data-act="merge" class="${canMerge ? 'primary' : ''} small" ${canMerge ? '' : 'disabled'}>Слить</button>
      <button data-act="discard" class="danger small" ${canDiscard ? '' : 'disabled'}>Отбросить</button>
      <span class="spacer"></span>
      <button data-act="open" class="ghost small" ${t.baseSha && !['merged', 'discarded'].includes(t.status) ? '' : 'disabled'}>Открыть worktree</button>
    </div>`;
  el.querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', async () => {
      const runId = state.run?.runId;
      try {
        if (b.dataset.act === 'merge') toast(await orch.mergeTask(runId, t.id));
        if (b.dataset.act === 'discard') toast(await orch.discardTask(runId, t.id));
        if (b.dataset.act === 'open') {
          const msg = await orch.openWorktree(runId, t.id);
          if (typeof msg === 'string') toast(msg);
        }
        if (state.viewing && b.dataset.act !== 'open') openRun(state.viewing); // saved runs get no live events
      } catch (e) { toast(e.message ?? String(e), 'error'); }
    }),
  );
  $('#taskCount').textContent = state.tasks.size;
}

function costCell(t) {
  if (t.costUsd == null) return '—';
  if (t.apiEquivUsd != null && !t.costUsd) return `$0<small> ≈$${t.apiEquivUsd.toFixed(2)} по API</small>`;
  return `$${t.costUsd.toFixed(3)}${t.costEstimated ? '<small> оценка</small>' : ''}`;
}
function taskCost(t) {
  if (t.costUsd == null) return '';
  if (t.apiEquivUsd != null && !t.costUsd) return ` · по плану/подписке (≈$${t.apiEquivUsd.toFixed(3)} по API)`;
  const tok = t.tokensIn != null ? ` · ${Math.round(t.tokensIn / 1000)}k→${Math.round((t.tokensOut ?? 0) / 1000)}k ток.` : '';
  return ` · $${t.costUsd.toFixed(3)}${t.costEstimated ? ' (оценка)' : ''}${tok}`;
}

function appendLog(taskId, line) {
  const t = state.tasks.get(taskId);
  if (t) t.log.push(line);
  const pre = document.getElementById(`log-${taskId}`);
  if (pre) {
    const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
    pre.textContent += (pre.textContent ? '\n' : '') + line;
    if (stick) pre.scrollTop = pre.scrollHeight;
  }
  if (taskId === liveTaskId) paintLiveLog(t);
}

// ---------- live task (big field) ----------
let liveTaskId = null;

function liveMeta(t) {
  const elapsed = t.startedAt ? hms((t.finishedAt ?? Date.now()) - t.startedAt) : '—';
  return `${t.providerId} · ${elapsed}`;
}

function paintLiveLog(t, forceBottom) {
  const pre = $('#liveTaskLog');
  const stick = forceBottom || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.textContent = BigField.tailLines(t.log, 40).join('\n');
  if (stick) pre.scrollTop = pre.scrollHeight;
}

function renderLiveTask() {
  const t = BigField.pickLiveTask(state.run);
  const box = $('#liveTask');
  if (!t) {
    box.hidden = true;
    liveTaskId = null;
    $('#transcriptEmpty').hidden = state.run ? state.run.transcript.length > 0 : false;
    return;
  }
  const fresh = liveTaskId !== t.id;
  liveTaskId = t.id;
  $('#liveTitle').textContent = t.title;
  $('#liveMeta').textContent = liveMeta(t);
  box.hidden = false;
  $('#transcriptEmpty').hidden = true;
  paintLiveLog(t, fresh);
}

function renderRunChip() {
  const r = state.run;
  const chip = $('#runChip');
  // Several runs can work at once (several projects): the chip counts all of them, not just the one on screen.
  const agg = window.ovSummary?.();
  if (agg && agg.runs > 0 && !state.viewing) {
    chip.className = 'runChip running';
    $('#runChipText').textContent = `идёт запусков: ${agg.runs} · воркеров в работе ${agg.workers} · ${usd(agg.cost)}`;
    chip.title = 'Все идущие запуски (подробности на вкладке «Обзор»)';
    return;
  }
  if (!r) {
    chip.className = 'runChip idle';
    $('#runChipText').textContent = 'Нет активного запуска';
    return;
  }
  if (r.status === 'running' && r.source === 'mcp' && !r.tasks.some((t) => t.status === 'queued' || t.status === 'running')) {
    chip.className = 'runChip idle';
    $('#runChipText').textContent = 'Сессия MCP открыта, воркеры не работают';
    return;
  }
  const working = r.tasks.filter((t) => t.status === 'running').length;
  const merged = r.tasks.filter((t) => t.status === 'merged').length;
  const total = (r.orchestratorCostUsd ?? 0) + r.tasks.reduce((a, t) => a + (t.costUsd ?? 0), 0);
  const dur = r.startedAt ? hms((r.finishedAt ?? Date.now()) - r.startedAt) : '';
  chip.className = `runChip ${r.status}`;
  const parts = [RUN_RU[r.status] ?? r.status, dur, `воркеров в работе ${working}`, `слито ${merged} из ${r.tasks.length}`, usd(total)];
  if (r.status !== 'running') parts.splice(2, 1);
  $('#runChipText').textContent = (state.viewing ? 'просмотр · ' : '') + parts.filter(Boolean).join(' · ');
  chip.title = r.goal ?? '';
}
function renderRunMeta() {
  const r = state.run;
  renderRunChip();
  if (!r) return ($('#runMeta').textContent = '');
  const dur = r.startedAt ? hms((r.finishedAt ?? Date.now()) - r.startedAt) : '';
  const merged = r.tasks.filter((t) => t.status === 'merged').length;
  $('#runMeta').textContent = `${r.runId} · ${RUN_RU[r.status] ?? r.status} · ${dur}\nветка ${r.baseBranch} · задач ${r.tasks.length}, слито ${merged}${r.stopReason ? '\n' + r.stopReason : ''}`;
  renderSpend(r);
  const running = r.status === 'running' && !state.viewing;
  $('#start').disabled = running;
  $('#autoPlan').disabled = running;
  $('#cancel').disabled = !running;
}
function renderSpend(r) {
  const orchCost = r.orchestratorCostUsd ?? 0;
  const byProv = {};
  let workers = 0;
  let estimated = false;
  for (const t of r.tasks) {
    workers += t.costUsd ?? 0;
    byProv[t.providerId] = (byProv[t.providerId] ?? 0) + (t.costUsd ?? 0);
    if (t.costEstimated) estimated = true;
  }
  const total = orchCost + workers;
  const budget = r.budgetUsd ?? 0;
  $('#spend').hidden = false;
  $('#spendText').textContent = budget ? `${usd(total)} из ${usd(budget)}` : `${usd(total)} (без лимита)`;
  const pct = budget ? Math.min(100, (total / budget) * 100) : 0;
  const bar = $('#spendBar');
  bar.style.width = budget ? pct + '%' : '0';
  bar.className = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
  const caps = Object.fromEntries((state.config?.providers ?? []).map((p) => [p.id, p.maxUsdPerRun]));
  const lines = [`оркестратор ${usd(orchCost)}`].concat(
    Object.entries(byProv).map(([id, v]) => `${id} ${usd(v)}${caps[id] ? ' / лимит ' + usd(caps[id]) : ''}`),
  );
  const equiv = (r.apiEquivUsd ?? 0) + r.tasks.reduce((a, t) => a + (t.apiEquivUsd ?? 0), 0);
  if (r.orchestrator && r.orchestrator !== 'api') lines[0] = `оркестратор: ${MODE_RU[r.orchestrator]} (подписка, $0)`;
  if (equiv > 0) lines.push(`подписки и планы по ценам API ≈ ${usd(equiv)} (не списано)`);
  if (estimated) lines.push('часть цен — оценка Claude Code: укажите цены воркеров в настройках');
  $('#spendDetail').textContent = lines.join('\n');
}

setInterval(() => {
  if (state.viewing) return;
  renderRunMeta();
  for (const t of state.tasks.values()) if (t.status === 'running') {
    const el = document.querySelector(`#task-${t.id} [data-m=time]`);
    if (el && t.startedAt) el.textContent = hms(Date.now() - t.startedAt);
  }
  if (liveTaskId) {
    const t = state.tasks.get(liveTaskId);
    if (t?.status === 'running') $('#liveMeta').textContent = liveMeta(t);
  }
}, 1000);

// ---------- events ----------
function showRun(s) {
  state.run = s;
  state.tasks = new Map(s.tasks.map((t) => [t.id, t]));
  $('#transcript').innerHTML = '';
  $('#transcriptEmpty').hidden = s.transcript.length > 0;
  s.transcript.forEach(addEntry);
  $('#tasks').innerHTML = '';
  s.tasks.forEach(renderTask);
  $('#taskCount').textContent = s.tasks.length;
  renderRunMeta();
  renderLiveTask();
}

let historyTimer = null;
function loadHistorySoon() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(loadHistory, 800);
}

orch.onEvent((ev) => {
  window.ovEvent?.(ev);
  window.alertEvent?.(ev);
  window.activityEvent?.(ev);
  if (ev.type === 'toast') {
    if (!ev.runId || ev.runId === state.watch || ev.level === 'error') toast(ev.text, ev.level);
    return;
  }
  // Several runs can be live at once (the panel, MCP sessions, other clients): draw only the one we follow.
  if (ev.runId) {
    const idle = !state.run || state.run.status !== 'running';
    if (ev.type === 'state' && ev.state.status === 'running' && ev.runId !== state.watch && idle && !state.viewing) {
      state.watch = ev.runId; // nothing live on screen: follow the run that just started (e.g. an MCP session)
    }
    if (ev.runId !== state.watch) {
      if (ev.type === 'state') loadHistorySoon();
      return;
    }
  }
  // While a saved run is open, live events are not drawn; «Закрыть» reloads the live state.
  if (state.viewing && ev.type !== 'health') {
    if (ev.type === 'state' && ev.state.status !== 'running') loadHistory();
    return;
  }
  switch (ev.type) {
    case 'state':
      showRun(ev.state);
      if (ev.state.status !== 'running' && ev.state.status !== 'idle') {
        toast(`Запуск: ${RUN_RU[ev.state.status]}`);
        loadHistory();
        setTimeout(renderMemory, 1500);
      }
      break;
    case 'transcript':
      if (state.run) state.run.transcript.push(ev.entry);
      addEntry(ev.entry);
      break;
    case 'task': {
      const prev = state.tasks.get(ev.task.id);
      const t = { ...ev.task, log: prev?.log?.length > ev.task.log.length ? prev.log : ev.task.log };
      state.tasks.set(t.id, t);
      if (state.run) {
        const i = state.run.tasks.findIndex((x) => x.id === t.id);
        if (i >= 0) state.run.tasks[i] = t; else state.run.tasks.push(t);
      }
      renderTask(t);
      if (state.run) renderSpend(state.run);
      renderLiveTask();
      break;
    }
    case 'task_log': appendLog(ev.taskId, ev.line); break;
    case 'scheduled': renderScheduled(); break;
    case 'health':
      state.health = ev.health;
      if (dlg.open) paintCards(); else renderConns();
      break;
  }
});

// ---------- project memory ----------
async function renderMemory() {
  const repo = $('#repo').value.trim();
  const box = $('#memBox');
  if (!repo || !orch.memoryStatus) { box.hidden = true; return; }
  try {
    const m = await orch.memoryStatus(repo);
    box.hidden = false;
    $('#memInit').hidden = m.enabled;
    $('#memDigest').hidden = !m.enabled;
    $('#memChangelog').hidden = !m.enabled;
    if (!m.enabled) {
      $('#memStat').textContent = 'выключена';
      $('#memSession').textContent = 'Факты, решения, журнал и wiki для этого репозитория ещё не заведены.';
      return;
    }
    $('#memStat').textContent = `фактов ${m.facts} · решений ${m.decisions}`;
    const s = m.session;
    $('#memSession').textContent = s
      ? `Сессия идёт ${s.minutes} из ${s.limit} мин (${s.author})${s.minutes >= s.limit ? ' — пора закрыть' : ''}`
      : m.lastJournal ? `Последняя запись: ${m.lastJournal.slice(0, 140)}` : 'Записей ещё нет.';
  } catch { box.hidden = true; }
}
function showMemDialog(title, text, by) {
  $('#memDlgTitle').textContent = title;
  $('#memDlgBy').textContent = by ? `подготовил: ${by}` : '';
  $('#memDlgText').textContent = text;
  $('#memDlg').showModal();
}
$('#memInit').addEventListener('click', async () => {
  try {
    const lines = await orch.memoryInit($('#repo').value.trim());
    showMemDialog('Память проекта включена', lines.join('\n'));
    renderMemory();
  } catch (e) { toast(e.message ?? String(e), 'error'); }
});
$('#memDigest').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true; b.textContent = 'Готовлю…';
  try {
    const r = await orch.memoryDigest($('#repo').value.trim());
    showMemDialog('Свежая выжимка', r.text, r.by);
  } catch (err) { toast(err.message ?? String(err), 'error'); }
  finally { b.disabled = false; b.textContent = 'Свежая выжимка'; }
});
$('#memChangelog').addEventListener('click', async (e) => {
  const release = prompt('Название этапа для CHANGELOG (пусто — дописать в «Unreleased»):', '');
  if (release === null) return;
  const b = e.currentTarget; b.disabled = true; b.textContent = 'Пишу…';
  try {
    const r = await orch.memoryChangelog($('#repo').value.trim(), release.trim() || undefined);
    const text = Object.entries(r.sections).filter(([, v]) => v && v.length).map(([k, v]) => `### ${k}\n` + v.map((x) => `- ${x}`).join('\n')).join('\n\n') || 'Новых значимых изменений нет.';
    showMemDialog('CHANGELOG обновлён', text, r.by);
    renderMemory();
  } catch (err) { toast(err.message ?? String(err), 'error'); }
  finally { b.disabled = false; b.textContent = 'CHANGELOG этапа'; }
});
setInterval(renderMemory, 60_000);

// ---------- goal & repo ----------
$('#pickRepo').addEventListener('click', async () => {
  const p = await orch.selectRepo();
  if (p) $('#repo').value = p;
  localStorage.setItem('repo', $('#repo').value);
});
$('#repo').addEventListener('change', () => { localStorage.setItem('repo', $('#repo').value); renderMemory(); });
$('#goal').addEventListener('input', () => localStorage.setItem('goal', $('#goal').value));
$('#repo').value = localStorage.getItem('repo') || '';
$('#goal').value = localStorage.getItem('goal') || '';

$('#attachGoal').addEventListener('click', async () => {
  try {
    const f = await orch.attachGoalFile();
    if (!f) return;
    const g = $('#goal');
    g.value = (g.value.trim() ? g.value.trimEnd() + '\n\n' : '') + `--- ${f.name} ---\n${f.text.trim()}\n`;
    localStorage.setItem('goal', g.value);
    toast(`Прикреплено: ${f.name}`);
  } catch (e) { toast(e.message ?? String(e), 'error'); }
});

// ---------- plan ----------
function providerOptions(selected, role) {
  const provs = (state.config?.providers ?? []).filter((p) => p.enabled && p.kind !== 'codex-sub');
  return provs.map((p) => {
    const fits = !p.roles?.length || !role || p.roles.includes(role);
    const l = lightOf(p.id);
    const warn = l === 'red' ? ' — не подключён' : l === 'yellow' ? ' — нет денег' : '';
    return `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.label)}${fits ? '' : ' (роль не разрешена)'}${warn}</option>`;
  }).join('');
}

function renderPlan() {
  const plan = state.plan;
  $('#planCount').textContent = plan ? plan.tasks.length : 0;
  $('#planEmpty').hidden = !!plan;
  $('#planBox').hidden = !plan;
  $('#startHint').textContent = plan
    ? `Запуск пойдёт по плану: ${plan.tasks.length} задач(и). План можно править на вкладке «План».`
    : 'Без плана оркестратор распределит задачи сам по ходу работы.';
  if (plan && state.choiceLabel) $('#startHint').textContent += ` Планирует и ведёт: ${state.choiceLabel}.`;
  $('#start').textContent = plan ? 'Запустить по плану' : 'Запустить';
  if (!plan) return;
  $('#planSummary').textContent = plan.summary || '';
  const box = $('#planTasks');
  box.innerHTML = '';
  plan.tasks.forEach((t) => {
    const node = $('#planTaskTpl').content.firstElementChild.cloneNode(true);
    node.querySelector('.pid').textContent = t.id;
    const title = node.querySelector('.ptitle'); title.value = t.title;
    const role = node.querySelector('.prole');
    role.innerHTML = state.roles.map((r) => `<option value="${r.id}" ${r.id === t.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('');
    const prov = node.querySelector('.pprov');
    prov.innerHTML = providerOptions(t.providerId, t.role);
    node.querySelector('.preason').textContent = t.reason || '';
    const spec = node.querySelector('.pspec'); spec.value = t.spec;
    node.querySelector('.pdeps').textContent = t.dependsOn?.length ? `после: ${t.dependsOn.join(', ')}` : 'независимая задача';
    title.addEventListener('input', () => (t.title = title.value));
    spec.addEventListener('input', () => (t.spec = spec.value));
    role.addEventListener('change', () => { t.role = role.value; prov.innerHTML = providerOptions(t.providerId, t.role); });
    prov.addEventListener('change', () => (t.providerId = prov.value));
    node.querySelector('.pdel').addEventListener('click', () => {
      plan.tasks = plan.tasks.filter((x) => x !== t);
      plan.tasks.forEach((x) => (x.dependsOn = (x.dependsOn || []).filter((d) => d !== t.id)));
      renderPlan();
    });
    box.appendChild(node);
  });
}

async function autoPlan() {
  const repo = $('#repo').value.trim();
  const goal = $('#goal').value.trim();
  if (!repo || !goal) return toast('Укажите репозиторий и опишите задание', 'error');
  const btn = $('#autoPlan');
  btn.disabled = true;
  btn.textContent = 'Оцениваю задачу…';
  try {
    const choice = await choosePlanner(goal);
    if (!choice) return;
    btn.textContent = 'Составляю план…';
    state.plan = await orch.makePlan(repo, goal, choice);
    state.choice = choice;
    renderPlan();
    showTab('plan');
    toast(`План: ${state.plan.tasks.length} задач(и)`);
  } catch (e) { toast(e.message ?? String(e), 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Распределить автоматически'; }
}
$('#autoPlan').addEventListener('click', autoPlan);
$('#replan').addEventListener('click', autoPlan);
$('#clearPlan').addEventListener('click', () => { state.plan = null; state.choice = null; state.choiceLabel = ''; renderPlan(); });

// ---------- which model plans and orchestrates ----------
const LIGHT_MARK = { green: '●', yellow: '◐', red: '○', gray: '·' };
const COMPLEXITY_RU = { low: 'простая', medium: 'обычная', high: 'сложная' };

/** Ask the hub for a recommendation; show it for approval unless Settings say not to ask. Resolves to a choice id or null. */
async function choosePlanner(goal) {
  state.config = await orch.getConfig();
  const t = await orch.triage(goal);
  const rec = t.choices.find((c) => c.id === t.recommended);
  if ((state.config.plannerPick ?? 'ask') !== 'ask') {
    state.choiceLabel = rec?.label ?? t.recommended;
    toast(`Планирует: ${state.choiceLabel} (${t.reason})`);
    return t.recommended;
  }
  return showPicker(t);
}

function showPicker(t) {
  return new Promise((resolve) => {
    const box = $('#picker');
    const sel = $('#pickSelect');
    $('#pickReason').innerHTML = `Задача: <b>${esc(COMPLEXITY_RU[t.complexity] ?? t.complexity)}</b>. ${esc(t.reason)}<br><span class="muted">оценил: ${esc(t.by)}</span>`;
    sel.innerHTML = t.choices.map((c) => {
      const off = c.light === 'red' || c.light === 'yellow';
      return `<option value="${esc(c.id)}" ${c.id === t.recommended ? 'selected' : ''} ${off ? 'disabled' : ''}>${LIGHT_MARK[c.light] ?? ''} ${esc(c.label)}${c.id === t.recommended ? ' — рекомендую' : ''}${off ? ' (недоступна)' : ''}</option>`;
    }).join('');
    const hint = () => { $('#pickHint').textContent = t.choices.find((c) => c.id === sel.value)?.hint ?? ''; };
    sel.onchange = hint;
    hint();
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest' });
    const done = (v) => {
      box.hidden = true;
      if (v) state.choiceLabel = t.choices.find((c) => c.id === v)?.label ?? v;
      resolve(v);
    };
    $('#pickOk').onclick = () => done(sel.value);
    $('#pickCancel').onclick = () => done(null);
  });
}

// ---------- run ----------
$('#start').addEventListener('click', async () => {
  const repo = $('#repo').value.trim();
  const goal = $('#goal').value.trim();
  if (!repo || !goal) return toast('Укажите репозиторий и опишите задание', 'error');
  if (state.plan && !state.plan.tasks.length) return toast('План пуст — сбросьте его или добавьте задачи', 'error');
  const btn = $('#start');
  try {
    btn.disabled = true;
    // With a plan the planner is already chosen; without one, choose who orchestrates now.
    const choice = state.plan ? state.choice : await choosePlanner(goal);
    if (!choice && !state.plan) return;
    state.viewing = null;
    $('#viewing').hidden = true;
    $('#transcript').innerHTML = '';
    $('#tasks').innerHTML = '';
    state.tasks = new Map();
    state.watch = await orch.start(repo, goal, state.plan ?? undefined, choice ?? undefined);
    showTab('orchestrator');
  } catch (e) { toast(e.message ?? String(e), 'error'); }
  finally { btn.disabled = false; renderRunMeta(); }
});
$('#cancel').addEventListener('click', () => state.run && orch.cancel(state.run.runId));

// ---------- history ----------
async function loadHistory() {
  try {
    state.history = await orch.listRuns();
  } catch (e) { return toast(e.message ?? String(e), 'error'); }
  $('#historyCount').textContent = state.history.length;
  const repos = [...new Set(state.history.map((r) => r.repo))];
  $('#knownRepos').innerHTML = repos.map((r) => `<option value="${esc(r)}"></option>`).join('');
  const box = $('#history');
  box.innerHTML = state.history.length ? '' : '<div class="empty">Запусков пока не было.</div>';
  for (const r of state.history) {
    const el = document.createElement('div');
    el.className = 'hrun';
    const goal = r.goal.split('\n').find((l) => l.trim()) ?? '';
    el.innerHTML = `
      <div class="goal" title="${esc(r.goal)}">${esc(goal)}${r.source === 'mcp' ? '<span class="src">MCP</span>' : ''}</div>
      <div class="actions">
        <span class="status ${r.status}">${RUN_RU[r.status] ?? r.status}</span>
        <button data-act="open" class="ghost small">Открыть</button>
        ${r.resumable ? '<button data-act="resume" class="primary small">Продолжить</button>' : ''}
        ${r.status !== 'running' ? '<button data-act="delete" class="ghost small" title="Удалить из истории (ветки в git не трогает)">✕</button>' : ''}
      </div>
      <div class="sub">${fmtDate(r.startedAt)} · ${esc(r.repo)} · задач ${r.tasks}, слито ${r.merged} · ${usd(r.costUsd)}</div>`;
    el.querySelector('[data-act=open]').addEventListener('click', () => openRun(r.runId));
    el.querySelector('[data-act=resume]')?.addEventListener('click', () => resumeRun(r.runId));
    el.querySelector('[data-act=delete]')?.addEventListener('click', async () => {
      try { await orch.deleteRun(r.runId); if (state.viewing === r.runId) backToCurrent(); loadHistory(); }
      catch (e) { toast(e.message ?? String(e), 'error'); }
    });
    box.appendChild(el);
  }
}

async function openRun(runId) {
  try {
    if (runId === state.watch && state.run?.status === 'running') return backToCurrent();
    const s = await orch.loadRun(runId);
    state.viewing = runId;
    const meta = state.history.find((h) => h.runId === runId);
    $('#viewing').hidden = false;
    $('#viewingText').textContent = `Просмотр сохранённого запуска ${runId} (${RUN_RU[s.status] ?? s.status}, ${fmtDate(s.startedAt)})`;
    $('#resumeRun').hidden = !meta?.resumable;
    $('#resumeRun').onclick = () => resumeRun(runId);
    showRun(s);
    showTab('orchestrator');
  } catch (e) { toast(e.message ?? String(e), 'error'); }
}

async function backToCurrent() {
  state.viewing = null;
  $('#viewing').hidden = true;
  const s = await orch.getState(state.watch ?? undefined);
  if (s) { state.watch = s.runId; showRun(s); }
  else {
    state.run = null; state.tasks = new Map();
    $('#transcript').innerHTML = ''; $('#tasks').innerHTML = ''; $('#spend').hidden = true;
    renderRunMeta();
  }
}

async function resumeRun(runId) {
  try {
    state.config = await orch.getConfig();
    state.viewing = null;
    $('#viewing').hidden = true;
    state.watch = await orch.resumeRun(runId);
    showTab('orchestrator');
    toast('Запуск продолжен');
  } catch (e) { toast(e.message ?? String(e), 'error'); }
}

$('#backToCurrent').addEventListener('click', backToCurrent);
$('#refreshHistory').addEventListener('click', loadHistory);
document.querySelector('[data-tab=history]').addEventListener('click', loadHistory);

// ---------- connections & settings ----------
const dlg = $('#settings');
const form = $('#settingsForm');
const LIGHT_RU = { green: 'работает', yellow: 'нет денег / лимит', red: 'не подключено', gray: 'не проверено' };
const BILLING_RU = { api: 'API', plan: 'план', subscription: 'подписка' };
const MODE_RU = { 'claude-sub': 'Claude, подписка', 'codex-sub': 'ChatGPT, подписка', api: 'Claude API' };
const MODE_CONN = { 'claude-sub': 'claude-sub', 'codex-sub': 'codex-sub', api: 'anthropic' };

function lightOf(id) { return state.health?.[id]?.light ?? 'gray'; }
function presetOf(p) { return state.catalog.find((x) => x.id === (p.preset ?? p.id)); }

function rolesChips(selected) {
  const box = document.createElement('div');
  box.className = 'roles';
  state.roles.forEach((r) => {
    const lab = document.createElement('label');
    lab.className = 'chip' + (selected.includes(r.id) ? ' on' : '');
    lab.title = r.hint;
    const inp = document.createElement('input');
    inp.type = 'checkbox'; inp.value = r.id; inp.checked = selected.includes(r.id);
    inp.addEventListener('change', () => lab.classList.toggle('on', inp.checked));
    lab.appendChild(inp);
    lab.appendChild(document.createTextNode(r.label));
    box.appendChild(lab);
  });
  return box;
}

/** One card per added connection: light, status, facts, quota bars; fields behind «Настроить». */
function providerCard(p, open = false) {
  const node = $('#providerTpl').content.firstElementChild.cloneNode(true);
  node._p = p;
  const kind = p.kind ?? 'api';
  const pr = presetOf(p);
  node.querySelectorAll('[data-k]').forEach((inp) => {
    const k = inp.dataset.k;
    if (inp.type === 'checkbox') inp.checked = !!p[k]; else inp.value = p[k] ?? '';
  });
  node.querySelector('[data-roles]').replaceWith(rolesChips(p.roles ?? []));
  node.querySelectorAll('[data-api-only]').forEach((el) => (el.hidden = kind !== 'api'));
  node.querySelectorAll('[data-worker-only]').forEach((el) => (el.hidden = kind === 'codex-sub'));
  if (kind === 'codex-sub') node.querySelector('.work').hidden = true;
  node.querySelector('.help').textContent = pr?.help ?? 'Любой Anthropic-совместимый адрес: base URL, ключ и модель.';
  const edit = node.querySelector('.edit');
  edit.hidden = !open;
  node.querySelector('.toggle').addEventListener('click', () => (edit.hidden = !edit.hidden));
  node.querySelector('.remove').addEventListener('click', () => { node.remove(); fillAddSelect(); });
  node.querySelector('.check-one').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true; b.textContent = 'Проверяю…';
    try {
      state.config = readSettings();
      await orch.saveConfig(state.config); // the check reads saved settings
      const id = node.querySelector('[data-k=id]').value.trim();
      state.health = await orch.checkHealth(id);
      paintCards();
    } catch (err) { toast(err.message ?? String(err), 'error'); }
    finally { b.disabled = false; b.textContent = 'Проверить'; }
  });
  paintCard(node);
  return node;
}

function paintCard(node) {
  const p = node._p;
  const id = node.querySelector('[data-k=id]')?.value.trim() || p.id;
  const h = state.health?.[id];
  const light = h?.light ?? 'gray';
  node.className = `conn ${light}`;
  node.querySelector('.dot').className = `dot big ${light}`;
  node.querySelector('.name').textContent = node.querySelector('[data-k=label]').value || p.label || id;
  node.querySelector('.cstatus').textContent = h ? h.text : 'ещё не проверено';
  node.querySelector('.badge').textContent = BILLING_RU[p.billing ?? 'api'];
  const facts = [...(h?.details ?? [])];
  if ((p.kind ?? 'api') !== 'codex-sub' && p.model) facts.unshift(`модель: ${p.model}`);
  node.querySelector('.facts').textContent = facts.join(' · ');
  const q = node.querySelector('.quotas');
  q.innerHTML = (h?.quotas ?? []).map((x) => {
    const pct = Math.min(100, Math.round(x.usedPercent));
    const cls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
    const reset = x.resetsAt ? ` · сброс ${fmtDate(Date.parse(x.resetsAt))}` : '';
    return `<div class="quota"><span>${esc(x.label)}: ${pct}%${esc(reset)}</span><div class="bar"><div class="${cls}" style="width:${pct}%"></div></div></div>`;
  }).join('');
}

function paintCards() {
  document.querySelectorAll('#providers .conn').forEach(paintCard);
  document.querySelectorAll('[data-light-for]').forEach((d) => (d.className = `dot ${lightOf(d.dataset.lightFor)}`));
  renderConns();
}

/** Drop-down: everything from the catalog that isn't added yet, grouped. */
function fillAddSelect() {
  const have = new Set([...document.querySelectorAll('#providers .conn')].map((n) => n._p.preset ?? n._p.id));
  const groups = {};
  for (const pr of state.catalog) if (!have.has(pr.id)) (groups[pr.group] ??= []).push(pr);
  const sel = $('#addConn');
  sel.innerHTML = '<option value="">— выберите, что подключить —</option>' +
    Object.entries(groups).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((pr) => `<option value="${pr.id}">${esc(pr.template.label)}</option>`).join('')}</optgroup>`).join('') +
    '<optgroup label="Другое"><option value="custom">Своё (Anthropic-совместимый API)</option></optgroup>';
}

$('#addConnBtn').addEventListener('click', () => {
  const v = $('#addConn').value;
  if (!v) return toast('Выберите подключение в списке', 'error');
  let p;
  if (v === 'custom') {
    const n = document.querySelectorAll('#providers .conn').length + 1;
    p = { id: `custom${n}`, kind: 'api', billing: 'api', label: 'Своё подключение', baseUrl: '', token: '', model: '', notes: '', enabled: true, roles: [] };
  } else {
    const pr = state.catalog.find((x) => x.id === v);
    p = { ...structuredClone(pr.template), token: '', enabled: pr.canWork && pr.template.kind === 'api' };
  }
  const card = providerCard(p, true);
  $('#providers').appendChild(card);
  fillAddSelect();
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  card.querySelector('[data-k=token]:not([hidden])')?.focus();
});

$('#checkAll').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  b.disabled = true; b.textContent = 'Проверяю…';
  try {
    state.config = readSettings();
    await orch.saveConfig(state.config);
    state.health = await orch.checkHealth();
    paintCards();
  } catch (err) { toast(err.message ?? String(err), 'error'); }
  finally { b.disabled = false; b.textContent = 'Проверить все'; }
});

function showModeFields() {
  const mode = form.querySelector('[name=orchMode]:checked')?.value ?? 'claude-sub';
  form.querySelectorAll('[data-mode-only]').forEach((el) => (el.hidden = el.dataset.modeOnly !== mode));
}
form.querySelectorAll('[name=orchMode]').forEach((r) => r.addEventListener('change', showModeFields));

function fillSettings(cfg) {
  const mode = cfg.orchestrator?.mode ?? 'claude-sub';
  form.querySelectorAll('[name=orchMode]').forEach((r) => (r.checked = r.value === mode));
  form.elements['orchestrator.claudeModel'].value = cfg.orchestrator?.claudeModel ?? '';
  form.elements['orchestrator.codexModel'].value = cfg.orchestrator?.codexModel ?? '';
  form.elements['orchestrator.codexPath'].value = cfg.orchestrator?.codexPath ?? 'codex';
  form.elements['anthropic.model'].value = cfg.anthropic.model;
  form.elements['anthropic.maxTokens'].value = cfg.anthropic.maxTokens;
  form.elements['runBudgetUsd'].value = cfg.runBudgetUsd ?? 0;
  form.elements['plannerPick'].value = cfg.plannerPick ?? 'ask';
  form.elements['serve.host'].value = cfg.serve?.host ?? '127.0.0.1';
  form.elements['serve.port'].value = cfg.serve?.port ?? 7777;
  if (orch.isWeb) orch.info().then((i) => ($('#serveInfo').textContent = `Вы в веб-панели службы. MCP для агентов: ${i.mcp}?repo=<путь к репозиторию>, заголовок Authorization: Bearer <токен>. Изменения адреса применятся после перезапуска службы.`)).catch(() => {});
  else $('#serveInfo').textContent = 'Запуск службы: npm run serve (или node dist/server/serve.js --install-launchd для автозапуска на macOS). Токен: node dist/server/serve.js --print-token.';
  form.elements['orchestratorPreamble'].value = cfg.orchestratorPreamble || '';
  form.elements['claudePath'].value = cfg.claudePath;
  form.elements['maxParallel'].value = cfg.maxParallel;
  form.elements['workerTimeoutMin'].value = cfg.workerTimeoutMin;
  form.elements['skipPermissions'].checked = !!cfg.skipPermissions;
  form.elements['workerPreamble'].value = cfg.workerPreamble || '';
  const box = $('#providers');
  box.innerHTML = '';
  cfg.providers.forEach((p) => box.appendChild(providerCard(p)));
  fillAddSelect();
  showModeFields();
  paintCards();
}

function readSettings() {
  const providers = [...document.querySelectorAll('#providers .conn')].map((node) => {
    const p = { ...node._p };
    node.querySelectorAll('[data-k]').forEach((inp) => {
      const k = inp.dataset.k;
      if (inp.type === 'checkbox') p[k] = inp.checked;
      else if (inp.hasAttribute('data-num')) p[k] = inp.value.trim() === '' ? undefined : Number(inp.value);
      else p[k] = inp.value.trim();
    });
    p.roles = [...node.querySelectorAll('.roles input:checked')].map((i) => i.value);
    if (p.kind === 'codex-sub') p.enabled = false;
    return p;
  });
  const ids = providers.map((p) => p.id);
  const dup = ids.find((id, i) => !id || ids.indexOf(id) !== i);
  if (dup !== undefined) throw new Error(dup ? `id «${dup}» повторяется` : 'у подключения пустой id');
  return {
    ...state.config,
    orchestrator: {
      mode: form.querySelector('[name=orchMode]:checked')?.value ?? 'claude-sub',
      claudeModel: form.elements['orchestrator.claudeModel'].value,
      codexModel: form.elements['orchestrator.codexModel'].value.trim(),
      codexPath: form.elements['orchestrator.codexPath'].value.trim() || 'codex',
    },
    anthropic: {
      ...state.config.anthropic,
      model: form.elements['anthropic.model'].value.trim(),
      maxTokens: Number(form.elements['anthropic.maxTokens'].value) || 8192,
    },
    runBudgetUsd: Math.max(0, Number(form.elements['runBudgetUsd'].value) || 0),
    plannerPick: form.elements['plannerPick'].value,
    serve: { host: form.elements['serve.host'].value.trim() || '127.0.0.1', port: Number(form.elements['serve.port'].value) || 7777 },
    orchestratorPreamble: form.elements['orchestratorPreamble'].value,
    claudePath: form.elements['claudePath'].value.trim() || 'claude',
    maxParallel: Number(form.elements['maxParallel'].value) || 3,
    workerTimeoutMin: Number(form.elements['workerTimeoutMin'].value) || 30,
    skipPermissions: form.elements['skipPermissions'].checked,
    workerPreamble: form.elements['workerPreamble'].value,
    providers,
  };
}

async function openSettings() {
  state.config = await orch.getConfig();
  fillSettings(state.config);
  dlg.showModal();
}
$('#openSettings').addEventListener('click', openSettings);
$('#conns').addEventListener('click', openSettings);
$('#connsSetup').addEventListener('click', openSettings);
$('#settingsCancel').addEventListener('click', () => dlg.close());
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    state.config = readSettings();
    await orch.saveConfig(state.config);
    dlg.close();
    toast('Настройки сохранены, проверяю подключения…');
    checkEnv();
    renderConns();
    renderForce();
    if (state.plan) renderPlan();
  } catch (err) { toast(err.message ?? String(err), 'error'); }
});

/** Sidebar: who orchestrates + a light per connection. */
function renderConns() {
  const cfg = state.config;
  if (!cfg) return;
  const mode = cfg.orchestrator?.mode ?? 'claude-sub';
  const orchLight = lightOf(MODE_CONN[mode]);
  const rows = cfg.providers.map((p) => {
    const l = lightOf(p.id);
    const role = p.kind === 'codex-sub' ? '' : p.enabled ? '' : ' <span class="muted">(не берёт задачи)</span>';
    return `<div class="connRow" title="${esc(state.health?.[p.id]?.text ?? LIGHT_RU[l])}"><span class="dot ${l}"></span>${esc(p.label)}${role}</div>`;
  });
  $('#conns').innerHTML = `<div class="connRow head"><span class="dot ${orchLight}"></span>Оркестратор: ${esc(MODE_RU[mode])}</div>${rows.join('')}`;
}

/** «Все задачи → один провайдер»: the select in the «Запуск» panel and the chip in the top bar. */
function renderForce() {
  const cfg = state.config;
  const sel = $('#forceProvider');
  const provs = (cfg?.providers ?? []).filter((p) => p.enabled && p.kind !== 'codex-sub');
  sel.innerHTML = '<option value="">Все задачи: по плану (авто)</option>' +
    provs.map((p) => `<option value="${esc(p.id)}">Все задачи → ${esc(p.label)}</option>`).join('');
  sel.value = cfg?.forceProvider ?? '';
  const forced = cfg?.providers.find((p) => p.id === cfg.forceProvider);
  const chip = $('#forceChip');
  chip.hidden = !forced;
  if (forced) $('#forceChipLabel').textContent = forced.label;
}
$('#forceProvider').addEventListener('change', async () => {
  try {
    const cfg = await orch.getConfig();
    cfg.forceProvider = $('#forceProvider').value || undefined;
    await orch.saveConfig(cfg);
    state.config = cfg;
    renderForce();
  } catch (e) { toast(e.message ?? String(e), 'error'); }
});


// ---------- diagnostics: Orca + Orchestra modes ----------
const DOC_MODES = [
  { id: 'together', title: 'Orca и Orchestra вместе', text: 'Служба Orchestra работает в фоне. В каждом проекте Claude Code в терминале Orca видит Orchestra и может раздавать задачи дешёвым исполнителям.',
    icon: '<svg viewBox="0 0 24 24"><circle cx="8" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="16" cy="12" r="5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>' },
  { id: 'orca', title: 'Только Orca', text: 'Orchestra выключена. Агенты в Orca пишут код сами, по вашей подписке. Память проектов и wiki продолжают работать — им служба не нужна.',
    icon: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7 10l3 2-3 2M12 15h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  { id: 'orchestra', title: 'Только Orchestra', text: 'Служба и эта панель работают, задачи запускаются отсюда или автопилотом. В проектах Orca Orchestra не подключена.',
    icon: '<svg viewBox="0 0 24 24"><path d="M3 15l4-6 4 8 4-12 4 9 2-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
];
const DOC_GROUPS = { system: 'Система', orchestra: 'Orchestra', orca: 'Orca' };
const DOC_LIGHT = { ok: 'green', warn: 'yellow', err: 'red', off: 'gray' };
state.doctor = null;

function paintModeChip(rep) {
  const chip = $('#modeChip');
  if (!rep) return;
  const m = DOC_MODES.find((x) => x.id === rep.mode);
  $('#modeChipText').textContent = m ? m.title : 'Смешанный режим';
  chip.className = `modeChip${rep.mode === 'orca' ? ' off' : ''}`;
  const n = rep.summary.err + rep.summary.warn;
  for (const el of [$('#modeChipIssues'), $('#doctorBadge')]) {
    el.hidden = !n;
    el.textContent = n;
    el.className = `pill ${rep.summary.err ? 'err' : 'warn'}`;
  }
  chip.title = `${m ? m.title : 'Смешанный режим'}${n ? ` · замечаний: ${n}` : ''} — открыть диагностику`;
}

async function loadDoctor() {
  if (!orch.doctorReport) return;
  try {
    const rep = await orch.doctorReport();
    state.doctor = rep;
    paintModeChip(rep);
    renderDoctor(rep);
  } catch (e) {
    $('#docChecks').innerHTML = `<div class="empty small">${esc(e.message ?? e)}</div>`;
  }
}

function renderDoctor(rep) {
  $('#modeCards').innerHTML = DOC_MODES.map((m) => `
    <div class="modeCard ${rep.mode === m.id ? 'current' : ''}">
      ${rep.mode === m.id ? '<span class="now">сейчас</span>' : ''}
      <div class="mIcon">${m.icon}</div>
      <h3>${esc(m.title)}</h3>
      <p>${esc(m.text)}</p>
      <button class="${rep.mode === m.id ? 'ghost' : 'secondary'} small" data-mode="${m.id}">${rep.mode === m.id ? 'Проверить, всё ли так' : 'Выбрать этот режим'}</button>
    </div>`).join('');
  $('#modeCards').querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => previewMode(b.dataset.mode)));
  const undo = $('#docUndo');
  undo.disabled = !rep.undo;
  undo.title = rep.undo ? `Вернуть как было до «${DOC_MODES.find((x) => x.id === rep.undo.mode)?.title ?? rep.undo.mode}» (${fmtDate(rep.undo.at)})` : 'Изменений ещё не применяли';
  $('#docChecks').innerHTML = Object.entries(DOC_GROUPS).map(([g, title]) => {
    const list = rep.checks.filter((c) => c.group === g);
    return `<div class="card"><div class="cardHead"><span>${title}</span></div>${list.map((c) => `
      <div class="chk ${c.state}"><span class="dot ${DOC_LIGHT[c.state]}"></span><span class="l">${esc(c.label)}</span>
        <span class="d">${esc(c.detail)}</span>${c.fix ? `<span class="f">→ ${esc(c.fix)}</span>` : ''}</div>`).join('') || '<div class="hint">—</div>'}</div>`;
  }).join('');
  const rows = rep.projects.map((p) => {
    const ch = rep.checks.find((c) => c.id === `project:${p.path}`);
    const issues = (ch?.detail ?? '').split(' · ').slice(2).join(' · ');
    return `<tr>
      <td><span class="dot ${DOC_LIGHT[ch?.state ?? 'off']}"></span> <b>${esc(p.name)}</b><div class="path">${esc(p.path)}</div></td>
      <td>${p.memory ? '<span class="yes">есть</span>' : '<span class="no">нет</span>'}</td>
      <td>${p.hooksPath === '.githooks' ? '<span class="yes">включены</span>' : '<span class="no">—</span>'}</td>
      <td>${p.mcp ? '<span class="yes">подключена</span>' : '<span class="no">нет</span>'}</td>
      <td class="hint">${esc(issues)}</td></tr>`;
  });
  $('#docProjects').innerHTML = rep.projects.length
    ? `<table class="ptable"><thead><tr><th>Проект</th><th>Память</th><th>Git-хуки</th><th>Orchestra в Claude Code</th><th>Замечания</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : '<div class="empty small">Проекты не найдены — нажмите «где искать…».</div>';
}

async function previewMode(mode) {
  const box = $('#docPlan');
  const m = DOC_MODES.find((x) => x.id === mode);
  box.hidden = false;
  box.innerHTML = `<h3>${esc(m.title)}</h3><div class="hint">Смотрю, что нужно изменить…</div>`;
  try {
    const acts = await orch.doctorPlan(mode);
    if (!acts.length) {
      box.innerHTML = `<h3>${esc(m.title)}</h3><div class="hint">Всё уже так — менять нечего.</div><div class="row right"><button class="ghost small" id="docPlanClose">Закрыть</button></div>`;
      $('#docPlanClose').onclick = () => (box.hidden = true);
      return;
    }
    const stopsSelf = orch.isWeb && acts.some((a) => a.kind === 'service-stop');
    box.innerHTML = `<h3>${esc(m.title)}: что будет сделано</h3>
      <ul>${acts.map((a) => `<li>${esc(a.label)}</li>`).join('')}</ul>
      ${stopsSelf ? '<div class="hint warnText">Эта панель работает через службу Orchestra: после применения она перестанет отвечать. Включить снова — двойной клик по Orchestra.command → пункт 1 или 3.</div>' : ''}
      <div class="row right"><button class="ghost" id="docPlanCancel">Отмена</button><button class="primary" id="docPlanApply">Применить</button></div>`;
    $('#docPlanCancel').onclick = () => (box.hidden = true);
    $('#docPlanApply').onclick = async () => {
      $('#docPlanApply').disabled = true;
      try {
        const r = await orch.doctorApply(mode);
        box.hidden = true;
        showApplyResult(r, `Режим «${m.title}» применён`);
      } catch (e) { toast(e.message ?? String(e), 'error'); $('#docPlanApply').disabled = false; }
    };
  } catch (e) { box.innerHTML = `<div class="hint">${esc(e.message ?? e)}</div>`; }
}

function showApplyResult(r, title) {
  if (r.failed.length) toast(`${title} с ошибками: ${r.failed.join('; ')}`, 'error');
  else toast(`${title}. Вернуть как было — «Отменить последнее».`);
  if (r.stoppingSelf) {
    const o = document.createElement('div');
    o.className = 'overlay';
    o.innerHTML = '<div class="box"><div class="emptyIcon"><svg viewBox="0 0 48 48"><path d="M16 16l16 16M32 16L16 32" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></div><div class="emptyTitle">Служба Orchestra остановлена</div><div class="hint">Эта панель больше не отвечает. Работайте в Orca как обычно. Включить Orchestra снова: двойной клик по Orchestra.command → пункт 1 или 3, там же можно отменить это изменение.</div></div>';
    document.body.appendChild(o);
    return;
  }
  setTimeout(loadDoctor, 600);
}

$('#docRefresh').addEventListener('click', () => { $('#docChecks').innerHTML = '<div class="empty small">Проверяю…</div>'; loadDoctor(); });
$('#docUndo').addEventListener('click', async () => {
  if (!confirm('Вернуть состояние до последнего изменения режима?')) return;
  try { showApplyResult(await orch.doctorUndo(), 'Последнее изменение отменено'); } catch (e) { toast(e.message ?? String(e), 'error'); }
});
$('#modeChip').addEventListener('click', () => { showTab('doctor'); loadDoctor(); });
document.querySelector('[data-tab=doctor]').addEventListener('click', loadDoctor);

// projects dialog
const projDlg = $('#projDlg');
let projFound = [];
$('#docProjEdit').addEventListener('click', () => {
  const cfg = state.config ?? {};
  $('#projRoots').value = (cfg.projectRoots?.length ? cfg.projectRoots : []).join('\n');
  projFound = state.doctor?.projects.map((p) => p.path) ?? [];
  paintProjList(new Set(projFound));
  projDlg.showModal();
});
function paintProjList(checked) {
  $('#projFound').textContent = projFound.length ? `найдено ${projFound.length}` : '';
  $('#projList').innerHTML = projFound.map((p, i) => `<label><input type="checkbox" data-i="${i}" ${checked.has(p) ? 'checked' : ''}/> ${esc(p)}</label>`).join('');
}
$('#projFind').addEventListener('click', async () => {
  const roots = $('#projRoots').value.split('\n').map((x) => x.trim()).filter(Boolean);
  projFound = await orch.doctorDiscover(roots);
  paintProjList(new Set(projFound));
});
$('#projCancel').addEventListener('click', () => projDlg.close());
$('#projSave').addEventListener('click', async () => {
  const roots = $('#projRoots').value.split('\n').map((x) => x.trim()).filter(Boolean);
  const list = [...$('#projList').querySelectorAll('input:checked')].map((i) => projFound[+i.dataset.i]);
  try {
    const rep = await orch.doctorProjects(list, roots);
    state.config = await orch.getConfig();
    state.doctor = rep; renderDoctor(rep); paintModeChip(rep);
    projDlg.close();
    toast(`Проектов в списке: ${list.length}`);
  } catch (e) { toast(e.message ?? String(e), 'error'); }
});


// ---------- tariff & off-peak scheduling ----------
const hm = (iso) => new Date(iso).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
/** Time of day, with the day when it is not today (a window can now last for days). */
const hmd = (iso) => (new Date(iso).toDateString() === new Date().toDateString() ? hm(iso) : whenText(iso));
function whenText(iso) {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  const day = d.toDateString() === today.toDateString() ? 'сегодня' : d.toDateString() === tomorrow.toDateString() ? 'завтра' : d.toLocaleDateString(LOCALE, { weekday: 'short', day: '2-digit', month: '2-digit' });
  return `${day} ${hm(iso)}`;
}
async function renderTariff() {
  if (!orch.tariff) return;
  try {
    const t = await orch.tariff();
    const chip = $('#tariffChip');
    const btn = $('#startOffPeak');
    if (!t.has) { chip.hidden = true; btn.hidden = true; return; }
    const names = t.providers.map((p) => p.label).join(', ');
    chip.hidden = false;
    chip.className = `tariffChip ${t.cheap ? 'cheap' : 'peak'}`;
    $('#tariffText').textContent = t.cheap ? `${names}: льготно до ${hmd(t.until)}` : `${names}: дорого до ${hmd(t.until)}`;
    chip.title = `Цены ${names} зависят от времени суток: вне часов пик — в ${Math.round(1 / t.providers[0].factor)} раза дешевле. Ближайшее льготное окно от 3 часов: ${whenText(t.nextStart)} — ${hmd(t.nextEnd)}.`;
    btn.hidden = false;
    const nowInWindow = Date.parse(t.nextStart) <= Date.now() + 60_000;
    $('#offPeakWhen').textContent = nowInWindow ? `· сейчас, до ${hmd(t.nextEnd)}` : `· ${whenText(t.nextStart)}`;
    btn.title = nowInWindow
      ? `Сейчас льготное окно. Запуск начнётся сразу; если он дойдёт до часов пик, новые задачи этих исполнителей подождут их окончания.`
      : `Запуск начнётся ${whenText(t.nextStart)} (льготное окно до ${hmd(t.nextEnd)}). До этого ничего не тратится. В часы пик новые задачи этих исполнителей ждут.`;
  } catch (e) { /* no tariff API (older service) */ }
}
async function renderScheduled() {
  if (!orch.scheduledList) return;
  let list = [];
  try { list = await orch.scheduledList(); } catch (e) { return; }
  $('#schedBox').hidden = !list.length;
  $('#schedCount').textContent = list.length ? String(list.length) : '';
  $('#schedList').innerHTML = list.map((it) => `
    <div class="sched">
      <div class="when">☾ ${esc(whenText(it.at))}${it.windowEnd ? ` — ${esc(hmd(it.windowEnd))}` : ''}</div>
      <div class="g" title="${esc(it.goal)}">${esc(it.goal)}</div>
      <div class="hint mono">${esc(it.repo.split('/').slice(-1)[0])}${it.plan ? ` · план: ${it.plan.tasks.length} задач` : ''}</div>
      ${it.lastError ? `<div class="err">не стартовал: ${esc(it.lastError)} — повтор каждую минуту</div>` : ''}
      <div class="row"><button class="ghost small" data-now="${esc(it.id)}">Запустить сейчас</button><button class="ghost small" data-del="${esc(it.id)}">Отменить</button></div>
    </div>`).join('');
  $('#schedList').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await orch.unschedule(b.dataset.del); toast('Отложенный запуск отменён'); renderScheduled(); } catch (e) { toast(e.message ?? String(e), 'error'); }
  }));
  $('#schedList').querySelectorAll('[data-now]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Запустить сейчас? Если сейчас часы пик, задачи исполнителей с почасовой ценой всё равно подождут льготного времени.')) return;
    try { state.watch = await orch.startScheduledNow(b.dataset.now); showTab('orchestrator'); renderScheduled(); } catch (e) { toast(e.message ?? String(e), 'error'); }
  }));
}
$('#startOffPeak').addEventListener('click', async () => {
  const repo = $('#repo').value.trim();
  const goal = $('#goal').value.trim();
  if (!repo || !goal) return toast('Укажите репозиторий и опишите задание', 'error');
  if (state.plan && !state.plan.tasks.length) return toast('План пуст — сбросьте его или добавьте задачи', 'error');
  const btn = $('#startOffPeak');
  try {
    btn.disabled = true;
    const choice = state.plan ? state.choice : await choosePlanner(goal);
    if (!choice && !state.plan) return;
    const it = await orch.schedule(repo, goal, state.plan ?? undefined, choice ?? undefined);
    toast(Date.parse(it.at) <= Date.now() + 60_000 ? 'Сейчас льготное время — запуск начинается' : `Запуск запланирован на ${whenText(it.at)} (льготно до ${hmd(it.windowEnd)})`);
    renderScheduled();
  } catch (e) { toast(e.message ?? String(e), 'error'); }
  finally { btn.disabled = false; }
});
setInterval(renderTariff, 60_000);
setInterval(renderScheduled, 30_000);

// ---------- startup ----------
async function checkEnv() {
  try {
    const r = await orch.checkEnv();
    const okClaude = !/^не /.test(r.claude);
    const okGit = r.git !== 'не найден';
    const chip = (ok, label, title) => `<span class="envChip" title="${esc(title)}"><span class="dot ${ok ? 'green' : 'red'}"></span>${esc(label)}</span>`;
    $('#env').innerHTML =
      chip(okClaude, okClaude ? `Claude Code ${r.claude.split(' ')[0]}` : 'Claude Code не найден', r.claude) +
      chip(okGit, okGit ? `git ${r.git.replace('git version ', '')}` : 'git не найден', r.git);
  } catch (e) { $('#env').textContent = String(e); }
}
(async () => {
  state.roles = await orch.listRoles();
  state.catalog = await orch.listCatalog();
  state.config = await orch.getConfig();
  state.health = await orch.getHealth();
  renderConns();
  renderForce();
  checkEnv();
  renderPlan();
  const s = await orch.getState();
  if (s) { state.watch = s.runId; showRun(s); }
  await loadHistory();
  renderMemory();
  loadDoctor();
  renderTariff();
  renderScheduled();
  if (orch.info) orch.info().then((i) => { if (i?.version) $('#ver').textContent = 'v' + i.version; }).catch(() => {});
  const interrupted = state.history.find((h) => h.status === 'interrupted' && h.source === 'app');
  if (!s && interrupted) toast(`Есть прерванный запуск от ${fmtDate(interrupted.startedAt)} — его можно продолжить на вкладке «История»`);
})();

/** Язык отчётов моделей следует переключателю RU/EN: сохраняем его в настройках службы (вызывает i18n.js перед перезагрузкой). */
window.setServerLanguage = async (lang) => {
  const cfg = await orch.getConfig();
  cfg.language = lang;
  await orch.saveConfig(cfg);
};
