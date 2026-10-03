/* Язык интерфейса: русский (по умолчанию) или английский. Английский — автоматический перевод фрагментов (i18n-en.js):
   текст и подсказки на странице подменяются при загрузке и при каждом изменении страницы. Тексты оркестратора, логи, diff и
   брифы не переводятся. Переключение перезагружает страницу. Выбор хранится в этом браузере. */
(function () {
  let lang = 'ru';
  try { if (localStorage.getItem('orchestra-lang') === 'en') lang = 'en'; } catch (e) { /* без хранилища — русский */ }
  window.LANG = lang;
  window.LOCALE = lang === 'en' ? 'en-GB' : 'ru-RU';
  document.documentElement.lang = lang;

  const ATTRS = ['title', 'placeholder', 'aria-label', 'label'];
  const SKIP = 'script, style, textarea, pre, code, .transcript, .entry, #liveTaskLog';
  const CYR = /[А-Яа-яЁё]/;

  function build() {
    const base = window.I18N_EN || {};
    const dict = new Map();
    const flip = (s, up) => (s ? (up ? s[0].toUpperCase() : s[0].toLowerCase()) + s.slice(1) : s);
    for (const [k, v] of Object.entries(base)) {
      dict.set(k, v);
      const k2 = flip(k, k[0] === k[0].toLowerCase());
      if (!dict.has(k2)) dict.set(k2, flip(v, k[0] === k[0].toLowerCase()));
    }
    const keys = [...dict.keys()].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // Фрагмент не должен начинаться или кончаться посреди русского слова.
    const re = new RegExp('(?<![А-Яа-яЁё])(?:' + keys.join('|') + ')(?![А-Яа-яЁё])', 'g');
    return (s) => (CYR.test(s) ? s.replace(re, (m) => dict.get(m) ?? m) : s);
  }

  if (lang === 'en') {
    const tr = build();
    const skipped = (n) => { const el = n.nodeType === 1 ? n : n.parentElement; return !el || !!el.closest(SKIP); };
    const done = new WeakMap(); // последнее переведённое значение узла: чтобы не переводить дважды
    function text(n) {
      const v = n.nodeValue;
      if (!CYR.test(v) || done.get(n) === v || skipped(n)) return;
      const t = tr(v);
      done.set(n, t);
      if (t !== v) n.nodeValue = t;
    }
    function attrs(el) {
      for (const a of ATTRS) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v && CYR.test(v)) { const t = tr(v); if (t !== v) el.setAttribute(a, t); }
      }
    }
    function walk(root) {
      if (root.nodeType === 3) return text(root);
      if (root.nodeType !== 1) return;
      attrs(root);
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = w.nextNode(); n; n = w.nextNode()) (n.nodeType === 3 ? text(n) : attrs(n));
    }
    let obs;
    function start() {
      document.title = tr(document.title);
      walk(document.body);
      obs = new MutationObserver((recs) => {
        for (const r of recs) {
          if (r.type === 'childList') r.addedNodes.forEach(walk);
          else if (r.type === 'characterData') text(r.target);
          else if (r.type === 'attributes') attrs(r.target);
        }
        obs.takeRecords(); // свои же правки не разбираем повторно
      });
      obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    }
    document.addEventListener('DOMContentLoaded', start);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('langBtn');
    if (!b) return;
    b.textContent = lang === 'en' ? 'EN' : 'RU';
    b.title = lang === 'en' ? 'Interface language: English (click for Russian)' : 'Язык интерфейса: русский (нажмите для English)';
    b.addEventListener('click', () => {
      const next = lang === 'en' ? 'ru' : 'en';
      try { localStorage.setItem('orchestra-lang', next); } catch (e) { /* ignore */ }
      // Модели пишут планы и отчёты на том же языке: сохраняем его и в настройках службы.
      Promise.resolve(window.setServerLanguage && window.setServerLanguage(next)).catch(() => {}).then(() => location.reload());
    });
  });
})();
