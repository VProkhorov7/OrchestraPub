/**
 * Diagnostics and modes: together / only Orca / only Orchestra, apply and undo,
 * with a fake launchctl (really starts and stops `orchestra serve` from the plist) and a fake `claude mcp`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { execFileSync } from 'child_process';
import { tmpdir, testConfig, check, sh } from './helpers';
import { Doctor, discoverProjects } from '../main/doctor';
import { Hub } from '../main/hub';
import { workerEnv } from '../main/worker';
import { fromPreset } from '../main/catalog';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

function repo(root: string, name: string, memory: boolean) {
  const r = path.join(root, name);
  fs.mkdirSync(r, { recursive: true });
  sh('git', ['init', '-q', '-b', 'main'], r);
  sh('git', ['config', 'user.email', 'a@b'], r);
  sh('git', ['config', 'user.name', 'a'], r);
  fs.writeFileSync(path.join(r, 'run.sh'), 'echo hi\n');
  if (memory) fs.mkdirSync(path.join(r, '.memory'));
  sh('git', ['add', '.'], r);
  sh('git', ['commit', '-q', '-m', 'init'], r);
  return r;
}

async function main() {
  const tmp = tmpdir('orch-doctor-');
  const home = path.join(tmp, 'home');
  const bin = path.join(tmp, 'bin');
  const agents = path.join(tmp, 'LaunchAgents');
  const cdir = path.join(tmp, 'claude-config');
  for (const d of [home, bin, agents, cdir]) fs.mkdirSync(d, { recursive: true });
  const port = await freePort();

  // Fake launchctl: load = start ProgramArguments from the plist in the background; unload = kill; list = alive?
  const state = path.join(tmp, 'launchd.pid');
  fs.writeFileSync(
    path.join(bin, 'launchctl'),
    `#!/usr/bin/env node
const fs=require('fs'),{spawn}=require('child_process');const [cmd,...a]=process.argv.slice(2);const st=${JSON.stringify(state)};
const alive=()=>{try{const p=+fs.readFileSync(st,'utf8');process.kill(p,0);return p}catch{return 0}};
if(cmd==='list'){process.exit(alive()?0:113)}
if(cmd==='load'){const f=a[a.length-1];const x=fs.readFileSync(f,'utf8');const arr=x.match(/<array>(.*?)<\\/array>/s)[1];
 const args=[...arr.matchAll(/<string>(.*?)<\\/string>/g)].map(m=>m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'));
 if(alive())process.exit(0);const c=spawn(args[0],args.slice(1),{detached:true,stdio:'ignore',env:process.env});c.unref();fs.writeFileSync(st,String(c.pid));process.exit(0)}
if(cmd==='unload'){const p=alive();if(p)process.kill(p,'SIGTERM');fs.rmSync(st,{force:true});process.exit(0)}
process.exit(1);
`,
  );
  // Fake claude: --version, auth status, mcp add-json/remove --scope local (edits $CLAUDE_CONFIG_DIR/.claude.json like Claude Code).
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/usr/bin/env node
const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=path.join(process.env.CLAUDE_CONFIG_DIR,'.claude.json');
const j=(()=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return {}}})();const cwd=process.cwd();
if(a[0]==='--version'){console.log('2.9.0 (Claude Code)');process.exit(0)}
if(a[0]==='auth'){console.log(JSON.stringify({loggedIn:true,subscriptionType:'pro'}));process.exit(0)}
if(a[0]==='mcp'){j.projects??={};const p=(j.projects[cwd]??={});p.mcpServers??={};
 if(a[1]==='add-json'){const name=a[4];if(p.mcpServers[name]){console.error('already exists');process.exit(1)}p.mcpServers[name]=JSON.parse(a[5])}
 else if(a[1]==='remove'){const name=a[a.length-1];if(!p.mcpServers[name]){console.error('not found');process.exit(1)}delete p.mcpServers[name]}
 fs.writeFileSync(f,JSON.stringify(j));process.exit(0)}
process.exit(0);
`,
  );
  fs.chmodSync(path.join(bin, 'launchctl'), 0o755);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  fs.writeFileSync(path.join(bin, 'orchestra-memory'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'orchestra-memory'), 0o755);

  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.ORCHESTRA_LAUNCHCTL = path.join(bin, 'launchctl');
  process.env.ORCHESTRA_LAUNCH_AGENTS = agents;
  process.env.ORCHESTRA_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = cdir;
  // The owner's global Claude setup with RTK, like on the Mac mini: CLAUDE.md = "@RTK.md", a PreToolUse hook, rtk gain.
  const gh = path.join(tmp, 'global-claude');
  fs.mkdirSync(gh, { recursive: true });
  fs.writeFileSync(path.join(gh, 'CLAUDE.md'), '@RTK.md\n');
  fs.writeFileSync(path.join(gh, 'RTK.md'), '# RTK\nUse rtk.\n');
  fs.writeFileSync(path.join(gh, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }] } }));
  process.env.ORCHESTRA_CLAUDE_HOME = gh;
  fs.writeFileSync(path.join(bin, 'rtk'), '#!/bin/sh\ncase "$1" in --version) echo "rtk 0.49.0";; gain) printf "Total commands:    265\\nTokens saved:      22.7K (30.4%%)\\n";; esac\n');
  fs.chmodSync(path.join(bin, 'rtk'), 0o755);

  const projRoot = path.join(tmp, 'Developer');
  const a = repo(projRoot, 'site-b', true);
  const b = repo(path.join(projRoot, 'Work'), 'app-a', false);
  repo(path.join(projRoot, 'node_modules'), 'junk', false);
  // Copied disk: executable bit changed, content not.
  fs.chmodSync(path.join(a, 'run.sh'), 0o755);

  // Workers get no production keys and no wrangler login
  process.env.CLOUDFLARE_API_TOKEN = 'cf';
  process.env.GITHUB_TOKEN = 'gh';
  process.env.MY_DB_PASSWORD = 'pw';
  const we = workerEnv(fromPreset('deepseek', { token: 'k' }), testConfig('claude'));
  const wh = we.CLAUDE_CONFIG_DIR!;
  check(JSON.stringify(JSON.parse(fs.readFileSync(path.join(wh, 'settings.json'), 'utf8')).hooks.PreToolUse).includes('rtk hook claude') && fs.readFileSync(path.join(wh, 'CLAUDE.md'), 'utf8').includes('@RTK.md'), 'worker config dir gets the RTK hook and RTK.md');
  check(!we.CLOUDFLARE_API_TOKEN && !we.GITHUB_TOKEN && !we.MY_DB_PASSWORD && we.ORCHESTRA_WORKER === '1' && /worker-sandbox/.test(we.XDG_CONFIG_HOME ?? '') && we.ANTHROPIC_AUTH_TOKEN === 'k', 'worker env: no prod keys, own wrangler config, provider key kept');
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.MY_DB_PASSWORD;

  check(discoverProjects([projRoot]).sort().join('|') === [b, a].sort().join('|'), 'discover: repos under the root, node_modules skipped');

  const cfg = testConfig('claude', { serve: { host: '127.0.0.1', port }, projects: [a, b] } as any);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(home, 'serve.json'), JSON.stringify({ token: 'tok' }));
  const hub = new Hub(home, () => {});
  const doctor = new Doctor({ home, config: () => hub.config(), saveConfig: (x) => hub.store.save(x), health: () => hub.health });

  // 1. start: nothing running, no MCP
  let rep = await doctor.report();
  check(rep.mode === 'orca', `initial mode: only Orca (${rep.mode})`);
  const pa = rep.projects.find((p) => p.path === a)!;
  check(pa.memory && pa.hooksPath === '' && pa.modeNoise === 1, `project state: memory, hooks off, 1 mode-only change (${pa.modeNoise})`);
  check(rep.checks.find((c) => c.id === 'claude')!.state === 'ok', 'claude found and logged in');
  check(rep.checks.find((c) => c.id === 'workers')!.state === 'warn', 'no workers → warning');

  // 2. plan for "together"
  const plan = await doctor.plan('together', rep);
  const kinds = plan.map((x) => x.kind).sort().join(',');
  check(kinds === 'command,git-config,git-config,global-rules,mcp-set,mcp-set,service-install,service-start', `plan together: ${kinds}`);
  const rc = rep.checks.find((c) => c.id === 'rtk')!;
  check(rc.state === 'ok' && /22\.7K \(30\.4%\) на 265/.test(rc.detail), `rtk check: ${rc.detail}`);
  check(rep.checks.find((c) => c.id === 'global-rules')!.state === 'warn', 'no Karpathy principles globally → warning');

  // 3. apply together
  let r = await doctor.apply('together');
  check(!r.failed.length, `apply together: no failures ${r.failed.join('; ')}`);
  rep = await doctor.report();
  check(rep.service.answers && rep.service.loaded, 'service answers and launchd has it');
  check(rep.mode === 'together', `mode together (${rep.mode})`);
  const cj = JSON.parse(fs.readFileSync(path.join(cdir, '.claude.json'), 'utf8'));
  const entry = cj.projects[b].mcpServers.orchestra;
  check(entry.url === `http://127.0.0.1:${port}/mcp?repo=${b.split('/').map(encodeURIComponent).join('/')}` && entry.headers.Authorization === 'Bearer tok', 'MCP entry: URL with the repo (spaces encoded) and token');
  check(execFileSync('git', ['config', 'core.hooksPath'], { cwd: a }).toString().trim() === '.githooks', 'memory hooks enabled');
  check(rep.projects.find((p) => p.path === a)!.modeNoise === 0, 'fileMode off → the permission-only changes are no longer reported');
  const cmdFile = path.join(a, '.claude', 'commands', 'orchestra.md');
  check(fs.readFileSync(cmdFile, 'utf8').includes('$ARGUMENTS') && !fs.existsSync(path.join(b, '.claude', 'commands', 'orchestra.md')), '/orchestra command installed where memory is on');
  check((await doctor.plan('together')).length === 0, 'second apply: nothing to change');

  const gmd = fs.readFileSync(path.join(gh, 'CLAUDE.md'), 'utf8');
  check(gmd.startsWith('@RTK.md') && gmd.includes('Хирургические правки') && gmd.split('orchestra-global:start').length === 2, 'global CLAUDE.md: RTK line kept, principles added once');

  // 4. only Orca
  r = await doctor.apply('orca');
  check(!r.failed.length, `apply orca ${r.failed.join('; ')}`);
  await sleep(500);
  rep = await doctor.report();
  check(!rep.service.answers && !rep.service.loaded && rep.mode === 'orca', `orca: service stopped, mode ${rep.mode}`);
  check(rep.projects.every((p) => !p.mcp), 'orca: MCP removed from projects');
  check(execFileSync('git', ['config', 'core.hooksPath'], { cwd: a }).toString().trim() === '.githooks', 'orca: memory hooks stay');

  // 5. undo → together again
  check(fs.readFileSync(path.join(gh, 'CLAUDE.md'), 'utf8').includes('Хирургические'), 'principles stay in «only Orca» (they are not about Orchestra)');
  r = await doctor.undo();
  check(!r.failed.length, `undo ${r.failed.join('; ')}`);
  rep = await doctor.report();
  check(rep.mode === 'together' && rep.service.answers, `undo restored together (${rep.mode})`);
  let threw = false;
  try {
    await doctor.undo();
  } catch {
    threw = true;
  }
  check(threw, 'nothing more to undo');

  // 6. only Orchestra
  r = await doctor.apply('orchestra');
  rep = await doctor.report();
  check(rep.mode === 'orchestra' && rep.service.answers, `orchestra: service on, MCP off (${rep.mode})`);

  // 6b. the command alone: install, undo removes it, the owner's own file is never touched
  fs.rmSync(cmdFile);
  check((await doctor.plan('orchestra')).map((x) => x.kind).join() === 'command', 'missing command → one action');
  await doctor.apply('orchestra');
  check(fs.existsSync(cmdFile), 'command installed again');
  await doctor.undo();
  check(!fs.existsSync(cmdFile), 'undo removed the command it had installed');
  fs.writeFileSync(cmdFile, 'my own command');
  check((await doctor.plan('orchestra')).length === 0, "owner's own /orchestra file is left alone");
  fs.rmSync(cmdFile);
  await doctor.apply('orchestra');

  // 6c. global principles: added and undone, the owner's own lines untouched
  fs.writeFileSync(path.join(gh, 'CLAUDE.md'), '@RTK.md\nмоё правило\n');
  const gp = await doctor.plan('orchestra');
  check(gp.map((x) => x.kind).join() === 'global-rules', `only the global principles to add: ${gp.map((x) => x.kind)}`);
  await doctor.apply('orchestra');
  check(fs.readFileSync(path.join(gh, 'CLAUDE.md'), 'utf8').includes('моё правило\n\n<!-- orchestra-global:start'), 'appended after the owner lines');
  await doctor.undo();
  check(fs.readFileSync(path.join(gh, 'CLAUDE.md'), 'utf8') === '@RTK.md\nмоё правило\n', 'undo restores the global CLAUDE.md exactly');
  await doctor.apply('orchestra');

  // 7. through the panel API: report, then "only Orca" from inside the service
  const api = (p: string, body?: any) =>
    fetch(`http://127.0.0.1:${port}/api${p}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const pr: any = await (await api('/doctor')).json();
  check(pr.mode === 'orchestra' && pr.projects.length === 2, 'panel: /api/doctor');
  const plan2: any = await (await api('/doctor/plan', { mode: 'together' })).json();
  check(plan2.length === 2 && plan2.every((x: any) => x.kind === 'mcp-set'), 'panel: plan together = connect MCP in 2 projects');
  const ar: any = await (await api('/doctor/apply', { mode: 'orca' })).json();
  check(ar.stoppingSelf === true, 'panel: apply orca answers first, then stops the service');
  let down = false;
  for (let i = 0; i < 20 && !down; i++) {
    await sleep(300);
    down = !(await fetch(`http://127.0.0.1:${port}/`).then(() => true).catch(() => false));
  }
  check(down, 'panel: service stopped itself after the answer');

  // 8. CLI: JSON report and non-interactive apply
  const cli = path.join(__dirname, '..', 'doctor', 'cli.js');
  const out = JSON.parse(execFileSync(process.execPath, [cli, '--json'], { env: process.env }).toString().replace(/^[^{]*/, ''));
  check(out.mode === 'orca', `CLI --json (${out.mode})`);
  const planTxt = execFileSync(process.execPath, [cli, '--mode', 'together'], { env: process.env }).toString();
  check(/--yes/.test(planTxt) && /подключить Orchestra/.test(planTxt), 'CLI --mode without --yes only shows the plan');
  execFileSync(process.execPath, [cli, '--mode', 'together', '--yes'], { env: process.env });
  rep = await doctor.report();
  check(rep.mode === 'together', 'CLI --mode together --yes applied');
  await doctor.apply('orca');
  await sleep(300);
  console.log('SMOKE-DOCTOR OK', tmp);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
