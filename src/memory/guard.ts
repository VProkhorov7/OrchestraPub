import * as fs from 'fs';
import { Lang, pick } from './lang';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * Prod guard: a PreToolUse hook that refuses commands touching production unless the owner allowed it.
 *
 * Why a hook and not a rule in CLAUDE.md: a written rule is re-read every turn and still broken under
 * time pressure when nothing physically stops the action. The
 * Cloudflare login on the Mac is shared by every agent, so any agent can `wrangler deploy`.
 *
 * Permission comes only from the owner's own message (UserPromptSubmit fires on what a person typed,
 * an agent cannot produce it): «разрешаю прод» opens a short window for this repository. Orchestra
 * workers (ORCHESTRA_WORKER=1) never get the window.
 */

export interface GuardConfig {
  enabled: boolean;
  /** A push to main deploys (CI on push to main runs wrangler): guard pushes of main too. */
  pushDeploys: boolean;
  /** Minutes the owner's permission lasts. */
  minutes: number;
  /** Extra regular expressions (strings) of commands to guard. */
  extra: string[];
}

export const GUARD_DEFAULTS: GuardConfig = { enabled: true, pushDeploys: false, minutes: 20, extra: [] };

/** One segment of a shell command line (between ; && || | and newlines). */
const SEG = '[^|;&\\n]*';

const RULES: Array<[RegExp, string, string]> = [
  [new RegExp(`\\bwrangler\\b${SEG}\\b(deploy|publish|rollback)\\b`), 'выкладка воркера в Cloudflare (wrangler deploy)', 'a worker deploy to Cloudflare (wrangler deploy)'],
  [new RegExp(`\\bwrangler\\b${SEG}--remote\\b`), 'команда к боевым данным Cloudflare (--remote)', 'a command against live Cloudflare data (--remote)'],
  [new RegExp(`\\bwrangler\\b${SEG}\\bsecret\\s+(put|delete|bulk)\\b`), 'изменение секретов воркера', 'a change of worker secrets'],
  [new RegExp(`\\bwrangler\\b${SEG}\\b(kv|r2)\\b${SEG}\\b(put|delete)\\b(?!${SEG}--local)`), 'запись в боевые KV или R2 (без --local)', 'a write to live KV or R2 (without --local)'],
  [/\b(npm|pnpm|yarn|bun)\s+(run\s+)?deploy\b/, 'скрипт выкладки (npm run deploy)', 'a deploy script (npm run deploy)'],
  [/\bgh\s+workflow\s+run\b/, 'запуск workflow в GitHub (может выкладывать прод)', 'a GitHub workflow run (may deploy to production)'],
  [new RegExp(`\\bgit\\s+push\\b${SEG}(\\s--force\\b|\\s-f\\b|\\s--force-with-lease\\b)`), 'принудительный git push', 'a forced git push'],
];

/** The permission file lives in .git: not part of the tree, not committed. */
export function allowFile(root: string) {
  let gitDir = '.git';
  try {
    gitDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || '.git';
  } catch {
    /* not a repo */
  }
  return path.join(path.resolve(root, gitDir), 'orchestra-prod-allow.json');
}

function currentBranch(root: string) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

/** What in this command touches production, or null. */
export function prodReason(cmd: string, root: string, cfg: GuardConfig, lang?: Lang): string | null {
  const c = cmd.replace(/\\\n/g, ' ');
  for (const [re, ru, en] of RULES) if (re.test(c)) return pick(lang, ru, en);
  for (const x of cfg.extra) {
    try {
      if (new RegExp(x).test(c)) return pick(lang, `команда из списка сторожа (${x})`, `a command from the guard's list (${x})`);
    } catch {
      /* bad pattern in config */
    }
  }
  if (cfg.pushDeploys) {
    const push = new RegExp(`\\b(git\\s+push|orchestra-memory\\s+push)\\b${SEG}`).exec(c);
    if (push) {
      const seg = push[0];
      const named = /\b(main|master)\b/.test(seg);
      const other = /\s(origin|upstream)\s+(?!main\b|master\b)[\w./-]+/.test(seg) || /\s[\w./-]+:(?!main\b|master\b)/.test(seg);
      if (named || (!other && /^(main|master)$/.test(currentBranch(root)))) return pick(lang, 'push в main — в этом проекте он сразу выкладывает прод', 'a push to main, which deploys to production in this project');
    }
  }
  return null;
}

/** Touching the permission file itself is refused: only the owner's message opens it. */
export function touchesAllowFile(s: string) {
  return /orchestra-prod-allow|briefs[\\/]approvals\.json/.test(s);
}

