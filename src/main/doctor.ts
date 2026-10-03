import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppConfig, Health } from './types';
import { run } from './git';
import { commandState, setupRepo, upgradeFiles, upgradeNeeds } from '../memory/setup';
import { globalClaudeMd, globalRulesState, installGlobalRules, rtkState } from './globalkit';
import {
  hasLaunchd,
  launchdLoad,
  launchdLoaded,
  launchdUnload,
  loadToken,
  manualServicePids,
  mcpUrl,
  plistPath,
  serviceAnswers,
  writePlist,
} from './service';

/**
 * «Диагностика и режимы»: how Orca and Orchestra work together on this Mac.
 *
 * Modes:
 *  - together   — Orchestra service runs in the background, Claude Code in every project (Orca terminals) has the Orchestra MCP server;
 *  - orca       — only Orca: the service is stopped, the MCP entry is removed from projects so Claude Code does not try a dead server;
 *  - orchestra  — only Orchestra: the service runs (web panel, autopilot), projects have no MCP entry.
 * In every mode project memory stays on (git hooks) — it needs only the orchestra-memory command.
 *
 * Apply = a plan of concrete actions, shown before anything changes; the previous state is saved, so «Отменить» restores it.
 */

export type DoctorMode = 'together' | 'orca' | 'orchestra';
export type CheckState = 'ok' | 'warn' | 'err' | 'off';

export interface Check {
  id: string;
  group: 'system' | 'orchestra' | 'orca' | 'projects';
  label: string;
  state: CheckState;
  detail: string;
  /** What to do about it, for a person. */
  fix?: string;
}

export interface McpEntry {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  [k: string]: unknown;
}

export interface ProjectState {
  path: string;
  name: string;
  exists: boolean;
  git: boolean;
  memory: boolean;
  hooksPath: string;
  fileMode: string;
  /** Files git shows as modified only because the executable bit changed (copied disks). */
  modeNoise: number;
  mcp: McpEntry | null;
  /** A project-level .mcp.json also mentions orchestra (shared through git). */
  mcpProjectFile: boolean;
  /** The /orchestra command in .claude/commands. */
  command: 'missing' | 'current' | 'outdated' | 'custom';
  /** What the memory kit would bring up to date (rules, prod guard, command, roles, invariants). */
  upgrade: string[];
}

export interface ServiceState {
  launchd: boolean;
  plist: boolean;
  loaded: boolean;
  answers: boolean;
  manualPids: number[];
  host: string;
  port: number;
}

export interface Action {
  id: string;
  label: string;
  kind: 'service-install' | 'service-start' | 'service-stop' | 'mcp-set' | 'mcp-remove' | 'git-config' | 'command' | 'global-rules';
  repo?: string;
  key?: string;
  value?: string;
  entry?: McpEntry;
}

export interface Snapshot {
  at: string;
  mode: DoctorMode | 'undo';
  service: { plist: boolean; loaded: boolean; answers: boolean };
  mcp: Record<string, McpEntry | null>;
  git: Record<string, Record<string, string>>;
  /** Files written by apply: previous content, null = did not exist. */
  files?: Record<string, string | null>;
}

export interface DoctorReport {
  at: string;
  mode: DoctorMode | 'mixed';
  checks: Check[];
  projects: ProjectState[];
  service: ServiceState;
  undo: { at: string; mode: string } | null;
  summary: { ok: number; warn: number; err: number };
}

export interface DoctorDeps {
  home: string;
  config: () => AppConfig;
  saveConfig?: (cfg: AppConfig) => void;
  health: () => Record<string, Health>;
  /** true inside the service itself: stopping it must wait until the HTTP answer is sent. */
  insideService?: boolean;
  /** Where the service listens and its token, when they differ from config.json / serve.json (tests, --port). */
  endpoint?: { host: string; port: number };
  token?: string;
}

const MODE_LABEL: Record<DoctorMode, string> = {
  together: 'Orca и Orchestra вместе',
  orca: 'Только Orca',
  orchestra: 'Только Orchestra',
};
export const modeLabel = (m: string) => MODE_LABEL[m as DoctorMode] ?? m;

