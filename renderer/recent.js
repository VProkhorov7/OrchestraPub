/* «Недавно завершено»: лента последних завершённых задач внизу панели, только история. Список собирает служба (src/main/recent.ts), здесь он только рисуется. Пустой — плашка скрыта. */
const RECENT_STATUS = { merged: 'слито', discarded: 'отброшено', done: 'готово, не слито' };

function recentAgo(ms) {
  const h = Math.floor(Math.max(0, Date.now() - ms) / 3_600_000);
  return h < 24 ? `${h} ч назад` : `${Math.floor(h / 24)} дн назад`;
}

async function recentLoad() {
  let items = [];
  try { items = (await orch.recent?.()) ?? []; } catch (e) { /* служба старой версии */ }
  const box = $('#recent');
  box.hidden = items.length === 0;
  if (!items.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="recentHead">Недавно завершено</div><div class="recentRow">' + items.map((r) => `
    <div class="recentCard ${esc(r.status)}">
      <div class="recentTitle" title="${esc(r.title)}">${esc(r.title)}</div>
      <div class="recentMeta">${esc(r.providerId)}</div>
      <div class="recentStatus">${esc(RECENT_STATUS[r.status] ?? r.status)}${typeof r.costUsd === 'number' && r.costUsd > 0 ? ` · $${r.costUsd.toFixed(2)}` : ''}</div>
      <div class="recentMeta">${esc(recentAgo(r.finishedAt))}</div>
    </div>`).join('') + '</div>';
}

let recentTimer = 0;
/** Завершения и слияния меняют ленту: перечитываем не чаще раза в 2 секунды. */
window.recentEvent = (ev) => {
  if (!['task', 'state'].includes(ev.type) || recentTimer) return;
  recentTimer = setTimeout(() => { recentTimer = 0; recentLoad(); }, 2000);
};
setInterval(recentLoad, 60_000); // «N ч назад» растёт со временем, без события
recentLoad();
