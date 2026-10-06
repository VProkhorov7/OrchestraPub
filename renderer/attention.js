/* «Требует вас»: один блок сверху со всем, что ждёт владельца. Список собирает служба (src/main/attention.ts), здесь он только рисуется. Пустой — блок скрыт. */
let attLast = null; // подпись последнего нарисованного списка: без изменений DOM не трогаем
const attState = {}; // `${runId}/${taskId}` -> {open, text, scrollTop, busy}: что пережить перерисовку
const attKey = (a) => `${a.runId}/${a.taskId}`;
const attIsUnmerged = (a) => a.kind === 'unmerged' && a.runId && a.taskId;
const attHasButtons = (a) => AttentionLogic.buttonsFor(a).length > 0; // логика кнопок — attention-logic.js (проверяется в node)
/** Состав пунктов и счётчик: если подпись та же, перерисовывать нечего. */
function attSignature(items) { return JSON.stringify(items); }
/** Перед перерисовкой запоминает прокрутку открытых diff. */
function attSaveScroll(box, state) {
  box.querySelectorAll('.attentionActions').forEach((row) => {
    const s = state[`${row.dataset.run}/${row.dataset.task}`], pre = row.nextElementSibling;
    if (s && pre && pre.tagName === 'PRE' && !pre.hidden) s.scrollTop = pre.scrollTop;
  });
}
/** Фокус в поле формы (textarea/select) и курсор: после перерисовки поле новое, фокус надо вернуть. */
function attFocusOf(box) {
  const t = document.activeElement, cont = t?.closest?.('.attentionCont');
  if (!cont || !box.contains(t) || !t.dataset?.att) return null;
  const row = cont.previousElementSibling;
  return { run: row.dataset.run, task: row.dataset.task, att: t.dataset.att, start: t.selectionStart, end: t.selectionEnd };
}
function attFocusBack(box, f) {
  if (!f) return;
  const row = [...box.querySelectorAll('.attentionActions')].find((r) => r.dataset.run === f.run && r.dataset.task === f.task);
  const t = row?.nextElementSibling.querySelector(`[data-att=${f.att}]`);
  if (!t || t.disabled) return;
  t.focus();
  if (f.start != null) t.setSelectionRange(f.start, f.end);
}
/** Приводит DOM к записям состояния: раскрытый diff с текстом и прокруткой, disabled у занятых кнопок. */
function attRestoreState(box, state) {
  box.querySelectorAll('.attentionActions').forEach((row) => {
    const s = state[`${row.dataset.run}/${row.dataset.task}`], pre = row.nextElementSibling;
    if (!s) return;
    row.querySelectorAll('button').forEach((x) => { x.disabled = !!s.busy; });
    if (pre.tagName !== 'PRE') { attRenderCont(pre, row.dataset.kind, s); return; }
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
  const focus = attFocusOf(box);
  const keys = new Set(items.filter(attHasButtons).map(attKey));
  Object.keys(attState).forEach((k) => { if (!keys.has(k)) delete attState[k]; });
  box.hidden = items.length === 0;
  if (!items.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="attentionHead">Требует вас: ${items.length}</div>` + items.map((a) => `
    <div class="attentionItem ${a.level}">
      <div class="attentionWhat">${esc(a.what)}</div>
      <div class="attentionWho">${esc(a.who)}</div>
      <div class="attentionHint">Что делать: ${esc(a.hint)}</div>
      ${attHasButtons(a) ? `<div class="attentionActions" data-run="${esc(a.runId)}" data-task="${esc(a.taskId)}" data-kind="${esc(a.kind)}">
        ${AttentionLogic.buttonsFor(a).map((b) => `<button class="${b.cls}" data-att="${b.act}">${esc(b.label)}</button>`).join('\n        ')}
      </div>${attIsUnmerged(a) ? '<pre class="attentionDiff" hidden></pre>' : '<div class="attentionCont" hidden></div>'}` : ''}
    </div>`).join('');
  box.querySelectorAll('.attentionActions').forEach((row, i) => {
    const a = items.filter(attHasButtons)[i];
    (attIsUnmerged(a) ? attWire : attWireCont)(row, a);
  });
  attRestoreState(box, attState);
  attFocusBack(box, focus);
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

/** Форма «продолжить» внутри пункта: исполнитель, текст, предупреждение о деньгах. Рисуется из attState; DOM меняется, только если изменилось видимое (текст в поле не в счёт). */
function attRenderCont(el, kind, s) {
  const c = s.cont;
  if (!c) { el.hidden = true; return; }
  el.hidden = !c.open;
  const sig = JSON.stringify([c.open, c.loading, c.opts, c.provider, c.error, s.busy]);
  if (!c.open || el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  const L = AttentionLogic, problem = c.loading ? null : L.optionsProblem(c.opts);
  const forced = !!c.opts?.forced;
  let html;
  if (c.loading) html = '<div class="attentionWho">Загружаю варианты исполнителей…</div>';
  else if (problem) html = `<div class="attentionHint">${esc(problem)}</div><div class="attentionActions"><button class="small" data-att="cancel">Закрыть</button></div>`;
  else {
    const pid = L.pickProvider(c.opts, c.provider);
    const options = c.opts.providers.map((p) => `<option value="${esc(p.id)}"${p.id === pid ? ' selected' : ''}>${esc(p.label)} (${esc(p.model)})</option>`).join('');
    const label = kind === 'question' ? 'Ответ воркеру (обязательно)' : kind === 'capped' ? 'Заметка воркеру (по желанию)' : '';
    html = `<label class="attentionWho">Исполнитель <select data-att="provider"${forced || s.busy ? ' disabled' : ''}>${options}</select></label>
      ${kind === 'decision' ? '' : `<label class="attentionWho">${label}<textarea data-att="text" rows="3" maxlength="${L.MAX_TEXT}"${s.busy ? ' disabled' : ''}></textarea></label>`}
      ${c.error ? `<div class="attentionHint attentionErr">${esc(c.error)}</div>` : ''}
      <div class="attentionHint">${L.detailLines(c.opts, pid).map(esc).join('<br>')}</div>
      <div class="attentionActions"><button class="primary small" data-att="go"${s.busy ? ' disabled' : ''}>Запустить</button><button class="small" data-att="cancel"${s.busy ? ' disabled' : ''}>Отмена</button></div>`;
  }
  const focus = attFocusOf(el.parentNode);
  el.innerHTML = html;
  const ta = el.querySelector('textarea');
  if (ta) ta.value = c.text;
  attFocusBack(el.parentNode, focus);
}

/** Кнопка пункта «вопрос / решение / лимит»: раскрывает форму; запуск — только через confirm (логика в AttentionLogic.submitForm). */
function attWireCont(row, a) {
  const key = attKey(a), el = row.nextElementSibling;
  const say = (text, level = 'info') => (typeof toast === 'function' ? toast(text, level) : alert(text));
  const sync = () => attRestoreState($('#attention'), attState);
  const state = () => (attState[key] ||= { open: false, text: '', scrollTop: 0, busy: false, cont: { open: false, loading: false, text: '', provider: null, opts: null, error: '' } });
  const done = async (started) => {
    if (typeof recentLoad === 'function') recentLoad();
    if (started) delete attState[key];
    await attLoad(true);
  };
  row.querySelector('[data-att=continue]').addEventListener('click', () => {
    const s = state();
    if (!s.busy) AttentionLogic.toggleForm({ a, s, orch, sync });
  });
  el.addEventListener('input', (e) => {
    const s = state();
    if (e.target.dataset.att !== 'text') return;
    s.cont.text = e.target.value;
    if (s.cont.error) { s.cont.error = ''; sync(); } // перерисовка только чтобы убрать ошибку; фокус и курсор возвращает attRenderCont
  });
  el.addEventListener('change', (e) => {
    const s = state();
    if (e.target.dataset.att === 'provider' && !s.busy) { s.cont.provider = e.target.value; sync(); }
  });
  el.addEventListener('click', (e) => {
    const s = state(), act = e.target.dataset?.att;
    if (act === 'cancel' && !s.busy) { s.cont.open = false; sync(); }
    if (act === 'go') AttentionLogic.submitForm({ a, s, orch, confirm: (t) => confirm(t), say, sync, done });
  });
}

let attTimer = 0;
/** События задач, подключений и запусков меняют список: перечитываем не чаще раза в 2 секунды. */
window.attentionEvent = (ev) => {
  if (!['task', 'health', 'state'].includes(ev.type) || attTimer) return;
  attTimer = setTimeout(() => { attTimer = 0; attLoad(); }, 2000);
};
setInterval(attLoad, 60_000); // «готово, но не слито» наступает со временем, без события
attLoad();
