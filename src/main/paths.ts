import * as os from 'os';
import * as path from 'path';

/**
 * The Electron app's userData folder, computed without Electron so the MCP server finds the same
 * config.json, runs/ and worktrees/. Override with ORCHESTRA_HOME.
 */
export function orchestraHome(): string {
  if (process.env.ORCHESTRA_HOME) return process.env.ORCHESTRA_HOME;
  const name = 'Orchestra'; // package.json productName
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

/** Apps started from Finder or launchd get a bare PATH; add the usual places where claude, codex, codexbar and git live. */
export function fixPath() {
  const home = os.homedir();
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', `${home}/.npm-global/bin`, `${home}/.local/bin`, `${home}/.claude/local`, `${home}/.bun/bin`, `${home}/.volta/bin`];
  const cur = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  process.env.PATH = [...cur, ...extra.filter((d) => !cur.includes(d))].join(path.delimiter);
}

/** An MCP run is alive while its server process exists. */
export function pidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
