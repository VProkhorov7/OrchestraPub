/**
 * Restoring an MCP session after a service restart: the saved run is reloaded, tasks that were
 * mid-flight are reconciled (a branch with committed work becomes done, the rest fail with the
 * worktree kept), and the same MCP client gets its tasks back. Also: what must NOT be restored.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Hub } from '../main/hub';
import { TaskEngine } from '../main/engine';
import { RunStore } from '../main/runs';
import { RunState } from '../main/types';
import { registerOrchestraTools } from '../mcp/tools';
import { tmpdir, makeRepo, check, testConfig, sh } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = tmpdir('orch-restore-');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);

  // One fake claude for all workers: fast tasks edit+commit hello.txt; a spec containing SLOW sleeps
  // without writing; SLOW_COMMIT commits first and then keeps running (a worker that finished its
  // commit before the restart).
  const claudePath = path.join(tmp, 'claude');
  fs.writeFileSync(
    claudePath,
    `#!/usr/bin/env node
const fs=require('fs');const cp=require('child_process');
const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const args=process.argv.slice(2);
if(args[0]==='auth'){ out({loggedIn:true,authMethod:'claude.ai',subscriptionType:'pro'}); process.exit(0); }
const argv=args.join(' ');
const usage={input_tokens:100000,output_tokens:10000,cache_read_input_tokens:0,cache_creation_input_tokens:0};
const slowUsage={input_tokens:1000,output_tokens:100,cache_read_input_tokens:0,cache_creation_input_tokens:0};
out({type:'system',subtype:'init',model:process.env.ANTHROPIC_MODEL});
if(argv.includes('SLOW_COMMIT')) {
  const file=process.env.FAKE_FILE||'hello.txt';
  fs.writeFileSync(file,'committed before restart\\n');
  cp.execSync('git add -A && git -c user.name=w -c user.email=w@w commit -q -m worker');
  setTimeout(()=>out({type:'result',result:'Committed, then restarted.',total_cost_usd:0.01,usage:slowUsage}), 8000);
} else if(argv.includes('SLOW')) {
  setTimeout(()=>out({type:'result',result:'Slow task would finish.',total_cost_usd:0.01,usage:slowUsage}), 8000);
} else {
  const file=process.env.FAKE_FILE||'hello.txt';
  out({type:'assistant',message:{id:'m1',usage,content:[{type:'text',text:'Editing.'}]}});
  out({type:'assistant',message:{id:'m1',usage,content:[{type:'tool_use',name:'Write',input:{file_path:file}}]}});
  fs.writeFileSync(file,'merged content from t01\\n');
  cp.execSync('git add -A && git -c user.name=w -c user.email=w@w commit -q -m worker');
  out({type:'result',result:'Changed hello.txt as asked.',total_cost_usd:9.99,usage});
}
`,
  );
  fs.chmodSync(claudePath, 0o755);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(testConfig(claudePath)));

  const repoIn = (name: string) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    return makeRepo(dir);
  };

  const clientFor = async (engine: TaskEngine, repo: string) => {
    const server = new McpServer({ name: 'orchestra', version: '0' });
    registerOrchestraTools(server, { engine, repo });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'smoke', version: '0' });
    await client.connect(ct);
    const call = async (name: string, args: any = {}) => {
      const r: any = await client.callTool({ name, arguments: args });
      return { text: r.content.map((c: any) => c.text).join('\n'), isError: !!r.isError };
    };
    return { client, call };
  };

  const waitStatus = async (engine: TaskEngine, taskId: string, status: string, timeoutMs = 10_000) => {
    const start = Date.now();
    for (;;) {
      const t = engine.state.tasks.find((x) => x.id === taskId);
      if (t?.status === status) return;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${taskId} ${status}`);
      await sleep(50);
    }
  };

  const commitsAhead = (repo: string, base: string, branch: string) => {
    try {
      return Number(sh('git', ['rev-list', '--count', `${base}..${branch}`], repo)) > 0;
    } catch {
      return false;
    }
  };

  // (a)+(b): a restart with two hubs on the same home.
  const repoA = repoIn('a');
  const hub1 = new Hub(home, () => {});
  const eng1 = await hub1.mcpSession(repoA);
  const a1 = await clientFor(eng1, repoA);
  const d1 = await a1.call('delegate', { provider: 'deepseek', role: 'docs', title: 'T1', spec: 'Change hello.txt' });
  check(!d1.isError && d1.text.includes('started t01'), 't01 delegated');
  await a1.call('wait_for', { timeout_sec: 60 });
  check(eng1.state.tasks[0].status === 'done', 't01 done');
  const d2 = await a1.call('delegate', { provider: 'deepseek', role: 'docs', title: 'T2', spec: 'SLOW' });
  check(!d2.isError && d2.text.includes('started t02'), 't02 delegated');
  await waitStatus(eng1, 't02', 'running');
  hub1.runs.flush();
  hub1.freezeAll(); // kill the slow worker so it can't finish and rewrite the saved run
  await a1.client.close();

  const hub2 = new Hub(home, () => {});
  hub2.init();
  const eng2 = await hub2.mcpSession(repoA);
  check(eng2.state.runId === eng1.state.runId, 'restored runId matches: ' + eng2.state.runId);
  check(eng2.state.tasks.length === 2, 'restored 2 tasks');
  check(eng2.state.tasks[0].status === 'done', 't01 still done');
  check(eng2.state.tasks[1].status === 'failed' && (eng2.state.tasks[1].error ?? '').includes('перезапуском'), 't02 failed on restart: ' + eng2.state.tasks[1].error);
  check(eng2.state.transcript.some((e) => e.text.includes('Сессия восстановлена')), 'restore note in transcript');

  const b = await clientFor(eng2, repoA);
  const status = await b.call('task_status');
  check(status.text.includes('t01') && status.text.includes('t02'), 'task_status mentions t01 and t02: ' + status.text);
  const merged = await b.call('merge_task', { task_id: 't01' });
  check(merged.text.startsWith('merged t01'), 'merge t01: ' + merged.text);
  check(fs.readFileSync(path.join(repoA, 'hello.txt'), 'utf8') === 'merged content from t01\n', 'merged content is in the working tree');
  const discarded = await b.call('discard_task', { task_id: 't02' });
  check(discarded.text.startsWith('discarded t02'), 'discard t02: ' + discarded.text);
  check(!fs.existsSync(eng2.state.tasks[1].worktree), 't02 worktree gone after discard');
  const d3 = await b.call('delegate', { provider: 'deepseek', role: 'docs', title: 'T3', spec: 'third' });
  check(!d3.isError && d3.text.includes('started t03'), 'new delegate continues at t03: ' + d3.text);
  await b.client.close();

  // (c): a task that was running but whose branch already has a commit becomes done, not failed.
  const repoC = repoIn('c');
  const hub3 = new Hub(home, () => {});
  const eng3 = await hub3.mcpSession(repoC);
  const c = await clientFor(eng3, repoC);
  await c.call('delegate', { provider: 'deepseek', role: 'docs', title: 'C1', spec: 'SLOW_COMMIT' });
  await waitStatus(eng3, 't01', 'running');
  const t1 = eng3.state.tasks[0];
  const committed = Date.now();
  while (!commitsAhead(repoC, t1.baseSha, t1.branch) && Date.now() - committed < 10_000) await sleep(50);
  check(commitsAhead(repoC, t1.baseSha, t1.branch), 'task committed before the restart');
  hub3.runs.flush();
  hub3.freezeAll();
  await c.client.close();

  const hub4 = new Hub(home, () => {});
  hub4.init();
  const eng4 = await hub4.mcpSession(repoC);
  check(eng4.state.runId === eng3.state.runId, 'case c: same runId');
  check(eng4.state.tasks[0].status === 'done' && eng4.state.tasks[0].result === 'восстановлено после перезапуска службы', 'committed task restored as done: ' + eng4.state.tasks[0].status);
  const c2 = await clientFor(eng4, repoC);
  const cm = await c2.call('merge_task', { task_id: 't01' });
  check(cm.text.startsWith('merged t01'), 'case c: merge the restored done task');
  check(fs.readFileSync(path.join(repoC, 'hello.txt'), 'utf8') === 'committed before restart\n', 'case c: committed content merged');
  await c2.client.close();

  // (d): what must NOT be restored.
  const store = new RunStore(path.join(home, 'runs'));
  const mkRun = (runId: string, repo: string, over: Partial<RunState>) => {
    const state: RunState = {
      runId,
      source: 'mcp',
      repo,
      baseBranch: 'main',
      goal: 'MCP-сессия',
      status: 'interrupted',
      tasks: [{ id: 't01', title: 'T', providerId: 'deepseek', model: 'deepseek-v4-pro', spec: 'x', role: 'docs', status: 'done', branch: `orch/${runId}-t01-t`, worktree: path.join(tmp, 'wt', runId, 't01'), baseSha: '', createdAt: 0, log: [] }],
      transcript: [],
      startedAt: Date.now(),
      pid: process.pid,
      ...over,
    };
    store.write({ version: 1, state, messages: [], savedAt: Date.now() });
  };

  // 25h-old run → not restored, a fresh run is created.
  const repoD1 = repoIn('d1');
  mkRun('mcp-old', repoD1, { startedAt: Date.now() - 25 * 3600_000 });
  const hubD = new Hub(home, () => {});
  const engD1 = await hubD.mcpSession(repoD1);
  check(engD1.state.runId !== 'mcp-old' && engD1.state.tasks.length === 0, '25h-old run not restored: ' + engD1.state.runId);

  // Another repo's run → not used for this repo.
  const repoD2 = repoIn('d2');
  mkRun('mcp-other', repoIn('d2-other'), {});
  const engD2 = await hubD.mcpSession(repoD2);
  check(engD2.state.runId !== 'mcp-other' && engD2.state.tasks.length === 0, 'another repo run not restored: ' + engD2.state.runId);

  // All tasks merged → not restored.
  const repoD3 = repoIn('d3');
  mkRun('mcp-merged', repoD3, { tasks: [{ id: 't01', title: 'T', providerId: 'deepseek', model: 'deepseek-v4-pro', spec: 'x', role: 'docs', status: 'merged', branch: 'orch/x-t01-t', worktree: path.join(tmp, 'wt', 'mcp-merged', 't01'), baseSha: '', createdAt: 0, log: [] }] });
  const engD3 = await hubD.mcpSession(repoD3);
  check(engD3.state.runId !== 'mcp-merged' && engD3.state.tasks.length === 0, 'all-merged run not restored: ' + engD3.state.runId);

  // (e): restoring twice in a row keeps the same run and does not duplicate tasks or notes.
  const repoE = repoIn('e');
  const hub1e = new Hub(home, () => {});
  const eng1e = await hub1e.mcpSession(repoE);
  const e1 = await clientFor(eng1e, repoE);
  await e1.call('delegate', { provider: 'deepseek', role: 'docs', title: 'E1', spec: 'SLOW' });
  await waitStatus(eng1e, 't01', 'running');
  hub1e.runs.flush();
  hub1e.freezeAll();
  await e1.client.close();

  const hub2e = new Hub(home, () => {});
  hub2e.init();
  const eng2e = await hub2e.mcpSession(repoE);
  const runIdE = eng2e.state.runId;
  check(eng2e.state.tasks.length === 1 && eng2e.state.tasks[0].status === 'failed', 'first restore reconciles t01');
  hub2e.runs.flush();

  const hub3e = new Hub(home, () => {});
  hub3e.init();
  const eng3e = await hub3e.mcpSession(repoE);
  check(eng3e.state.runId === runIdE, 'second restore keeps the runId');
  check(eng3e.state.tasks.length === 1, 'no duplicated tasks: ' + eng3e.state.tasks.length);
  const restoreNotes = eng3e.state.transcript.filter((x) => x.text.includes('Сессия восстановлена'));
  check(restoreNotes.length === 2, `one restore note per restart, got ${restoreNotes.length}`);

  // (f): at service start the interrupted sessions are restored without any mcpSession() call.
  const homeF = path.join(tmp, 'homeF');
  fs.mkdirSync(homeF);
  fs.writeFileSync(path.join(homeF, 'config.json'), JSON.stringify(testConfig(claudePath)));
  const storeF = new RunStore(path.join(homeF, 'runs'));
  const mkRunF = (runId: string, repo: string, over: Partial<RunState>) => {
    const state: RunState = {
      runId,
      source: 'mcp',
      repo,
      baseBranch: 'main',
      goal: 'MCP-сессия',
      status: 'interrupted',
      tasks: [{ id: 't01', title: 'T', providerId: 'deepseek', model: 'deepseek-v4-pro', spec: 'x', role: 'docs', status: 'done', branch: `orch/${runId}-t01-t`, worktree: path.join(tmp, 'wt', runId, 't01'), baseSha: '', createdAt: 0, log: [] }],
      transcript: [],
      startedAt: Date.now() - 3600_000,
      pid: process.pid,
      ...over,
    };
    storeF.write({ version: 1, state, messages: [], savedAt: Date.now() });
  };
  const repoF1 = repoIn('f1');
  const repoF2 = repoIn('f2');
  const repoF3 = repoIn('f3');
  mkRunF('mcp-start', repoF1, {});
  mkRunF('mcp-start-old', repoF2, { startedAt: Date.now() - 25 * 3600_000 });
  mkRunF('mcp-start-merged', repoF3, { tasks: [{ id: 't01', title: 'T', providerId: 'deepseek', model: 'deepseek-v4-pro', spec: 'x', role: 'docs', status: 'merged', branch: 'orch/x-t01-t', worktree: path.join(tmp, 'wt', 'mcp-start-merged', 't01'), baseSha: '', createdAt: 0, log: [] }] });
  mkRunF('mcp-start-gone', path.join(tmp, 'no-such-repo'), {});
  const repoF4 = repoIn('f4');
  mkRunF('mcp-start-idle', repoF4, { tasks: [
    { id: 't01', title: 'T', providerId: 'deepseek', model: 'deepseek-v4-pro', spec: 'x', role: 'docs', status: 'done', branch: 'orch/mcp-start-idle-t01-t', worktree: path.join(tmp, 'wt', 'mcp-start-idle', 't01'), baseSha: '', createdAt: 0, log: [] },
    { id: 't02', title: 'Q', providerId: 'deepseek', model: 'deepseek-v4-pro', spec: 'x', role: 'docs', status: 'queued', branch: 'orch/mcp-start-idle-t02-q', worktree: path.join(tmp, 'wt', 'mcp-start-idle', 't02'), baseSha: '', createdAt: 0, log: [] },
  ] });
  // plain init(): the Electron app must not claim sessions
  const hubP = new Hub(homeF, () => {});
  hubP.init();
  await hubP.whenStartRestored();
  await sleep(300);
  check(hubP.liveEngines().length === 0, 'plain init(): restores nothing');
  hubP.stop();

  const hubF = new Hub(homeF, () => {});
  hubF.init({ restoreMcp: true });
  // race: the agent's first call comes while the start-up restore is running
  const raced = await hubF.mcpSession(repoF1);
  await hubF.whenStartRestored();
  const liveIds = hubF.liveEngines().map((e) => e.state.runId);
  check(liveIds.filter((x) => x === 'mcp-start').length === 1, 'start: interrupted MCP session is live: ' + liveIds.join(','));
  check(raced.state.runId === 'mcp-start' && hubF.liveEngines().find((e) => e.state.runId === 'mcp-start') === raced, 'race: mcpSession got the restored engine');
  check(raced.state.transcript.filter((x) => x.text.includes('Сессия восстановлена')).length === 1, 'race: exactly one restore note');
  check(!liveIds.includes('mcp-start-old'), 'start: 24h-old session not restored');
  check(!liveIds.includes('mcp-start-merged'), 'start: all-merged session not restored');
  check(!liveIds.includes('mcp-start-gone'), 'start: missing repo not restored, no throw');
  check(raced.state.status === 'running' && raced.state.tasks.every((t) => t.status === 'done'), 'start: restored session starts no worker');

  // idle close of a start-restored session nobody used keeps it interrupted
  const engI = hubF.liveEngines().find((e) => e.state.runId === 'mcp-start-idle')!;
  check(!!engI, 'start: idle session restored');
  check(engI.state.tasks.find((t) => t.id === 't02')!.status === 'failed', 'start: queued task is failed by reconcile, not started');
  (hubF as any).closeMcp(path.resolve(repoF4), (hubF as any).mcp.get(path.resolve(repoF4)));
  check(new RunStore(path.join(homeF, 'runs')).load('mcp-start-idle').state.status === 'interrupted', 'idle: untouched start-restored session saved as interrupted');
  hubF.stop();

  // two restores of the same repo at once share one promise: one engine, one note
  const hubR = new Hub(homeF, () => {});
  hubR.init();
  const [r1, r2] = await Promise.all([(hubR as any).restoreMcpSession(path.resolve(repoF4)), (hubR as any).restoreMcpSession(path.resolve(repoF4))]);
  check(!!r1 && r1 === r2, 'race: concurrent restores return the same engine');
  hubR.stop();

  console.log('\nSMOKE-RESTORE OK', tmp);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
