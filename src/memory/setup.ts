import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ProjectMemory } from './store';
import { agentRules, RULES_START, RULES_END, GIT_HOOK, CLAUDE_HOOKS, orchestraCommand, AGENT_ROLES, invariantsTemplate } from './templates';
import { Lang, appAutoMemory, pick, projectLanguage } from './lang';
import { detectPushDeploys } from './guard';

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch {
    return '';
  }
}

/** Put the memory rules block into CLAUDE.md / AGENTS.md, replacing an older version of the block only. */
export function upsertRules(file: string, lang?: Lang) {
  const AGENT_RULES = agentRules(lang);
  let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`${RULES_START}[\\s\\S]*?${RULES_END}\\n?`);
  body = re.test(body) ? body.replace(re, AGENT_RULES) : (body.trimEnd() ? body.trimEnd() + '\n\n' : '') + AGENT_RULES;
  fs.writeFileSync(file, body);
}

/** Add our Claude Code hooks to .claude/settings.json, keeping the owner's own hooks. */
export function mergeClaudeSettings(file: string) {
  let cfg: any = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* new file */
  }
  cfg.hooks ??= {};
  for (const [event, entries] of Object.entries(CLAUDE_HOOKS)) {
    const cur: any[] = cfg.hooks[event] ?? [];
    const ours = (e: any) => JSON.stringify(e).includes('orchestra-memory hook');
    cfg.hooks[event] = [...cur.filter((e) => !ours(e)), ...entries];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

export function commandPath(root: string) {
  return path.join(root, '.claude', 'commands', 'orchestra.md');
}

/** Files Orchestra keeps up to date in a repository: the /orchestra command and the subagent roles. */
export function kitFiles(root: string): Array<{ file: string; body: string; mark: string }> {
  return [
    { file: commandPath(root), body: orchestraCommand(projectLanguage(root)), mark: 'orchestra-command' },
    ...Object.entries(AGENT_ROLES).map(([name, body]) => ({ file: path.join(root, '.claude', 'agents', `${name}.md`), body, mark: 'orchestra-role' })),
  ];
}

type KitState = 'missing' | 'current' | 'outdated' | 'custom';
function fileState(f: { file: string; body: string; mark: string }): KitState {
  if (!fs.existsSync(f.file)) return 'missing';
  const body = fs.readFileSync(f.file, 'utf8');
  if (body === f.body) return 'current';
  return body.includes(f.mark) ? 'outdated' : 'custom';
}

/** Overall state of the kit: missing/outdated if any of our files needs installing; custom files are left alone. */
export function commandState(root: string): KitState {
  const st = kitFiles(root).map(fileState);
  if (st.includes('missing')) return 'missing';
  if (st.includes('outdated')) return 'outdated';
  if (st.every((x) => x === 'custom')) return 'custom';
  return 'current';
}

/** Files the kit would write now (missing or outdated ones of ours). */
export function kitPending(root: string): string[] {
  return kitFiles(root).filter((f) => ['missing', 'outdated'].includes(fileState(f))).map((f) => f.file);
}

/** Install or update the /orchestra command and the roles; the owner's own files are left alone. Returns written files. */
export function installKit(root: string): string[] {
  const written: string[] = [];
  for (const f of kitFiles(root)) {
    if (!['missing', 'outdated'].includes(fileState(f))) continue;
    fs.mkdirSync(path.dirname(f.file), { recursive: true });
    fs.writeFileSync(f.file, f.body);
    written.push(f.file);
  }
  return written;
}

/** Back-compat: true when something was installed or all is current. */
export function installCommand(root: string): boolean {
  installKit(root);
  return commandState(root) !== 'custom';
}

/**
 * Turn memory on for a repository: .memory/, wiki/, CHANGELOG.md, rules for agents, Claude Code hooks, git hooks.
 * Idempotent; never overwrites the owner's content. Returns report lines.
 */
export function setupRepo(root: string, o: { project?: string; rules?: boolean; claudeHooks?: boolean; gitHooks?: boolean; language?: Lang } = {}): string[] {
  const m = new ProjectMemory(root);
  const lang = o.language ?? projectLanguage(root);
  const created = m.init(o.project);
  if (o.rules !== false) {
    upsertRules(path.join(root, 'CLAUDE.md'), lang);
    upsertRules(path.join(root, 'AGENTS.md'), lang);
  }
  if (o.claudeHooks !== false) mergeClaudeSettings(path.join(root, '.claude', 'settings.json'));
  const kit = o.claudeHooks !== false ? installKit(root) : [];
  // Invariants: created once, then the owner's.
  const cfgNow = m.config();
  const inv = path.join(root, cfgNow.wikiDir, 'INVARIANTS.md');
  if (!fs.existsSync(inv)) {
    fs.mkdirSync(path.dirname(inv), { recursive: true });
    fs.writeFileSync(inv, invariantsTemplate(cfgNow.project, lang));
  }
  // Prod guard settings, visible to the owner in .memory/config.json.
  const cfgFile = path.join(root, '.memory', 'config.json');
  const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  if (!raw.prodGuard) {
    raw.prodGuard = { enabled: true, pushDeploys: detectPushDeploys(root), minutes: 20, extra: [] };
    fs.writeFileSync(cfgFile, JSON.stringify(raw, null, 2) + '\n');
  }
  let hooksNote = '';
  if (o.gitHooks !== false) {
    const current = git(root, ['config', '--get', 'core.hooksPath']);
    if (current && current !== '.githooks') hooksNote = pick(lang, `core.hooksPath уже указывает на «${current}»: git-хуки не установлены, добавьте вызов \`orchestra-memory hook <имя>\` в свои хуки сами.`, `core.hooksPath already points to «${current}»: git hooks are not installed, add a call to \`orchestra-memory hook <name>\` to your own hooks.`);
    else {
      const dir = path.join(root, '.githooks');
      fs.mkdirSync(dir, { recursive: true });
      for (const h of ['pre-commit', 'pre-push']) {
        fs.writeFileSync(path.join(dir, h), GIT_HOOK(h, lang));
        fs.chmodSync(path.join(dir, h), 0o755);
      }
      git(root, ['config', 'core.hooksPath', '.githooks']);
    }
  }
  return [
    pick(lang, `Память проекта готова: ${root}`, `Project memory is ready: ${root}`),
    created.length ? pick(lang, `Создано: ${created.join(', ')}`, `Created: ${created.join(', ')}`) : pick(lang, 'Всё уже было на месте, ничего не перезаписано.', 'Everything was already in place, nothing overwritten.'),
    pick(lang, 'Правила для агентов: CLAUDE.md и AGENTS.md (блок orchestra-memory).', 'Rules for agents: CLAUDE.md and AGENTS.md (the orchestra-memory block).'),
    pick(lang, 'Хуки Claude Code: .claude/settings.json. Git-хуки: .githooks (core.hooksPath).', 'Claude Code hooks: .claude/settings.json. Git hooks: .githooks (core.hooksPath).'),
    kit.length
      ? pick(lang, `Установлено: ${kit.map((f) => path.relative(root, f)).join(', ')} (команда /orchestra и роли scout, applier, reviewer).`, `Installed: ${kit.map((f) => path.relative(root, f)).join(', ')} (the /orchestra command and the roles scout, applier, reviewer).`)
      : pick(lang, 'Команда /orchestra и роли — уже на месте.', 'The /orchestra command and the roles are already in place.'),
    pick(
      lang,
      `Сторож прода: включён${raw.prodGuard.pushDeploys ? ', push в main выкладывает прод — тоже под сторожем' : ''} (.memory/config.json → prodGuard). Разрешение — фраза владельца «разрешаю прод».`,
      `Prod guard: on${raw.prodGuard.pushDeploys ? ', a push to main deploys to production, so it is guarded too' : ''} (.memory/config.json → prodGuard). Permission is the owner's phrase «allow prod».`,
    ),
    pick(lang, 'Инварианты: wiki/INVARIANTS.md — допишите свои.', 'Invariants: wiki/INVARIANTS.md: add your own.'),
    hooksNote,
    pick(lang, 'Закоммитьте эти файлы. На другой машине после git clone выполните `orchestra-memory init` ещё раз, чтобы включить git-хуки.', 'Commit these files. On another machine after git clone run `orchestra-memory init` again to turn the git hooks on.'),
  ].filter(Boolean);
}

/**
 * What `init` would bring up to date in a repository that already has memory (diagnostics uses this):
 * rules block, Claude Code hooks (prod guard), /orchestra command and roles, invariants, guard settings.
 */
export function upgradeNeeds(root: string): string[] {
  const needs: string[] = [];
  const rulesOf = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  for (const f of ['CLAUDE.md', 'AGENTS.md']) if (!rulesOf(path.join(root, f)).includes(agentRules(projectLanguage(root)).trim())) needs.push(`правила в ${f}`);
  const settings = rulesOf(path.join(root, '.claude', 'settings.json'));
  if (!settings.includes('hook guard')) needs.push('сторож прода');
  const kit = kitPending(root).map((f) => path.basename(f, '.md'));
  if (kit.length) needs.push(kit.includes('orchestra') ? `команда /orchestra${kit.length > 1 ? ' и роли' : ''}` : 'роли агентов');
  const cfg = new ProjectMemory(root).config();
  if (!fs.existsSync(path.join(root, cfg.wikiDir, 'INVARIANTS.md'))) needs.push('инварианты');
  if (!cfg.prodGuard) needs.push('настройки сторожа');
  return needs;
}

/** Files `setupRepo` may touch, for the diagnostics' undo snapshot. */
export function upgradeFiles(root: string): string[] {
  const cfg = new ProjectMemory(root).config();
  return [
    path.join(root, 'CLAUDE.md'),
    path.join(root, 'AGENTS.md'),
    path.join(root, '.claude', 'settings.json'),
    path.join(root, cfg.wikiDir, 'INVARIANTS.md'),
    path.join(root, '.memory', 'config.json'),
    ...kitFiles(root).map((f) => f.file),
  ];
}

// ---------- memory by itself, on first use ----------

export interface EnsureResult {
  created: boolean;
  /** The branch had no memory, but another one did: its files were taken over, so a later merge has nothing to fight over. */
  adoptedFrom?: string;
  skipped?: 'exists' | 'off' | 'marker' | 'not-git';
}

/** Files of `ref` under `dirs` that do not exist in the working tree yet are written there (nothing is overwritten, nothing is staged). */
function adoptFrom(root: string, ref: string, dirs: string[]): number {
  let n = 0;
  const files = git(root, ['ls-tree', '-r', '--name-only', ref, '--', ...dirs]).split('\n').filter(Boolean);
  for (const f of files) {
    const dst = path.join(root, f);
    if (fs.existsSync(dst)) continue;
    try {
      const body = execFileSync('git', ['show', `${ref}:${f}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, body);
      n++;
    } catch {
      /* a file that cannot be read is skipped */
    }
  }
  return n;
}

/**
 * Project memory on first use: the first time Orchestra (a run, an MCP session, a memory tool, the CLI or a hook) touches
 * a repository or a branch without `.memory/`, it is set up there, no `init` needed. When another branch already has the
 * memory (main, master), its files are taken over first, so two branches do not create different copies and conflict later.
 * Never overwrites anything; does not commit (the run's end commits memory with the rest). Switched off by
 * `autoMemory: false`, ORCHESTRA_NO_AUTOMEMORY, or an empty file `.orchestra-no-memory` in the repository.
 */
export function ensureMemory(root: string): EnsureResult {
  if (fs.existsSync(path.join(root, '.memory', 'config.json'))) return { created: false, skipped: 'exists' };
  if (!appAutoMemory()) return { created: false, skipped: 'off' };
  if (fs.existsSync(path.join(root, '.orchestra-no-memory'))) return { created: false, skipped: 'marker' };
  if (!git(root, ['rev-parse', '--git-dir'])) return { created: false, skipped: 'not-git' };
  // The files memory touches. If the owner has uncommitted changes in them, nothing is committed for them.
  const mine = ['.memory', 'wiki', 'CHANGELOG.md', 'CLAUDE.md', 'AGENTS.md', '.claude', '.githooks'];
  const cleanBefore = !git(root, ['status', '--porcelain', '--', ...mine]).trim();
  let adoptedFrom: string | undefined;
  const here = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  for (const ref of ['main', 'master', 'origin/main', 'origin/master']) {
    if (ref === here) continue;
    const cfgText = git(root, ['show', `${ref}:.memory/config.json`]);
    if (!cfgText) continue;
    let wiki = 'wiki';
    try {
      wiki = JSON.parse(cfgText).wikiDir || 'wiki';
    } catch {
      /* default */
    }
    if (adoptFrom(root, ref, ['.memory', wiki]) > 0) {
      adoptedFrom = ref;
      break;
    }
  }
  setupRepo(root, {}); // fills in whatever is still missing: rules, hooks, command, starter pages
  try {
    new ProjectMemory(root).log({
      type: 'note',
      author: 'orchestra',
      description: adoptedFrom ? `память создана автоматически при первом обращении (взята с ветки ${adoptedFrom})` : 'память создана автоматически при первом обращении',
    });
  } catch {
    /* the journal note is a courtesy */
  }
  // One small commit with just those files: a run refuses to start in a repository with uncommitted changes, and
  // memory that is part of the history follows the branch from now on.
  if (cleanBefore) {
    try {
      const wikiDir = new ProjectMemory(root).config().wikiDir;
      for (const p of [...mine, wikiDir]) {
        if (!fs.existsSync(path.join(root, p))) continue;
        try {
          execFileSync('git', ['add', '-A', '--', p], { cwd: root, stdio: 'ignore' });
        } catch {
          /* ignored by .gitignore: leave it out */
        }
      }
      if (git(root, ['diff', '--cached', '--name-only']).trim()) {
        const staged = git(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
        execFileSync('git', ['-c', 'user.name=orchestra', '-c', 'user.email=orchestra@localhost', 'commit', '--no-verify', '-q', '-m', 'chore(memory): project memory created automatically', '--', ...staged], { cwd: root, stdio: 'ignore', env: { ...process.env, ORCHESTRA_MEMORY_OFF: '1' } });
      }
    } catch {
      /* not committed: the files stay in the working tree */
    }
  }
  return { created: true, adoptedFrom };
}
