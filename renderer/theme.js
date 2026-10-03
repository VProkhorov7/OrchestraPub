/* Тема панели: «как в системе», «по времени суток» (светлая днём), «светлая», «тёмная».
   Подключается в <head>, чтобы тема встала до первой отрисовки. Выбор хранится в этом браузере. */
(function () {
  const MODES = ['system', 'schedule', 'light', 'dark'];
  const LABEL = { system: 'Тема: как в системе', schedule: 'Тема: по времени суток', light: 'Тема: светлая', dark: 'Тема: тёмная' };
  const DAY_FROM = 7; // с 07:00 до 19:00 — светлая
  const DAY_TO = 19;
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  let mode = 'system';
  try { const m = localStorage.getItem('orchestra-theme'); if (MODES.includes(m)) mode = m; } catch (e) { /* без хранилища — по системе */ }

  function effective() {
    if (mode === 'light' || mode === 'dark') return mode;
    if (mode === 'schedule') { const h = new Date().getHours(); return h >= DAY_FROM && h < DAY_TO ? 'light' : 'dark'; }
    return media && !media.matches ? 'light' : 'dark';
  }
  function apply() {
    document.documentElement.dataset.theme = effective();
    const b = document.getElementById('themeBtn');
    if (b) { b.textContent = { system: '◐', schedule: '◔', light: '☀', dark: '☾' }[mode]; b.title = LABEL[mode] + ' (нажмите, чтобы сменить)'; b.setAttribute('aria-label', LABEL[mode]); }
  }
  apply();
  if (media && media.addEventListener) media.addEventListener('change', apply);
  setInterval(apply, 60000); // «по времени суток» меняется само, без перезагрузки
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('themeBtn');
    if (b) b.addEventListener('click', () => {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      try { localStorage.setItem('orchestra-theme', mode); } catch (e) { /* ignore */ }
      apply();
    });
    apply();
  });
})();
