#!/usr/bin/env node
/**
 * `orchestra serve`: Orchestra as an always-on service.
 *
 *  - web panel (the same UI as the desktop app) at  http://<host>:<port>/?token=<token>
 *  - MCP over Streamable HTTP at                    http://<host>:<port>/mcp?repo=<absolute repo path>
 *      with ?repo=: the connected agent is the orchestrator (list_workers, delegate, wait_for, …)
 *      always:      autopilot tools (autopilot_start → approve → run_status) where Orchestra plans and orchestrates
 *  - JSON API + server-sent events under /api
 *
 * One process owns all runs, so budgets, the worker limit and merges into a repo are shared by every client.
 * Options: --host 127.0.0.1 (use your Tailscale address to reach it from other machines), --port 7777,
 *          --install-launchd (macOS: start at login and keep running), --print-token.
 * Env: ORCHESTRA_HOME for another data folder.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { timingSafeEqual } from 'crypto';
import { loadToken, writePlist } from '../main/service';
import { Doctor, discoverProjects } from '../main/doctor';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Hub, HubEvent } from '../main/hub';
import { orchestraHome, fixPath } from '../main/paths';
import { registerOrchestraTools, registerMemoryTools, ORCHESTRA_INSTRUCTIONS } from '../mcp/tools';

const VERSION = '0.7.5';
const RENDERER = path.join(__dirname, '..', '..', 'renderer');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

export interface ServeOptions {
  home?: string;
  host?: string;
  port?: number;
  token?: string;
  log?: (s: string) => void;
}

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function body(req: http.IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 5_000_000) throw new Error('слишком большой запрос');
  }
  return raw ? JSON.parse(raw) : {};
}

function json(res: http.ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data ?? null));
}

/** MCP tools where Orchestra itself plans and orchestrates (for any client, including weak ones and phones). */
function registerAutopilot(server: McpServer, hub: Hub, defaultRepo?: string) {
  const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
  const guard = (fn: (a: any) => Promise<string> | string) => async (a: any) => {
    try {
      return text(await fn(a));
    } catch (e: any) {
      return { ...text(`ERROR: ${e?.message ?? e}`), isError: true };
    }
  };
  const tool = (name: string, config: { description: string; inputSchema: Record<string, unknown> }, handler: (a: any) => Promise<unknown>) =>
    (server.registerTool as any).call(server, name, config, handler);
  const repoOf = (r?: string) => {
    const repo = r || defaultRepo;
    if (!repo) throw new Error('укажите repo (абсолютный путь к репозиторию на машине с Orchestra)');
    return repo;
  };
  const describe = (t: Awaited<ReturnType<Hub['triage']>>) =>
    `Complexity: ${t.complexity}. Recommended planner/orchestrator: ${t.recommended} — ${t.reason} (by ${t.by}).\nChoices:\n` +
    t.choices.map((c) => `- ${c.id}: ${c.label} — ${c.hint} [${c.light}]`).join('\n');

  tool(
    'autopilot_start',
    {
      description:
        'Hand a whole task to Orchestra: it recommends which model should plan and orchestrate, makes a plan and runs the workers. With approve="ask" (default from the user\'s settings) it returns a pending_id and the recommendation; show it to the user and call autopilot_approve. With approve="auto" or an explicit planner it starts at once. Returns quickly; follow with run_status.',
      inputSchema: {
        goal: z.string().describe('the task, as the user would describe it'),
        repo: z.string().optional().describe('absolute path of the git repository on the Orchestra machine'),
        planner: z.string().optional().describe('planner choice id, e.g. "claude-sub:opus"; omit to use the recommendation'),
        approve: z.enum(['ask', 'auto']).optional(),
        when: z.enum(['now', 'offpeak']).optional().describe('offpeak: start at the next cheap window of the time-of-day providers (DeepSeek is half price off-peak); workers of those providers never start in peak hours. Use when the owner asks to run «в льготное время» / cheaply / tonight.'),
      },
    },
    guard(async (a) => {
      const r = await hub.autopilot(repoOf(a.repo), a.goal, { planner: a.planner, approve: a.approve, when: a.when });
      if ((r as any).scheduled) return `scheduled ${(r as any).scheduled.id}: starts at ${(r as any).scheduled.at} (cheap window until ${(r as any).scheduled.windowEnd}).\n${describe(r.triage)}`;
      if (r.runId) return `started run ${r.runId}\n${describe(r.triage)}\nPoll run_status("${r.runId}").`;
      return `pending_id: ${r.pendingId}\n${describe(r.triage)}\nAsk the user to approve or pick another choice, then call autopilot_approve.`;
    }),
  );

  tool(
    'autopilot_approve',
    { description: 'Approve the recommended planner (or pass another choice id) for a pending task: Orchestra plans with it and starts the run.', inputSchema: { pending_id: z.string(), planner: z.string().optional() } },
    guard(async (a) => {
      const r = await hub.approveEx(a.pending_id, a.planner);
      if (r.scheduled) return `scheduled ${r.scheduled.id}: starts at ${r.scheduled.at} (off-peak window until ${r.scheduled.windowEnd}).`;
      return `started run ${r.runId}. Poll run_status("${r.runId}").`;
    }),
  );

  tool(
    'tariff_status',
    { description: 'Is it cheap now for the time-of-day providers (DeepSeek), until when, and the next cheap window of 3+ hours. Times are UTC ISO.', inputSchema: {} },
    guard(async () => JSON.stringify(hub.tariff(), null, 1)),
  );

  tool('run_status', { description: 'Status, tasks, spend and (when finished) the final report of a run.', inputSchema: { run_id: z.string() } }, guard((a) => hub.runReport(a.run_id)));

  tool(
    'list_runs',
    { description: 'Recent runs with status.', inputSchema: { limit: z.number().int().min(1).max(50).optional() } },
    guard((a) =>
      hub
        .listRuns()
        .slice(0, a.limit ?? 10)
        .map((r) => `${r.runId} [${r.source}] ${r.status} · ${r.repo} · ${r.merged}/${r.tasks} merged · $${r.costUsd.toFixed(2)} · ${r.goal.split('\n')[0].slice(0, 80)}`)
        .join('\n') || 'no runs',
    ),
  );

  tool('cancel_run', { description: 'Stop a run started by autopilot or the panel.', inputSchema: { run_id: z.string() } }, guard((a) => (hub.cancel(a.run_id) ? `cancelling ${a.run_id}` : `run ${a.run_id} is not active`)));
}

