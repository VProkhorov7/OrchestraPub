import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Lang, appLanguage, pick } from './lang';

/**
 * Project memory, kept inside the repository and committed with the code:
 *
 *   .memory/config.json          settings (wiki folder, session length, …)
 *   .memory/facts.json           база фактов: what is known / found / done
 *   .memory/logic.json           база логики: decisions and WHY they were made
 *   .memory/log/YYYY-MM.jsonl    detailed machine log, one JSON event per line (for AI)
 *   wiki/JOURNAL.md              short human journal, one entry per micro-session (for the owner)
 *   CHANGELOG.md                 Keep a Changelog summary, written at the end of a stage or on request
 *
 * Session state lives in .git/orchestra-memory-session.json (never committed).
 */

export interface MemoryConfig {
  version: 1;
  /** Workflow language (rules, hook messages, journal labels). Not stored by default: follows the app's RU/EN switch. */
  language?: import('./lang').Lang;
  project: string;
  wikiDir: string;
  journal: string;
  changelog: string;
  /** Length of a micro-session in minutes; after it the agent is reminded to close it. */
  sessionMinutes: number;
  /** Refuse commits of code without a wiki update in the same session (default: only warn). */
  requireWiki: boolean;
  /** Prod guard (PreToolUse hook): see guard.ts. Missing = on, pushDeploys detected from CI workflows. */
  prodGuard?: Partial<import('./guard').GuardConfig>;
}

export interface Fact {
  id: string;
  text: string;
  tags: string[];
  files: string[];
  source?: string;
  author: string;
  created: string;
  updated: string;
  status: 'active' | 'obsolete';
  supersededBy?: string;
}

export interface Decision {
  id: string;
  title: string;
  decision: string;
  why: string;
  alternatives: string[];
  consequences?: string;
  facts: string[];
  files: string[];
  tags: string[];
  author: string;
  date: string;
  status: 'active' | 'superseded';
  supersededBy?: string;
}

export type EventType =
  | 'session_start' | 'session_end' | 'task' | 'feature' | 'change' | 'fix' | 'security' | 'removed' | 'deprecated'
  | 'refactor' | 'test' | 'docs' | 'decision' | 'fact' | 'commit' | 'merge' | 'deploy' | 'review' | 'command' | 'edit' | 'error' | 'note' | 'changelog'
  /** Manual data cleanup without removing the cause: not a fix, or the next occurrence reads as «already fixed». */
  | 'cleanup'
  /** The prod guard stopped or let through a command. */
  | 'guard';

export interface LogEvent {
  id: string;
  ts: string;
  type: EventType | string;
  author: string;
  description: string;
  files?: string[];
  session?: string;
  commit?: string;
  details?: unknown;
  tags?: string[];
  /** Why this was done: required for work an agent records by hand (feature, fix, change, security, deploy, cleanup). */
  why?: string;
}

export interface Session {
  id: string;
  author: string;
  goal?: string;
  start: string;
  startCommit: string;
  /** Claude Code session id when started by a hook. */
  agentSession?: string;
  remindedAt?: string;
  wikiTouched?: boolean;
}

/** Work an agent records by hand must say why (a journal without «why» is a list of events). */
export const NEEDS_WHY = ['feature', 'fix', 'change', 'security', 'deploy', 'cleanup', 'removed', 'refactor'];
export const MAX_GATES = 3;

/** A hand-written log entry: type known, «why» present where required. Throws a Russian message. */
export function checkManualLog(type: string, why?: string, lang: Lang = appLanguage()) {
  if (NEEDS_WHY.includes(type) && !why?.trim())
    throw new Error(pick(lang, `для записи типа «${type}» нужно «почему» (--why): зачем это сделано. Ручная чистка данных без устранения причины — тип cleanup, а не fix`, `an entry of type «${type}» needs a «why» (--why): why it was done. A manual data cleanup that leaves the cause in place is type cleanup, not fix`));
}

/** Shift handoff: at most 3 mandatory gates and exactly one next task. */
export function checkHandoff(gates: string[] = [], next: string[] = [], lang: Lang = appLanguage()) {
  if (gates.length > MAX_GATES) throw new Error(pick(lang, `обязательных пунктов (--gate) не больше ${MAX_GATES}: важное тонет в длинном списке. Остальное — ссылкой в wiki/status/current.md`, `at most ${MAX_GATES} mandatory items (--gate): what matters drowns in a long list. The rest goes as a link in wiki/status/current.md`));
  if (next.length > 1) throw new Error(pick(lang, 'следующая задача (--next) — ровно одна. Остальное — ссылкой в wiki/status/current.md', 'the next task (--next) is exactly one. The rest goes as a link in wiki/status/current.md'));
}