function claudeJsonPath() {
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function readJson<T>(f: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
}

async function which(cmd: string): Promise<string> {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : '';
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

const SKIP_DIRS = new Set(['node_modules', 'archive', '_vendor', 'dist', 'build', '.git', 'Library']);

/** Git repositories under the given roots (depth ≤ 3), skipping vendored and archived folders. */
/** Where git projects usually live, when the owner has not set the folders to search. */
export function defaultProjectRoots(): string[] {
  return ['Developer', 'Projects', 'Code', 'dev'].map((d) => path.join(os.homedir(), d));
}

export function discoverProjects(roots: string[], maxDepth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (fs.existsSync(path.join(dir, '.git'))) {
      out.push(dir);
      // A repository can contain other repositories (a group folder with a shared wiki does): keep walking.
    }
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name) || /sync-conflict/.test(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(path.resolve(r), 0);
  return [...new Set(out)];
}

export class Doctor {
  constructor(private d: DoctorDeps) {}

  private get endpoint() {
    return this.d.endpoint ?? this.d.config().serve;
  }

  private get snapFile() {
    return path.join(this.d.home, 'doctor', 'last-apply.json');
  }

  /** Projects: the saved list, else discovered under the saved roots (or the usual places: ~/Developer, ~/Projects, ~/Code, ~/dev). */
  projects(): string[] {
    const cfg = this.d.config();
    if (cfg.projects?.length) return cfg.projects.filter((p) => fs.existsSync(p));
    const roots = cfg.projectRoots?.length ? cfg.projectRoots : defaultProjectRoots().filter((r) => fs.existsSync(r));
    return discoverProjects(roots);
  }

  setProjects(list: string[], roots?: string[]) {
    if (!this.d.saveConfig) throw new Error('настройки только для чтения');
    const cfg = this.d.config();
    cfg.projects = [...new Set(list.map((p) => path.resolve(p)))];
    if (roots) cfg.projectRoots = roots;
    this.d.saveConfig(cfg);
  }

  private mcpEntries(): { local: Record<string, McpEntry | null>; user: McpEntry | null } {
    const j = readJson<any>(claudeJsonPath(), {});
    const local: Record<string, McpEntry | null> = {};
    for (const [p, v] of Object.entries<any>(j.projects ?? {})) local[path.resolve(p)] = v?.mcpServers?.orchestra ?? null;
    return { local, user: j.mcpServers?.orchestra ?? null };
  }

  async projectState(repo: string, mcpLocal: Record<string, McpEntry | null>): Promise<ProjectState> {
    const exists = fs.existsSync(repo);
    const git = exists && fs.existsSync(path.join(repo, '.git'));
    const cfg = async (k: string) => (git ? (await run('git', ['config', '--local', '--get', k], repo, { timeoutMs: 10_000 })).stdout.trim() : '');
    let modeNoise = 0;
    const fileMode = await cfg('core.fileMode');
    // Already told git to ignore permission bits: nothing to report.
    if (git && fileMode !== 'false') {
      const a = await run('git', ['-c', 'core.fileMode=true', 'diff', '--summary'], repo, { timeoutMs: 20_000 });
      modeNoise = (a.stdout.match(/^ mode change /gm) ?? []).length;
      if (modeNoise) {
        // Only count files whose content did not change.
        const b = await run('git', ['-c', 'core.fileMode=false', 'diff', '--name-only'], repo, { timeoutMs: 20_000 });
        const real = new Set(b.stdout.split('\n').filter(Boolean));
        const changed = [...a.stdout.matchAll(/^ mode change \d+ => \d+ (.+)$/gm)].map((m) => m[1]);
        modeNoise = changed.filter((f) => !real.has(f)).length;
      }
    }
    const projMcp = readJson<any>(path.join(repo, '.mcp.json'), {});
    return {
      path: repo,
      name: path.basename(repo),
      exists,
      git,
      memory: exists && fs.existsSync(path.join(repo, '.memory')),
      hooksPath: await cfg('core.hooksPath'),
      fileMode,
      modeNoise,
      mcp: mcpLocal[path.resolve(repo)] ?? null,
      mcpProjectFile: !!projMcp?.mcpServers?.orchestra,
      command: exists ? commandState(repo) : 'missing',
      upgrade: exists && fs.existsSync(path.join(repo, '.memory')) ? upgradeNeeds(repo) : [],
    };
  }

  async service(): Promise<ServiceState> {
    const { host, port } = this.endpoint;
    const launchd = hasLaunchd();
    const answers = await serviceAnswers(host, port);
    const loaded = launchd ? await launchdLoaded() : false;
    return {
      launchd,
      plist: fs.existsSync(plistPath()),
      loaded,
      answers,
      manualPids: answers && !loaded && !this.d.insideService ? await manualServicePids(port) : [],
      host,
      port,
    };
  }

  expectedMcp(repo: string): McpEntry {
    const { host, port } = this.endpoint;
    return { type: 'http', url: mcpUrl(host, port, repo), headers: { Authorization: `Bearer ${this.d.token ?? loadToken(this.d.home)}` } };
  }

  private mcpMatches(e: McpEntry | null, repo: string) {
    if (!e) return false;
    const x = this.expectedMcp(repo);
    return e.url === x.url && e.headers?.Authorization === x.headers!.Authorization;
  }

  async report(): Promise<DoctorReport> {
    const cfg = this.d.config();
    const checks: Check[] = [];
    const add = (c: Check) => checks.push(c);

    // ---- system
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    add({ id: 'node', group: 'system', label: 'Node.js', state: nodeMajor >= 20 ? 'ok' : 'err', detail: `v${process.versions.node}`, fix: nodeMajor >= 20 ? undefined : 'Нужен Node.js 20 или новее: brew install node' });
    const gitv = await run('git', ['--version'], process.cwd(), { timeoutMs: 10_000 });
    add({ id: 'git', group: 'system', label: 'git', state: gitv.code === 0 ? 'ok' : 'err', detail: gitv.code === 0 ? gitv.stdout.trim().replace('git version ', '') : 'не найден', fix: gitv.code === 0 ? undefined : 'xcode-select --install' });
    const claudeBin = await which(cfg.claudePath);
    let claudeDetail = 'не найден';
    let claudeState: CheckState = 'err';
    if (claudeBin) {
      const v = await run(claudeBin, ['--version'], process.cwd(), { timeoutMs: 15_000 });
      const a = await run(claudeBin, ['auth', 'status'], process.cwd(), { timeoutMs: 15_000 });
      let logged = false;
      try {
        logged = !!JSON.parse(a.stdout).loggedIn;
      } catch {
        logged = a.code === 0 && !/not logged|не выполнен/i.test(a.stdout + a.stderr);
      }
      const ver = v.stdout.trim().split('\n')[0].split(' ')[0];
      claudeDetail = `${/^\d+\.\d+/.test(ver) ? ver : 'есть'}${logged ? ', вход выполнен' : ', вход не выполнен'}`;
      claudeState = logged ? 'ok' : 'warn';
    }
    add({ id: 'claude', group: 'system', label: 'Claude Code', state: claudeState, detail: claudeDetail, fix: claudeState === 'ok' ? undefined : claudeBin ? 'claude → /login' : 'npm i -g @anthropic-ai/claude-code' });
    const mem = await which('orchestra-memory');
    add({ id: 'memory-cli', group: 'system', label: 'Команда orchestra-memory', state: mem ? 'ok' : 'err', detail: mem || 'нет в PATH — хуки памяти молча не работают', fix: mem ? undefined : 'В папке Orchestra: npm run build && npm link' });

    const rtk = await rtkState();
    add({
      id: 'rtk',
      group: 'system',
      label: 'RTK (сжатие вывода команд)',
      state: !rtk.installed ? 'off' : rtk.hooked ? 'ok' : 'warn',
      detail: !rtk.installed
        ? 'не установлен — Claude читает вывод команд целиком'
        : rtk.hooked
          ? `${rtk.version}, хук включён${rtk.saved ? `; сэкономлено ${rtk.saved}${rtk.commands ? ` на ${rtk.commands} командах` : ''}` : ''}; исполнителям Orchestra передаётся`
          : `${rtk.version} установлен, но хук не включён`,
      fix: !rtk.installed ? 'brew install rtk-ai/tap/rtk && rtk init --global' : rtk.hooked ? undefined : 'rtk init --global',
    });
    const gr = globalRulesState();
    add({
      id: 'global-rules',
      group: 'system',
      label: 'Принципы Карпатого (глобально)',
      state: gr === 'current' ? 'ok' : 'warn',
      detail: gr === 'current' ? `в ${globalClaudeMd()}` : gr === 'outdated' ? 'блок в ~/.claude/CLAUDE.md устарел' : 'нет в ~/.claude/CLAUDE.md — во всех проектах Claude работает без них',
    });

    // ---- orchestra
    const svc = await this.service();
    const svcState: CheckState = svc.answers ? 'ok' : 'off';
    add({
      id: 'service',
      group: 'orchestra',
      label: 'Служба Orchestra',
      state: svcState,
      detail: svc.answers
        ? `работает на ${svc.host}:${svc.port}${svc.loaded ? ', автозапуск включён' : ', запущена вручную'}`
        : svc.loaded
          ? 'автозапуск включён, но служба не отвечает — смотрите лог'
          : 'выключена',
      fix: !svc.answers && svc.loaded ? '~/Library/Application Support/Orchestra/logs/serve.log' : undefined,
    });
    if (svc.launchd) add({ id: 'launchd', group: 'orchestra', label: 'Автозапуск (launchd)', state: svc.loaded ? 'ok' : svc.plist ? 'off' : 'off', detail: svc.loaded ? 'включён' : svc.plist ? 'установлен, выключен' : 'не установлен' });
    const health = this.d.health();
    const workers = cfg.providers.filter((p) => (p.kind ?? 'api') === 'api' && p.enabled);
    const green = workers.filter((p) => health[p.id]?.light === 'green');
    const orch = cfg.providers.filter((p) => p.kind === 'claude-sub' || p.kind === 'codex-sub');
    const orchGreen = orch.filter((p) => health[p.id]?.light === 'green');
    add({
      id: 'orchestrator',
      group: 'orchestra',
      label: 'Оркестратор (подписка)',
      state: orchGreen.length ? 'ok' : 'warn',
      detail: orchGreen.length ? orchGreen.map((p) => p.label).join(', ') : 'ни одна подписка не горит зелёным',
      fix: orchGreen.length ? undefined : 'Панель → Настройки → Подключения',
    });
    add({
      id: 'workers',
      group: 'orchestra',
      label: 'Исполнители',
      state: green.length ? 'ok' : 'warn',
      detail: green.length ? `${green.length} из ${workers.length}: ${green.map((p) => p.label).join(', ')}` : workers.length ? 'подключены, но нет денег или лимита' : 'не подключены — задачи раздавать некому',
      fix: green.length ? undefined : 'Добавьте ключ DeepSeek, GLM, Kimi или Qwen; до этого работайте в режиме «Только Orca»',
    });

    // ---- orca
    const orcaApp = ['/Applications/Orca.app', path.join(os.homedir(), 'Applications', 'Orca.app')].find((p) => fs.existsSync(p));
    const orcaCfg = fs.existsSync(path.join(os.homedir(), '.orca'));
    add({ id: 'orca', group: 'orca', label: 'Orca', state: orcaApp || orcaCfg ? 'ok' : 'off', detail: orcaApp ? `установлена (${orcaApp})` : orcaCfg ? 'настройки есть (~/.orca), приложение не найдено в /Applications' : 'не найдена' });
    const { local, user } = this.mcpEntries();
    if (user) add({ id: 'mcp-user', group: 'orca', label: 'Orchestra для всех проектов', state: 'warn', detail: 'в ~/.claude.json есть общий сервер orchestra (scope user): он подключается во всех папках', fix: 'claude mcp remove orchestra -s user' });

    // ---- projects
    const projects = await Promise.all(this.projects().map((p) => this.projectState(p, local)));
    for (const p of projects) {
      const problems: string[] = [];
      let state: CheckState = 'ok';
      if (!p.exists) (problems.push('папка не найдена'), (state = 'err'));
      if (p.memory && p.hooksPath !== '.githooks') (problems.push('память есть, git-хуки выключены'), (state = 'warn'));
      if (p.modeNoise) (problems.push(`${p.modeNoise} файлов «изменены» только правами`), (state = state === 'err' ? state : 'warn'));
      if (p.mcp && !this.mcpMatches(p.mcp, p.path)) (problems.push('Orchestra подключена со старым адресом или токеном'), (state = state === 'err' ? state : 'warn'));
      if (p.memory && p.upgrade.length) (problems.push(`устарело: ${p.upgrade.join(', ')}`), (state = state === 'err' ? state : 'warn'));
      const bits = [p.memory ? 'память' : 'без памяти', p.mcp ? 'Orchestra подключена' : 'без Orchestra'];
      add({ id: `project:${p.path}`, group: 'projects', label: p.name, state, detail: [...bits, ...problems].join(' · ') });
    }

    // ---- current mode
    const withMcp = projects.filter((p) => p.mcp).length;
    let mode: DoctorReport['mode'] = 'mixed';
    if (svc.answers && projects.length && withMcp === projects.length) mode = 'together';
    else if (!svc.answers && withMcp === 0) mode = 'orca';
    else if (svc.answers && withMcp === 0) mode = 'orchestra';

    const snap = readJson<Snapshot | null>(this.snapFile, null);
    const summary = { ok: 0, warn: 0, err: 0 };
    for (const c of checks) if (c.state !== 'off') summary[c.state]++;
    return { at: new Date().toISOString(), mode, checks, projects, service: svc, undo: snap ? { at: snap.at, mode: snap.mode } : null, summary };
  }

  /** Concrete changes for a mode; nothing is changed here. */
  async plan(mode: DoctorMode, rep?: DoctorReport): Promise<Action[]> {
    const r = rep ?? (await this.report());
    const acts: Action[] = [];
    // Global coding principles apply in every mode: they are about how Claude writes code, not about Orchestra.
    if (r.checks.find((c) => c.id === 'global-rules')?.state !== 'ok')
      acts.push({ id: 'global-rules', kind: 'global-rules', key: globalClaudeMd(), label: `Принципы Карпатого в ${globalClaudeMd().replace(os.homedir(), '~')} (для всех проектов)` });
    const svc = r.service;
    const wantService = mode !== 'orca';
    if (wantService) {
      if (svc.launchd) {
        if (!svc.plist) acts.push({ id: 'svc-install', kind: 'service-install', label: 'Установить автозапуск службы Orchestra (launchd)' });
        if (!svc.loaded && !svc.answers) acts.push({ id: 'svc-start', kind: 'service-start', label: 'Запустить службу Orchestra и включить автозапуск' });
        else if (!svc.loaded && svc.answers) acts.push({ id: 'svc-start', kind: 'service-start', label: 'Служба запущена вручную: перевести на автозапуск (launchd)' });
      } else if (!svc.answers) acts.push({ id: 'svc-start', kind: 'service-start', label: 'Запустить службу Orchestra' });
    } else if (svc.answers || svc.loaded) {
      acts.push({ id: 'svc-stop', kind: 'service-stop', label: `Остановить службу Orchestra${svc.loaded ? ' и выключить автозапуск' : ''}` });
    }
    for (const p of r.projects) {
      if (!p.exists || !p.git) continue;
      if (mode === 'together') {
        if (!this.mcpMatches(p.mcp, p.path)) acts.push({ id: `mcp:${p.path}`, kind: 'mcp-set', repo: p.path, entry: this.expectedMcp(p.path), label: `${p.name}: ${p.mcp ? 'обновить' : 'подключить'} Orchestra в Claude Code` });
      } else if (p.mcp) acts.push({ id: `mcp:${p.path}`, kind: 'mcp-remove', repo: p.path, label: `${p.name}: отключить Orchestra в Claude Code` });
      if (p.memory && p.hooksPath !== '.githooks') acts.push({ id: `hooks:${p.path}`, kind: 'git-config', repo: p.path, key: 'core.hooksPath', value: '.githooks', label: `${p.name}: включить git-хуки памяти` });
      if (p.memory && p.upgrade.length) acts.push({ id: `kit:${p.path}`, kind: 'command', repo: p.path, label: `${p.name}: обновить набор Orchestra — ${p.upgrade.join(', ')}` });
      if (p.modeNoise && p.fileMode !== 'false') acts.push({ id: `fm:${p.path}`, kind: 'git-config', repo: p.path, key: 'core.fileMode', value: 'false', label: `${p.name}: не считать изменением смену прав файлов (${p.modeNoise})` });
    }
    return acts;
  }

  private async claudeMcp(repo: string, args: string[]) {
    const bin = (await which(this.d.config().claudePath)) || this.d.config().claudePath;
    const r = await run(bin, ['mcp', ...args], repo, { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`claude mcp ${args[0]}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
  }

  private async setMcp(repo: string, entry: McpEntry | null, current: McpEntry | null) {
    if (current) await this.claudeMcp(repo, ['remove', '--scope', 'local', 'orchestra']);
    if (entry) await this.claudeMcp(repo, ['add-json', '--scope', 'local', 'orchestra', JSON.stringify(entry)]);
  }

  private async gitConfig(repo: string, key: string, value: string | '') {
    const r = value
      ? await run('git', ['config', '--local', key, value], repo, { timeoutMs: 10_000 })
      : await run('git', ['config', '--local', '--unset', key], repo, { timeoutMs: 10_000 });
    if (r.code !== 0 && value) throw new Error(`git config ${key}: ${r.stderr.trim()}`);
  }

  private stopLater: (() => Promise<void>) | null = null;

  private async startService() {
    const { host, port } = this.endpoint;
    if (hasLaunchd()) {
      writePlist(host, port);
      // A service started by hand holds the port: stop it first, launchd takes over.
      for (const pid of await manualServicePids(port)) process.kill(pid, 'SIGTERM');
      if (await launchdLoaded()) await launchdUnload().catch(() => {});
      await launchdLoad();
    } else {
      const { spawn } = await import('child_process');
      const { serveScript } = await import('./service');
      spawn(process.execPath, [serveScript(), '--host', host, '--port', String(port)], { detached: true, stdio: 'ignore' }).unref();
    }
    for (let i = 0; i < 20 && !(await serviceAnswers(host, port, 1000)); i++) await new Promise((r) => setTimeout(r, 300));
  }

  private async stopService(svc: ServiceState) {
    const stop = async () => {
      if (svc.loaded) await launchdUnload();
      for (const pid of svc.manualPids) process.kill(pid, 'SIGTERM');
      if (this.d.insideService && !svc.loaded) setTimeout(() => process.exit(0), 300);
    };
    // Inside the service the answer must go out first.
    if (this.d.insideService) this.stopLater = stop;
    else await stop();
  }

  /** After the HTTP answer: run a deferred service stop (only inside the service). */
  async afterResponse() {
    const f = this.stopLater;
    this.stopLater = null;
    if (f) setTimeout(() => f().catch(() => {}), 400);
  }

  async apply(mode: DoctorMode): Promise<{ done: string[]; failed: string[]; stoppingSelf: boolean }> {
    const rep = await this.report();
    const acts = await this.plan(mode, rep);
    // Snapshot of everything we may change.
    const snap: Snapshot = {
      at: new Date().toISOString(),
      mode,
      service: { plist: rep.service.plist, loaded: rep.service.loaded, answers: rep.service.answers },
      mcp: {},
      git: {},
      files: {},
    };
    for (const a of acts) {
      if (!a.repo) continue;
      const p = rep.projects.find((x) => x.path === a.repo)!;
      if (a.kind.startsWith('mcp')) snap.mcp[a.repo] = p.mcp;
      if (a.kind === 'git-config') (snap.git[a.repo] ??= {})[a.key!] = a.key === 'core.hooksPath' ? p.hooksPath : p.fileMode;
      if (a.kind === 'command') for (const f of upgradeFiles(a.repo)) snap.files![f] = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    }
    for (const a of acts) {
      if (a.kind === 'global-rules') snap.files![a.key!] = fs.existsSync(a.key!) ? fs.readFileSync(a.key!, 'utf8') : null;
    }
    fs.mkdirSync(path.dirname(this.snapFile), { recursive: true });
    fs.writeFileSync(this.snapFile, JSON.stringify(snap, null, 2), { mode: 0o600 });
    const res = await this.execute(acts, rep);
    return { ...res, stoppingSelf: !!this.stopLater };
  }

  private async execute(acts: Action[], rep: DoctorReport) {
    const done: string[] = [];
    const failed: string[] = [];
    // Service first when starting (MCP entries point to it), last when stopping.
    const order = (a: Action) => (a.kind === 'service-install' ? 0 : a.kind === 'service-start' ? 1 : a.kind === 'service-stop' ? 9 : 5);
    for (const a of [...acts].sort((x, y) => order(x) - order(y))) {
      try {
        if (a.kind === 'service-install') writePlist(rep.service.host, rep.service.port);
        else if (a.kind === 'service-start') await this.startService();
        else if (a.kind === 'service-stop') await this.stopService(rep.service);
        else if (a.kind === 'mcp-set' || a.kind === 'mcp-remove') {
          const p = rep.projects.find((x) => x.path === a.repo)!;
          await this.setMcp(a.repo!, a.kind === 'mcp-set' ? a.entry! : null, p.mcp);
        } else if (a.kind === 'git-config') await this.gitConfig(a.repo!, a.key!, a.value!);
        else if (a.kind === 'global-rules') installGlobalRules();
        else if (a.kind === 'command') {
          if (a.value !== undefined) {
            // undo: restore the previous file (or remove ours)
            if (a.value === '\u0000') fs.rmSync(a.key!, { force: true });
            else fs.writeFileSync(a.key!, a.value);
          } else setupRepo(a.repo!, { gitHooks: false });
        }
        done.push(a.label);
      } catch (e: any) {
        failed.push(`${a.label}: ${e?.message ?? e}`);
      }
    }
    return { done, failed };
  }

  /** Undo the last apply: back to the saved state. */
  async undo(): Promise<{ done: string[]; failed: string[]; stoppingSelf: boolean }> {
    const snap = readJson<Snapshot | null>(this.snapFile, null);
    if (!snap) throw new Error('Отменять нечего: изменений ещё не применяли');
    const rep = await this.report();
    const acts: Action[] = [];
    const svc = rep.service;
    if (snap.service.answers && !svc.answers) acts.push({ id: 'svc-start', kind: 'service-start', label: 'Снова запустить службу Orchestra' });
    if (!snap.service.answers && (svc.answers || svc.loaded)) acts.push({ id: 'svc-stop', kind: 'service-stop', label: 'Снова остановить службу Orchestra' });
    if (!snap.service.plist && fs.existsSync(plistPath()) && !snap.service.answers) {
      /* the plist stays: harmless while not loaded */
    }
    for (const [repo, entry] of Object.entries(snap.mcp)) {
      const p = rep.projects.find((x) => x.path === repo) ?? (await this.projectState(repo, this.mcpEntries().local));
      const same = JSON.stringify(p.mcp ?? null) === JSON.stringify(entry ?? null);
      if (!same) acts.push({ id: `mcp:${repo}`, kind: entry ? 'mcp-set' : 'mcp-remove', repo, entry: entry ?? undefined, label: `${path.basename(repo)}: вернуть прежнее подключение Orchestra` });
    }
    for (const [repo, keys] of Object.entries(snap.git))
      for (const [key, value] of Object.entries(keys)) acts.push({ id: `git:${repo}:${key}`, kind: 'git-config', repo, key, value, label: `${path.basename(repo)}: вернуть ${key}${value ? ` = ${value}` : ' (не задано)'}` });
    for (const [file, prev] of Object.entries(snap.files ?? {}))
      acts.push({ id: `file:${file}`, kind: 'command', key: file, value: prev ?? '\u0000', label: `${prev == null ? 'убрать' : 'вернуть прежний'} ${file}` });
    // Projects added only during undo are not in rep.projects: add their state for execute().
    for (const repo of Object.keys(snap.mcp)) if (!rep.projects.some((x) => x.path === repo)) rep.projects.push(await this.projectState(repo, this.mcpEntries().local));
    const res = await this.execute(acts, rep);
    fs.rmSync(this.snapFile, { force: true });
    return { ...res, stoppingSelf: !!this.stopLater };
  }
}