export interface Allow {
  until: string;
  grantedAt: string;
  phrase: string;
}

export function readAllow(root: string): Allow | null {
  try {
    const a: Allow = JSON.parse(fs.readFileSync(allowFile(root), 'utf8'));
    return Date.parse(a.until) > Date.now() ? a : null;
  } catch {
    return null;
  }
}

/** «разрешаю прод», «разрешаю выкладку», «разрешаю деплой», «разрешаю push», «даю добро на прод». */
// English: «allow prod», «allow deploy», «allow push», «green light for prod». Both languages work in any project.
export const GRANT_RE = /(разреша[юе]\s+(прод|выкладк|деплой|push|пуш|миграц)|добро\s+на\s+(прод|выкладк|деплой)|\ballow\s+(prod|production|deploy|deployment|push|migrations?)\b|\b(green\s*light|go[- ]ahead)\s+(for|on|to)\s+(prod|production|deploy|deployment)\b)/i;
export const REVOKE_RE = /(запреща[юе]\s+(прод|выкладк|деплой)|отбой\s+(прод|выкладк|деплой)|\b(revoke|deny|cancel)\s+(prod|production|deploy|deployment)\b)/i;

export function grant(root: string, prompt: string, minutes: number): Allow {
  const now = new Date();
  const a: Allow = { grantedAt: now.toISOString(), until: new Date(now.getTime() + minutes * 60_000).toISOString(), phrase: prompt.slice(0, 200) };
  fs.writeFileSync(allowFile(root), JSON.stringify(a, null, 2));
  return a;
}

export function revoke(root: string) {
  fs.rmSync(allowFile(root), { force: true });
}

/** Detect at init: a workflow on push to main that runs wrangler means a push to main deploys. */
export function detectPushDeploys(root: string): boolean {
  const dir = path.join(root, '.github', 'workflows');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return false;
  }
  return files.some((f) => {
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    const onPushMain = /push\s*:[\s\S]{0,120}?branches\s*:\s*\[?[^\]\n]*\b(main|master)\b/.test(t) || /push\s*:\s*\{[^}]*\b(main|master)\b/.test(t);
    return onPushMain && /wrangler|deploy/i.test(t);
  });
}

export type GuardDecision = { decision: 'allow' } | { decision: 'deny'; reason: string } | { decision: 'allowed-by-owner'; reason: string; until: string };

/** The whole decision for one PreToolUse call. */
export function decide(tool: string, input: any, root: string, cfg: GuardConfig, isWorker: boolean, lang?: Lang): GuardDecision {
  if (!cfg.enabled) return { decision: 'allow' };
  const fileArg = String(input?.file_path ?? input?.notebook_path ?? '');
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
    return touchesAllowFile(fileArg) ? { decision: 'deny', reason: pick(lang, 'разрешения на прод и утверждения брифов даёт только владелец своим сообщением («разрешаю прод», «утверждаю»); эти файлы агент не меняет', 'prod permissions and brief approvals are given only by the owner in their own message («allow prod», «approve the brief»); an agent does not change these files') } : { decision: 'allow' };
  }
  if (tool !== 'Bash') return { decision: 'allow' };
  const cmd = String(input?.command ?? '');
  if (touchesAllowFile(cmd)) return { decision: 'deny', reason: pick(lang, 'разрешения на прод и утверждения брифов даёт только владелец своим сообщением («разрешаю прод», «утверждаю»); эти файлы агент не трогает', 'prod permissions and brief approvals are given only by the owner in their own message («allow prod», «approve the brief»); an agent does not touch these files') };
  const why = prodReason(cmd, root, cfg, lang);
  if (!why) return { decision: 'allow' };
  if (isWorker) return { decision: 'deny', reason: pick(lang, `${why}: исполнителям Orchestra прод недоступен никогда. Остановитесь и опишите в отчёте, какую команду нужно выполнить владельцу.`, `${why}: production is never available to Orchestra workers. Stop and describe in your report which command the owner has to run.`) };
  const a = readAllow(root);
  if (a) return { decision: 'allowed-by-owner', reason: why, until: a.until };
  return {
    decision: 'deny',
    reason: pick(
      lang,
      `${why}. Это меняет прод. Остановитесь, объясните владельцу, что именно сделает команда, и попросите разрешения: он пишет «разрешаю прод» (действует ${cfg.minutes} мин для этого проекта). Сами файл разрешения не создавайте.`,
      `${why}. This changes production. Stop, explain to the owner what exactly the command will do and ask for permission: they write «allow prod» (valid for ${cfg.minutes} min for this project). Do not create the permission file yourself.`,
    ),
  };
}
