/**
 * Connections and subscriptions:
 *  1. Traffic lights: API answers (200 / 401 / 402 / low credit / 429 / no key), claude auth status, codex login status, missing CLI.
 *  2. A yellow worker is refused by delegate and marked UNAVAILABLE for the orchestrator.
 *  3. Orchestrator on the Claude subscription: `claude -p` + MCP over HTTP drives the app's engine; no API key leaks.
 *  4. The same with Codex (`codex exec --json`).
 *  5. Usage limit of the subscription → run stopped with a clear reason.
 *  6. Planning through the CLIs.
 *  7. Old (0.3) configs migrate: keyless defaults dropped, subscriptions added.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { checkAll, checkOne, classifyApi } from '../main/health';
import { CliOrchestrator } from '../main/cliorch';
import { makePlan, describeWorkers } from '../main/planner';
import { TaskEngine } from '../main/engine';
import { normalizeConfig } from '../main/config';
import { fromPreset } from '../main/catalog';
import { AppConfig, RunState } from '../main/types';
import { tmpdir, sh, makeRepo, makeFakeClaude, check, testConfig } from './helpers';

function makeFakeCodex(root: string) {
  const f = path.join(root, 'codex');
  fs.writeFileSync(f, `#!/usr/bin/env node\nrequire(${JSON.stringify(path.join(__dirname, 'fake-orchestrator.js'))}).codex(process.argv.slice(2));\n`);
  fs.chmodSync(f, 0o755);
  return f;
}

async function fakeProviderApi() {
  const server = http.createServer((req, res) => {
    const key = String(req.headers['x-api-key'] ?? String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const send = (code: number, body: any) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/user/balance') return send(200, { is_available: key !== 'broke', balance_infos: [{ currency: 'USD', total_balance: key === 'broke' ? '0.00' : '12.34' }] });
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (key === 'good' || key === 'broke') return send(200, { id: 'x', content: [] });
      if (key === 'bad') return send(401, { error: { message: 'invalid x-api-key' } });
      if (key === 'poor') return send(402, { error: { message: 'Insufficient Balance' } });
      if (key === 'lowcredit') return send(400, { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } });
      if (key === 'rate') return send(429, { error: { message: 'Rate limit exceeded, slow down' } });
      send(500, { error: { message: 'boom' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as any).port}`, close: () => server.close() };
}

/** The health ping must use max_tokens that every gateway accepts (B.AI rejects <= 2); classification stays unchanged. */
async function healthPing() {
  const tmp = tmpdir('orch-ping-');
  const cfg: AppConfig = testConfig(makeFakeClaude(tmp));

  // Gateway that records the ping body and mirrors B.AI's rule: max_tokens <= 2 -> 400.
  const recorded: any[] = [];
  const strict = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = JSON.parse(body);
      recorded.push(j);
      if ((j.max_tokens ?? 0) <= 2) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'max_tokens must be greater than 2' } }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
      }
    });
  });
  await new Promise<void>((r) => strict.listen(0, '127.0.0.1', r));
  const strictBase = `http://127.0.0.1:${(strict.address() as any).port}`;
  const h = await checkOne(fromPreset('glm', { baseUrl: strictBase, token: 'good' }), cfg);
  check(h.light === 'green', `ping with max_tokens=16 is green: ${h.text}`);
  check(recorded.length === 1 && recorded[0].max_tokens === 16, `ping max_tokens exactly 16, got ${JSON.stringify(recorded)}`);
  strict.close();

  // A gateway that always answers 401 must still be RED (classification unchanged).
  const denied = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } }));
    });
  });
  await new Promise<void>((r) => denied.listen(0, '127.0.0.1', r));
  const deniedBase = `http://127.0.0.1:${(denied.address() as any).port}`;
  const bad = await checkOne(fromPreset('glm', { baseUrl: deniedBase, token: 'bad' }), cfg);
  check(bad.light === 'red', `401 gateway still red: ${bad.text}`);
  denied.close();
  console.log('health ping OK');
}