export const DEFAULT_MEMORY_CONFIG = (project: string): MemoryConfig => ({
  version: 1,
  project,
  wikiDir: 'wiki',
  journal: 'wiki/JOURNAL.md',
  changelog: 'CHANGELOG.md',
  sessionMinutes: 35,
  requireWiki: false,
});

const now = () => new Date().toISOString();
const rid = () => Math.random().toString(36).slice(2, 6);

function git(repo: string, args: string[], raw = false): string {
  try {
    const out = execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ORCHESTRA_MEMORY_OFF: '1' } }).toString();
    return raw ? out : out.trim();
  } catch {
    return '';
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Pretty JSON, one object per line inside arrays, so git diffs of facts/logic stay readable. */
function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = Array.isArray(data) ? '[\n' + data.map((x) => '  ' + JSON.stringify(x)).join(',\n') + (data.length ? '\n' : '') + ']\n' : JSON.stringify(data, null, 2) + '\n';
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

/** Words for matching: lowercase, Latin + Cyrillic + digits, 3+ chars, crude Russian/English stemming. */
export function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-zа-яё0-9_]{3,}/g) ?? []).map((w) => (w.length > 5 ? w.slice(0, w.length - 2) : w));
}

/** End a sentence with exactly one period. */
const dot = (s: string) => s.trim().replace(/[.。]+$/, '') + '.';

export class ProjectMemory {
  readonly root: string;
  readonly dir: string;

  constructor(repo: string) {
    this.root = path.resolve(repo);
    this.dir = path.join(this.root, '.memory');
  }

  static exists(repo: string) {
    return fs.existsSync(path.join(repo, '.memory', 'config.json'));
  }

  // ---------- files ----------

  config(): MemoryConfig {
    const stored = readJson<Partial<MemoryConfig>>(path.join(this.dir, 'config.json'), {});
    return { ...DEFAULT_MEMORY_CONFIG(path.basename(this.root)), ...stored, language: stored.language ?? appLanguage() };
  }

  private p(rel: string) {
    return path.join(this.root, rel);
  }

  facts(): Fact[] {
    return readJson<Fact[]>(path.join(this.dir, 'facts.json'), []);
  }

  decisions(): Decision[] {
    return readJson<Decision[]>(path.join(this.dir, 'logic.json'), []);
  }

  /** Create what is missing; never overwrites existing content. */
  init(project?: string): string[] {
    const created: string[] = [];
    const make = (rel: string, content: string) => {
      const f = this.p(rel);
      if (fs.existsSync(f)) return;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
      created.push(rel);
    };
    const cfg = { ...DEFAULT_MEMORY_CONFIG(project ?? path.basename(this.root)), ...readJson<Partial<MemoryConfig>>(path.join(this.dir, 'config.json'), {}) };
    const lang = cfg.language ?? appLanguage(); // not stored: the project follows the app's language until the owner pins one
    // An existing wiki folder with another name is kept.
    if (!fs.existsSync(this.p(cfg.wikiDir))) {
      const alt = ['wiki', 'Wiki', 'docs/wiki', 'docs'].find((d) => fs.existsSync(this.p(d)) && fs.statSync(this.p(d)).isDirectory());
      if (alt) {
        cfg.wikiDir = alt;
        cfg.journal = `${alt}/JOURNAL.md`;
      }
    }
    make('.memory/config.json', JSON.stringify(cfg, null, 2) + '\n');
    make('.memory/facts.json', '[\n]\n');
    make('.memory/logic.json', '[\n]\n');
    make('.memory/log/.keep', '');
    make(
      `${cfg.wikiDir}/README.md`,
      pick(
        lang,
        `# ${cfg.project}: wiki\n\nСправочник проекта. Обновляется в каждой микросессии вместе с кодом.\n\n- [Журнал работы](JOURNAL.md): что сделано по сессиям, для человека\n- Факты и решения для ИИ: \`.memory/facts.json\`, \`.memory/logic.json\`\n- Изменения по этапам: [CHANGELOG](../CHANGELOG.md)\n`,
        `# ${cfg.project}: wiki\n\nThe project reference. Updated in every micro-session together with the code.\n\n- [Work journal](JOURNAL.md): what was done per session, for people\n- Facts and decisions for AI: \`.memory/facts.json\`, \`.memory/logic.json\`\n- Changes by stage: [CHANGELOG](../CHANGELOG.md)\n`,
      ),
    );
    make(
      cfg.journal,
      pick(
        lang,
        `# Журнал работы: ${cfg.project}\n\nКороткие записи по микросессиям, новые сверху. Подробный лог для ИИ: \`.memory/log/\`.\n\n<!-- entries -->\n`,
        `# Work journal: ${cfg.project}\n\nShort records per micro-session, newest first. The detailed log for AI: \`.memory/log/\`.\n\n<!-- entries -->\n`,
      ),
    );
    make(
      cfg.changelog,
      pick(
        lang,
        `# Changelog\n\nВсе заметные изменения проекта. Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/).\n\n## [Unreleased]\n`,
        `# Changelog\n\nAll notable changes to the project. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).\n\n## [Unreleased]\n`,
      ),
    );
    return created;
  }

