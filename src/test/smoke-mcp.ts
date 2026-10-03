/**
 * MCP server end-to-end: spawn dist/mcp/server.js over stdio like Claude Code would, drive it with the SDK client.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RunStore } from '../main/runs';
import { TaskEngine } from '../main/engine';
import { describeWorkers } from '../main/planner';
import { fromPreset } from '../main/catalog';
import { AppConfig, RunState } from '../main/types';
import { tmpdir, sh, makeRepo, makeFakeClaude, check, testConfig } from './helpers';

(async () => {
  const tmp = tmpdir('orch-mcp-');
  const repo = makeRepo(tmp);
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(testConfig(makeFakeClaude(tmp), { runBudgetUsd: 5 })));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js'), '--repo', repo],
    env: { ...process.env, ORCHESTRA_HOME: home } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(transport);
  const call = async (name: string, args: any = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content.map((c: any) => c.text).join('\n');
    console.log(`> ${name}: ${text.split('\n')[0]}`);
    return { text, isError: !!r.isError };
  };

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check(['delegate','discard_task','get_diff','list_workers','merge_task','task_status','wait_for','memory_context','changelog_write'].every((n) => tools.includes(n)), 'tools: ' + tools);
  check(!!client.getInstructions()?.includes('lead engineer'), 'server instructions');

  const workers = await call('list_workers');
  check(workers.text.includes('id="deepseek"') && workers.text.includes('branch main'), 'workers listed');

  const bad = await call('delegate', { provider: 'deepseek', role: 'feature', title: 'x', spec: 'x' });
  check(bad.isError && bad.text.includes('not allowed'), 'role check through MCP');

  const ok = await call('delegate', { provider: 'deepseek', role: 'docs', title: 'Edit hello', spec: 'Change hello.txt' });
  check(!ok.isError && ok.text.includes('started t01'), 'delegated');

  const waited = await call('wait_for', { timeout_sec: 60 });
  check(waited.text.includes('status=done') && waited.text.includes('hello from deepseek-v4-pro'), 'wait_for returns diff');

  const merged = await call('merge_task', { task_id: 't01' });
  check(merged.text.startsWith('merged t01'), 'merged');
  check(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8').includes('deepseek'), 'repo updated');
  check(sh('git', ['log', '--oneline'], repo).includes('Merge orch/'), 'merge commit');

  const status = await call('task_status');
  check(status.text.includes('status=merged') && status.text.includes('of $5 budget'), 'status with budget');

  await client.close();
  await new Promise((r) => setTimeout(r, 500));
  const runs = new RunStore(path.join(home, 'runs')).list();
  check(runs.length === 1 && runs[0].source === 'mcp' && runs[0].merged === 1 && runs[0].status === 'done', 'MCP session saved to history: ' + JSON.stringify(runs));

  // ---------- force provider (engine level: real provider ids, texts, refusals, task counts) ----------
  const claudePath = makeFakeClaude(tmp);
  const fdir = path.join(tmp, 'force');
  fs.mkdirSync(fdir);
  const frepo = makeRepo(fdir);
  const wtRoot = path.join(tmp, 'force-wt');
  const engineFor = (cfg: AppConfig): TaskEngine => {
    const state: RunState = {
      runId: `mcp-force-${Math.random().toString(36).slice(2)}`,
      source: 'mcp',
      repo: frepo,
      baseBranch: 'main',
      goal: 'force provider test',
      status: 'running',
      tasks: [],
      transcript: [],
      budgetUsd: cfg.runBudgetUsd || 0,
      startedAt: Date.now(),
      pid: process.pid,
    };
    return new TaskEngine(cfg, wtRoot, state, () => {});
  };
  const refused = (e: TaskEngine, provider: string, role: string) => {
    let err = '';
    try { e.delegate({ provider, role, title: 'x', spec: 'x' }); } catch (ex: any) { err = String(ex?.message ?? ex); }
    return err;
  };

  // (a) forced wins over the requested provider even when the requested one forbids the role
  {
    const e = engineFor(testConfig(claudePath, { forceProvider: 'glm' }));
    const r = e.delegate({ provider: 'deepseek', role: 'feature', title: 'Edit hello', spec: 'Change hello.txt' });
    check(r.includes('on glm (glm-5.3)'), '(a) forced provider: ' + r);
    check(e.state.tasks.length === 1 && e.state.tasks[0].providerId === 'glm' && e.state.tasks[0].model === 'glm-5.3', '(a) task provider/model');
    check(e.state.transcript.some((x) => x.text === 'Принудительный маршрут: запрошен deepseek, выполняет glm'), '(a) transcript line');
    await e.wait(['t01'], 30000);
  }
  // (b) forced == requested → no «Принудительный маршрут» line
  {
    const e = engineFor(testConfig(claudePath, { forceProvider: 'glm' }));
    const r = e.delegate({ provider: 'glm', role: 'feature', title: 'Edit hello', spec: 'Change hello.txt' });
    check(r.includes('on glm (glm-5.3)'), '(b) forced=requested: ' + r);
    check(!e.state.transcript.some((x) => x.text.includes('Принудительный маршрут:')), '(b) no force transcript line');
    await e.wait(['t01'], 30000);
  }
  // (c) forced provider red light → refusal, no task
  {
    const e = engineFor(testConfig(claudePath, { forceProvider: 'glm', health: { glm: { light: 'red', text: 'нет ключа', checkedAt: 0 } } }));
    const err = refused(e, 'deepseek', 'feature');
    check(err.startsWith('Принудительный маршрут → glm:'), '(c) refusal prefix: ' + err);
    check(e.state.tasks.length === 0, '(c) no task created');
  }
  // (d) forced id unknown → refusal, no task
  {
    const e = engineFor(testConfig(claudePath, { forceProvider: 'nope' }));
    const err = refused(e, 'deepseek', 'docs');
    check(err.startsWith('Принудительный маршрут → nope:'), '(d) unknown forced: ' + err);
    check(e.state.tasks.length === 0, '(d) no task created');
  }
  // (e) forced provider disabled → refusal
  {
    const e = engineFor(testConfig(claudePath, { forceProvider: 'glm', providers: [fromPreset('deepseek', { token: 'k' }), fromPreset('glm', { token: 'k', enabled: false })] }));
    const err = refused(e, 'deepseek', 'docs');
    check(err.startsWith('Принудительный маршрут → glm:'), '(e) disabled forced: ' + err);
    check(e.state.tasks.length === 0, '(e) no task created');
  }
  // (f) forced provider spend cap already exceeded → refusal, task list unchanged
  {
    const e = engineFor(testConfig(claudePath, { forceProvider: 'glm', providers: [fromPreset('deepseek', { token: 'k' }), fromPreset('glm', { token: 'k', maxUsdPerRun: 5 })] }));
    e.state.tasks.push({ id: 'seed', title: 'x', providerId: 'glm', model: 'glm-5.3', spec: 'x', status: 'done', branch: 'b', worktree: 'w', baseSha: '', createdAt: 0, log: [], costUsd: 5 });
    const err = refused(e, 'deepseek', 'docs');
    check(err.startsWith('Принудительный маршрут → glm:') && err.includes('spend cap'), '(f) cap refusal: ' + err);
    check(e.state.tasks.length === 1, '(f) task list unchanged: ' + e.state.tasks.length);
  }
  // (g) switched off → normal rules again
  {
    const e = engineFor(testConfig(claudePath, {}));
    const err = refused(e, 'deepseek', 'feature');
    check(err.includes('not allowed to take role') && !err.startsWith('Принудительный маршрут'), '(g) off → usual refusal: ' + err);
    check(e.state.tasks.length === 0, '(g) no task created');
  }
  // (i) list_workers marks the route when forced and stays silent when off
  {
    const on = describeWorkers(testConfig(claudePath, { forceProvider: 'glm' }));
    check(on.includes('принудительно идут к glm') && on.includes('не будет использован: включён принудительный маршрут'), '(i) describeWorkers forced: ' + on);
    check(!describeWorkers(testConfig(claudePath, {})).includes('принудительно идут к'), '(i) describeWorkers off');
  }

  console.log('\nSMOKE-MCP OK', tmp);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
