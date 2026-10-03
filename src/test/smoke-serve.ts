/**
 * `orchestra serve` end to end, in-process, with fake claude and a fake provider API:
 *  1. token auth (API 401 without it, cookie from ?token=, web panel served with api-web.js)
 *  2. health lights over the API
 *  3. planner triage: a cheap green worker recommends; heuristic fallback; "settings" mode
 *  4. plan + run with the chosen planner through the API; the model reaches the CLI; SSE carries runId-tagged events
 *  5. MCP over HTTP with ?repo=: the connected agent orchestrates (delegate → wait_for → merge_task), session saved to history
 *  6. MCP autopilot: autopilot_start (ask) → autopilot_approve → run_status until done
 *  7. merge lock: concurrent merges into one repo are serialized and both succeed
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serve } from '../server/serve';
import { fromPreset } from '../main/catalog';
import { triage, heuristicComplexity } from '../main/triage';
import * as git from '../main/git';
import { tmpdir, sh, makeRepo, makeFakeClaude, check, testConfig } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fakeProvider() {
  let triageCalls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/user/balance') return res.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '5.00' }] }));
      const b = body ? JSON.parse(body) : {};
      if (b.max_tokens === 16) return res.end(JSON.stringify({ id: 'x', content: [] }));
      triageCalls++;
      res.end(JSON.stringify({ id: 'y', content: [{ type: 'text', text: '{"complexity":"high","recommended":"claude-sub:opus","reason":"много файлов и миграция"}' }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as any).port}`, close: () => server.close(), calls: () => triageCalls };
}

function repoIn(tmp: string, name: string) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  return makeRepo(dir);
}

(async () => {
  const tmp = tmpdir('orch-serve-');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const argLog = path.join(tmp, 'claude-args.jsonl');
  process.env.FAKE_ARGLOG = argLog;
  const prov = await fakeProvider();
  const cfg = testConfig(makeFakeClaude(tmp), {
    providers: [
      fromPreset('claude-sub', { enabled: false }),
      fromPreset('deepseek', { token: 'k', baseUrl: prov.base + '/anthropic' }),
      fromPreset('glm', { token: 'k', baseUrl: prov.base }),
    ],
  });
  cfg.orchestrator.mode = 'claude-sub';
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));

  const srv = await serve({ home, host: '127.0.0.1', port: 0, token: 'secret', log: () => {} });
  const base = `http://127.0.0.1:${srv.port}`;
  const api = async (method: string, p: string, data?: unknown, auth = true) => {
    const r = await fetch(base + p, {
      method,
      headers: { ...(auth ? { authorization: 'Bearer secret' } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
      body: data ? JSON.stringify(data) : undefined,
      redirect: 'manual',
    });
    const t = await r.text();
    let j: any = t;
    try { j = JSON.parse(t); } catch { /* html */ }
    return { status: r.status, j, headers: r.headers };
  };

  // 1. auth
  check((await api('GET', '/api/config', undefined, false)).status === 401, 'API needs the token');
  const login = await api('GET', '/?token=secret', undefined, false);
  check(login.status === 302 && String(login.headers.get('set-cookie')).includes('orch_token=secret'), 'token link sets a cookie');
  const page = await fetch(base + '/', { headers: { cookie: 'orch_token=secret' } });
  const html = await page.text();
  check(page.status === 200 && html.includes('api-web.js') && html.includes('renderer.js'), 'web panel served');
  check((await fetch(base + '/api-web.js', { headers: { cookie: 'orch_token=secret' } })).status === 200, 'static js served');
  check(html.includes('id="forceProvider"') && html.includes('Все задачи: по плану (авто)'), 'index.html has the forceProvider select');
  check((await api('GET', '/../package.json')).status === 404, 'no path traversal');

  // SSE
  const events: any[] = [];
  const ac = new AbortController();
  (async () => {
    const r = await fetch(base + '/api/events', { headers: { authorization: 'Bearer secret' }, signal: ac.signal });
    const reader = r.body!.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
      }
    }
  })().catch(() => {});

  // 2. health
  const h = (await api('POST', '/api/health', {})).j;
  check(h['claude-sub']?.light === 'green' && h.deepseek?.light === 'green' && h.glm?.light === 'green', 'lights over API: ' + JSON.stringify(Object.fromEntries(Object.entries(h).map(([k, v]: any) => [k, v.light]))));

  // 3. triage
  const t = (await api('POST', '/api/triage', { goal: 'Спроектировать миграцию базы данных и переписать авторизацию' })).j;
  check(t.recommended === 'claude-sub:opus' && t.complexity === 'high' && t.by.includes('DeepSeek') && prov.calls() === 1, 'cheapest green worker recommends: ' + JSON.stringify(t));
  check(t.choices.some((c: any) => c.id === 'claude-sub:sonnet'), 'choices listed');
  check(heuristicComplexity('Исправь опечатку в README') === 'low' && heuristicComplexity('Добавь кнопку экспорта') === 'medium', 'heuristic complexity');
  const noJudge = await triage({ ...cfg, health: { 'claude-sub': { light: 'green', text: '', checkedAt: 0 } } }, 'Исправь опечатку в README');
  check(noJudge.by === 'эвристика' && noJudge.recommended === 'claude-sub:sonnet', 'heuristic fallback picks the cheaper planner: ' + noJudge.recommended);
  const tight = await triage(
    { ...cfg, health: { 'claude-sub': { light: 'green', text: '', checkedAt: 0, quotas: [{ label: 'неделя', usedPercent: 91 }] } } },
    'Спроектировать архитектуру',
  );
  check(tight.recommended === 'api:claude-opus-5', 'nearly used-up subscription → the same model via API: ' + tight.recommended);
  const tightOnly = await triage(
    { ...cfg, anthropic: { ...cfg.anthropic, apiKey: '' }, health: { 'claude-sub': { light: 'green', text: '', checkedAt: 0, quotas: [{ label: 'неделя', usedPercent: 91 }] } } },
    'Спроектировать архитектуру',
  );
  check(tightOnly.recommended === 'claude-sub:opus' && tightOnly.reason.includes('почти исчерпан'), 'no alternative → warns about the limit');

  // 4. plan + run with the chosen planner
  const repo1 = repoIn(tmp, 'r1');
  const plan = (await api('POST', '/api/plan', { repo: repo1, goal: 'Change hello.txt', choice: 'claude-sub:sonnet' })).j;
  check(plan.tasks?.[0]?.providerId === 'deepseek', 'plan through the API: ' + JSON.stringify(plan).slice(0, 200));
  const planArgs = fs.readFileSync(argLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((a: string[]) => a.includes('json'));
  check(planArgs && planArgs[planArgs.indexOf('--model') + 1] === 'sonnet', 'planner model passed to claude: ' + JSON.stringify(planArgs));
  const started = await api('POST', '/api/runs', { repo: repo1, goal: 'Change hello.txt', plan, choice: 'claude-sub:opus' });
  const runId = started.j.runId;
  check(!!runId, 'run started: ' + JSON.stringify(started.j));
  let st: any;
  for (let i = 0; i < 100; i++) {
    st = (await api('GET', `/api/runs/${runId}`)).j;
    if (st && st.status !== 'running' && st.status !== 'idle') break;
    await sleep(200);
  }
  check(st.status === 'done' && st.tasks[0]?.status === 'merged' && st.orchestrator === 'claude-sub', `run done via API: ${st.status} ${st.stopReason ?? ''}`);
  const orchArgs = fs.readFileSync(argLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((a: string[]) => a.includes('--mcp-config'));
  check(orchArgs[orchArgs.indexOf('--model') + 1] === 'opus', 'orchestrator got the chosen model');
  check(events.some((e) => e.runId === runId && e.type === 'task') && events.some((e) => e.type === 'health'), 'SSE events tagged with runId');
  check((await api('POST', '/api/runs', { repo: repo1, goal: 'x', choice: 'nope:x' })).status === 400, 'unknown planner rejected');

  // 5. MCP over HTTP, agent as orchestrator
  const repo2 = repoIn(tmp, 'r2');
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp?repo=${encodeURIComponent(repo2)}`), { requestInit: { headers: { authorization: 'Bearer secret' } } }),
  );
  const names = (await client.listTools()).tools.map((x) => x.name);
  check(['delegate', 'wait_for', 'merge_task', 'autopilot_start', 'run_status', 'end_session'].every((n) => names.includes(n)), 'tools: ' + names);
  const call = async (name: string, args: any = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c: any) => c.text).join('\n'), isError: !!r.isError };
  };
  check((await call('delegate', { provider: 'deepseek', role: 'docs', title: 'Edit hello', spec: 'x' })).text.includes('started t01'), 'delegate over HTTP MCP');
  check((await call('wait_for', { timeout_sec: 60 })).text.includes('status=done'), 'wait_for');
  check((await call('merge_task', { task_id: 't01' })).text.startsWith('merged'), 'merged');
  check(events.some((e) => e.type === 'state' && e.state?.source === 'mcp'), 'panel sees the MCP session');
  check((await call('end_session')).text.includes('closed'), 'session closed');
  const list = (await api('GET', '/api/runs')).j;
  check(list.some((r: any) => r.source === 'mcp' && r.merged === 1 && r.status === 'done'), 'MCP session in history');

  // 6. autopilot
  const repo3 = repoIn(tmp, 'r3');
  const ap = await call('autopilot_start', { goal: 'Change hello.txt', repo: repo3, approve: 'ask' });
  const pending = /pending_id: (\S+)/.exec(ap.text)?.[1];
  check(!!pending && ap.text.includes('claude-sub:opus'), 'autopilot asks with a recommendation: ' + ap.text.slice(0, 200));
  const ok = await call('autopilot_approve', { pending_id: pending, planner: 'claude-sub:sonnet' });
  const apRun = /started run (\S+)\./.exec(ok.text)?.[1];
  check(!!apRun, 'approved and started: ' + ok.text);
  let rep = '';
  for (let i = 0; i < 100; i++) {
    rep = (await call('run_status', { run_id: apRun })).text;
    if (!/: (running|idle)/.test(rep.split("\n")[0])) break;
    await sleep(200);
  }
  check(rep.startsWith(`run ${apRun}: done`) && rep.includes('merged'), 'autopilot run finished: ' + rep.split('\n')[0]);
  await client.close();

  // 7. merge lock
  const repo4 = repoIn(tmp, 'r4');
  for (const [b, f] of [['a', 'a.txt'], ['b', 'b.txt']]) {
    const wt = path.join(tmp, 'wt4', b);
    await git.createWorktree(repo4, wt, b);
    fs.writeFileSync(path.join(wt, f), b);
    await git.commitAll(wt, b);
  }
  const order: string[] = [];
  const m = (b: string) => git.withRepoLock(repo4, async () => { order.push(`${b}+`); const r = await git.mergeBranch(repo4, b, `m ${b}`); order.push(`${b}-`); return r; });
  const [ra, rb] = await Promise.all([m('a'), m('b')]);
  check(ra.ok && rb.ok && order.join(',') === 'a+,a-,b+,b-', 'merges serialized: ' + order.join(','));
  check(!fs.existsSync(path.join(repo4, '.git', 'orchestra-merge.lock')), 'lock released');

  // 8. forceProvider: settings round-trip + live switch into an already-open MCP session
  const repo5 = repoIn(tmp, 'r5');
  const fc = new Client({ name: 'smoke', version: '0' });
  await fc.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp?repo=${encodeURIComponent(repo5)}`), { requestInit: { headers: { authorization: 'Bearer secret' } } }),
  );
  const fcall = async (name: string, args: any = {}) => {
    const r: any = await fc.callTool({ name, arguments: args });
    return { text: r.content.map((c: any) => c.text).join('\n'), isError: !!r.isError };
  };
  await fcall('list_workers'); // opens the MCP session
  const forcedCfg = { ...(await api('GET', '/api/config')).j, forceProvider: 'glm' };
  check((await api('PUT', '/api/config', forcedCfg)).status === 200, 'PUT config with forceProvider');
  check((await api('GET', '/api/config')).j.forceProvider === 'glm', 'forceProvider survives the settings round-trip');
  const fd = await fcall('delegate', { provider: 'deepseek', role: 'docs', title: 'Edit hello', spec: 'x' });
  check(!fd.isError && fd.text.includes('on glm (glm-5.3)'), 'delegate in an already-open session goes to the forced provider: ' + fd.text);
  await fc.close();

  ac.abort();
  await srv.close();
  prov.close();
  console.log(`\nSMOKE-SERVE OK ${tmp}`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
