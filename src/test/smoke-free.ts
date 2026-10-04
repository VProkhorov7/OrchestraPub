/**
 * «Free only» mode: which workers count as free (local, free tier, OpenRouter's free models from its own list,
 * already paid subscriptions), that paid ones are never used (delegate, retries, stand-ins, the orchestrator by API
 * key), and that the orchestrator is told. Run: as a step of `npm run smoke`.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { forgetFreeModels, freeOnlyReason, isFreeProvider, refreshFreeModels } from '../main/freetier';
import { describeWorkers } from '../main/planner';
import { plannerChoices } from '../main/triage';
import { workerCost } from '../main/pricing';
import { TaskEngine } from '../main/engine';
import { Hub } from '../main/hub';
import { fromPreset } from '../main/catalog';
import { AppConfig, ProviderConfig, RunState } from '../main/types';
import { makeFakeClaude, makeRepo, testConfig, tmpdir, check } from './helpers';

const prov = (over: Partial<ProviderConfig>): ProviderConfig => ({ id: 'x', kind: 'api', billing: 'api', label: 'X', baseUrl: 'https://api.example.com', token: 'k', model: 'm', notes: '', enabled: true, roles: [], ...over });

(async () => {
  const tmp = tmpdir('orch-free-');

  // ---- OpenRouter's own list is the source of truth for «free»
  const list = {
    data: [
      { id: 'qwen/qwen3.8-27b:free', name: 'Qwen 27B', context_length: 262144, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
      { id: 'inclusionai/ling-3.1-flash', name: 'Ling', context_length: 262144, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
      { id: 'openrouter/free', name: 'Free Models Router', context_length: 200000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
      { id: 'no/tools:free', name: 'No tools', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: [] },
      { id: 'deepseek/deepseek-v4-pro', name: 'DS', context_length: 128000, pricing: { prompt: '0.0000013', completion: '0.000004' }, supported_parameters: ['tools'] },
    ],
  };
  const srv = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(list)); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  process.env.ORCHESTRA_OPENROUTER_MODELS_URL = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/models`;
  forgetFreeModels();
  const fm = await refreshFreeModels(true);
  check(fm.length === 4 && fm.every((m) => !/deepseek/.test(m.id)), `only models priced at 0 are free: ${fm.map((m) => m.id).join(', ')}`);
  check(fm[fm.length - 1].id === 'no/tools:free', 'models without tool support go last (Claude Code needs tools)');

  // ---- what counts as free
  const or = (model: string) => prov({ id: 'or', baseUrl: 'https://openrouter.ai/api', model });
  check(isFreeProvider(or('qwen/qwen3.8-27b:free')) && isFreeProvider(or('inclusionai/ling-3.1-flash')) && isFreeProvider(or('openrouter/free')), 'OpenRouter free models, also those without the :free suffix');
  check(!isFreeProvider(or('deepseek/deepseek-v4-pro')), 'a paid OpenRouter model is not free');
  forgetFreeModels();
  check(isFreeProvider(or('x/y:free')) && !isFreeProvider(or('inclusionai/ling-3.1-flash')), 'offline, only the :free suffix is trusted');
  check(isFreeProvider(prov({ kind: 'claude-sub', baseUrl: '' })) && isFreeProvider(prov({ billing: 'plan' })), 'subscriptions and flat plans cost nothing more per task');
  check(isFreeProvider(prov({ local: 'ollama' })) && isFreeProvider(prov({ freeTier: true })) && isFreeProvider(prov({ priceIn: 0, priceOut: 0 })), 'local, a marked free tier, an explicit price of 0');
  check(!isFreeProvider(prov({})) && !isFreeProvider(prov({ priceIn: 0 })), 'a pay-per-token worker without prices (or with only one) is not free');
  check(workerCost(prov({ freeTier: true, priceIn: 5, priceOut: 9 }), { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }).usd === 0, 'a marked free tier costs 0');
  check(freeOnlyReason({ freeOnly: false }, prov({})) === null && /free-only mode/.test(freeOnlyReason({ freeOnly: true, language: 'en' }, prov({}))!), 'the reason is given only while the mode is on');
  const preset = fromPreset('openrouter-free', { token: 'k' });
  check(preset.model === 'openrouter/free' && preset.freeTier === true && preset.priceOut === 0 && preset.maxConcurrent === 1, 'the «OpenRouter · free models» preset');

  // ---- the engine never uses a paid worker
  const claudePath = makeFakeClaude(tmp);
  const c = testConfig(claudePath, { freeOnly: true, language: 'en', autoRetry: 3 });
  c.providers.push(prov({ id: 'loc', local: 'ollama', baseUrl: 'http://127.0.0.1:1', roles: ['refactor'], priceIn: 0, priceOut: 0 }));
  fs.mkdirSync(path.join(tmp, 'e'), { recursive: true });
  const repo = makeRepo(path.join(tmp, 'e'));
  const state: RunState = { runId: 'mcp-free', source: 'mcp', repo, baseBranch: 'main', goal: 'g', status: 'running', tasks: [], transcript: [], budgetUsd: 0, startedAt: Date.now(), pid: process.pid };
  const e = new TaskEngine(c, path.join(tmp, 'wt'), state, () => {});
  let err = '';
  try { e.delegate({ provider: 'deepseek', role: 'refactor', title: 'x', spec: 'x' }); } catch (x: any) { err = x.message; }
  check(/free-only mode/.test(err) && /Free workers available: loc/.test(err) && e.state.tasks.length === 0, `delegating to a paid worker is refused and the free ones are named: ${err.slice(0, 90)}`);
  check(e.providersFor('refactor').map((p) => p.id).join() === 'loc', 'only the free worker can take the role');
  const task: any = { id: 't01', title: 'x', role: 'refactor', providerId: 'loc', jobId: 't01' };
  check((e as any).retryProvider(task)?.id === 'loc', 'a retry never picks a paid worker');
  check(/UNAVAILABLE \(free-only mode/.test(describeWorkers(c).split('\n').find((l) => l.includes('id="deepseek"'))!), 'the orchestrator is told that paid workers are unavailable');
  check(plannerChoices({ ...c, anthropic: { ...c.anthropic, apiKey: 'k' } } as AppConfig).every((x) => x.mode !== 'api'), 'the API-key orchestrator is not offered');
  c.freeOnly = false;
  check(e.providersFor('refactor').length > 1, 'with the mode off the paid workers are back');

  // ---- starting a run
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const write = (over: object) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ ...c, freeOnly: true, ...over }));
  const hub = new Hub(home, () => {});
  write({ orchestrator: { mode: 'api', claudeModel: '', codexModel: '', codexPath: 'codex' }, anthropic: { apiKey: 'k', model: 'claude-opus-5', maxTokens: 1000 } });
  let e1 = '';
  await hub.readyConfig().catch((x) => (e1 = x.message));
  check(/только бесплатное/.test(e1) && /API-ключу/.test(e1), `an orchestrator by API key is refused: ${e1.slice(0, 60)}`);
  // Codex orchestrates only; the one worker left is paid
  write({ providers: [prov({ id: 'codex-sub', kind: 'codex-sub', baseUrl: '' }), prov({ id: 'deepseek' })], orchestrator: { mode: 'codex-sub', claudeModel: '', codexModel: '', codexPath: 'codex' } });
  (hub as any).health = { 'codex-sub': { light: 'green', text: '', checkedAt: 0 }, deepseek: { light: 'green', text: '', checkedAt: 0 } };
  let e2 = '';
  await hub.readyConfig().catch((x) => (e2 = x.message));
  check(/нет ни одного бесплатного исполнителя/.test(e2), `no free worker: a clear message: ${e2.slice(0, 60)}`);

  srv.close();
  delete process.env.ORCHESTRA_OPENROUTER_MODELS_URL;
  console.log('SMOKE-FREE OK');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
