/* «Требует вас»: один блок сверху со всем, что ждёт владельца. Список собирает служба (src/main/attention.ts), здесь он только рисуется. Пустой — блок скрыт. */
async function attLoad() {
  let items = [];
  try { items = (await orch.attention?.()) ?? []; } catch (e) { /* служба старой версии */ }
  const box = $('#attention');
  box.hidden = items.length === 0;
  if (!items.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="attentionHead">Требует вас: ${items.length}</div>` + items.map((a) => `
    <div class="attentionItem ${a.level}">
      <div class="attentionWhat">${esc(a.what)}</div>
      <div class="attentionWho">${esc(a.who)}</div>
      <div class="attentionHint">Что делать: ${esc(a.hint)}</div>
    </div>`).join('');
}

let attTimer = 0;
/** События задач, подключений и запусков меняют список: перечитываем не чаще раза в 2 секунды. */
window.attentionEvent = (ev) => {
  if (!['task', 'health', 'state'].includes(ev.type) || attTimer) return;
  attTimer = setTimeout(() => { attTimer = 0; attLoad(); }, 2000);
};
setInterval(attLoad, 60_000); // «готово, но не слито» наступает со временем, без события
attLoad();
