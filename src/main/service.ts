import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { orchestraHome } from './paths';
import { run } from './git';

/**
 * The `orchestra serve` background service on macOS (launchd agent), its access token,
 * and checks whether it answers. Paths and the launchctl binary can be overridden for tests.
 */

export const LAUNCH_LABEL = 'dev.orchestra.serve';

export const WATCH_LABEL = 'dev.orchestra.watch';

export function launchAgentsDir() {
  return process.env.ORCHESTRA_LAUNCH_AGENTS || path.join(os.homedir(), 'Library', 'LaunchAgents');
}

export function plistPath() {
  return path.join(launchAgentsDir(), `${LAUNCH_LABEL}.plist`);
}

function launchctl() {
  return process.env.ORCHESTRA_LAUNCHCTL || 'launchctl';
}

/** launchd exists (macOS), or a test double is configured. */
export function hasLaunchd() {
  return process.platform === 'darwin' || !!process.env.ORCHESTRA_LAUNCHCTL;
}

/** The access token lives next to config.json (mode 600) and survives restarts. */
export function loadToken(home: string): string {
  const f = path.join(home, 'serve.json');
  try {
    const t = JSON.parse(fs.readFileSync(f, 'utf8')).token;
    if (t) return t;
  } catch {
    /* first start */
  }
  const token = randomBytes(24).toString('base64url');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ token }, null, 2), { mode: 0o600 });
  return token;
}

/** Path to the service entry point (dist/server/serve.js), next to this file after the build. */
export function serveScript() {
  return path.resolve(__dirname, '..', 'server', 'serve.js');
}

/** A stable node path (e.g. /opt/homebrew/bin/node) that points at the running node, so the plist survives `brew upgrade node`. */
export function stableNodePath(
  execPath = process.execPath,
  candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node'],
): string {
  let real: string;
  try {
    real = fs.realpathSync(execPath);
  } catch {
    return execPath;
  }
  for (const candidate of candidates) {
    try {
      if (fs.realpathSync(candidate) === real) return candidate;
    } catch {
      /* candidate missing or unreadable */
    }
  }
  return execPath;
}

/** The plist XML for the launchd agent, with a stable node path in ProgramArguments. */
export function plistText(host: string, port: number, nodePath?: string): string {
  const args = [nodePath ?? stableNodePath(), serveScript(), '--host', host, '--port', String(port)];
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const logDir = path.join(orchestraHome(), 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(path.join(logDir, 'serve.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir, 'serve.log'))}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH ?? '')}</string></dict>
</dict></plist>
`;
}

export function watchPlistPath() {
  return path.join(launchAgentsDir(), `${WATCH_LABEL}.plist`);
}

/** The external watchdog: launchd runs `orchestra-ctl watch` every minute, independently of the service it watches. */
export function watchPlistText(nodePath?: string): string {
  const ctl = path.resolve(__dirname, '..', 'server', 'ctl.js');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const log = path.join(orchestraHome(), 'logs', 'watch.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${WATCH_LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(nodePath ?? stableNodePath())}</string><string>${esc(ctl)}</string><string>watch</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH ?? '')}</string></dict>
</dict></plist>
`;
}

export function writeWatchPlist(): string {
  const f = watchPlistPath();
  fs.mkdirSync(path.join(orchestraHome(), 'logs'), { recursive: true });
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, watchPlistText());
  return f;
}

export async function watchLoaded(): Promise<boolean> {
  if (!hasLaunchd()) return false;
  const r = await run(launchctl(), ['list', WATCH_LABEL], process.cwd(), { timeoutMs: 10_000 });
  return r.code === 0;
}

export async function watchLoad(): Promise<void> {
  const r = await run(launchctl(), ['load', '-w', watchPlistPath()], process.cwd(), { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`launchctl load (watch): ${(r.stderr || r.stdout).trim()}`);
}

export async function watchUnload(): Promise<void> {
  await run(launchctl(), ['unload', '-w', watchPlistPath()], process.cwd(), { timeoutMs: 15_000 });
}

/** Write the launchd agent that keeps `orchestra serve` running (does not load it). */
export function writePlist(host: string, port: number): string {
  const plist = plistPath();
  const logDir = path.join(orchestraHome(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, plistText(host, port));
  return plist;
}

export async function launchdLoaded(): Promise<boolean> {
  if (!hasLaunchd()) return false;
  const r = await run(launchctl(), ['list', LAUNCH_LABEL], process.cwd(), { timeoutMs: 10_000 });
  return r.code === 0;
}

export async function launchdLoad(): Promise<void> {
  const r = await run(launchctl(), ['load', '-w', plistPath()], process.cwd(), { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`launchctl load: ${(r.stderr || r.stdout).trim()}`);
}

/** Restart the agent in place (kill and start again). The agent must be loaded. */
export async function launchdKickstart(): Promise<void> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const r = await run(launchctl(), ['kickstart', '-k', `gui/${uid}/${LAUNCH_LABEL}`], process.cwd(), { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`launchctl kickstart: ${(r.stderr || r.stdout).trim()}`);
}

export async function launchdUnload(): Promise<void> {
  const r = await run(launchctl(), ['unload', '-w', plistPath()], process.cwd(), { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`launchctl unload: ${(r.stderr || r.stdout).trim()}`);
}

/** The service answers on host:port (any HTTP answer counts: the page itself asks for the token). */
export async function serviceAnswers(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`, { signal: ac.signal });
    return r.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Service processes started by hand (not by launchd) that listen on the port: their pids. */
export async function manualServicePids(port: number): Promise<number[]> {
  const r = await run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], process.cwd(), { timeoutMs: 10_000 });
  if (r.code !== 0) return [];
  const pids = r.stdout.split(/\s+/).filter(Boolean).map(Number).filter((p) => p && p !== process.pid);
  const ours: number[] = [];
  for (const pid of pids) {
    const a = await run('ps', ['-o', 'args=', '-p', String(pid)], process.cwd(), { timeoutMs: 5000 });
    if (/serve\.js|orchestra-serve/.test(a.stdout)) ours.push(pid);
  }
  return ours;
}

export function panelUrl(host: string, port: number, token: string) {
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/?token=${token}`;
}

export function mcpUrl(host: string, port: number, repo: string) {
  return `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/mcp?repo=${repo.split('/').map(encodeURIComponent).join('/')}`;
}