export async function serve(opts: ServeOptions = {}) {
  fixPath();
  const home = opts.home ?? orchestraHome();
  const log = opts.log ?? ((s: string) => console.log(`[orchestra] ${s}`));
  const clients = new Set<http.ServerResponse>();
  const hub = new Hub(home, (ev: HubEvent) => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) c.write(line);
  });
  hub.init();
  const cfg = hub.config();
  const host = opts.host ?? cfg.serve.host;
  const port = opts.port ?? cfg.serve.port;
  const token = opts.token ?? loadToken(home);
  const doctor = new Doctor({ home, config: () => hub.config(), saveConfig: (c) => hub.saveConfig(c), health: () => hub.health, insideService: true, endpoint: { host, port }, token });

  const authorized = (req: http.IncomingMessage, url: URL) => {
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const cookie = /(?:^|;\s*)orch_token=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1] ?? '';
    const q = url.searchParams.get('token') ?? '';
    return [bearer, decodeURIComponent(cookie), q].some((t) => t && same(t, token));
  };

  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref();

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const repo = url.searchParams.get('repo') ?? undefined;
    const payload = await body(req);
    const server = new McpServer(
      { name: 'orchestra', version: VERSION },
      {
        instructions: repo
          ? ORCHESTRA_INSTRUCTIONS(repo) + '\nFor a whole task you prefer not to orchestrate yourself, autopilot_start hands it to Orchestra.'
          : 'Orchestra: hand whole coding tasks to autopilot_start (repo = absolute path on the Orchestra machine), then run_status. Add ?repo=<path> to the server URL to orchestrate the workers yourself.',
      },
    );
    if (repo) {
      registerOrchestraTools(server, { engine: () => hub.mcpSession(repo), repo, waitSec: 240 });
      registerMemoryTools(server, repo, 'mcp-agent', () => ({ ...hub.config(), health: hub.health }));
    }
    registerAutopilot(server, hub, repo);
    if (repo)
      (server.registerTool as any).call(
        server,
        'end_session',
        { description: 'Close this repository session (it also closes itself after 2 hours without calls). Unfinished tasks are stopped.', inputSchema: {} },
        async () => ({ content: [{ type: 'text', text: hub.endMcpSession(repo) }] }),
      );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req as any, res, payload);
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const p = url.pathname.replace(/\/+$/, '');
    const m = req.method ?? 'GET';
    const seg = p.split('/').slice(2); // after /api
    if (seg[0] === 'scheduled' && seg[1]) {
      if (m === 'DELETE') {
        hub.unschedule(seg[1]);
        return json(res, 200, true);
      }
      if (m === 'POST' && seg[2] === 'now') return json(res, 200, { runId: await hub.startScheduledNow(seg[1]) });
    }
    const route = `${m} /${seg.map((s, i) => (seg[i - 1] === 'runs' && s !== 'current' ? ':id' : seg[i - 1] === 'tasks' ? ':tid' : s)).join('/')}`;
    const runId = seg[1];
    const taskId = seg[3];
    switch (route) {
      case 'GET /events': {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'health', health: hub.health })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      case 'GET /info':
        return json(res, 200, { version: VERSION, host, port, mcp: `http://${host}:${port}/mcp`, home });
      case 'GET /config':
        return json(res, 200, hub.config());
      case 'PUT /config':
        hub.saveConfig(await body(req));
        return json(res, 200, true);
      case 'GET /catalog':
        return json(res, 200, hub.catalog());
      case 'GET /roles':
        return json(res, 200, hub.roles());
      case 'GET /env':
        return json(res, 200, await hub.envCheck());
      case 'GET /health':
        return json(res, 200, hub.health);
      case 'POST /health': {
        const b = await body(req);
        await hub.refreshHealth(b.id);
        return json(res, 200, hub.health);
      }
      case 'GET /repos': {
        const repos = [...new Set(hub.listRuns().map((r) => r.repo))];
        return json(res, 200, repos);
      }
      case 'POST /triage':
        return json(res, 200, await hub.triage((await body(req)).goal ?? ''));
      case 'POST /plan': {
        const b = await body(req);
        return json(res, 200, await hub.makePlan(b.repo, b.goal, b.choice));
      }
      case 'GET /memory':
        return json(res, 200, hub.memoryStatus(url.searchParams.get('repo') ?? ''));
      case 'POST /memory/init': {
        const b = await body(req);
        return json(res, 200, hub.memoryInit(b.repo, b.project));
      }
      case 'POST /memory/digest':
        return json(res, 200, await hub.memoryDigest((await body(req)).repo));
      case 'POST /memory/changelog': {
        const b = await body(req);
        return json(res, 200, await hub.memoryChangelog(b.repo, b.release));
      }
      case 'GET /doctor':
        return json(res, 200, await doctor.report());
      case 'POST /doctor/plan':
        return json(res, 200, await doctor.plan((await body(req)).mode));
      case 'POST /doctor/apply': {
        const r = await doctor.apply((await body(req)).mode);
        json(res, 200, r);
        return doctor.afterResponse();
      }
      case 'POST /doctor/undo': {
        const r = await doctor.undo();
        json(res, 200, r);
        return doctor.afterResponse();
      }
      case 'POST /doctor/projects': {
        const b = await body(req);
        doctor.setProjects(b.projects ?? [], b.roots);
        return json(res, 200, await doctor.report());
      }
      case 'POST /doctor/discover':
        return json(res, 200, discoverProjects((await body(req)).roots ?? []));
      case 'GET /tariff':
        return json(res, 200, hub.tariff());
      case 'GET /scheduled':
        return json(res, 200, hub.scheduled());
      case 'POST /schedule': {
        const b = await body(req);
        return json(res, 200, await hub.schedule(b.repo, b.goal, b.plan, b.choice));
      }
      case 'GET /runs':
        return json(res, 200, hub.listRuns());
      case 'POST /runs': {
        const b = await body(req);
        return json(res, 200, { runId: await hub.start(b.repo, b.goal, b.plan, b.choice) });
      }
      case 'GET /runs/current':
        return json(res, 200, hub.state());
      case 'GET /runs/:id':
        return json(res, 200, hub.state(runId));
      case 'DELETE /runs/:id':
        hub.deleteRun(runId);
        return json(res, 200, true);
      case 'POST /runs/:id/resume':
        return json(res, 200, { runId: await hub.resume(runId) });
      case 'POST /runs/:id/cancel':
        return json(res, 200, hub.cancel(runId));
      case 'POST /runs/:id/tasks/:tid/merge':
        return json(res, 200, await hub.merge(runId, taskId));
      case 'POST /runs/:id/tasks/:tid/discard':
        return json(res, 200, await hub.discard(runId, taskId));
      case 'GET /runs/:id/tasks/:tid/worktree':
        return json(res, 200, hub.worktreeOf(runId, taskId) ?? null);
      default:
        return json(res, 404, { error: `нет такого адреса: ${route}` });
    }
  }

  function handleStatic(res: http.ServerResponse, url: URL) {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.resolve(RENDERER, rel);
    if (!file.startsWith(RENDERER + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (!authorized(req, url)) {
        if (url.pathname === '/' || url.pathname.endsWith('.html')) {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<meta charset="utf-8"><p style="font:16px sans-serif;margin:40px">Orchestra: откройте ссылку с токеном (<code>orchestra-serve --print-token</code>).</p>');
        } else json(res, 401, { error: 'нужен токен' });
        return;
      }
      // First visit with ?token=: remember it in a cookie and drop it from the address bar.
      if (url.searchParams.get('token') && req.method === 'GET' && !url.pathname.startsWith('/mcp') && !url.pathname.startsWith('/api')) {
        res.writeHead(302, { 'set-cookie': `orch_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, location: url.pathname });
        res.end();
        return;
      }
      if (url.pathname === '/mcp') return await handleMcp(req, res, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return handleStatic(res, url);
    } catch (e: any) {
      if (!res.headersSent) json(res, 400, { error: e?.message ?? String(e) });
      else res.end();
    }
  });
  srv.requestTimeout = 0; // wait_for and SSE are long by design
  srv.headersTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, host, () => resolve());
  });
  const actualPort = (srv.address() as any).port;
  log(`веб-панель: http://${host}:${actualPort}/?token=${token}`);
  log(`MCP:        http://${host}:${actualPort}/mcp?repo=<путь к репозиторию>  (заголовок Authorization: Bearer <токен>)`);
  if (host === '127.0.0.1' || host === 'localhost') log('доступ только с этой машины; для других машин запустите с --host <адрес Tailscale>');

  return {
    hub,
    port: actualPort,
    token,
    close: async () => {
      clearInterval(heartbeat);
      for (const c of clients) c.end();
      hub.stop();
      await new Promise<void>((r) => srv.close(() => r()));
    },
  };
}

// ---------- launchd (macOS) ----------

function installLaunchd(host: string, port: number) {
  const plist = writePlist(host, port);
  console.log(`Записал ${plist}\nЗапуск сейчас и при каждом входе:\n  launchctl unload "${plist}" 2>/dev/null; launchctl load -w "${plist}"\nЛог: ${path.join(orchestraHome(), 'logs', 'serve.log')}\nПроще: двойной клик по Orchestra.command → «Orca и Orchestra вместе».`);
}

if (require.main === module) {
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const home = orchestraHome();
  if (process.argv.includes('--print-token')) {
    console.log(loadToken(home));
    process.exit(0);
  }
  const cfgServe = new Hub(home, () => {}).config().serve;
  const host = arg('host') ?? cfgServe.host;
  const port = Number(arg('port') ?? cfgServe.port);
  if (process.argv.includes('--install-launchd')) {
    installLaunchd(host, port);
    process.exit(0);
  }
  serve({ host, port }).then(
    (s) => {
      const stop = async () => {
        await s.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    },
    (e) => {
      console.error(e?.message ?? e);
      process.exit(1);
    },
  );
}
