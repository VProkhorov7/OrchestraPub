/* Оповещения: что сторожа службы сочли проблемой. Колокольчик в шапке, список под ним; новые приходят событием «alert». */
const al = { list: [], seen: 0 };
try { al.seen = Number(localStorage.getItem('orchestra-alerts-seen')) || 0; } catch (e) { /* без хранилища: всё считается новым */ }

function alUnread() { return al.list.filter((a) => a.level !== 'info' && a.ts > al.seen).length; }

function alPaint() {
  const n = alUnread();
  const badge = $('#alertCount');
  badge.hidden = n === 0;
  badge.textContent = String(n);
  const worst = al.list.filter((a) => a.ts > al.seen).some((a) => a.level === 'error');
  badge.className = `pill ${worst ? 'err' : 'warn'}`;
  const box = $('#alertList');
  if (!al.list.length) { box.innerHTML = '<div class="empty small">Оповещений нет: всё в порядке.</div>'; return; }
  box.innerHTML = al.list.slice(0, 60).map((a) => `
    <div class="alertItem ${a.level}${a.ts > al.seen ? ' fresh' : ''}">
      <div class="alertTitle"><span class="dot ${a.level === 'error' ? 'red' : a.level === 'warn' ? 'yellow' : 'green'}"></span>${esc(a.title)}
        <span class="alertTime mono">${esc(fmtDate(a.ts))}</span></div>
      ${a.text ? `<div class="alertText">${esc(a.text)}</div>` : ''}
    </div>`).join('');
}

async function alLoad() {
  try { al.list = (await orch.listAlerts?.()) ?? []; } catch (e) { /* служба старой версии */ }
  alPaint();
}

function alOpen(open) {
  const p = $('#alertPanel');
  p.hidden = !open;
  if (open) {
    alLoad().then(() => {
      al.seen = Math.max(0, ...al.list.map((a) => a.ts));
      try { localStorage.setItem('orchestra-alerts-seen', String(al.seen)); } catch (e) { /* ignore */ }
      setTimeout(alPaint, 1500); // метки «новое» гаснут после просмотра
    });
  }
}

window.alertEvent = (ev) => {
  if (ev.type !== 'alert') return;
  al.list.unshift(ev.alert);
  alPaint();
  if (ev.alert.level !== 'info') toast(`${ev.alert.title}`, ev.alert.level === 'error' ? 'error' : 'info');
};

$('#alertBtn').addEventListener('click', (e) => { e.stopPropagation(); alOpen($('#alertPanel').hidden); });
document.addEventListener('click', (e) => { if (!$('#alertPanel').hidden && !e.target.closest('#alertPanel')) $('#alertPanel').hidden = true; });
$('#alertClear').addEventListener('click', async () => { try { await orch.clearAlerts?.(); } catch (e) { /* ignore */ } al.list = []; alPaint(); });
alLoad();
