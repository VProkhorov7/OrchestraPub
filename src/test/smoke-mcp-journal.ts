/**
 * MCP orchestrator journal: every orchestrator action through the MCP tools is recorded in the
 * run's transcript (Russian one-liners), a transcript-only run (a refused delegation, no tasks)
 * is still saved to history, and a normal app run keeps its own transcript untouched.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Hub, HubEvent } from '../main/hub';
import { TaskEngine } from '../main/engine';
import { Orchestrator } from '../main/orchestrator';
import { registerOrchestraTools } from '../mcp/tools';
import { tmpdir, makeRepo, makeFakeClaude, fakeApi, toolUse, check, testConfig } from './helpers';

(async () => {
  const tmp = tmpdir('orch-mcp-journal-');
  const cfg = testConfig(makeFakeClaude(tmp));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));

  const events: HubEvent[] = [];
  const hub = new Hub(home, (ev) => events.push(ev));

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

  // 1. A run with only transcript entries (a refused delegation, no tasks) is still saved.
  const repoA = repoIn('a');
  const engA = await hub.mcpSession(repoA);
  const a = await clientFor(engA, repoA);
  const refusedA = await a.call('delegate', { provider: 'deepseek', role: 'feature', title: 'x', spec: 'x' });
  check(refusedA.isError && refusedA.text.includes('not allowed'), 'refused delegate returns error: ' + refusedA.text);
  check(engA.state.tasks.length === 0 && engA.state.transcript.length === 1 && engA.state.transcript[0].kind === 'error', 'refusal recorded with no task');
  hub.runs.flush();
  const savedA = hub.runs.load(engA.state.runId).state;
  check(savedA.tasks.length === 0 && savedA.transcript.length === 1, 'transcript-only MCP run saved to history');
  await a.client.close();

  // 2. The journal for a real session: delegate → wait_for → merge → delegate → discard → refusal.
  const repoB = repoIn('b');
  const engB = await hub.mcpSession(repoB);
  const runIdB = engB.state.runId;
  const b = await clientFor(engB, repoB);
  const longSpec = 's'.repeat(400);

  const d1 = await b.call('delegate', { provider: 'deepseek', role: 'docs', title: 'T1', spec: longSpec });
  check(!d1.isError && d1.text.includes('started t01'), 'delegated T1');
  const waited = await b.call('wait_for', { timeout_sec: 60 });
  check(waited.text.includes('status=done'), 'wait_for T1 done');
  const merged = await b.call('merge_task', { task_id: 't01' });
  check(merged.text.startsWith('merged t01'), 'merged t01');
  const d2 = await b.call('delegate', { provider: 'deepseek', role: 'docs', title: 'T2', spec: 'second' });
  check(!d2.isError && d2.text.includes('started t02'), 'delegated T2');
  const discarded = await b.call('discard_task', { task_id: 't02', reason: 'ненужно' });
  check(discarded.text.startsWith('discarded t02'), 'discarded t02');
  const refusedB = await b.call('delegate', { provider: 'deepseek', role: 'feature', title: 'bad', spec: 'x' });
  check(refusedB.isError && refusedB.text.includes('not allowed'), 'second refusal');

  // Noise tools must not add entries.
  const before = engB.state.transcript.length;
  await b.call('list_workers');
  await b.call('task_status');
  await b.call('get_diff', { task_id: 't01' });
  check(engB.state.transcript.length === before, 'noise tools add no transcript entries');

  const tr = engB.state.transcript;
  check(tr.length === 7, `7 transcript entries, got ${tr.length}`);
  check(
    JSON.stringify(tr.map((e) => e.kind)) === JSON.stringify(['tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_call', 'error']),
    'kinds in order: ' + tr.map((e) => e.kind).join(','),
  );
  check(tr[0].text.includes('deepseek') && tr[0].text.includes('docs') && tr[0].text.includes('«T1»'), 'first entry: ' + tr[0].text);
  const specExcerpt = tr[0].text.split('\n')[1] ?? '';
  check(specExcerpt.length === 300 && specExcerpt === longSpec.slice(0, 300), 'spec excerpt cut at 300 chars');
  check(tr[1].text.includes('→ done, $') && tr[1].text.includes('Changed hello.txt as asked'), 'wait_for entry: ' + tr[1].text);
  check(tr[5].text.includes('«ненужно»'), 'discard entry: ' + tr[5].text);
  check(tr[6].kind === 'error' && tr[6].text.includes('not allowed to take role'), 'refusal error entry: ' + tr[6].text);

  // One live transcript event per entry, through the engine callback (the hub tags it with runId).
  const live = events.filter((e) => e.type === 'transcript' && e.runId === runIdB);
  check(live.length === 7, `7 live transcript events, got ${live.length}`);
  check(live.map((e: any) => e.entry.text).join('\n') === tr.map((e) => e.text).join('\n'), 'live events match the transcript entries');

  await b.client.close();

  // 3. A normal app run (API orchestrator) keeps its own transcript, without the MCP journal notes.
  const api = await fakeApi([
    toolUse('a1', 'delegate', { provider: 'deepseek', role: 'docs', title: 'Edit hello', spec: 'Change hello.txt' }),
    toolUse('a2', 'wait_for', {}),
    toolUse('a3', 'merge_task', { task_id: 't01' }),
    toolUse('a4', 'finish', { report: 'Merged t01.' }),
  ]);
  const orch = new Orchestrator(cfg, path.join(tmp, 'wt-app'), repoIn('c'), 'Change hello.txt', () => {});
  await orch.start();
  api.close();
  const appTr = orch.state.transcript;
  check(appTr.length === 9, `app run transcript unchanged (9 entries), got ${appTr.length}`);
  check(!appTr.some((e) => e.text.startsWith('Поручено') || e.text.startsWith('Слить ') || e.text.startsWith('Отбросить ')), 'app transcript has no MCP journal notes');

  // 4. Dedupe: a finished task's result is recorded only once, no matter how often wait_for is called.
  const repoD = repoIn('d');
  const engD = await hub.mcpSession(repoD);
  const d = await clientFor(engD, repoD);
  await d.call('delegate', { provider: 'deepseek', role: 'docs', title: 'T3', spec: 'third' });
  await d.call('delegate', { provider: 'deepseek', role: 'docs', title: 'T4', spec: 'fourth' });
  const dDone = await d.call('wait_for', { task_ids: ['t01', 't02'] });
  check(dDone.text.includes('status=done'), 'T3/T4 finished: ' + dDone.text);
  await d.call('wait_for', { task_ids: ['t01', 't02'] });
  await d.call('wait_for', { task_ids: ['t01', 't02'] });
  await d.call('wait_for', { task_ids: ['t01', 't02'] });
  const dResults = engD.state.transcript.filter((e) => e.kind === 'tool_result');
  check(dResults.length === 2, `two tool_result entries total, got ${dResults.length}`);
  check(dResults.filter((e) => e.text.startsWith('t01 «T3»')).length === 1, 'one tool_result for T3');
  check(dResults.filter((e) => e.text.startsWith('t02 «T4»')).length === 1, 'one tool_result for T4');
  await d.client.close();

  // 5. A task still running is not recorded until wait_for first sees it terminal.
  const slowClaude = path.join(tmp, 'claude-slow');
  fs.writeFileSync(
    slowClaude,
    `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
setTimeout(() => {
  out({ type: 'result', result: 'Slow task finished.', total_cost_usd: 0.01, usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
}, 8000);
`,
  );
  fs.chmodSync(slowClaude, 0o755);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(testConfig(slowClaude)));

  const repoE = repoIn('e');
  const engE = await hub.mcpSession(repoE);
  const e = await clientFor(engE, repoE);
  await e.call('delegate', { provider: 'deepseek', role: 'docs', title: 'T5', spec: 'slow' });
  const still = await e.call('wait_for', { task_ids: ['t01'], timeout_sec: 5 });
  check(still.text.includes('still running'), 'T5 still running: ' + still.text);
  check(engE.state.transcript.filter((x) => x.kind === 'tool_result' && x.text.includes('«T5»')).length === 0, 'no tool_result for T5 while running');
  await e.call('wait_for', { task_ids: ['t01'] });
  await e.call('wait_for', { task_ids: ['t01'] });
  check(engE.state.transcript.filter((x) => x.kind === 'tool_result' && x.text.startsWith('t01 «T5»')).length === 1, 'exactly one tool_result for T5');
  await e.client.close();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));

  // 6. Two sessions keep independent noted sets: the same task id in two repos is recorded once each.
  const repoF = repoIn('f');
  const engF = await hub.mcpSession(repoF);
  const f = await clientFor(engF, repoF);
  await f.call('delegate', { provider: 'deepseek', role: 'docs', title: 'F1', spec: 'first' });
  await f.call('wait_for', { task_ids: ['t01'] });
  check(engF.state.transcript.filter((x) => x.kind === 'tool_result' && x.text.startsWith('t01 «F1»')).length === 1, 'repo f records its own t01 result');

  const repoG = repoIn('g');
  const engG = await hub.mcpSession(repoG);
  const g = await clientFor(engG, repoG);
  await g.call('delegate', { provider: 'deepseek', role: 'docs', title: 'G1', spec: 'second' });
  await g.call('wait_for', { task_ids: ['t01'] });
  check(engG.state.transcript.filter((x) => x.kind === 'tool_result' && x.text.startsWith('t01 «G1»')).length === 1, 'repo g records its own t01 result');
  await f.client.close();
  await g.client.close();

  console.log('\nSMOKE-MCP-JOURNAL OK', tmp);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
