/* Ход работы: что происходит с задачами и запусками, коротко и в углу. Читает события, которые панель и так получает,
   токены не тратит. Всплывающие сообщения настраиваются (обо всём / о результатах / выключены); список за последнее
   время лежит во вкладке «Ход работы» у колокольчика. Сбои и ошибки показывают оповещения, здесь они только в списке. */
const feed = { items: [], prev: new Map(), repos: new Map(), batch: [], timer: 0, mode: 'all' };
try {
  feed.mode = localStorage.getItem('orchestra-feed-mode') || 'all';
  feed.items = JSON.parse(localStorage.getItem('orchestra-feed') || '[]');
} catch (e) { /* без хранилища: лента живёт до перезагрузки */ }

const FEED_TASK = {
  queued: ['в очереди', 'wait'], running: ['запущена', 'run'], done: ['готова, ждёт проверки', 'ok'], merged: ['слита', 'ok'],
  failed: ['ошибка', 'err'], timeout: ['таймаут', 'err'], discarded: ['отброшена', 'idle'], cancelled: ['отменена', 'idle'],
};
const FEED_RESULTS = new Set(['done', 'merged', 'failed', 'timeout', 'discarded', 'cancelled']);

function feedSave() {
  try { localStorage.setItem('orchestra-feed', JSON.stringify(feed.items.slice(0, 60))); } catch (e) { /* ignore */ }
}

function feedPaint() {
  const box = $('#feedList');
  if (!box) return;
  box.innerHTML = feed.items.length
    ? feed.items.slice(0, 60).map((x) => `<div class="alertItem feed-${x.tone}"><div class="alertTitle"><span class="feedDot ${x.tone}"></span>${esc(x.text)}<span class="alertTime mono">${esc(fmtTime(x.ts))}</span></div></div>`).join('')
    : '<div class="empty small">Пока ничего не происходило.</div>';
}

function feedFlush() {
  feed.timer = 0;
  const b = feed.batch;
  feed.batch = [];
  if (!b.length) return;
  // Пачка событий за полторы секунды сливается в одно сообщение, чтобы угол не заливало.
  toast(b.length <= 3 ? b.map((x) => x.text).join('\n') : `${b.length} событий: ${b.slice(0, 2).map((x) => x.text).join('; ')} …`, 'info', 'feed');
}

function feedSay(text, tone, popup) {
  feed.items.unshift({ ts: Date.now(), text, tone });
  feed.items.length = Math.min(feed.items.length, 60);
  feedSave();
  feedPaint();
  if (!popup || feed.mode === 'off') return;
  feed.batch.push({ text });
  if (!feed.timer) feed.timer = setTimeout(feedFlush, 1500);
}

const feedProject = (runId) => feed.repos.get(runId) || runId;
const feedFresh = (ts) => !!ts && Date.now() - ts < 20000; // события, которые произошли только что, а не давно, до открытия страницы

window.activityEvent = (ev) => {
  if (!ev.runId) return;
  if (ev.type === 'state') {
    const s = ev.state;
    feed.repos.set(ev.runId, (s.repo || '').split('/').filter(Boolean).pop() || ev.runId);
    const k = `run:${ev.runId}`;
    const prev = feed.prev.get(k);
    feed.prev.set(k, s.status);
    if (prev === s.status) return;
    const proj = feedProject(ev.runId);
    if (s.source === 'mcp' && !s.tasks.length) return; // открытая MCP-сессия без задач: это не работа
    if (s.status === 'running' && (prev !== undefined || feedFresh(s.startedAt))) feedSay(`${proj}: запуск начался`, 'run', true);
    else if (['done', 'failed', 'stopped', 'cancelled', 'interrupted'].includes(s.status) && prev !== undefined) {
      const merged = s.tasks.filter((t) => t.status === 'merged').length;
      const txt = { done: 'запуск завершён', failed: 'запуск завершился ошибкой', stopped: 'запуск остановлен по бюджету', cancelled: 'запуск отменён', interrupted: 'запуск прерван' }[s.status];
      feedSay(`${proj}: ${txt}${s.tasks.length ? `, слито ${merged} из ${s.tasks.length}` : ''}`, s.status === 'done' ? 'ok' : 'err', true);
    }
    return;
  }
  if (ev.type !== 'task') return;
  const t = ev.task;
  const k = `${ev.runId}:${t.id}`;
  const prev = feed.prev.get(k);
  feed.prev.set(k, t.status);
  if (prev === t.status) return;
  const known = prev !== undefined
    || (t.status === 'queued' && feedFresh(t.createdAt))
    || (t.status === 'running' && feedFresh(t.startedAt))
    || (FEED_RESULTS.has(t.status) && feedFresh(t.finishedAt));
  if (!known) return;
  const [label, tone] = FEED_TASK[t.status] ?? [t.status, 'idle'];
  const retry = t.retriedAs ? ` (автоповтор → ${t.retriedAs})` : t.attempt > 1 ? ` (попытка ${t.attempt})` : '';
  const text = `${feedProject(ev.runId)}: ${t.id} (${t.providerId}) «${t.title}» — ${label}${retry}`;
  // Ошибки и таймауты уже показывает колокольчик всплывающим сообщением: здесь они только в списке.
  const popup = feed.mode === 'all' ? t.status !== 'failed' && t.status !== 'timeout' : feed.mode === 'results' ? FEED_RESULTS.has(t.status) && t.status !== 'failed' && t.status !== 'timeout' : false;
  feedSay(text, tone, popup);
};

// вкладки в панели колокольчика
function feedTab(name) {
  $('#tabAlerts').classList.toggle('active', name === 'alerts');
  $('#tabFeed').classList.toggle('active', name === 'feed');
  $('#alertList').hidden = name !== 'alerts';
  $('#feedBox').hidden = name !== 'feed';
  $('#alertClear').hidden = name !== 'alerts' && !feed.items.length;
  if (name === 'feed') feedPaint();
}
$('#tabAlerts').addEventListener('click', () => feedTab('alerts'));
$('#tabFeed').addEventListener('click', () => feedTab('feed'));
$('#feedMode').value = feed.mode;
$('#feedMode').addEventListener('change', (e) => {
  feed.mode = e.target.value;
  try { localStorage.setItem('orchestra-feed-mode', feed.mode); } catch (err) { /* ignore */ }
});
$('#alertClear').addEventListener('click', (e) => {
  if ($('#feedBox').hidden) return;
  e.stopImmediatePropagation(); // на вкладке «Ход работы» очищается лента, а не оповещения
  feed.items = [];
  feedSave();
  feedPaint();
}, true);
feedPaint();
