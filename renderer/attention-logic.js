/* «Требует вас»: логика кнопок без DOM (какие кнопки, проверка текста, текст подтверждения, разбор ответа, порядок «продолжить»).
   UMD-модуль: `module.exports` в Node (его проверяет src/test/smoke-attention-ui.ts), `window.AttentionLogic` в браузере. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AttentionLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_TEXT = 4000; // как на сервере (Hub.continueChecked)
  const FAIL_PREFIXES = ['Не запущено', 'Эту задачу продолжить нельзя', 'Задача не найдена', 'Репозиторий не найден'];
  const CONT_LABEL = { question: 'Ответить', decision: 'Продолжить с ветки на другом исполнителе', capped: 'Продолжить' };

  /** Кнопки пункта по его виду. Без runId/taskId кнопок нет. */
  function buttonsFor(a) {
    if (!a || !a.runId || !a.taskId) return [];
    if (a.kind === 'unmerged') return [{ act: 'diff', label: 'Показать diff', cls: 'small' }, { act: 'merge', label: 'Слить', cls: 'primary small' }, { act: 'discard', label: 'Отбросить', cls: 'danger small' }];
    return CONT_LABEL[a.kind] ? [{ act: 'continue', label: CONT_LABEL[a.kind], cls: 'primary small' }] : [];
  }

  /** Текст ответа: у question обязателен (непустой после trim), у остальных заметка по желанию; не длиннее 4000. decision текста не берёт. */
  function validateText(kind, text) {
    if (kind === 'decision') return { ok: true, text: '' };
    const t = String(text ?? '').trim();
    if (kind === 'question' && !t) return { ok: false, text: t, error: 'Напишите ответ воркеру: пустой ответ не отправляется.' };
    if (t.length > MAX_TEXT) return { ok: false, text: t, error: `Текст длиннее ${MAX_TEXT} знаков (сейчас ${t.length}).` };
    return { ok: true, text: t };
  }

  /** Можно ли запускать: null, если да, иначе понятная фраза. */
  function optionsProblem(opts) {
    if (!opts) return 'Не удалось получить список исполнителей: задачу сейчас нельзя продолжить.';
    if (!Array.isArray(opts.providers) || !opts.providers.length) return 'Нет подходящего исполнителя для этой задачи (включите подключение в настройках): продолжить нельзя.';
    return null;
  }

  /** Исполнитель: при forced — только он, иначе выбранный, иначе по умолчанию, иначе первый. */
  function pickProvider(opts, chosen) {
    const ids = (opts?.providers ?? []).map((p) => p.id);
    if (opts?.forced && ids.includes(opts.forced)) return opts.forced;
    if (ids.includes(chosen)) return chosen;
    return ids.includes(opts?.defaultProvider) ? opts.defaultProvider : ids[0] ?? null;
  }

  const money = (x) => `$${Number(x).toFixed(2).replace(/\.00$/, '')}`;

  /** Про деньги: бесплатный, подписка (делит лимит с оркестратором) или платный API. */
  function costNote(p, opts) {
    if (p.free) return 'Бесплатный исполнитель: деньги не тратятся.';
    const cap = opts.taskCapUsd > 0 ? `до ${money(opts.taskCapUsd)} на задачу` : 'лимит на задачу не задан';
    if (p.billing === 'subscription' || p.billing === 'plan') return `Подписка: деньги не списываются, но задача делит лимит подписки с оркестратором (${cap}).`;
    return `Внимание: задача тратит деньги (${cap}).`;
  }

  /** Строки подробностей под выбором исполнителя. */
  function detailLines(opts, providerId) {
    const p = opts.providers.find((x) => x.id === providerId) ?? opts.providers[0];
    const lines = [`Исполнитель: ${p.label} (${p.model})`];
    lines.push(opts.taskCapUsd > 0 ? `Лимит на задачу: до ${money(opts.taskCapUsd)}` : 'Лимит на задачу: не задан');
    if (opts.runBudgetUsd > 0) lines.push(`Бюджет запуска: ${money(opts.runBudgetUsd)}`);
    if (opts.forced) lines.push('Исполнитель задан в настройках принудительно, выбрать другого нельзя.');
    lines.push(costNote(p, opts));
    return lines;
  }

  /** Текст confirm перед запуском. */
  function confirmText(a, opts, providerId, text) {
    const name = String(a.who ?? '').replace(/ \(.*$/, '');
    const what = a.kind === 'question' ? 'Ответить воркеру и продолжить' : 'Продолжить';
    const note = text ? `\nТекст: ${text.length > 300 ? text.slice(0, 300) + '…' : text}` : '';
    return `${what} задачу ${a.taskId} «${name}» (запуск ${a.runId})?\n${detailLines(opts, providerId).join('\n')}${note}\nБудет создана новая задача от ветки старой.`;
  }

  /** Ответ continueTask — строка. Ошибка, если начинается с одной из известных фраз отказа. */
  function classifyResult(r) {
    const text = String(r ?? '');
    return { error: FAIL_PREFIXES.some((p) => text.startsWith(p)), text };
  }

  /** Свежие варианты исполнителей: ответ службы null/ошибка → null. */
  async function loadOptions(orch, a) {
    try { return (await orch.continueOptions(a.runId, a.taskId)) ?? null; } catch (e) { return null; }
  }

  /** Открыть или закрыть форму; при каждом открытии варианты читаются заново (исполнители и лимиты могли смениться). */
  async function toggleForm({ a, s, orch, sync }) {
    const c = s.cont;
    if (c.open) { c.open = false; sync(); return; }
    c.open = true;
    c.error = '';
    c.loading = true;
    sync();
    c.opts = await loadOptions(orch, a);
    c.loading = false;
    if (c.opts) c.provider = pickProvider(c.opts, c.provider);
    sync();
  }

  /**
   * «Запустить» в форме. Порядок: занято → ничего; свежие варианты; нет вариантов → фраза; выбранный исполнитель пропал → фраза и форма обновлена;
   * текст не прошёл → ошибка в форме; confirm не дан → ничего; только потом orch.continueTask. Возвращает, чем кончилось (для теста).
   * busy ставится до первого await: второй клик во время чтения вариантов или запроса уйдёт в 'busy'.
   */
  async function submitForm({ a, s, orch, confirm, say, sync, done }) {
    if (s.busy) return 'busy';
    const c = s.cont;
    s.busy = true;
    let provider, text, result = 'error';
    try {
      const fresh = await loadOptions(orch, a);
      const problem = optionsProblem(fresh);
      if (problem) { c.opts = fresh; s.busy = false; say(problem, 'error'); sync(); return 'no-options'; }
      c.opts = fresh;
      if (!fresh.forced && c.provider && !fresh.providers.some((p) => p.id === c.provider)) {
        c.provider = pickProvider(fresh, null);
        s.busy = false;
        say('Выбранный исполнитель больше недоступен: список обновлён, выберите исполнителя и нажмите «Запустить» ещё раз.', 'error');
        sync();
        return 'provider-gone';
      }
      const v = validateText(a.kind, c.text);
      if (!v.ok) { c.error = v.error; s.busy = false; sync(); return 'invalid'; }
      provider = pickProvider(fresh, c.provider);
      text = v.text;
      c.provider = provider;
      if (!confirm(confirmText(a, fresh, provider, text))) { s.busy = false; sync(); return 'declined'; }
    } catch (e) {
      s.busy = false;
      throw e;
    }
    c.error = '';
    sync();
    try {
      const r = classifyResult(await orch.continueTask(a.runId, a.taskId, { provider, text }));
      say(r.text, r.error ? 'error' : 'info');
      result = r.error ? 'refused' : 'started';
    } catch (e) {
      say(String(e?.message ?? e), 'error');
    } finally {
      s.busy = false;
    }
    await done(result === 'started'); // успех: пункт закроется связью, состояние сбросить и перечитать список
    return result;
  }

  return { MAX_TEXT, buttonsFor, validateText, optionsProblem, pickProvider, detailLines, confirmText, classifyResult, toggleForm, submitForm };
});
