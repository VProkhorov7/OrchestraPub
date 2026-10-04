/* Порядок в интерфейсе: меню «⋯» в шапке (язык, тема, режим Orca), счётчики вкладок без нулей. */
const moreBtn = $('#moreBtn');
const moreMenu = $('#moreMenu');
function moreOpen(open) {
  moreMenu.hidden = !open;
  moreBtn.setAttribute('aria-expanded', String(open));
}
moreBtn.addEventListener('click', (e) => { e.stopPropagation(); moreOpen(moreMenu.hidden); });
document.addEventListener('click', (e) => { if (!moreMenu.hidden && !e.target.closest('#moreMenu')) moreOpen(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !moreMenu.hidden) { moreOpen(false); moreBtn.focus(); } });
$('#modeChip').addEventListener('click', () => moreOpen(false));

// Нулевые счётчики на вкладках только шумят: показываем число, когда оно больше нуля.
const pills = document.querySelectorAll('.tabs .pill');
const hideZero = () => pills.forEach((p) => { const z = p.textContent.trim() === '0'; if (p.hidden !== z && p.id !== 'doctorBadge') p.hidden = z; });
new MutationObserver(hideZero).observe(document.querySelector('.tabs'), { subtree: true, childList: true, characterData: true });
hideZero();
