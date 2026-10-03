#!/usr/bin/env node
/**
 * orchestra-memory: project memory, wiki discipline and logs for one repository.
 * Run inside the repository (or pass --repo). `orchestra-memory help` lists commands.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { ProjectMemory, checkHandoff, checkManualLog } from './store';
import { APPROVE_RE, approveLatest, checkBrief, describe as describeBrief, listBriefs } from './brief';
import { setupRepo } from './setup';
import { GUARD_DEFAULTS, GuardConfig, GRANT_RE, REVOKE_RE, decide, detectPushDeploys, grant, revoke } from './guard';
import { Lang, appLanguage, pick, projectLanguage } from './lang';

type Args = { _: string[]; [k: string]: string | string[] | boolean | undefined };

function parse(argv: string[]): Args {
  const a: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const v = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      const prev = a[k];
      if (prev === undefined) a[k] = v as any;
      else a[k] = ([] as any[]).concat(prev, v);
    } else a._.push(t);
  }
  return a;
}
const list = (v: unknown): string[] => (v === undefined || v === true ? [] : ([] as string[]).concat(v as any).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean));
const many = (v: unknown): string[] => (v === undefined || v === true ? [] : ([] as string[]).concat(v as any).map(String).filter(Boolean));
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? String(v[v.length - 1]) : undefined);

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }).toString().trim();
  } catch {
    return '';
  }
}

function repoRoot(start: string): string {
  return git(start, ['rev-parse', '--show-toplevel']) || start;
}

function author(): string {
  if (process.env.ORCHESTRA_AUTHOR) return process.env.ORCHESTRA_AUTHOR;
  if (process.env.CLAUDECODE) return 'claude-code';
  if (Object.keys(process.env).some((k) => k.startsWith('CODEX_'))) return 'codex';
  return git(process.cwd(), ['config', 'user.name']) || pick(appLanguage(), 'человек', 'human');
}

function readStdin(): any {
  try {
    if (process.stdin.isTTY) return {};
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function out(s: string) {
  process.stdout.write(s.endsWith('\n') ? s : s + '\n');
}

function hookContext(event: string, text: string) {
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}

// ---------- init ----------

function init(root: string, a: Args) {
  const l = str(a.lang);
  const language: Lang | undefined = l === 'en' || l === 'ru' ? l : undefined;
  out(setupRepo(root, { project: str(a.project), rules: !a['no-rules'], claudeHooks: !a['no-claude-hooks'], gitHooks: !a['no-git-hooks'], language }).join('\n'));
  if (language) {
    // `--lang` pins the project's language in .memory/config.json (otherwise the project follows the app's RU/EN switch).
    const f = path.join(root, '.memory', 'config.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    raw.language = language;
    fs.writeFileSync(f, JSON.stringify(raw, null, 2) + '\n');
  }
}

// ---------- commit helpers ----------

/** The commit message, read from the parent `git commit` command line (pre-commit has no access to it otherwise). */
/** argv of a process: exact on Linux (/proc), best effort via `ps` elsewhere (macOS). */
function procArgs(pid: number): { argv?: string[]; line: string } {
  const proc = `/proc/${pid}/cmdline`;
  if (fs.existsSync(proc)) {
    const argv = fs.readFileSync(proc).toString('utf8').split('\0').filter((x, i, a) => x !== '' || i < a.length - 1);
    return { argv, line: argv.join(' ') };
  }
  return { line: execFileSync('ps', ['-o', 'args=', '-p', String(pid)]).toString('utf8').trim() };
}

function parentPid(pid: number): number {
  const stat = `/proc/${pid}/stat`;
  if (fs.existsSync(stat)) {
    const s = fs.readFileSync(stat, 'utf8');
    return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]);
  }
  return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim());
}

const firstLine = (s: string) => s.trim().split('\n')[0].slice(0, 200) || undefined;

