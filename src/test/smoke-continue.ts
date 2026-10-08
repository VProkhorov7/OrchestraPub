/**
 * Continue a task from the panel (Hub.continueTask): answer a question, retry after the automatic retries, go on after a cap stop.
 * The new task lives in the repo's MCP session and starts from the old task's branch, even when the old task is in a saved run;
 * the old run.json is never touched; the old attention item closes by the `runId/taskId` link. Run: as a step of `npm run smoke`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Hub } from '../main/hub';
import { collectAttention } from '../main/attention';
import { clearPauses, pauseProvider } from '../main/ratelimit';
import { makeFakeClaude, makeRepo, testConfig, tmpdir, check, sh } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = async (want: () => boolean, ms = 60_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !want()) await sleep(200);
};

(async () => {
  // ---- collectAttention is pure: a continuation in ANOTHER run closes the item by `runId/taskId` ----
  const mk = (runId: string, tasks: any[]) => ({ runId, tasks, budgetUsd: 0, spentTotal: 0, spentByProvider: {}, live: false });
  const tk = (id: string, extra: any = {}) => ({ id, title: id, providerId: 'glm', status: 'done', log: [], ...extra });
  const base = { providers: [] as any[], health: {}, pausedUntil: {}, unmergedWarnMinutes: 0, now: 1e10 };
  const asks = tk('t01', { needsAnswer: 'which port?' });
  const open = collectAttention({ ...base, runs: [mk('saved', [asks]), mk('mcp-x', [])] });
  check(open.length === 1 && open[0].kind === 'question' && open[0].runId === 'saved', `no continuation: the question is shown: ${JSON.stringify(open)}`);
  const closed = collectAttention({ ...base, runs: [mk('saved', [asks]), mk('mcp-x', [tk('t01', { continuedFrom: 'saved/t01', status: 'running' })])] });
  check(closed.length === 0, `a continuation in another run closes the item: ${JSON.stringify(closed)}`);
  const other = collectAttention({ ...base, runs: [mk('saved', [asks]), mk('mcp-x', [tk('t01', { continuedFrom: 'other/t01', status: 'running' })])] });
  check(other.length === 1, 'a link to another run/task does not close it');
  const capped = collectAttention({ ...base, runs: [mk('saved', [tk('t02', { capped: true, status: 'failed' }), tk('t03', { status: 'failed', escalated: true })]), mk('mcp-x', [tk('t09', { continuedFrom: 'saved/t02' }), tk('t10', { continuedFrom: 'saved/t03' })])] });
  check(capped.length === 0, 'capped and escalated items close the same way');

  // ---- Hub ----
  const tmp = tmpdir('orch-continue-');
  const claudePath = makeFakeClaude(tmp);
  const repo = makeRepo(tmp);
  const g = (...a: string[]) => sh('git', a, repo);
  const base0 = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '-b', 'orch/saved-t01-old', 'main');
  fs.writeFileSync(path.join(repo, 'old.txt'), 'from the old branch\n');
  g('add', '.');
  g('commit', '-q', '-m', 'old work');
  g('checkout', '-q', 'main');

  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const writeCfg = (extra: any = {}) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(testConfig(claudePath, { language: 'en', ...extra })));
  writeCfg();
  const hub = new Hub(home, () => {});
  const savedTask = (id: string, extra: any = {}) => ({ id, title: `Old ${id}`, providerId: 'deepseek', model: 'm', role: 'docs', spec: 'Write the docs for X', status: 'done', log: ['last words'], branch: 'orch/saved-t01-old', baseSha: base0, error: undefined, ...extra });
  const save = (runId: string, state: any) => {
    const d = path.join(home, 'runs', runId);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify({ version: 1, state: { runId, source: 'app', status: 'done', baseBranch: 'main', transcript: [], startedAt: 1, ...state }, messages: [], savedAt: 0 }));
  };
  save('saved', {
    repo,
    tasks: [
      savedTask('t01', { needsAnswer: 'which port?' }),
      savedTask('t02'), // plain done, not continuable
      savedTask('t03', { capped: true, status: 'failed', branch: 'orch/gone-branch' }),
      savedTask('t04', { escalated: true, status: 'timeout', role: 'feature', providerId: 'deepseek' }),
    ],
  });
  save('gone', { repo: path.join(tmp, 'no-such-repo'), tasks: [savedTask('t01', { needsAnswer: 'q?' })] });
  const runJson = (id: string) => fs.readFileSync(path.join(home, 'runs', id, 'run.json'), 'utf8');
  const before = { saved: runJson('saved'), gone: runJson('gone') };
  const items = () => hub.attention().filter((i) => i.runId === 'saved').map((i) => `${i.kind}:${i.taskId}`);

  check(items().includes('question:t01'), `the saved question is in «Требует вас»: ${items()}`);

  // ---- refusals: clear sentences, nothing started, old run.json unchanged ----
  const eng = await hub.mcpSession(repo);
  const noTasks = eng.state.tasks.length;
  const r = async (run: string, t: string, o: any) => hub.continueTask(run, t, o);
  let s = await r('saved', 't99', { provider: 'deepseek', text: 'x' });
  check(s === 'Задача не найдена', `unknown task: ${s}`);
  s = await r('nope', 't01', { provider: 'deepseek', text: 'x' });
  check(s === 'Задача не найдена', `unknown run: ${s}`);
  s = await r('saved', 't02', { provider: 'deepseek', text: 'x' });
  check(/^Эту задачу продолжить нельзя: /.test(s), `not in a continuable state: ${s}`);
  s = await r('saved', 't01', { provider: 'deepseek', text: '  ' });
  check(/^Эту задачу продолжить нельзя: .*ответ/.test(s), `empty answer to a question: ${s}`);
  s = await r('saved', 't01', { provider: 'deepseek', text: 'x'.repeat(4001) });
  check(/4000/.test(s), `too long: ${s}`);
  s = await r('gone', 't01', { provider: 'deepseek', text: 'x' });
  check(/^Репозиторий не найден: .*no-such-repo\. Ничего не сделано\.$/.test(s), `repo missing: ${s}`);
  s = await r('saved', 't01', { provider: 'nope', text: 'x' });
  check(/^Не запущено: .*nope/.test(s), `provider not allowed: ${s}`);
  pauseProvider('deepseek', '429 too many requests');
  s = await r('saved', 't01', { provider: 'deepseek', text: 'x' });
  check(/^Не запущено: .*rate-limited/.test(s), `provider on pause: ${s}`);
  clearPauses();
  check(eng.state.tasks.length === noTasks, 'a refusal starts nothing');
  check(runJson('saved') === before.saved && runJson('gone') === before.gone, 'old run.json unchanged after refusals');

  // ---- (a) a question of a SAVED run, answered: new task in the MCP session, from the old branch ----
  process.env.FAKE_FILE = 'new.txt';
  s = await r('saved', 't01', { provider: 'deepseek', text: 'port 8080' });
  check(/^started t01 /.test(s), `started: ${s}`);
  const n1 = eng.state.tasks[0];
  check(n1.continuedFrom === 'saved/t01' && n1.continuedFromBranch === 'orch/saved-t01-old', `link to the saved task: ${n1.continuedFrom} ${n1.continuedFromBranch}`);
  check(n1.role === 'docs' && n1.title === 'Old t01 (продолжение)' && n1.providerId === 'deepseek', `role/title/provider: ${n1.role} ${n1.title} ${n1.providerId}`);
  check(/port 8080/.test(n1.spec) && /which port\?/.test(n1.spec) && /Write the docs for X/.test(n1.spec) && /CONTINUATION/.test(n1.spec) && /last words/.test(n1.spec), 'the brief has the answer, the question, the task and the continuation header');
  check(!items().includes('question:t01'), `the item is closed by the link right away: ${items()}`);
  await settle(() => n1.status === 'done');
  check(n1.status === 'done', `the continuation finishes: ${n1.status} ${n1.error ?? ''}`);
  check(fs.existsSync(path.join(n1.worktree, 'old.txt')) && fs.existsSync(path.join(n1.worktree, 'new.txt')), 'the new worktree started from the old branch (old.txt) and has its own work (new.txt)');
  check(runJson('saved') === before.saved, 'the saved run.json is not touched by a continuation');

  // ---- cap stop with a missing branch: from a clean sheet, said so; a decision: other worker, note appended ----
  s = await r('saved', 't03', { provider: 'deepseek', text: 'be brief', title: 'Fresh start' });
  check(/^started t02 /.test(s) && /чистого листа/.test(s), `missing branch → clean start: ${s}`);
  const n2 = eng.state.tasks[1];
  check(n2.continuedFrom === 'saved/t03' && !n2.continuedFromBranch && !/CONTINUATION/.test(n2.spec) && n2.title === 'Fresh start' && /be brief/.test(n2.spec), `clean start: linked, no branch, no continuation header, owner note kept: ${n2.continuedFrom}`);
  const cnt2 = eng.state.tasks.length;
  s = await r('saved', 't03', { provider: 'deepseek' });
  check(/уже продолжена \(/.test(s) && eng.state.tasks.length === cnt2, `clean start: second click refused: ${s}`);
  check(!hub.attention().some((i) => i.runId === 'saved' && i.taskId === 't03'), 'clean start: the old panel item is closed');
  s = await r('saved', 't04', { provider: 'glm' });
  check(/^started t03 /.test(s) && eng.state.tasks[2].continuedFrom === 'saved/t04', `decision retried on another worker: ${s}`);
  await settle(() => eng.state.tasks.every((t) => t.status === 'done' || t.status === 'failed'));

  // ---- (b) a LIVE run: same engine, plain continue_from id ----
  process.env.FAKE_FILE = 'live.txt';
  process.env.FAKE_NEEDS_ANSWER = '1';
  eng.delegate({ provider: 'deepseek', role: 'docs', title: 'Ask', spec: 'Ask me' });
  await settle(() => eng.state.tasks.length === 4 && eng.state.tasks[3].status === 'done');
  const q = eng.state.tasks[3];
  check(q.needsAnswer === 'which port?', `the live worker stopped with a question: ${q.needsAnswer} ${q.status}`);
  delete process.env.FAKE_NEEDS_ANSWER;
  process.env.FAKE_FILE = 'live2.txt'; // the first one is already committed on the question's branch
  s = await r(eng.state.runId, q.id, { provider: 'deepseek', text: '9090' });
  check(/^started t05 /.test(s), `live continue: ${s}`);
  const n5 = eng.state.tasks[4];
  check(n5.continuedFrom === q.id && !n5.continuedFromBranch && /9090/.test(n5.spec), `live: plain link ${n5.continuedFrom}`);
  await settle(() => n5.status === 'done');
  check(n5.status === 'done' && fs.existsSync(path.join(n5.worktree, 'live.txt')) && fs.existsSync(path.join(n5.worktree, 'live2.txt')), `live continuation finishes: ${n5.status} ${n5.error ?? ''}`);
  check(!hub.attention().some((i) => i.taskId === q.id && i.runId === eng.state.runId), 'the live question item is closed');

  // ---- double-continue guard (money): a second continue of the same task is refused, nothing starts ----
  const cnt = eng.state.tasks.length;
  s = await r('saved', 't01', { provider: 'deepseek', text: 'again' });
  check(/^Эту задачу продолжить нельзя: уже продолжена \(.+\)\.$/.test(s), `saved task continued twice: ${s}`);
  s = await r(eng.state.runId, q.id, { provider: 'deepseek', text: 'again' });
  check(/^Эту задачу продолжить нельзя: уже продолжена \(.+\)\.$/.test(s), `live task continued twice: ${s}`);
  check(eng.state.tasks.length === cnt, `the refused repeats start nothing: ${eng.state.tasks.length} vs ${cnt}`);
  // two parallel clicks on a fresh item: exactly one task
  save('par', { repo, tasks: [savedTask('t01', { needsAnswer: 'which?' })] });
  const [p1, p2] = await Promise.all([r('par', 't01', { provider: 'deepseek', text: 'a' }), r('par', 't01', { provider: 'deepseek', text: 'b' })]);
  const started = [p1, p2].filter((x) => /^started /.test(x));
  const refused = [p1, p2].filter((x) => /^Эту задачу продолжить нельзя: уже продолжена/.test(x));
  check(started.length === 1 && refused.length === 1, `parallel clicks: one started, one refused: ${p1} | ${p2}`);
  check(eng.state.tasks.length === cnt + 1 && eng.state.tasks.filter((t) => t.continuedFrom === 'par/t01').length === 1, `parallel clicks: exactly one new task: ${eng.state.tasks.length}`);
  s = await r('par', 't01', { provider: 'deepseek', text: 'c' });
  check(/уже продолжена/.test(s) && eng.state.tasks.length === cnt + 1, `after the parallel pair a third call is refused: ${s}`);
  // retriedAs pointing to an existing task of the same run
  save('retr', { repo, tasks: [savedTask('t01', { needsAnswer: 'q?', retriedAs: 't02' }), savedTask('t02')] });
  s = await r('retr', 't01', { provider: 'deepseek', text: 'x' });
  check(/^Эту задачу продолжить нельзя: уже продолжена \(retr\/t02\)\.$/.test(s) && eng.state.tasks.length === cnt + 1, `retriedAs: ${s}`);
  await settle(() => eng.state.tasks.every((t) => t.status !== 'running' && t.status !== 'queued'));

  // ---- the branch vanishes before the worktree is made: one failed task, no automatic clean-sheet retry ----
  const nt = eng.state.tasks.length;
  const ghost = JSON.parse(JSON.stringify({ ref: 'saved/t01', branch: 'orch/vanished', baseSha: base0 }));
  eng.delegate({ provider: 'deepseek', role: 'docs', title: 'Ghost', spec: 'x', continueFromExternal: ghost });
  await settle(() => eng.state.tasks[nt].status === 'failed');
  await sleep(500);
  check(eng.state.tasks[nt].status === 'failed' && !eng.state.tasks[nt].startedAt, `vanished branch: failed before start: ${eng.state.tasks[nt].status}`);
  check(eng.state.tasks.length === nt + 1 && !eng.state.tasks[nt].retriedAs, `vanished branch: no automatic retry: ${eng.state.tasks.length} vs ${nt + 1}`);
  check(eng.state.tasks[nt].escalated === true && !!eng.state.tasks[nt].question, 'vanished branch: escalated to the owner with a question');
  check(hub.attention().some((i) => i.kind === 'decision' && i.runId === eng.state.runId && i.taskId === eng.state.tasks[nt].id), 'vanished branch: a «decision» item is shown');

  // ---- money: a task started by one owner click never retries automatically; a normal task still does ----
  process.env.FAKE_FAIL_ALL = '1';
  save('fail', { repo, tasks: [savedTask('t01', { escalated: true, status: 'failed' })] });
  const nf = eng.state.tasks.length;
  s = await r('fail', 't01', { provider: 'deepseek' });
  check(/^started /.test(s), `failing continuation: started: ${s}`);
  await settle(() => eng.state.tasks[nf].status === 'failed');
  await sleep(1000);
  check(eng.state.tasks.length === nf + 1 && !eng.state.tasks[nf].retriedAs, `continued task fails: no automatic retry: ${eng.state.tasks.length} vs ${nf + 1}`);
  check(eng.state.tasks[nf].escalated === true && !!eng.state.tasks[nf].question, 'continued task fails: escalated to the owner');
  check(hub.attention().some((i) => i.kind === 'decision' && i.runId === eng.state.runId && i.taskId === eng.state.tasks[nf].id), 'continued task fails: a «decision» item is shown');
  eng.delegate({ provider: 'deepseek', role: 'docs', title: 'Plain', spec: 'x' });
  await settle(() => eng.state.tasks.length > nf + 1 && !!eng.state.tasks[nf + 1].retriedAs);
  check(!!eng.state.tasks[nf + 1].retriedAs && eng.state.tasks.length > nf + 2, `normal task fails: still retried automatically: ${eng.state.tasks[nf + 1].retriedAs}`);
  await settle(() => eng.state.tasks.every((t) => t.status !== 'running' && t.status !== 'queued'));
  delete process.env.FAKE_FAIL_ALL;

  // a continuation that gets a 429 is not moved to another worker either: one click, one paid attempt
  process.env.FAKE_RATE_LIMIT_URL = 'deepseek';
  save('rl', { repo, tasks: [savedTask('t01', { escalated: true, status: 'failed' })] });
  const nr = eng.state.tasks.length;
  s = await r('rl', 't01', { provider: 'deepseek' });
  check(/^started /.test(s), `rate-limited continuation: started: ${s}`);
  await settle(() => eng.state.tasks[nr].status === 'failed');
  await sleep(1000);
  check(eng.state.tasks.length === nr + 1 && !eng.state.tasks[nr].retriedAs, `continued task gets a 429: no retry, no extra task: ${eng.state.tasks.length} vs ${nr + 1}`);
  check(eng.state.tasks[nr].escalated === true, 'continued task gets a 429: escalated to the owner');
  check(hub.attention().some((i) => i.kind === 'decision' && i.runId === eng.state.runId && i.taskId === eng.state.tasks[nr].id), 'continued task gets a 429: a «decision» item is shown');
  delete process.env.FAKE_RATE_LIMIT_URL;
  clearPauses();

  // ---- (d) continue-options ----
  check(hub.continueOptions('saved', 'nope') === null, 'options: unknown task → null');
  let o = hub.continueOptions('saved', 't01')!;
  check(o.role === 'docs' && o.providers.map((p) => p.id).join() === 'deepseek' && o.defaultProvider === 'deepseek' && o.taskCapUsd === 0.5 && o.runBudgetUsd === 20, `options: ${JSON.stringify(o)}`);
  check(o.providers.every((p) => p.model && p.billing && typeof p.capUsd === 'number' && typeof p.free === 'boolean'), 'options: provider fields');
  const feat = hub.continueOptions('saved', 't04')!;
  check(feat.role === 'feature' && feat.providers.some((p) => p.id === 'glm'), `options for another role: ${JSON.stringify(feat)}`);
  const hasDeepseek = feat.providers.some((p) => p.id === 'deepseek');
  check(hasDeepseek ? feat.defaultProvider === 'deepseek' : feat.defaultProvider !== 'deepseek', `default worker is the task's own only when it may take the role: ${feat.defaultProvider}`);
  writeCfg({ providers: JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).providers.map((p: any) => (p.id === 'glm' ? { ...p, enabled: false } : p)), taskCapUsd: { docs: 0.07 }, runBudgetUsd: 5 });
  o = hub.continueOptions('saved', 't01')!;
  check(o.taskCapUsd === 0.07 && o.runBudgetUsd === 5, `options: caps from the settings: ${JSON.stringify(o)}`);
  check(!hub.continueOptions('saved', 't04')!.providers.some((p) => p.id === 'glm'), 'options: a disabled worker is gone');
  pauseProvider('deepseek', '429');
  o = hub.continueOptions('saved', 't01')!;
  check(o.providers.length === 0 && o.defaultProvider === null, `options: a paused worker is gone: ${JSON.stringify(o)}`);
  clearPauses();
  writeCfg({ forceProvider: 'glm' });
  o = hub.continueOptions('saved', 't01')!;
  check(o.forced === 'glm' && o.providers.length === 1 && o.providers[0].id === 'glm', `options: forceProvider → the only worker: ${JSON.stringify(o)}`);
  writeCfg({ forceProvider: 'no-such' });
  o = hub.continueOptions('saved', 't01')!;
  check(o.forced === null && o.providers.length > 0, `options: a broken forceProvider is ignored: ${o.forced}`);

  hub.endMcpSession(repo);
  hub.stop();
  console.log('SMOKE-CONTINUE OK');
  process.exit(0);
})();