  // ---------- facts & decisions ----------

  addFact(f: { text: string; tags?: string[]; files?: string[]; source?: string; author: string; supersedes?: string }): Fact {
    const facts = this.facts();
    const norm = f.text.trim().toLowerCase();
    const dup = facts.find((x) => x.status === 'active' && x.text.trim().toLowerCase() === norm);
    if (dup) return dup;
    const id = `F-${String(facts.length + 1).padStart(4, '0')}`;
    const fact: Fact = { id, text: f.text.trim(), tags: f.tags ?? [], files: f.files ?? [], source: f.source, author: f.author, created: now(), updated: now(), status: 'active' };
    if (f.supersedes) {
      const old = facts.find((x) => x.id === f.supersedes);
      if (old) Object.assign(old, { status: 'obsolete', supersededBy: id, updated: now() });
    }
    facts.push(fact);
    writeJson(path.join(this.dir, 'facts.json'), facts);
    this.log({ type: 'fact', author: f.author, description: fact.text, files: fact.files, details: { id, supersedes: f.supersedes } });
    return fact;
  }

  addDecision(d: { title: string; decision: string; why: string; alternatives?: string[]; consequences?: string; facts?: string[]; files?: string[]; tags?: string[]; author: string; supersedes?: string }): Decision {
    const list = this.decisions();
    const id = `D-${String(list.length + 1).padStart(4, '0')}`;
    const dec: Decision = {
      id,
      title: d.title.trim(),
      decision: d.decision.trim(),
      why: d.why.trim(),
      alternatives: d.alternatives ?? [],
      consequences: d.consequences,
      facts: d.facts ?? [],
      files: d.files ?? [],
      tags: d.tags ?? [],
      author: d.author,
      date: now(),
      status: 'active',
    };
    if (d.supersedes) {
      const old = list.find((x) => x.id === d.supersedes);
      if (old) Object.assign(old, { status: 'superseded', supersededBy: id });
    }
    list.push(dec);
    writeJson(path.join(this.dir, 'logic.json'), list);
    this.log({ type: 'decision', author: d.author, description: `${dec.title}: ${dec.decision}`, files: dec.files, details: { id, why: dec.why, supersedes: d.supersedes } });
    return dec;
  }

  // ---------- log ----------

