/**
 * «Требует вас», кнопки продолжения: логика renderer/attention-logic.js (без DOM, грузится через require).
 * Проверяет: кнопки по виду пункта, проверку текста, текст подтверждения, разбор ответа,
 * и порядок «форма → проверка → confirm → continueTask» (без confirm платный запуск невозможен, при busy второй клик пуст).
 */
import * as fs from 'fs';
import * as path from 'path';
import { check } from './helpers';

const mod = path.join(__dirname, '..', '..', 'renderer', 'attention-logic.js');
check(fs.existsSync(mod), `attention-logic.js not found at ${mod}`);
const L = require(mod);

const item = (kind: string, extra: any = {}) => ({ kind, runId: 'r1', taskId: 't03', who: 'Задача (DeepSeek)', ...extra });
const labels = (a: any) => L.buttonsFor(a).map((b: any) => b.label).join('|');

// (1) кнопки по виду
check(labels(item('unmerged')) === 'Показать diff|Слить|Отбросить', '(1) unmerged: diff/merge/discard');
check(labels(item('question')) === 'Ответить', '(1) question: Ответить');
check(labels(item('decision')) === 'Продолжить с ветки на другом исполнителе', '(1) decision');
check(labels(item('capped')) === 'Продолжить', '(1) capped');
check(labels(item('spend')) === '' && labels(item('connection')) === '', '(1) spend/connection: no buttons');
check(labels(item('question', { runId: undefined })) === '' && labels(item('capped', { taskId: '' })) === '', '(1) no runId/taskId: no buttons');

// (2) текст
check(!L.validateText('question', '').ok && !L.validateText('question', '  \n ').ok, '(2) question: empty/blank refused');
check(L.validateText('question', '  да  ').text === 'да', '(2) question: trimmed');
check(L.validateText('question', 'x'.repeat(4000)).ok && !L.validateText('question', 'x'.repeat(4001)).ok, '(2) 4000 ok, 4001 refused');
check(L.validateText('capped', '').ok && L.validateText('capped', '').text === '' && !L.validateText('capped', 'x'.repeat(4001)).ok, '(2) capped: optional, max 4000');
check(L.validateText('decision', 'что угодно').text === '', '(2) decision: text dropped');

// (3) подтверждение и варианты
const prov = (id: string, extra: any = {}) => ({ id, label: id.toUpperCase(), model: `${id}-m`, billing: 'api', capUsd: 0, free: false, ...extra });
const opts = (extra: any = {}) => ({ role: 'code', providers: [prov('deepseek'), prov('glm'), prov('sub', { billing: 'subscription' }), prov('or', { free: true })], forced: null, taskCapUsd: 1.5, runBudgetUsd: 10, defaultProvider: 'glm', ...extra });
const ct = (pid: string, o: any = opts(), text = '') => L.confirmText(item('question'), o, pid, text);
check(/тратит деньги/.test(ct('deepseek')) && /до \$1\.50 на задачу/.test(ct('deepseek')) && /\$10/.test(ct('deepseek')) && /DEEPSEEK/.test(ct('deepseek')), '(3) api: money warning, cap, run budget, worker');
check(/делит лимит подписки с оркестратором/.test(ct('sub')) && !/тратит деньги/.test(ct('sub')), '(3) subscription: shares the limit');
check(/Бесплатный/.test(ct('or')) && !/тратит деньги/.test(ct('or')), '(3) free: free');
check(/задан в настройках принудительно/.test(ct('glm', opts({ forced: 'glm', providers: [prov('glm')] }))), '(3) forced is mentioned');
check(/Текст: привет/.test(ct('glm', opts(), 'привет')), '(3) answer text in the confirm');
check(L.optionsProblem(null) && L.optionsProblem({ providers: [] }) && L.optionsProblem({}) && !L.optionsProblem(opts()), '(3) null/empty providers: phrase; normal: none');
check(L.pickProvider(opts(), null) === 'glm' && L.pickProvider(opts(), 'sub') === 'sub' && L.pickProvider(opts(), 'zzz') === 'glm', '(3) default / chosen / unknown→default');
check(L.pickProvider(opts({ forced: 'glm', providers: [prov('glm')] }), 'deepseek') === 'glm', '(3) forced wins over the choice');