function messageFromArgv(argv: string[]): string | undefined {
  const i = argv.indexOf('commit');
  if (i < 0) return undefined;
  const msgs: string[] = [];
  for (let k = i + 1; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--') break;
    if (a.startsWith('--message=')) msgs.push(a.slice(10));
    else if (a === '--message') msgs.push(argv[++k] ?? '');
    else if (a.startsWith('--file=')) return fileMsg(a.slice(7));
    else if (a === '--file') return fileMsg(argv[++k] ?? '');
    else if (/^-[a-zA-Z]+$/.test(a) && !a.startsWith('--')) {
      // Combined short flags: -qm "msg", -am "msg", -mMSG is handled below.
      const letters = a.slice(1);
      const mi = letters.indexOf('m');
      const fi = letters.indexOf('F');
      if (mi >= 0) msgs.push(mi === letters.length - 1 ? argv[++k] ?? '' : letters.slice(mi + 1));
      else if (fi >= 0) return fileMsg(fi === letters.length - 1 ? argv[++k] ?? '' : letters.slice(fi + 1));
    } else if (/^-[a-zA-Z]*m./.test(a)) msgs.push(a.slice(a.indexOf('m') + 1));
  }
  return msgs.length ? firstLine(msgs[0]) : undefined;
}

function fileMsg(f: string): string | undefined {
  if (f === '-' || !f || !fs.existsSync(f)) return undefined;
  return firstLine(fs.readFileSync(f, 'utf8'));
}