  log(e: Omit<LogEvent, 'id' | 'ts'> & { ts?: string }): LogEvent {
    const ts = e.ts ?? now();
    const ev: LogEvent = { id: `E-${Date.parse(ts).toString(36)}-${rid()}`, ts, ...e, session: e.session ?? this.session()?.id };
    const file = path.join(this.dir, 'log', `${ts.slice(0, 7)}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(ev) + '\n');
    return ev;
  }

  readLog(opts: { since?: string; limit?: number; types?: string[] } = {}): LogEvent[] {
    const dir = path.join(this.dir, 'log');
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    const out: LogEvent[] = [];
    for (const f of files) {
      if (opts.since && f.slice(0, 7) < opts.since.slice(0, 7)) continue;
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as LogEvent;
          if (opts.since && ev.ts <= opts.since) continue;
          if (opts.types && !opts.types.includes(ev.type)) continue;
          out.push(ev);
        } catch {
          /* a broken line (e.g. a merge artefact) must not break everything */
        }
      }
    }
    out.sort((a, b) => a.ts.localeCompare(b.ts));
    return opts.limit ? out.slice(-opts.limit) : out;
  }

  // ---------- search & context ----------

  search(query: string, limit = 8): Array<{ kind: 'fact' | 'decision' | 'event'; score: number; item: Fact | Decision | LogEvent }> {
    const q = new Set(words(query));
    if (!q.size) return [];
    const score = (text: string, tags: string[] = [], files: string[] = []) => {
      let s = 0;
      for (const w of words(text)) if (q.has(w)) s += 1;
      for (const t of tags) if (q.has(words(t)[0] ?? '')) s += 2;
      for (const f of files) if (words(f).some((w) => q.has(w))) s += 1.5;
      return s;
    };
    const res: Array<{ kind: 'fact' | 'decision' | 'event'; score: number; item: any }> = [];
    for (const f of this.facts()) if (f.status === 'active') res.push({ kind: 'fact', score: score(f.text, f.tags, f.files), item: f });
    for (const d of this.decisions()) if (d.status === 'active') res.push({ kind: 'decision', score: score(`${d.title} ${d.decision} ${d.why}`, d.tags, d.files) * 1.2, item: d });
    for (const e of this.readLog({ limit: 400 })) if (!['edit', 'command', 'session_start'].includes(e.type)) res.push({ kind: 'event', score: score(e.description, e.tags, e.files) * 0.6, item: e });
    return res.filter((r) => r.score >= 1).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * What an agent should read before starting a task: related facts, the decisions behind them (with WHY),
   * what the last session left to do. Markdown, bounded in size.
   */
  context(task = '', maxChars = 6000): string {
    const parts: string[] = [];
    const lang = this.config().language;
    const hits = task ? this.search(task, 12) : [];
    const facts = hits.filter((h) => h.kind === 'fact').map((h) => h.item as Fact);
    const decs = hits.filter((h) => h.kind === 'decision').map((h) => h.item as Decision);
    // Decisions linked to the facts found are relevant too: that's the "why" behind what is known.
    const allDecs = this.decisions();
    for (const f of facts) for (const d of allDecs) if (d.status === 'active' && d.facts.includes(f.id) && !decs.includes(d)) decs.push(d);
    if (facts.length) parts.push(pick(lang, '### Уже известно (факты)', '### Already known (facts)') + '\n' + facts.map((f) => `- ${f.id}: ${f.text}${f.files.length ? ` (${f.files.join(', ')})` : ''}`).join('\n'));
    if (decs.length) parts.push(pick(lang, '### Принятые решения и почему', '### Decisions made and why') + '\n' + decs.map((d) => `- ${d.id} ${d.title}: ${dot(d.decision)} ${pick(lang, 'Почему', 'Why')}: ${dot(d.why)}${d.alternatives.length ? ` ${pick(lang, 'Отвергнуто', 'Rejected')}: ${d.alternatives.join('; ')}` : ''}`).join('\n'));
    // The run that asks for context has usually just logged its own task: that is not "already done".
    const first = task.trim().split('\n')[0];
    const fresh = Date.now() - 10 * 60_000;
    const events = hits
      .filter((h) => h.kind === 'event')
      .map((h) => h.item as LogEvent)
      .filter((e) => !(e.type === 'task' && Date.parse(e.ts) > fresh && first && e.description.includes(first)));
    if (events.length) parts.push(pick(lang, '### Что уже делалось по теме', '### Already done on this topic') + '\n' + events.slice(0, 6).map((e) => `- ${e.ts.slice(0, 10)} [${e.type}] ${e.description}`).join('\n'));
    const last = this.readLog({ types: ['session_end'], limit: 1 })[0];
    if (last) {
      const d = (last.details ?? {}) as any;
      parts.push(`${pick(lang, '### Прошлая сессия', '### Previous session')} (${last.ts.slice(0, 16).replace('T', ' ')}, ${last.author})\n${last.description}${d.next?.length ? `\n${pick(lang, 'Дальше', 'Next')}: ${[].concat(d.next).join('; ')}` : ''}`);
    }
    if (task && facts.length < 3) {
      // Few direct hits: add the latest facts and decisions so the reader still sees the project's baseline.
      const more = this.facts().filter((x) => x.status === 'active' && !facts.includes(x)).slice(-5);
      if (more.length) parts.push(pick(lang, '### Недавние факты', '### Recent facts') + '\n' + more.map((f) => `- ${f.id}: ${f.text}`).join('\n'));
      const moreDecs = allDecs.filter((d) => d.status === 'active' && !decs.includes(d)).slice(-3);
      if (moreDecs.length) parts.push(pick(lang, '### Недавние решения', '### Recent decisions') + '\n' + moreDecs.map((d) => `- ${d.id} ${d.title}: ${dot(d.decision)} ${pick(lang, 'Почему', 'Why')}: ${dot(d.why)}`).join('\n'));
    }
    if (!task) {
      const recentDecs = allDecs.filter((d) => d.status === 'active').slice(-5);
      if (recentDecs.length) parts.push(pick(lang, '### Последние решения', '### Latest decisions') + '\n' + recentDecs.map((d) => `- ${d.id} ${d.title}: ${d.decision}`).join('\n'));
      const f = this.facts().filter((x) => x.status === 'active');
      parts.push(pick(lang, `Всего в памяти: фактов ${f.length}, решений ${allDecs.filter((x) => x.status === 'active').length}. Поиск: orchestra-memory search "<слова>".`, `In memory: ${f.length} facts, ${allDecs.filter((x) => x.status === 'active').length} decisions. Search: orchestra-memory search "<words>".`));
    }
    let out = parts.join('\n\n') || pick(lang, 'Память проекта пока пуста.', 'The project memory is still empty.');
    if (out.length > maxChars) out = out.slice(0, maxChars) + '\n…';
    return out;
  }

  // ---------- sessions ----------

  private sessionFile() {
    const gitDir = git(this.root, ['rev-parse', '--git-dir']) || '.git';
    return path.join(path.resolve(this.root, gitDir), 'orchestra-memory-session.json');
  }

  session(): Session | undefined {
    return readJson<Session | undefined>(this.sessionFile(), undefined);
  }

  private saveSession(s: Session | undefined) {
    const f = this.sessionFile();
    if (!s) fs.rmSync(f, { force: true });
    else {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(s, null, 2));
    }
  }

  markSession(patch: Partial<Session>) {
    const s = this.session();
    if (s) this.saveSession({ ...s, ...patch });
  }

  sessionStart(author: string, goal?: string, agentSession?: string): Session {
    const cur = this.session();
    if (cur) return cur;
    const s: Session = { id: `S-${Date.now().toString(36)}`, author, goal, start: now(), startCommit: git(this.root, ['rev-parse', 'HEAD']), agentSession };
    this.saveSession(s);
    this.log({ type: 'session_start', author, description: goal ? pick(this.config().language, `начало сессии: ${goal}`, `session start: ${goal}`) : pick(this.config().language, 'начало сессии', 'session start'), session: s.id });
    return s;
  }

  minutesInSession(): number {
    const s = this.session();
    return s ? (Date.now() - Date.parse(s.start)) / 60_000 : 0;
  }

  /** Files changed since the session began: commits made in it plus what is not committed yet. */
  changedFiles(s = this.session()): string[] {
    const set = new Set<string>();
    if (s?.startCommit) for (const f of git(this.root, ['diff', '--name-only', `${s.startCommit}..HEAD`]).split('\n')) if (f) set.add(f);
    // -z: exact paths, no quoting; untracked files listed one by one.
    const entries = git(this.root, ['status', '--porcelain', '-z', '--untracked-files=all'], true).split('\0');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.length < 4) continue;
      set.add(e.slice(3));
      if (e[0] === 'R' || e[0] === 'C') i++; // rename: the next entry is the old path
    }
    return [...set].filter((f) => !f.startsWith('.memory/'));
  }

  /**
   * Close the micro-session: a detailed JSON event for AI and a short journal entry for the human.
   * Returns warnings (e.g. code changed but the wiki didn't).
   */
  sessionEnd(e: { author: string; summary: string; done?: string[]; why?: string; next?: string[]; gates?: string[]; details?: unknown; auto?: boolean }): { event: LogEvent; warnings: string[] } {
    // One next task; anything else the caller passed (a run report's list) stays in the details.
    const [nextOne, ...later] = e.next ?? [];
    const gates = (e.gates ?? []).slice(0, MAX_GATES);
    const s = this.session();
    const cfg = this.config();
    const files = this.changedFiles(s);
    const commits = s?.startCommit ? git(this.root, ['log', '--format=%h %s', `${s.startCommit}..HEAD`]).split('\n').filter(Boolean) : [];
    const minutes = s ? Math.round((Date.now() - Date.parse(s.start)) / 60_000) : 0;
    const wikiPrefix = cfg.wikiDir.replace(/\/?$/, '/');
    const codeFiles = files.filter((f) => !f.startsWith(wikiPrefix) && f !== cfg.changelog && !f.startsWith('.claude/') && !f.startsWith('.githooks/'));
    const wikiFiles = files.filter((f) => f.startsWith(wikiPrefix) && f !== cfg.journal);
    const warnings: string[] = [];
    if (codeFiles.length && !wikiFiles.length) warnings.push(pick(cfg.language, `код изменён (${codeFiles.length} файл.), а wiki (${cfg.wikiDir}/) в этой сессии не обновлялась`, `code changed (${codeFiles.length} files), but the wiki (${cfg.wikiDir}/) was not updated in this session`));
    const event = this.log({
      type: 'session_end',
      author: e.author,
      description: e.summary,
      files,
      session: s?.id,
      why: e.why,
      details: { minutes, done: e.done ?? [], why: e.why, gates, next: nextOne ? [nextOne] : [], later, commits, goal: s?.goal, auto: !!e.auto, warnings, extra: e.details },
    });
    this.appendJournal({ author: e.author, minutes, summary: e.summary, done: e.done, why: e.why, gates, next: nextOne ? [nextOne] : [], files: codeFiles, commits, auto: e.auto });
    this.saveSession(undefined);
    return { event, warnings };
  }

  appendJournal(j: { author: string; minutes: number; summary: string; done?: string[]; why?: string; gates?: string[]; next?: string[]; files: string[]; commits: string[]; auto?: boolean }) {
    const cfg = this.config();
    const file = this.p(cfg.journal);
    const d = new Date();
    const stamp = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const L = cfg.language;
    const lines = [`## ${stamp} · ${j.author}${j.minutes ? ` · ${j.minutes} ${pick(L, 'мин', 'min')}` : ''}${j.auto ? pick(L, ' · запись автоматическая', ' · automatic entry') : ''}`, '', j.summary];
    if (j.done?.length) lines.push('', `**${pick(L, 'Сделано', 'Done')}:**`, ...j.done.map((x) => `- ${x}`));
    if (j.why) lines.push('', `**${pick(L, 'Почему так', 'Why it is so')}:** ${j.why}`);
    if (j.gates?.length) lines.push('', `**${pick(L, 'Обязательно до следующей задачи', 'Mandatory before the next task')}:**`, ...j.gates.map((x) => `- [ ] ${x}`));
    if (j.next?.length === 1) lines.push('', `**${pick(L, 'Следующая задача', 'Next task')}:** ${j.next[0]}`);
    else if (j.next?.length) lines.push('', `**${pick(L, 'Дальше', 'Next')}:**`, ...j.next.map((x) => `- ${x}`));
    if (j.commits.length) lines.push('', `${pick(L, 'Коммиты', 'Commits')}: ${j.commits.slice(0, 8).map((c) => '`' + c.split(' ')[0] + '`').join(', ')}${j.commits.length > 8 ? ' …' : ''}`);
    if (j.files.length) lines.push(`${pick(L, 'Файлы', 'Files')}: ${j.files.slice(0, 12).join(', ')}${j.files.length > 12 ? pick(L, ` и ещё ${j.files.length - 12}`, ` and ${j.files.length - 12} more`) : ''}`);
    const entry = lines.join('\n') + '\n\n';
    let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : pick(cfg.language, `# Журнал работы: ${cfg.project}\n\n<!-- entries -->\n`, `# Work journal: ${cfg.project}\n\n<!-- entries -->\n`);
    const marker = '<!-- entries -->\n';
    body = body.includes(marker) ? body.replace(marker, marker + '\n' + entry) : body + '\n' + entry;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body.replace(/\n{3,}/g, '\n\n'));
  }

