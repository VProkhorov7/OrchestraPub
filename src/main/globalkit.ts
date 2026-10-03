import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from './git';
import { GLOBAL_END, GLOBAL_START, globalRules } from '../memory/templates';
import { appLanguage } from '../memory/lang';

/**
 * What Orchestra keeps in the owner's global Claude Code setup (~/.claude):
 *  - Karpathy's coding principles as a marked block in CLAUDE.md (added and undone by diagnostics);
 *  - RTK (github.com/rtk-ai/rtk): checked, and carried over to Orchestra workers, whose own config dir
 *    (CLAUDE_CONFIG_DIR per provider) would otherwise skip the global hook.
 */

export function claudeHome() {
  return process.env.ORCHESTRA_CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

export function globalClaudeMd() {
  return path.join(claudeHome(), 'CLAUDE.md');
}

const blockRe = () => new RegExp(`${GLOBAL_START}[\\s\\S]*?${GLOBAL_END}\\n?`);

export function globalRulesState(): 'missing' | 'current' | 'outdated' {
  const f = globalClaudeMd();
  const body = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (!body.includes(GLOBAL_START)) return 'missing';
  return body.includes(globalRules(appLanguage()).trim()) ? 'current' : 'outdated';
}

/** Add or update our block; the rest of the file (e.g. RTK's @RTK.md) stays as it is. */
export function installGlobalRules() {
  const f = globalClaudeMd();
  let body = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const rules = globalRules(appLanguage());
  body = blockRe().test(body) ? body.replace(blockRe(), rules) : (body.trimEnd() ? body.trimEnd() + '\n\n' : '') + rules;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

async function which(cmd: string): Promise<string> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const f = path.join(dir, cmd);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return f;
    } catch {
      /* next */
    }
  }
  return '';
}

function readJson(f: string): any {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

/** Global PreToolUse hook entries that call rtk. */
function rtkHookEntries(): any[] {
  const s = readJson(path.join(claudeHome(), 'settings.json'));
  return (s.hooks?.PreToolUse ?? []).filter((e: any) => JSON.stringify(e).includes('rtk'));
}

export interface RtkState {
  installed: string;
  version: string;
  hooked: boolean;
  saved?: string;
  commands?: number;
}

export async function rtkState(): Promise<RtkState> {
  const bin = await which('rtk');
  if (!bin) return { installed: '', version: '', hooked: false };
  const v = await run(bin, ['--version'], process.cwd(), { timeoutMs: 10_000 });
  const st: RtkState = { installed: bin, version: v.stdout.trim().replace(/^rtk\s+/, ''), hooked: rtkHookEntries().length > 0 };
  const g = await run(bin, ['gain'], process.cwd(), { timeoutMs: 15_000, env: { ...process.env, NO_COLOR: '1' } });
  const plain = g.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  st.saved = /Tokens saved:\s*([^\n]+)/.exec(plain)?.[1]?.trim();
  const n = /Total commands:\s*(\d+)/.exec(plain)?.[1];
  if (n) st.commands = Number(n);
  return st;
}

/**
 * A worker's own Claude config dir gets the owner's RTK hook and RTK.md, so workers' shell output is compressed too.
 * Only when rtk is installed and hooked globally; nothing else from the owner's global setup is copied.
 */
export function syncWorkerHome(dir: string) {
  const hooks = rtkHookEntries();
  if (!hooks.length) return;
  const sf = path.join(dir, 'settings.json');
  const s = readJson(sf);
  s.hooks ??= {};
  const cur: any[] = (s.hooks.PreToolUse ?? []).filter((e: any) => !JSON.stringify(e).includes('rtk'));
  s.hooks.PreToolUse = [...cur, ...hooks];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sf, JSON.stringify(s, null, 2) + '\n');
  const rtkMd = path.join(claudeHome(), 'RTK.md');
  if (fs.existsSync(rtkMd)) {
    fs.copyFileSync(rtkMd, path.join(dir, 'RTK.md'));
    const md = path.join(dir, 'CLAUDE.md');
    const body = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
    if (!body.includes('@RTK.md')) fs.writeFileSync(md, (body.trimEnd() ? body.trimEnd() + '\n' : '') + '@RTK.md\n');
  }
}