/** The commit message, read from the parent `git commit` command line (pre-commit has no access to it otherwise). */
function commitMessageFromParent(): string | undefined {
  try {
    // hook script (sh) → git commit; sometimes an extra wrapper in between.
    let pid = process.ppid;
    for (let depth = 0; depth < 4 && pid > 1; depth++) {
      const { argv, line } = procArgs(pid);
      if (argv) {
        if (argv.some((a) => /(^|\/)git$/.test(a)) && argv.includes('commit')) return messageFromArgv(argv);
      } else if (/\bgit\b.*\bcommit\b/.test(line)) {
        const m = line.match(/(?:^|\s)(?:-[a-zA-Z]*m|--message=?)\s*("?)(.+?)\1(?=\s+-[a-zA-Z-]|\s*$)/);
        if (m) return firstLine(m[2]);
        const f = line.match(/(?:-F|--file)[= ](\S+)/);
        return f ? fileMsg(f[1]) : undefined;
      }
      pid = parentPid(pid);
    }
  } catch {
    /* not critical */
  }
  return undefined;
}

function memoryOnly(files: string[], m: ProjectMemory) {
  const cfg = m.config();
  return files.every((f) => f.startsWith('.memory/') || f === cfg.changelog || f === cfg.journal);
}

function autoClose(m: ProjectMemory, why: string) {
  const L = m.config().language;
  const s = m.session();
  if (!s) return;
  const files = m.changedFiles(s);
  const commits = s.startCommit ? git(m.root, ['log', '--format=%h', `${s.startCommit}..HEAD`]).split('\n').filter(Boolean) : [];
  if (!files.length && !commits.length) {
    m.log({ type: 'session_end', author: s.author, description: pick(L, `сессия без изменений (${why})`, `session without changes (${why})`), details: { auto: true } });
    // Just forget it: nothing for the human journal.
    const f = path.join(path.resolve(m.root, git(m.root, ['rev-parse', '--git-dir']) || '.git'), 'orchestra-memory-session.json');
    fs.rmSync(f, { force: true });
    return;
  }
  m.sessionEnd({
    author: s.author,
    auto: true,
    summary: pick(
      L,
      `Итог сессии агент не записал (${why}). Изменено файлов: ${files.length}${commits.length ? `, коммитов: ${commits.length}` : ''}.`,
      `The agent did not record a session summary (${why}). Files changed: ${files.length}${commits.length ? `, commits: ${commits.length}` : ''}.`,
    ),
  });
}

// ---------- hooks ----------

const QUIET_CMD = /^\s*(ls|cat|head|tail|less|grep|rg|find|pwd|echo|which|wc|tree|file|stat|git (status|diff|log|show|branch|add|commit|push|fetch|pull|remote|rev-parse|config)|orchestra-memory)\b/;

function guardConfig(root: string): GuardConfig {
  const own = ProjectMemory.exists(root) ? new ProjectMemory(root).config().prodGuard ?? {} : {};
  return { ...GUARD_DEFAULTS, pushDeploys: own.pushDeploys ?? detectPushDeploys(root), ...own };
}

async function hook(name: string, a: Args) {
  const input = ['session-start', 'prompt', 'tool', 'session-end', 'guard'].includes(name) ? readStdin() : {};
  const root = repoRoot(input.cwd || process.cwd());
  const L = projectLanguage(root);
  // The prod guard works even where memory is off (Orchestra workers): that is exactly who it must stop.
  if (name === 'guard') {
    const d = decide(String(input.tool_name ?? ''), input.tool_input ?? {}, root, guardConfig(root), !!process.env.ORCHESTRA_WORKER, L);
    const note = (text: string) => {
      if (!process.env.ORCHESTRA_MEMORY_OFF && ProjectMemory.exists(root)) new ProjectMemory(root).log({ type: 'guard', author: author(), description: text });
    };
    const cmd = String(input.tool_input?.command ?? input.tool_input?.file_path ?? '').replace(/\s+/g, ' ').slice(0, 300);
    if (d.decision === 'deny') {
      note(pick(L, `сторож прода остановил: ${cmd} — ${d.reason.split('.')[0]}`, `the prod guard stopped: ${cmd}: ${d.reason.split('.')[0]}`));
      out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${pick(L, 'Сторож прода', 'Prod guard')}: ${d.reason}` } }));
    } else if (d.decision === 'allowed-by-owner') note(pick(L, `команда к проду по разрешению владельца (до ${d.until.slice(11, 16)} UTC): ${cmd}`, `a production command by the owner's permission (until ${d.until.slice(11, 16)} UTC): ${cmd}`));
    return;
  }
  let grantNote = '';
  if (name === 'prompt' && !process.env.ORCHESTRA_WORKER) {
    const p = String(input.prompt ?? '');
    if (REVOKE_RE.test(p)) {
      revoke(root);
      grantNote = pick(L, 'Владелец отозвал разрешение на команды к проду.', 'The owner revoked the permission for production commands.');
    } else if (GRANT_RE.test(p)) {
      const minutes = guardConfig(root).minutes;
      const g = grant(root, p, minutes);
      if (ProjectMemory.exists(root)) new ProjectMemory(root).log({ type: 'guard', author: pick(L, 'владелец', 'owner'), description: pick(L, `владелец разрешил команды к проду до ${g.until.slice(11, 16)} UTC`, `the owner allowed production commands until ${g.until.slice(11, 16)} UTC`), details: { phrase: g.phrase } });
      const untilT = new Date(g.until).toLocaleTimeString(pick(L, 'ru-RU', 'en-GB'), { hour: '2-digit', minute: '2-digit' });
      grantNote = pick(
        L,
        `Владелец разрешил команды к проду в этом проекте на ${minutes} мин (до ${untilT}). Выполняй только то, о чём договорились, и покажи вывод. Отозвать: «запрещаю прод».`,
        `The owner allowed production commands in this project for ${minutes} min (until ${untilT}). Do only what was agreed and show the output. To revoke: «revoke prod».`,
      );
    }
    if (grantNote && (process.env.ORCHESTRA_MEMORY_OFF || !ProjectMemory.exists(root))) return hookContext('UserPromptSubmit', grantNote);
  }

  if (process.env.ORCHESTRA_MEMORY_OFF || !ProjectMemory.exists(root)) return;
  const m = new ProjectMemory(root);
  const cfg = m.config();
  const who = author();

  switch (name) {
    case 'session-start': {
      const s = m.session();
      if (s && s.agentSession && input.session_id && s.agentSession !== input.session_id && m.minutesInSession() > cfg.sessionMinutes) autoClose(m, pick(L, 'новая сессия агента', 'a new agent session'));
      m.sessionStart(who, undefined, input.session_id);
      hookContext(
        'SessionStart',
        pick(
          L,
          `Память проекта ${cfg.project} (правила в CLAUDE.md, блок «Память проекта»). Перед задачей смотри факты и решения: orchestra-memory context "<задача>". Микросессия ${cfg.sessionMinutes} мин, в конце — orchestra-memory session-end. wiki (${cfg.wikiDir}/) обновляется вместе с кодом.`,
          `Project memory of ${cfg.project} (rules in CLAUDE.md, the «Project memory» block). Before a task look at the facts and decisions: orchestra-memory context "<task>". A micro-session is ${cfg.sessionMinutes} min, at the end run orchestra-memory session-end. The wiki (${cfg.wikiDir}/) is updated together with the code.`,
        ) + `\n\n${m.context('', 4000)}`,
      );
      return;
    }
    case 'prompt': {
      m.sessionStart(who, undefined, input.session_id);
      const parts: string[] = grantNote ? [grantNote] : [];
      const prompt = String(input.prompt ?? '');
      // Real wall-clock time from the machine, not the model's guess.
      const nowLocal = new Date().toLocaleString(pick(L, 'ru-RU', 'en-GB'), { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      parts.push(pick(L, `Сейчас: ${nowLocal}; в работе ${Math.round(m.minutesInSession())} мин из ${cfg.sessionMinutes}.`, `Now: ${nowLocal}; ${Math.round(m.minutesInSession())} of ${cfg.sessionMinutes} min in progress.`));
      if (APPROVE_RE.test(prompt)) {
        const c = approveLatest(root);
        if (c?.approved) {
          m.log({ type: 'decision', author: pick(L, 'владелец', 'owner'), description: pick(L, `бриф утверждён: ${c.file}`, `brief approved: ${c.file}`), files: [c.file] });
          parts.push(pick(L, `Владелец утвердил бриф ${c.file} (утверждение привязано к этой версии файла; изменишь бриф — утверждение сбросится). Можно выполнять.`, `The owner approved the brief ${c.file} (the approval is bound to this version of the file; if you change the brief the approval resets). Ready to execute.`));
        } else if (c) parts.push(pick(L, `Владелец написал «утверждаю», но бриф не утверждён:\n${describeBrief(c, L)}\nИсправь и покажи владельцу снова.`, `The owner wrote «approve the brief», but the brief is not approved:\n${describeBrief(c, L)}\nFix it and show it to the owner again.`));
      }
      if (/свеж[а-яё]* выжимк|дай выжимк|что сделано за|fresh digest|give me (a )?digest|what was done (since|for|in)/i.test(prompt)) parts.push(`${pick(L, 'Запрос выжимки. Последние записи лога', 'A digest was requested. The latest log records')}:\n${m.digest({ limit: 40 })}`);
      const hits = prompt ? m.search(prompt, 6).filter((h) => h.score >= 2) : [];
      if (hits.length) parts.push(pick(L, 'Из памяти проекта по этой теме', 'From the project memory on this topic') + ':\n' + hits.map((h) => {
        const it: any = h.item;
        return h.kind === 'fact' ? `- ${pick(L, 'факт', 'fact')} ${it.id}: ${it.text}` : h.kind === 'decision' ? `- ${pick(L, 'решение', 'decision')} ${it.id} ${it.title}: ${it.decision} (${pick(L, 'почему', 'why')}: ${it.why})` : `- ${it.ts.slice(0, 10)} ${it.type}: ${it.description}`;
      }).join('\n'));
      const s = m.session();
      const mins = m.minutesInSession();
      const last = s?.remindedAt ? (Date.now() - Date.parse(s.remindedAt)) / 60_000 : Infinity;
      if (mins >= cfg.sessionMinutes && last > 10) {
        parts.push(pick(L, `Микросессия идёт ${Math.round(mins)} мин (норма ${cfg.sessionMinutes}). Закончи текущий шаг, обнови wiki и закрой сессию: orchestra-memory session-end --summary … --done … --next … --details '{…}'. Следующая работа начнётся новой сессией автоматически.`, `The micro-session has been running ${Math.round(mins)} min (norm ${cfg.sessionMinutes}). Finish the current step, update the wiki and close the session: orchestra-memory session-end --summary … --done … --next … --details '{…}'. The next work starts a new session automatically.`));
        m.markSession({ remindedAt: new Date().toISOString() });
      }
      if (parts.length) hookContext('UserPromptSubmit', parts.join('\n\n'));
      return;
    }
    case 'tool': {
      const tool = String(input.tool_name ?? '');
      const ti = input.tool_input ?? {};
      m.sessionStart(who, undefined, input.session_id);
      if (tool === 'Bash') {
        const cmd = String(ti.command ?? '');
        if (!cmd || QUIET_CMD.test(cmd)) return;
        m.log({ type: 'command', author: who, description: cmd.replace(/\s+/g, ' ').slice(0, 300) });
        return;
      }
      const file = ti.file_path ?? ti.notebook_path;
      if (!file) return;
      const rel = path.relative(root, path.resolve(root, String(file)));
      if (rel.startsWith('.memory/')) return;
      if (rel.startsWith(cfg.wikiDir.replace(/\/?$/, '/'))) m.markSession({ wikiTouched: true });
      m.log({ type: 'edit', author: who, description: `${tool} ${rel}`, files: [rel] });
      return;
    }
    case 'session-end': {
      autoClose(m, pick(L, 'сессия агента завершилась', 'the agent session ended'));
      return;
    }
    case 'pre-commit': {
      const staged = git(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
      if (!staged.length || memoryOnly(staged, m)) return;
      const s = m.session();
      if (s && m.minutesInSession() > cfg.sessionMinutes * 1.5) autoClose(m, pick(L, 'коммит после окончания микросессии', 'a commit after the micro-session ended'));
      if (!m.session()) m.sessionStart(who);
      const wikiPrefix = cfg.wikiDir.replace(/\/?$/, '/');
      const code = staged.filter((f) => !f.startsWith(wikiPrefix) && !f.startsWith('.memory/') && f !== cfg.changelog);
      const wiki = staged.filter((f) => f.startsWith(wikiPrefix) && f !== cfg.journal);
      const msg = commitMessageFromParent();
      m.log({ type: 'commit', author: who, description: msg ? `${pick(L, 'коммит', 'commit')}: ${msg}` : `${pick(L, 'коммит', 'commit')}: ${staged.length} ${pick(L, 'файл.', 'files')}`, files: staged });
      if (code.length && !wiki.length && !m.session()?.wikiTouched) {
        const text = pick(L, `wiki (${cfg.wikiDir}/) не обновлена, а в коммите изменения кода: ${code.slice(0, 5).join(', ')}${code.length > 5 ? '…' : ''}`, `the wiki (${cfg.wikiDir}/) is not updated, but the commit changes code: ${code.slice(0, 5).join(', ')}${code.length > 5 ? '…' : ''}`);
        if (cfg.requireWiki) {
          process.stderr.write(pick(L, `orchestra-memory: коммит остановлен: ${text}. Обновите wiki или отключите requireWiki в .memory/config.json.\n`, `orchestra-memory: commit stopped: ${text}. Update the wiki or turn requireWiki off in .memory/config.json.\n`));
          process.exit(1);
        }
        process.stderr.write(pick(L, `orchestra-memory: внимание: ${text}.\n`, `orchestra-memory: warning: ${text}.\n`));
      }
      const paths = m.memoryPaths();
      if (paths.length) git(root, ['add', '--', ...paths]);
      return;
    }
    case 'pre-push': {
      const paths = m.memoryPaths();
      const dirty = git(root, ['status', '--porcelain', '--', ...paths]);
      if (!dirty) return;
      git(root, ['add', '--', ...paths]);
      git(root, ['commit', '--no-verify', '-q', '-m', pick(L, 'chore(memory): журнал, память и wiki', 'chore(memory): journal, memory and wiki')], { ORCHESTRA_MEMORY_OFF: '1' });
      process.stderr.write(pick(L, 'orchestra-memory: память и журнал дописаны отдельным коммитом. Повторите git push, чтобы отправить их вместе с кодом.\n', 'orchestra-memory: memory and the journal were appended as a separate commit. Repeat git push to send them together with the code.\n'));
      process.exit(1);
    }
  }
}

// ---------- main ----------

const HELP = `orchestra-memory: память проекта, wiki и логи

  init [--project Имя]        создать .memory/, wiki/, CHANGELOG.md, правила в CLAUDE.md/AGENTS.md, хуки
  context "<задача>"          факты, решения и прошлая работа по теме (перед задачей)
  search "<слова>"            поиск по фактам, решениям и логу
  add-fact "<факт>" [--tags a,b] [--files f] [--source s] [--supersedes F-0001]
  add-decision --title T --decision D --why W [--alt A]… [--files f] [--facts F-1] [--supersedes D-1]
  log --type feature|fix|change|security|test|deploy|docs|cleanup|note --why "<зачем>" [--files f] "<описание>" [--details '{json}']
                              (--why обязательно для feature, fix, change, security, deploy, cleanup, refactor, removed;
                               ручная чистка данных без устранения причины — cleanup, не fix)
  session-start [--goal "…"]  начать микросессию (обычно делает хук)
  session-end --summary "…" [--done …]… [--why …] [--gate …]×≤3 [--next "одна задача"] [--details '{json}']
  brief check [файл]          бриф из /orchestra: все ли разделы, нет ли заглушек, утверждён ли (код выхода 0 — можно выполнять)
  brief list                  брифы проекта и их состояние
  status                      текущая сессия и размеры памяти
  digest [--limit 60] [--since 2026-09-01]   свежая выжимка по логу
  changelog --draft           значимые события с прошлого обновления CHANGELOG
  changelog --write file.md [--release "этап"]  внести выжимку (разделы ### Added / ### Fixed …) в CHANGELOG.md
  push [аргументы git push]   дописать память отдельным коммитом, если нужно, и сделать git push
  hook <session-start|prompt|tool|session-end|pre-commit|pre-push>   для хуков

Общие флаги: --repo <путь> (по умолчанию текущий репозиторий), --author <имя>`;

const HELP_EN = `orchestra-memory: project memory, wiki and logs

  init [--project Name] [--lang en|ru]   create .memory/, wiki/, CHANGELOG.md, rules in CLAUDE.md/AGENTS.md, hooks
  context "<task>"            facts, decisions and past work on the topic (before a task)
  search "<words>"            search facts, decisions and the log
  add-fact "<fact>" [--tags a,b] [--files f] [--source s] [--supersedes F-0001]
  add-decision --title "…" --decision "…" --why "…" [--alt "rejected option"]… [--files f] [--facts F-0001] [--supersedes D-0001]
  log --type feature|fix|change|security|test|deploy|docs|cleanup|note --why "<why>" [--files f] "<description>" [--details '{json}']
                              (--why is required for feature, fix, change, security, deploy, cleanup, refactor, removed;
                               a manual data cleanup that leaves the cause in place is cleanup, not fix)
  session-start [--goal "…"]  start a micro-session (usually done by a hook)
  session-end --summary "…" [--done …]… [--why …] [--gate …]×≤3 [--next "one task"] [--details '{json}']
  brief check [file]          a /orchestra brief: all sections present, no placeholders, approved (exit code 0 = ready to execute)
  brief list                  the project's briefs and their state
  status                      the current session and the size of the memory
  digest [--limit 60] [--since 2026-09-01]   a fresh digest of the log
  changelog --draft           significant events since the last CHANGELOG update
  changelog --write file.md [--release "stage"]  put a digest (sections ### Added / ### Fixed …) into CHANGELOG.md
  push [git push arguments]   append memory as a separate commit if needed and run git push
  hook <session-start|prompt|tool|session-end|pre-commit|pre-push>   for hooks

Common flags: --repo <path> (default: the current repository), --author <name>`;

async function main() {
  const a = parse(process.argv.slice(2));
  const cmd = a._[0];
  if (str(a.author)) process.env.ORCHESTRA_AUTHOR = str(a.author);
  const root = repoRoot(path.resolve(str(a.repo) ?? process.cwd()));
  const L = projectLanguage(root);
  if (!cmd || cmd === 'help' || a.help) return out(pick(L, HELP, HELP_EN));
  if (cmd === 'hook') return hook(a._[1], a);
  if (cmd === 'init') return init(root, a);
  if (!ProjectMemory.exists(root)) {
    process.stderr.write(pick(L, `В ${root} нет памяти проекта. Выполните: orchestra-memory init\n`, `There is no project memory in ${root}. Run: orchestra-memory init\n`));
    process.exit(2);
  }
  const m = new ProjectMemory(root);
  const who = author();
  switch (cmd) {
    case 'context':
      return out(m.context(a._.slice(1).join(' ')));
    case 'search': {
      const hits = m.search(a._.slice(1).join(' '), Number(str(a.limit) ?? 10));
      return out(hits.length ? hits.map((h) => `${h.kind}\t${h.score.toFixed(1)}\t${JSON.stringify(h.item)}`).join('\n') : pick(L, 'ничего не найдено', 'nothing found'));
    }
    case 'add-fact': {
      const f = m.addFact({ text: a._.slice(1).join(' '), tags: list(a.tags), files: list(a.files), source: str(a.source), author: who, supersedes: str(a.supersedes) });
      return out(`${f.id}: ${f.text}`);
    }
    case 'add-decision': {
      if (!str(a.title) || !str(a.decision) || !str(a.why)) throw new Error(pick(L, 'нужны --title, --decision и --why', '--title, --decision and --why are required'));
      const d = m.addDecision({ title: str(a.title)!, decision: str(a.decision)!, why: str(a.why)!, alternatives: many(a.alt), consequences: str(a.consequences), files: list(a.files), facts: list(a.facts), tags: list(a.tags), author: who, supersedes: str(a.supersedes) });
      return out(`${d.id}: ${d.title}`);
    }
    case 'log': {
      let details: unknown;
      if (str(a.details)) details = JSON.parse(str(a.details)!);
      const type = str(a.type) ?? 'note';
      checkManualLog(type, str(a.why), L);
      const e = m.log({ type, author: who, description: a._.slice(1).join(' '), files: list(a.files), details, tags: list(a.tags), why: str(a.why) });
      return out(e.id);
    }
    case 'session-start':
      return out(m.sessionStart(who, str(a.goal)).id);
    case 'session-end': {
      if (!str(a.summary)) throw new Error(pick(L, 'нужен --summary: 2–3 понятных предложения для владельца', '--summary is required: 2–3 plain sentences for the owner'));
      let details: unknown;
      if (str(a.details)) {
        try {
          details = JSON.parse(str(a.details)!);
        } catch {
          details = str(a.details);
        }
      }
      checkHandoff(many(a.gate), many(a.next), L);
      if (!m.session()) m.sessionStart(who);
      const r = m.sessionEnd({ author: who, summary: str(a.summary)!, done: many(a.done), why: str(a.why), gates: many(a.gate), next: many(a.next), details });
      return out(pick(L, `Сессия закрыта (${r.event.id}). Журнал: ${m.config().journal}${r.warnings.length ? '\nВнимание: ' + r.warnings.join('; ') : ''}`, `Session closed (${r.event.id}). Journal: ${m.config().journal}${r.warnings.length ? '\nWarning: ' + r.warnings.join('; ') : ''}`));
    }
    case 'brief': {
      const sub = a._[1];
      if (sub === 'list') return out(listBriefs(root).map((f) => describeBrief(checkBrief(root, f), L).split('\n').slice(0, 2).join(' ')).join('\n') || pick(L, 'Брифов нет.', 'No briefs.'));
      const file = a._[2] ?? (sub !== 'check' ? sub : undefined) ?? listBriefs(root)[0];
      if (!file) throw new Error(pick(L, 'брифов нет: /orchestra сохраняет их в .memory/briefs/', 'no briefs: /orchestra saves them in .memory/briefs/'));
      const c = checkBrief(root, file);
      out(describeBrief(c, L));
      process.exitCode = c.ok ? 0 : 1;
      return;
    }
    case 'status': {
      const s = m.session();
      return out(
        [
          s
            ? pick(L, `Сессия ${s.id} (${s.author}), идёт ${Math.round(m.minutesInSession())} мин из ${m.config().sessionMinutes}${s.wikiTouched ? ', wiki обновлялась' : ''}`, `Session ${s.id} (${s.author}), ${Math.round(m.minutesInSession())} of ${m.config().sessionMinutes} min in progress${s.wikiTouched ? ', the wiki was updated' : ''}`)
            : pick(L, 'Активной сессии нет', 'No active session'),
          pick(L, `Фактов: ${m.facts().filter((f) => f.status === 'active').length}, решений: ${m.decisions().filter((d) => d.status === 'active').length}, событий в логе: ${m.readLog().length}`, `Facts: ${m.facts().filter((f) => f.status === 'active').length}, decisions: ${m.decisions().filter((d) => d.status === 'active').length}, log events: ${m.readLog().length}`),
        ].join('\n'),
      );
    }
    case 'digest':
      return out(m.digest({ since: str(a.since), limit: Number(str(a.limit) ?? 60) }));
    case 'changelog': {
      if (a.draft || (!a.write && !a.release)) {
        const c = m.changelogCandidates();
        const body = Object.entries(c)
          .map(([sec, evs]) => `### ${sec}\n` + evs.map((e) => `- ${e.ts.slice(0, 10)} ${e.author}: ${e.description}`).join('\n'))
          .join('\n\n');
        return out(body || pick(L, 'С прошлого обновления CHANGELOG значимых событий нет.', 'No significant events since the last CHANGELOG update.'));
      }
      const file = str(a.write);
      const sections: Record<string, string[]> = {};
      if (file) {
        let cur = '';
        for (const line of fs.readFileSync(path.resolve(file), 'utf8').split('\n')) {
          const h = line.match(/^#+\s*([\p{L}]+)/u);
          if (h) cur = h[1][0].toUpperCase() + h[1].slice(1).toLowerCase();
          else if (cur && /^\s*[-*]\s+/.test(line)) (sections[cur] ??= []).push(line.replace(/^\s*[-*]\s+/, ''));
        }
      }
      m.writeChangelog(sections, str(a.release));
      return out(pick(L, `CHANGELOG обновлён: ${m.config().changelog}`, `CHANGELOG updated: ${m.config().changelog}`));
    }
    case 'push': {
      const paths = m.memoryPaths();
      if (git(root, ['status', '--porcelain', '--', ...paths])) {
        git(root, ['add', '--', ...paths]);
        git(root, ['commit', '--no-verify', '-q', '-m', pick(L, 'chore(memory): журнал, память и wiki', 'chore(memory): journal, memory and wiki')], { ORCHESTRA_MEMORY_OFF: '1' });
      }
      const r = spawnSync('git', ['push', ...a._.slice(1)], { cwd: root, stdio: 'inherit', env: { ...process.env, ORCHESTRA_MEMORY_OFF: '1' } });
      process.exit(r.status ?? 1);
    }
    default:
      out(pick(L, HELP, HELP_EN));
      process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`orchestra-memory: ${e?.message ?? e}\n`);
  process.exit(1);
});
