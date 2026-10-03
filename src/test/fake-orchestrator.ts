/**
 * Plays the subscription orchestrator in tests: speaks MCP Streamable HTTP to the app's server by hand
 * (initialize → tools/call ...) and prints the event stream Claude Code (stream-json) or Codex (exec --json) would.
 * Loaded by the fake `claude` / `codex` binaries.
 */
import * as fs from 'fs';

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

async function rpc(url: string, token: string, method: string, params: any, id: number) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function session(url: string, token: string) {
  await rpc(url, token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } }, 0);
  let id = 1;
  return async (name: string, args: any = {}) => {
    const res = await rpc(url, token, 'tools/call', { name, arguments: args }, id++);
    return { text: (res.content ?? []).map((c: any) => c.text).join('\n'), isError: !!res.isError };
  };
}

/** The scripted run: one delegate, wait, merge. Returns the final report. */
async function script(call: (n: string, a?: any) => Promise<{ text: string; isError: boolean }>, log: (name: string, args: any, res: string) => void) {
  const steps: Array<[string, any]> = [
    ['list_workers', {}],
    ['delegate', { provider: 'deepseek', role: 'docs', title: 'Edit hello', spec: 'Change hello.txt' }],
    ['wait_for', { timeout_sec: 60 }],
    ['merge_task', { task_id: 't01' }],
  ];
  for (const [n, a] of steps) {
    const r = await call(n, a);
    log(n, a, r.text);
    if (r.isError) throw new Error(`${n}: ${r.text}`);
  }
  return 'Итог: слита задача t01.';
}

export async function claude(argv: string[]) {
  try {
    if (process.env.ANTHROPIC_API_KEY) throw new Error('API key leaked into the subscription orchestrator');
    const cfgFile = argv[argv.indexOf('--mcp-config') + 1];
    const srv = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).mcpServers.orchestra;
    const token = String(srv.headers.Authorization).replace(/^Bearer /, '');
    if (!argv.includes('--strict-mcp-config') || !argv.join(' ').includes('Edit,Write')) throw new Error('orchestrator not restricted');
    out({ type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: [{ name: 'orchestra', status: 'connected' }] });
    if (process.env.FAKE_LIMIT) {
      out({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1758000000' });
      process.exit(1);
    }
    const call = await session(srv.url, token);
    let n = 0;
    const report = await script(call, (name, args, res) => {
      const id = `tu${n++}`;
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__orchestra__${name}`, input: args }] } });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: res }] }] } });
    });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: report }] } });
    out({ type: 'result', is_error: false, result: report, total_cost_usd: 1.25, session_id: 'sess-1' });
    process.exit(0);
  } catch (e: any) {
    out({ type: 'result', is_error: true, result: String(e?.message ?? e) });
    process.exit(2);
  }
}

export async function codex(argv: string[]) {
  try {
    if (argv[0] === 'login') {
      console.log(process.env.FAKE_LOGGED_OUT ? 'Not logged in' : 'Logged in using ChatGPT');
      process.exit(process.env.FAKE_LOGGED_OUT ? 1 : 0);
    }
    if (argv.includes('read-only')) {
      const plan = { summary: 'план от codex', tasks: [{ id: 'p1', title: 'Правка', role: 'docs', providerId: 'deepseek', spec: 'x', dependsOn: [], reason: 'r' }] };
      out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: JSON.stringify(plan) } });
      process.exit(0);
    }
    const urlArg = argv.find((a) => a.startsWith('mcp_servers.orchestra.url='))!;
    const url = JSON.parse(urlArg.split('=').slice(1).join('='));
    const token = process.env.ORCHESTRA_MCP_TOKEN!;
    if (!argv.includes('--dangerously-bypass-approvals-and-sandbox')) throw new Error('codex would reject MCP calls');
    out({ type: 'thread.started', thread_id: 'thr-1' });
    const call = await session(url, token);
    let n = 0;
    const report = await script(call, (name, args, res) => {
      const id = `c${n++}`;
      out({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: 'orchestra', tool: name, arguments: args, status: 'in_progress' } });
      out({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'orchestra', tool: name, arguments: args, status: 'completed', result: { content: [{ type: 'text', text: res }] } } });
    });
    out({ type: 'item.completed', item: { id: 'last', type: 'agent_message', text: report } });
    out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 } });
    process.exit(0);
  } catch (e: any) {
    out({ type: 'error', message: String(e?.message ?? e) });
    process.exit(2);
  }
}