  // ---------- changelog & digest ----------

  private statePath() {
    return path.join(this.dir, 'state.json');
  }

  state(): { changelogUntil?: string } {
    return readJson(this.statePath(), {});
  }

  /** Significant events since the last CHANGELOG update, grouped by Keep a Changelog section. */
  changelogCandidates(): Record<string, LogEvent[]> {
    const since = this.state().changelogUntil;
    const map: Record<string, string> = {
      feature: 'Added', task: 'Added', merge: 'Added', change: 'Changed', refactor: 'Changed', docs: 'Changed', decision: 'Changed',
      fix: 'Fixed', security: 'Security', removed: 'Removed', deprecated: 'Deprecated', deploy: 'Changed',
    };
    const out: Record<string, LogEvent[]> = {};
    for (const e of this.readLog({ since })) {
      const sec = map[e.type] ?? (e.type === 'session_end' ? pick(this.config().language, 'Сессии', 'Sessions') : undefined);
      if (!sec) continue;
      (out[sec] ??= []).push(e);
    }
    return out;
  }

  /** Put the owner-facing summary into CHANGELOG.md under [Unreleased] (or a named release) and remember where we stopped. */
  writeChangelog(sections: Record<string, string[]>, release?: string): string {
    const cfg = this.config();
    const file = this.p(cfg.changelog);
    let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# Changelog\n\n## [Unreleased]\n`;
    if (!/^## \[Unreleased\]/m.test(body)) body = body.replace(/^(# .*\n(?:\n[^#].*\n)*)/, `$1\n## [Unreleased]\n`);
    const order = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
    // Merge new bullets into the existing Unreleased block.
    const m = body.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/);
    const existing: Record<string, string[]> = {};
    if (m) {
      let cur = '';
      for (const line of m[1].split('\n')) {
        const h = line.match(/^### ([\p{L}]+)/u);
        if (h) cur = h[1];
        else if (cur && line.startsWith('- ')) (existing[cur] ??= []).push(line.slice(2));
      }
    }
    for (const [k, v] of Object.entries(sections)) for (const b of v) if (b.trim() && !(existing[k] ?? []).includes(b.trim())) (existing[k] ??= []).push(b.trim());
    const block = order.filter((k) => existing[k]?.length).map((k) => `### ${k}\n${existing[k].map((b) => `- ${b}`).join('\n')}`).join('\n\n');
    const today = new Date().toISOString().slice(0, 10);
    const head = release ? `## [Unreleased]\n\n## [${release}] - ${today}\n\n${block}\n` : `## [Unreleased]\n\n${block}\n`;
    body = m ? body.replace(m[0], head) : body + '\n' + head;
    fs.writeFileSync(file, body.replace(/\n{3,}/g, '\n\n'));
    writeJson(this.statePath(), { ...this.state(), changelogUntil: now() });
    this.log({ type: 'changelog', author: 'orchestra-memory', description: release ? pick(cfg.language, `CHANGELOG: этап «${release}»`, `CHANGELOG: stage «${release}»`) : pick(cfg.language, 'CHANGELOG обновлён', 'CHANGELOG updated'), files: [cfg.changelog] });
    return body;
  }

  /** Mechanical digest of recent work (the agent or a cheap model can turn it into prose). */
  digest(opts: { since?: string; limit?: number } = {}): string {
    const events = this.readLog({ since: opts.since, limit: opts.limit ?? 60 }).filter((e) => !['edit', 'command', 'session_start'].includes(e.type));
    if (!events.length) return pick(this.config().language, 'В логе нет записей за этот период.', 'No log records for this period.');
    const byDay: Record<string, LogEvent[]> = {};
    for (const e of events) (byDay[e.ts.slice(0, 10)] ??= []).push(e);
    return Object.entries(byDay)
      .map(([day, list]) => `${day}\n` + list.map((e) => `- [${e.type}] ${e.author}: ${e.description}${e.files?.length ? ` (${e.files.slice(0, 4).join(', ')}${e.files.length > 4 ? '…' : ''})` : ''}`).join('\n'))
      .join('\n\n');
  }

  /** Paths that belong to memory and wiki, for staging with every commit. */
  memoryPaths(): string[] {
    const cfg = this.config();
    return ['.memory', cfg.wikiDir, cfg.changelog].filter((p) => fs.existsSync(this.p(p)));
  }
}