async function lights() {
  const tmp = tmpdir('orch-health-');
  const api = await fakeProviderApi();
  const mk = (id: string, token: string, preset = 'glm') => fromPreset(preset, { id, token, baseUrl: api.base });
  const cfg: AppConfig = testConfig(makeFakeClaude(tmp), {
    providers: [
      mk('ok', 'good'), mk('bad', 'bad'), mk('poor', 'poor'), mk('low', 'lowcredit'), mk('rate', 'rate'), mk('nokey', ''),
      { ...mk('ds', 'good', 'deepseek'), baseUrl: api.base + '/anthropic' }, { ...mk('dsbroke', 'broke', 'deepseek'), baseUrl: api.base + '/anthropic' },
      fromPreset('claude-sub'), fromPreset('codex-sub'),
    ],
  });
  cfg.orchestrator.codexPath = makeFakeCodex(tmp);
  const h = await checkAll(cfg);
  const L = (id: string) => `${h[id].light} (${h[id].text})`;
  console.log(Object.keys(h).map((k) => `${k}: ${L(k)}`).join('\n'));
  check(h.ok.light === 'green', 'ok green');
  check(h.bad.light === 'red', 'bad key red');
  check(h.poor.light === 'yellow', '402 yellow');
  check(h.low.light === 'yellow', 'low credit yellow');
  check(h.rate.light === 'green', 'plain rate limit still green');
  check(h.nokey.light === 'red' && h.nokey.text === 'нет ключа', 'no key red');
  check(h.ds.light === 'green' && !!h.ds.details?.some((d) => d.includes('12.34 USD')), 'deepseek balance shown');
  check(h.dsbroke.light === 'yellow', 'deepseek with zero balance yellow');
  check(h['claude-sub'].light === 'green' && !!h['claude-sub'].details?.includes('план: pro'), 'claude subscription green with plan');
  check(h['codex-sub'].light === 'green', 'codex logged in green');

  // Isolation: helpers stub codexbar on PATH, so the machine's real CodexBar limits never leak into a checkAll.
  const isolated = await checkAll({ ...cfg, providers: [fromPreset('claude-sub'), fromPreset('codex-sub')] });
  check(isolated['claude-sub'].light === 'green' && !!isolated['claude-sub'].details?.some((d) => d.includes('лимиты: установите CodexBar')), 'claude-sub isolated from the machine CodexBar: ' + isolated['claude-sub'].text);

  process.env.FAKE_LOGGED_OUT = '1';
  const h2 = await checkAll({ ...cfg, providers: [fromPreset('claude-sub'), fromPreset('codex-sub')] });
  delete process.env.FAKE_LOGGED_OUT;
  check(h2['claude-sub'].light === 'red' && h2['codex-sub'].light === 'red', 'logged out → red');
  const h3 = await checkAll({ ...cfg, claudePath: '/nonexistent/claude', providers: [fromPreset('claude-sub')] });
  check(h3['claude-sub'].light === 'red' && h3['claude-sub'].text.includes('не установлен'), 'missing CLI → red: ' + h3['claude-sub'].text);
  check(classifyApi(403, '{"error":{"message":"余额不足"}}').light === 'yellow', 'chinese "insufficient balance" yellow');
  api.close();

  // yellow worker is refused and flagged for the orchestrator
  const repo = makeRepo(tmp);
  const cfg2 = testConfig(cfg.claudePath);
  cfg2.health = { deepseek: { light: 'yellow', text: 'нет денег', checkedAt: 0 } };
  const state: RunState = { runId: 'run-x', source: 'app', repo, baseBranch: 'main', goal: '', status: 'running', tasks: [], transcript: [] };
  const eng = new TaskEngine(cfg2, path.join(tmp, 'wt'), state, () => {});
  let refused = '';
  try { eng.delegate({ provider: 'deepseek', role: 'refactor', title: 'x', spec: 'x' }); } catch (e: any) { refused = e.message; }
  check(refused.includes('unavailable') && refused.includes('glm'), 'yellow worker refused, alternative suggested: ' + refused);
  check(describeWorkers(cfg2).includes('UNAVAILABLE'), 'orchestrator sees UNAVAILABLE');
  console.log('lights OK');
}

