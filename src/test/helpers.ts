import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { execFileSync } from 'child_process';
import { DEFAULT_CONFIG } from '../main/config';
import { fromPreset } from '../main/catalog';
import { AppConfig } from '../main/types';

export function tmpdir(prefix: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Keep worker homes etc. out of the real user folder.
  process.env.ORCHESTRA_HOME ??= path.join(d, 'orchestra-home');
  return d;
}

/** Config for tests: API orchestrator plus DeepSeek and GLM workers with keys. */
export function testConfig(claudePath: string, extra: Partial<AppConfig> = {}): AppConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    orchestrator: { ...DEFAULT_CONFIG.orchestrator, mode: 'api' },
    anthropic: { apiKey: 'fake', model: 'claude-opus-5', maxTokens: 1000 },
    providers: [fromPreset('deepseek', { token: 'k' }), fromPreset('glm', { token: 'k' })],
    claudePath,
    workerTimeoutMin: 1,
    ...extra,
  };
}

export function sh(cmd: string, args: string[], cwd: string) {
  return execFileSync(cmd, args, { cwd, stdio: 'pipe' }).toString();
}

/** A real git repo with one committed file. */
export function makeRepo(root: string): string {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  sh('git', ['init', '-q', '-b', 'main'], repo);
  sh('git', ['config', 'user.email', 'a@b'], repo);
  sh('git', ['config', 'user.name', 'a'], repo);
  fs.writeFileSync(path.join(repo, 'hello.txt'), 'hello\n');
  sh('git', ['add', '.'], repo);
  sh('git', ['commit', '-q', '-m', 'init'], repo);
  return repo;
}

/**
 * Fake `claude` binary: writes hello.txt (or $FAKE_FILE), commits, emits stream-json with token usage
 * (100k input, 10k output per run) like Claude Code does.
 */
export function makeFakeClaude(root: string): string {
  const f = path.join(root, 'claude');
  fs.writeFileSync(
    f,
    `#!/usr/bin/env node
const fs=require('fs');const cp=require('child_process');
const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const argv=process.argv.slice(2);
if(process.env.FAKE_ARGLOG) fs.appendFileSync(process.env.FAKE_ARGLOG, JSON.stringify(argv)+'\\n');
if(argv[0]==='auth'){ out({loggedIn: process.env.FAKE_LOGGED_OUT?false:true, authMethod:'claude.ai', subscriptionType:'pro'}); process.exit(0); }
if(argv.includes('--mcp-config')) { require(${JSON.stringify(path.join(__dirname, 'fake-orchestrator.js'))}).claude(argv); return; }
if(argv.includes('json')) { // planning: --output-format json
  const plan={summary:'план по подписке',tasks:[{id:'p1',title:'Правка hello',role:'docs',providerId:'deepseek',spec:'Change hello.txt',dependsOn:[],reason:'дёшево'}]};
  out({type:'result',is_error:false,result:'Вот план:\\n\\\`\\\`\\\`json\\n'+JSON.stringify(plan)+'\\n\\\`\\\`\\\`'}); process.exit(0); }
const file=process.env.FAKE_FILE||'hello.txt';
out({type:'system',subtype:'init',model:process.env.ANTHROPIC_MODEL});
const usage={input_tokens:100000,output_tokens:10000,cache_read_input_tokens:0,cache_creation_input_tokens:0};
out({type:'assistant',message:{id:'m1',usage,content:[{type:'text',text:'Editing.'}]}});
out({type:'assistant',message:{id:'m1',usage,content:[{type:'tool_use',name:'Write',input:{file_path:file}}]}});
fs.writeFileSync(file,'hello from '+process.env.ANTHROPIC_MODEL+' via '+process.env.ANTHROPIC_BASE_URL+'\\n');
cp.execSync('git add -A && git -c user.name=w -c user.email=w@w commit -q -m worker');
out({type:'result',result:'Changed '+file+' as asked. Verified by reading it back.',total_cost_usd:9.99,usage});
`,
  );
  fs.chmodSync(f, 0o755);
  return f;
}

/** Fake Anthropic Messages API that plays a script and records every request body. */
export async function fakeApi(script: any[]) {
  const requests: any[] = [];
  let step = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const msg = script[step++] ?? { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'fake', usage: { input_tokens: 10, output_tokens: 5 }, ...msg }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  return { requests, close: () => server.close() };
}

export const toolUse = (id: string, name: string, input: any, text?: string) => ({
  content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id, name, input }],
  stop_reason: 'tool_use',
});

export function check(c: boolean, m: string) {
  if (!c) {
    console.error('FAIL:', m);
    process.exit(1);
  }
}

/**
 * Hermetic tests: stub `codexbar` so subscription limits never read the developer's real CodexBar.
 * A temp dir with an executable `codexbar` that prints `[]` and exits 0 is prepended to PATH, so
 * `codexBarQuotas()` finds no quotas and the machine's CodexBar is never consulted. Returns the stub path.
 * Runs once at import; a test that installs its own stub later (smoke-limits) prepends after this and wins.
 */
export function isolateCodexbar(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-codexbar-'));
  const stub = path.join(dir, 'codexbar');
  fs.writeFileSync(stub, '#!/bin/sh\necho \'[]\'\n');
  fs.chmodSync(stub, 0o755);
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
  return stub;
}

isolateCodexbar();
