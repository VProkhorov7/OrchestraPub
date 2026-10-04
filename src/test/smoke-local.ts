/**
 * Local models (Ollama, LM Studio, any Anthropic-compatible server): the catalog entries, the health check of the
 * server, the model and the context length (against fake servers), one task at a time for a local worker, local
 * workers as the last resort for retries, and the placeholder key. Run: as a step of `npm run smoke`.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { PRESETS } from '../main/catalog';
import { checkOne } from '../main/health';
import { forgetLoadedContext, localKind, prepareOllamaContext } from '../main/localmodels';
import { workerEnv } from '../main/worker';
import { TaskEngine } from '../main/engine';
import { AppConfig, ProviderConfig, RunState } from '../main/types';
import { makeFakeClaude, makeRepo, testConfig, tmpdir, check } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const serve = (handler: (req: http.IncomingMessage, body: string) => { status?: number; json: unknown }) =>
  new Promise<{ url: string; close: () => void; hits: string[] }>((resolve) => {
    const hits: string[] = [];
    const s = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        hits.push(`${req.method} ${req.url}`);
        const r = handler(req, b);
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close(), hits }));
  });

const local = (over: Partial<ProviderConfig>): ProviderConfig => ({
  id: 'loc', kind: 'api', billing: 'api', label: 'Local', baseUrl: '', token: '', model: 'qwen3-coder', notes: '', enabled: true, roles: [], priceIn: 0, priceOut: 0, priceCacheRead: 0, ...over,
});

(async () => {
  const tmp = tmpdir('orch-local-');

  // ---- catalog
  const ids = ['ollama', 'lmstudio', 'local-other'];
  const presets = ids.map((i) => PRESETS.find((p) => p.id === i)!);
  check(presets.every((p) => p && p.group === 'Локальные модели' && p.canWork && !p.canOrchestrate), 'three local presets, workers only');
  check(presets.every((p) => p.template.priceIn === 0 && p.template.priceOut === 0 && p.template.maxConcurrent === 1 && (p.template.timeoutMin ?? 0) >= 30), 'free, one task at a time, a longer timeout');
  check(presets[0].template.baseUrl === 'http://127.0.0.1:11434' && presets[1].template.baseUrl === 'http://127.0.0.1:1234', 'default addresses of Ollama and LM Studio');
  check(localKind({ preset: 'ollama' }) === 'ollama' && localKind({ local: 'lmstudio' }) === 'lmstudio' && localKind({ preset: 'deepseek' }) === null, 'kind detection');
  check(workerEnv(local({ local: 'ollama', baseUrl: 'http://127.0.0.1:11434' }), testConfig('claude')).ANTHROPIC_AUTH_TOKEN === 'local', 'a local worker gets a placeholder key (Claude Code needs one)');

  // ---- Ollama health: nothing listening
  const cfg = testConfig('claude');
  let h = await checkOne(local({ local: 'ollama', baseUrl: 'http://127.0.0.1:1' }), cfg);
  check(h.light === 'red' && /Ollama не отвечает/.test(h.text), `Ollama not running: ${h.text}`);

  // ---- Ollama health: model missing, context too small, context fine
  let numCtx = '';
  let serverDefaultCtx = 4096;
  let loaded: any[] = [];
  const ollama = await serve((req, body) => {
    if (req.url === '/api/tags') return { json: { models: [{ name: 'llama3.2:3b' }, { name: 'qwen3-coder:latest' }] } };
    if (req.url === '/api/show') return { json: { parameters: numCtx ? `num_ctx ${numCtx}` : '' } };
    if (req.url === '/api/ps') return { json: { models: loaded } };
    if (req.url === '/api/generate') {
      const b = JSON.parse(body);
      loaded = b.keep_alive === 0 ? [] : [{ name: b.model, context_length: serverDefaultCtx }];
      return { json: { done: true } };
    }
    return { status: 404, json: {} };
  });
  const op = (model: string) => local({ local: 'ollama', baseUrl: ollama.url, model });
  h = await checkOne(op('nothing'), cfg);
  check(h.light === 'red' && /ollama pull nothing/.test(h.text) && /llama3\.2:3b/.test(h.text), `a missing model names the fix and what is installed: ${h.text.slice(0, 80)}`);
  h = await checkOne(op('qwen3-coder'), cfg);
  check(h.light === 'yellow' && /4 096/.test(h.text) && /Контекст 32K/.test(h.text), `a 4 096 context is yellow with the fix: ${h.text.slice(0, 90)}`);
  check(loaded.length === 0, 'the model was only loaded for a moment to read the context, then unloaded');
  forgetLoadedContext();
  numCtx = '32768';
  h = await checkOne(op('qwen3-coder'), cfg);
  check(h.light === 'green' && (h.details ?? []).some((d) => /32 768/.test(d)), `num_ctx 32768 in the model: green: ${h.text}`);
  numCtx = '';
  forgetLoadedContext();
  serverDefaultCtx = 65536;
  h = await checkOne(op('qwen3-coder'), cfg);
  check(h.light === 'green', 'a server whose default context is large is green');
  ollama.close();

  // ---- LM Studio
  let models: any[] = [{ id: 'openai/gpt-oss-20b', state: 'loaded', loaded_context_length: 4096 }];
  const lm = await serve((req) => (req.url === '/api/v0/models' ? { json: { data: models } } : { status: 404, json: {} }));
  const lp = (model: string) => local({ local: 'lmstudio', baseUrl: lm.url, model });
  h = await checkOne(lp('openai/gpt-oss-20b'), cfg);
  check(h.light === 'yellow' && /4 096/.test(h.text), `LM Studio with a small loaded context: yellow: ${h.text.slice(0, 70)}`);
  models = [{ id: 'openai/gpt-oss-20b', state: 'loaded', loaded_context_length: 40000 }];
  check((await checkOne(lp('openai/gpt-oss-20b'), cfg)).light === 'green', 'a large loaded context is green');
  models = [{ id: 'openai/gpt-oss-20b', state: 'not-loaded' }];
  h = await checkOne(lp('openai/gpt-oss-20b'), cfg);
  check(h.light === 'green' && (h.details ?? []).some((d) => /не загружена/.test(d)), 'a model that is not loaded yet is green with a reminder about the context');
  check((await checkOne(lp('other/model'), cfg)).light === 'red', 'LM Studio without that model: red');
  lm.close();

  // ---- any other server
  const oth = await serve((req) => (req.url === '/v1/models' ? { json: { data: [{ id: 'my-model' }] } } : { status: 404, json: {} }));
  check((await checkOne(local({ local: 'other', baseUrl: oth.url, model: 'my-model' }), cfg)).light === 'green', 'another server with /v1/models: green');
  check((await checkOne(local({ local: 'other', baseUrl: oth.url, model: 'zzz' }), cfg)).light === 'red', 'and red for a model it does not have');
  oth.close();

  // ---- the context fix works only for Ollama on this machine
  let refused = '';
  await prepareOllamaContext(local({ local: 'ollama', baseUrl: 'http://192.168.1.50:11434', model: 'x' })).catch((e) => (refused = e.message));
  check(/на этом же компьютере/.test(refused), 'preparing a model on another machine is refused with an explanation');
  refused = '';
  await prepareOllamaContext(local({ local: 'lmstudio', baseUrl: 'http://127.0.0.1:1234', model: 'x' })).catch((e) => (refused = e.message));
  check(/только для Ollama/.test(refused), 'and it is Ollama only');

  // ---- engine: one task at a time, and a local model is the last resort for retries
  const claudePath = makeFakeClaude(tmp);
  const engineFor = (c: AppConfig, label: string): TaskEngine => {
    fs.mkdirSync(path.join(tmp, label), { recursive: true });
    const repo = makeRepo(path.join(tmp, label));
    const state: RunState = { runId: `mcp-${label}`, source: 'mcp', repo, baseBranch: 'main', goal: label, status: 'running', tasks: [], transcript: [], budgetUsd: 0, startedAt: Date.now(), pid: process.pid };
    return new TaskEngine(c, path.join(tmp, 'wt'), state, () => {});
  };
  process.env.FAKE_SLOW_MS = '1500';
  const c1 = testConfig(claudePath, { maxParallel: 4, autoRetry: 0 });
  c1.providers.push(local({ id: 'loc', local: 'other', baseUrl: 'http://127.0.0.1:1', maxConcurrent: 1, roles: ['refactor'] }));
  const e1 = engineFor(c1, 'conc');
  e1.delegate({ provider: 'loc', role: 'refactor', title: 'one', spec: 'Change hello.txt' });
  e1.delegate({ provider: 'loc', role: 'refactor', title: 'two', spec: 'Change hello.txt' });
  let most = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000 && !e1.state.tasks.every((t) => ['done', 'failed', 'merged'].includes(t.status))) {
    most = Math.max(most, e1.state.tasks.filter((t) => t.status === 'running').length);
    await sleep(50);
  }
  check(most === 1 && e1.state.tasks.every((t) => t.status === 'done'), `a local worker takes one task at a time and both finish: most at once = ${most}`);
  delete process.env.FAKE_SLOW_MS;

  const c2 = testConfig(claudePath, { autoRetry: 3 });
  c2.providers.push(local({ id: 'loc', local: 'other', baseUrl: 'http://127.0.0.1:1', maxConcurrent: 1, roles: ['refactor'] }));
  const e2 = engineFor(c2, 'order');
  const fake: any = { id: 't01', title: 'x', role: 'refactor', providerId: 'deepseek', jobId: 't01' };
  e2.state.tasks.push(fake);
  check((e2 as any).retryProvider(fake)?.id === 'glm', `a retry goes to a cloud worker first, not to the free local one: ${(e2 as any).retryProvider(fake)?.id}`);
  c2.providers.find((p) => p.id === 'glm')!.enabled = false;
  check((e2 as any).retryProvider(fake)?.id === 'loc', 'and to the local one when nothing else is left');

  console.log('SMOKE-LOCAL OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
