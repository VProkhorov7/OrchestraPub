/* «Требует вас»: один блок сверху со всем, что ждёт владельца. Список собирает служба (src/main/attention.ts), здесь он только рисуется. Пустой — блок скрыт. */
let attLast = null; // подпись последнего нарисованного списка: без изменений DOM не трогаем
const attState = {}; // `${runId}/${taskId}` -> {open, text, scrollTop, busy}: что пережить перерисовку
const attKey = (a) => `${a.runId}/${a.taskId}`;
const attIsUnmerged = (a) => a.kind === 'unmerged' && a.runId && a.taskId;
/** Состав пунктов и счётчик: если подпись та же, перерисовывать нечего. */
function attSignature(items) { return JSON.stringify(items); }
/** Перед перерисовкой запоминает прокрутку открытых diff. */
function attSaveScroll(box, state) {
  box.querySelectorAll('.attentionActions').forEach((row) => {
    const s = state[`${row.dataset.run}/${row.dataset.task}`], pre = row.nextElementSibling;
    if (s && pre && !pre.hidden) s.scrollTop = pre.scrollTop;
  });
}
/** Приводит DOM к записям состояния: раскрытый diff с текстом и прокруткой, disabled у занятых кнопок. */
function attRestoreState(box, state) {
  box.querySelectorAll('.attentionActions').forEach((row) => {
    const s = state[`${row.dataset.run}/${row.dataset.task}`], pre = row.nextElementSibling;
    if (!s) return;
    row.querySelectorAll('button').forEach((x) => { x.disabled = !!s.busy; });
    if (pre.hidden === !s.open && (!s.open || pre.textContent === s.text)) return;
    pre.hidden = !s.open;
    if (s.open) { pre.textContent = s.text; pre.scrollTop = s.scrollTop; }
  });
}
async function attLoad(force = false) {
  let items = [];
  try { items = (await orch.attention?.()) ?? []; } catch (e) { /* служба старой версии */ }
  const sig = attSignature(items);
  if (!force && sig === attLast) return;
  attLast = sig;
  const box = $('#attention');
  attSaveScroll(box, attState);
  const keys = new Set(items.filter(attIsUnmerged).map(attKey));
  Object.keys(attState).forEach((k) => { if (!keys.has(k)) delete attState[k]; });
  box.hidden = items.length === 0;
  if (!items.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="attentionHead">Требует вас: ${items.length}</div>` + items.map((a) => `
    <div class="attentionItem ${a.level}">
      <div class="attentionWhat">${esc(a.what)}</div>
      <div class="attentionWho">${esc(a.who)}</div>
      <div class="attentionHint">Что делать: ${esc(a.hint)}</div>
      ${attIsUnmerged(a) ? `<div class="attentionActions" data-run="${esc(a.runId)}" data-task="${esc(a.taskId)}">
        <button class="small" data-att="diff">Показать diff</button>
        <button class="primary small" data-att="merge">Слить</button>
        <button class="danger small" data-att="discard">Отбросить</button>
      </div><pre class="attentionDiff" hidden></pre>` : ''}
    </div>`).join('');
  box.querySelectorAll('.attentionActions').forEach((row, i) => attWire(row, items.filter(attIsUnmerged)[i]));
  attRestoreState(box, attState);
}

/** Кнопки пункта «не слито»: слияние и отбрасывание — существующие orch.mergeTask / orch.discardTask, всегда после confirm. Состояние живёт в attState, DOM после перерисовки им восстанавливается. */
function attWire(row, a) {
  const key = attKey(a);
  const name = a.who.replace(/ \(.*$/, '');
  const say = (text, level = 'info') => (typeof toast === 'function' ? toast(text, level) : alert(text));
  const sync = () => attRestoreState($('#attention'), attState);
  row.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.att;
    const s = (attState[key] ||= { open: false, text: '', scrollTop: 0, busy: false });
    if (s.busy) return;
    if (act === 'diff' && s.open) { attSaveScroll($('#attention'), attState); s.open = false; sync(); return; }
    if (act === 'merge' && !confirm(`Слить задачу ${a.taskId} «${name}» (ветка ${a.branch ?? '?'}) в текущую ветку основного репозитория (ту, что сейчас открыта там)? Изменения: ${a.diffStat || 'нет данных'}. Ревью не проверяется: слияние отменяется только откатом.`)) return;
    if (act === 'discard' && !confirm(`Отбросить задачу ${a.taskId} «${name}»? Ветка ${a.branch ?? '?'} и рабочая папка будут удалены, изменения пропадут.`)) return;
    s.busy = true;
    sync();
    let reload = false;
    try {
      if (act === 'diff') {
        s.open = true;
        s.text = 'Загружаю…';
        sync();
        s.text = await orch.taskDiff(a.runId, a.taskId);
      } else {
        const r = await (act === 'merge' ? orch.mergeTask(a.runId, a.taskId) : orch.discardTask(a.runId, a.taskId));
        say(String(r), /^(MERGE FAILED|REFUSED|Репозиторий не найден)/.test(String(r)) ? 'error' : 'info');
        if (typeof recentLoad === 'function') recentLoad();
        delete attState[key];
        reload = true;
      }
    } catch (e) {
      say(String(e?.message ?? e), 'error');
      if (act === 'diff') s.text = String(e?.message ?? e);
    } finally {
      s.busy = false;
    }
    if (reload) await attLoad(true);
    else sync(); // пункта уже нет в attState (исчез из списка) — sync ничего не найдёт и не тронет
  }));
}

let attTimer = 0;
/** События задач, подключений и запусков меняют список: перечитываем не чаще раза в 2 секунды. */
window.attentionEvent = (ev) => {
  if (!['task', 'health', 'state'].includes(ev.type) || attTimer) return;
  attTimer = setTimeout(() => { attTimer = 0; attLoad(); }, 2000);
};
setInterval(attLoad, 60_000); // «готово, но не слито» наступает со временем, без события
attLoad();