// (4) разбор ответа
for (const s of ['Не запущено: x', 'Эту задачу продолжить нельзя: y', 'Задача не найдена', 'Репозиторий не найден: /a. Ничего не сделано.']) check(L.classifyResult(s).error, `(4) error: ${s}`);
for (const s of ['Задача t07 запущена', 'Started t07. Ветка x не найдена: с чистого листа', '']) check(!L.classifyResult(s).error, `(4) ok: ${s}`);
check(!L.classifyResult('Ответ: Не запущено').error, '(4) prefix only');

// (5) порядок: форма, confirm, busy
function rig(o: any, kind = 'question', confirmAnswer = true) {
  const calls: any[] = [], dones: boolean[] = [], said: any[] = [], confirms: string[] = [];
  let release: (v: string) => void = () => {}, reject: (e: Error) => void = () => {};
  let current = o;
  const s: any = { open: false, text: '', scrollTop: 0, busy: false, cont: { open: false, loading: false, text: '', provider: null, opts: null, error: '' } };
  const orch = {
    continueOptions: async () => current,
    continueTask: (...args: any[]) => { calls.push(args); return new Promise<string>((r, j) => { release = r; reject = j; }); },
  };
  let reloads = 0;
  const env = { a: item(kind), s, orch, say: (t: string, l: string) => said.push([t, l]), sync: () => {}, confirm: (t: string) => { confirms.push(t); return confirmAnswer; }, done: async (ok: boolean) => { reloads++; dones.push(ok); } };
  return { env, calls, dones, said, confirms, s, setOpts: (n: any) => { current = n; }, release: (v: string) => release(v), fail: (m: string) => reject(new Error(m)), reloads: () => reloads };
}
// Зависший continueTask (его Promise в тесте не завершается сам) оставил бы процесс «чистым» с кодом 0: без метки конца это был бы зелёный тест.
let finished = false;
process.on('exit', () => { if (!finished) { console.error('FAIL: smoke-attention-ui did not run to the end'); process.exitCode = 1; } });
(async () => {
  // без confirm — не вызван
  let r = rig(opts(), 'question', false);
  await L.toggleForm(r.env);
  check(r.s.cont.open && r.s.cont.opts && r.s.cont.provider === 'glm', '(5) form opens, options loaded, default worker');
  r.s.cont.text = 'ответ';
  check(await L.submitForm(r.env) === 'declined' && r.calls.length === 0 && r.confirms.length === 1, '(5) confirm declined → continueTask not called');

  // пустой ответ у question — не доходит ни до confirm, ни до сервера
  r = rig(opts());
  await L.toggleForm(r.env);
  r.s.cont.text = '   ';
  check(await L.submitForm(r.env) === 'invalid' && r.calls.length === 0 && r.confirms.length === 0 && r.s.cont.error, '(5) empty answer: no confirm, no call, error shown');

  // варианты не получены — нельзя
  for (const bad of [null, { providers: [] }]) {
    r = rig(bad as any);
    await L.toggleForm(r.env);
    r.s.cont.text = 'x';
    check(await L.submitForm(r.env) === 'no-options' && r.calls.length === 0 && r.confirms.length === 0 && r.said.length === 1 && r.said[0][1] === 'error', '(5) no options: phrase, nothing started');
  }
  const thrower = rig(opts());
  thrower.env.orch.continueOptions = async () => { throw new Error('boom'); };
  await L.toggleForm(thrower.env);
  check(thrower.s.cont.opts === null && !thrower.s.cont.loading && await L.submitForm(thrower.env) === 'no-options', '(5) continueOptions throws → treated as no options');

  // запуск: один вызов, второй клик во время busy пуст; передаётся нужный исполнитель и текст
  r = rig(opts());
  await L.toggleForm(r.env);
  r.s.cont.text = '  ответ  ';
  r.s.cont.provider = 'deepseek';
  const first = L.submitForm(r.env);
  check(r.s.busy && r.calls.length === 0, '(5) reading fresh options: already busy');
  await new Promise((res) => setImmediate(res));
  check(r.s.busy && r.calls.length === 1, '(5) running: busy, one call');
  const second = await L.submitForm(r.env);
  check(second === 'busy' && r.calls.length === 1 && r.confirms.length === 1, '(5) double click while busy: no second call, no second confirm');
  check(r.calls[0][0] === 'r1' && r.calls[0][1] === 't03' && r.calls[0][2].provider === 'deepseek' && r.calls[0][2].text === 'ответ', '(5) call: ids, chosen worker, trimmed text');
  r.release('Задача t09 запущена');
  check(await first === 'started' && !r.s.busy && r.reloads() === 1 && r.dones.join() === 'true' && r.said[0][1] === 'info', '(5) success: toast info, busy cleared, done(true)');

  // отказ строкой — ошибка, форма остаётся
  r = rig(opts());
  await L.toggleForm(r.env);
  r.s.cont.text = 'a';
  const p = L.submitForm(r.env);
  await new Promise((res) => setImmediate(res));
  r.release('Эту задачу продолжить нельзя: уже продолжена (r1/t03).');
  check(await p === 'refused' && r.said[0][1] === 'error' && !r.s.busy && r.dones.join() === 'false', '(5) refusal string → error toast, done(false)');

  // forced: в запрос уходит forced, даже если в состоянии другое
  r = rig(opts({ forced: 'glm' })); // сервер вернул бы только glm; логика не должна полагаться на это
  await L.toggleForm(r.env);
  r.s.cont.provider = 'deepseek';
  r.s.cont.text = 'a';
  const f = L.submitForm(r.env);
  await new Promise((res) => setImmediate(res));
  r.release('ok');
  await f;
  check(r.calls[0][2].provider === 'glm', '(5) forced: the forced worker is used');

  // decision: текст не уходит
  r = rig(opts(), 'decision');
  await L.toggleForm(r.env);
  r.s.cont.text = 'мусор';
  const d = L.submitForm(r.env);
  await new Promise((res) => setImmediate(res));
  r.release('ok');
  await d;
  check(r.calls[0][2].text === '', '(5) decision: no text sent');

  // исключение continueTask → done(false), busy снят
  r = rig(opts());
  await L.toggleForm(r.env);
  r.s.cont.text = 'a';
  const x = L.submitForm(r.env);
  await new Promise((res) => setImmediate(res));
  r.fail('сеть упала');
  check(await x === 'error' && !r.s.busy && r.dones.join() === 'false' && r.said[0][1] === 'error', '(5) continueTask throws → error toast, done(false)');

  // варианты меняются между открытием и «Запустить»: confirm строится из свежих данных
  r = rig(opts({ forced: 'or', providers: [prov('or', { free: true })] }));
  await L.toggleForm(r.env);
  r.setOpts(opts({ forced: 'or', providers: [prov('or', { free: false }) ], taskCapUsd: 3 }));
  r.s.cont.text = 'a';
  const st = L.submitForm(r.env);
  await new Promise((res) => setImmediate(res));
  check(r.confirms.length === 1 && /тратит деньги/.test(r.confirms[0]) && /до \$3 на задачу/.test(r.confirms[0]) && !/Бесплатный/.test(r.confirms[0]), '(5) fresh options: confirm shows the new (paid) forced worker and cap');
  r.release('ok');
  await st;

  // выбранный исполнитель пропал: не запускать, фраза, форма обновлена
  r = rig(opts());
  await L.toggleForm(r.env);
  r.s.cont.provider = 'deepseek';
  r.setOpts(opts({ providers: [prov('glm'), prov('or', { free: true })] }));
  r.s.cont.text = 'a';
  check(await L.submitForm(r.env) === 'provider-gone' && r.calls.length === 0 && r.confirms.length === 0 && !r.s.busy && r.said[0][1] === 'error'
    && r.s.cont.opts.providers.length === 2 && r.s.cont.provider === 'glm', '(5) chosen worker vanished: nothing started, phrase, form refreshed');

  // повторное открытие перечитывает варианты
  r = rig(opts());
  await L.toggleForm(r.env);
  await L.toggleForm(r.env);
  r.setOpts(opts({ taskCapUsd: 7 }));
  await L.toggleForm(r.env);
  check(r.s.cont.opts.taskCapUsd === 7, '(5) reopening re-reads the options');

  // повторное открытие закрывает форму и не грузит варианты заново
  r = rig(opts());
  await L.toggleForm(r.env);
  await L.toggleForm(r.env);
  check(!r.s.cont.open, '(5) toggle closes');
  finished = true;
  console.log('smoke-attention-ui: OK');
})();