async function subscriptionRun(mode: 'claude-sub' | 'codex-sub') {
  const tmp = tmpdir(`orch-${mode}-`);
  const repo = makeRepo(tmp);
  const claude = makeFakeClaude(tmp);
  const cfg = testConfig(claude);
  cfg.orchestrator = { ...cfg.orchestrator, mode, codexPath: makeFakeCodex(tmp) };
  process.env.ANTHROPIC_API_KEY = 'must-not-leak';
  const log: string[] = [];
  const orch = new CliOrchestrator(cfg, path.join(tmp, 'wt'), repo, 'Change hello.txt', (ev) => {
    if (ev.type === 'transcript') log.push(`${ev.entry.kind}: ${ev.entry.text.split('\n')[0]}`);
  });
  await orch.start();
  delete process.env.ANTHROPIC_API_KEY;
  console.log(log.join('\n'));
  check(orch.state.status === 'done', `${mode}: done, got ${orch.state.status} ${orch.state.stopReason ?? ''}`);
  check(orch.state.orchestrator === mode, 'mode recorded');
  check(orch.state.tasks[0]?.status === 'merged', 'task merged through MCP');
  check(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8').includes('deepseek'), 'repo updated');
  check(orch.state.finalReport === 'Итог: слита задача t01.', 'final report from the CLI');
  check(log.some((l) => l.startsWith('tool_call: delegate')) && log.some((l) => l.includes('merged t01')), 'transcript shows MCP calls');
  check((orch.state.orchestratorCostUsd ?? 0) === 0, 'subscription orchestrator costs no dollars');
  if (mode === 'claude-sub') check(orch.state.apiEquivUsd === 1.25 && orch.state.cliSessionId === 'sess-1', 'API equivalent + session kept');
  else check(orch.state.cliSessionId === 'thr-1', 'codex thread kept');
  check(!sh('git', ['status', '--porcelain'], repo).trim(), 'repo clean');
  console.log(`${mode} OK`);
}

async function limitAndPlan() {
  const tmp = tmpdir('orch-limit-');
  const repo = makeRepo(tmp);
  const cfg = testConfig(makeFakeClaude(tmp));
  cfg.orchestrator = { ...cfg.orchestrator, mode: 'claude-sub', codexPath: makeFakeCodex(tmp) };
  process.env.FAKE_LIMIT = '1';
  const orch = new CliOrchestrator(cfg, path.join(tmp, 'wt'), repo, 'x', () => {});
  await orch.start();
  delete process.env.FAKE_LIMIT;
  check(orch.state.status === 'stopped' && !!orch.state.stopReason?.includes('лимит подписки'), 'usage limit → stopped: ' + orch.state.stopReason);

  const p1 = await makePlan(cfg, repo, 'Change hello.txt');
  check(p1.summary === 'план по подписке' && p1.tasks[0].providerId === 'deepseek', 'plan via claude -p');
  const p2 = await makePlan({ ...cfg, orchestrator: { ...cfg.orchestrator, mode: 'codex-sub' } }, repo, 'x');
  check(p2.summary === 'план от codex', 'plan via codex exec');
  console.log('limit + plan OK');
}

function migration() {
  const old: any = {
    anthropic: { apiKey: 'sk-old', model: 'claude-opus-5', maxTokens: 8192 },
    providers: [
      { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', token: 'ds-key', model: 'deepseek-v4-pro', notes: '', enabled: true, roles: ['tests'] },
      { id: 'glm', label: 'GLM', baseUrl: 'https://api.z.ai/api/anthropic', token: '', model: 'glm-5.3', notes: '', enabled: true, roles: [] },
      { id: 'anthropic', label: 'Claude', baseUrl: '', token: '', model: 'claude-sonnet-5', notes: '', enabled: false, roles: [] },
    ],
  };
  const c = normalizeConfig(old);
  const ids = c.providers.map((p) => p.id);
  check(ids.includes('deepseek') && !ids.includes('glm'), 'keyless defaults dropped, keyed kept: ' + ids);
  check(ids.includes('claude-sub') && ids.includes('codex-sub'), 'subscriptions added');
  check(c.providers.find((p) => p.id === 'anthropic')?.token === 'sk-old', 'legacy Anthropic key moved to the Claude API connection');
  check(c.providers.find((p) => p.id === 'deepseek')?.billing === 'api' && c.orchestrator.mode === 'claude-sub', 'billing + default mode');
  check(normalizeConfig(JSON.parse(JSON.stringify(c))).providers.length === c.providers.length, 'idempotent');
  console.log('migration OK');
}

(async () => {
  migration();
  await healthPing();
  await lights();
  await subscriptionRun('claude-sub');
  await subscriptionRun('codex-sub');
  await limitAndPlan();
  console.log('\nSMOKE-SUB OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
