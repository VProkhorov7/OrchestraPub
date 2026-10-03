import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Lang, appLanguage, pick, projectLanguage } from './lang';

/**
 * Task briefs from `/orchestra`: saved in .memory/briefs/ (a plan that lives only in the chat is gone
 * after /clear), checked for completeness, and approved by the owner.
 *
 * Approval is bound to the brief's content (Skaro's state hashes): the owner's «утверждаю» is recorded by
 * the UserPromptSubmit hook — an agent cannot type it — and any later change of the brief resets it.
 * Ticking subtasks (`- [x]`) does not count as a change.
 */

/** Section headings: a brief may use either language's (the check accepts both). */
export const BRIEF_SECTIONS = ['Цель', 'Что уже известно', 'Границы', 'Подзадачи', 'Готово, когда', 'Как проверить', 'Вопросы'];
export const BRIEF_SECTIONS_EN = ['Goal', 'What is already known', 'Boundaries', 'Subtasks', 'Done when', 'How to verify', 'Questions'];
const PLACEHOLDER = /\b(TODO|TBD|FIXME|XXX)\b|уточнить позже|определим позже|clarify later|decide later|to be determined|\?\?\?/i;
// English: «approve the brief», «I approve the brief», «brief approved»; a bare «approved» only as the whole message.
export const APPROVE_RE = /(^|[\s,.!])(утверждаю|бриф утвержд[её]н|одобряю бриф|(i\s+)?approve(d)?(\s+(the|this))?\s+brief|brief\s+(is\s+)?approved)([\s,.!]|$)|^\s*(approved?|i approve)[\s.!]*$/i;

export function briefsDir(root: string) {
  return path.join(root, '.memory', 'briefs');
}
function approvalsFile(root: string) {
  return path.join(briefsDir(root), 'approvals.json');
}

/** Content hash that ignores ticked checkboxes and trailing spaces. */
export function briefHash(text: string) {
  const norm = text.replace(/^(\s*[-*]\s*)\[[xX]\]/gm, '$1[ ]').replace(/[ \t]+$/gm, '').trim();
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

function readApprovals(root: string): Record<string, { sha: string; at: string }> {
  try {
    return JSON.parse(fs.readFileSync(approvalsFile(root), 'utf8'));
  } catch {
    return {};
  }
}

export function listBriefs(root: string): string[] {
  try {
    return fs
      .readdirSync(briefsDir(root))
      .filter((f) => f.endsWith('.md'))
      .map((f) => path.join(briefsDir(root), f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {
    return [];
  }
}

export interface BriefCheck {
  file: string;
  missing: string[];
  placeholders: string[];
  approved: boolean;
  /** Approved once, then changed. */
  changedAfterApproval: boolean;
  ok: boolean;
}

function hasSection(text: string, name: string) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/,\s*/, ',?\\s*');
  return new RegExp(`^\\s*(#{1,4}\\s*${n}|\\*\\*${n}\\*\\*)`, 'im').test(text);
}

export function checkBrief(root: string, file: string): BriefCheck {
  const abs = path.resolve(root, file);
  const text = fs.readFileSync(abs, 'utf8');
  const lang = projectLanguage(root);
  const missing = BRIEF_SECTIONS.map((ru, i) => [ru, BRIEF_SECTIONS_EN[i]]).filter(([ru, en]) => !hasSection(text, ru) && !hasSection(text, en)).map(([ru, en]) => pick(lang, ru, en));
  const placeholders = text.split('\n').filter((l) => PLACEHOLDER.test(l)).map((l) => l.trim()).slice(0, 5);
  const rel = path.relative(root, abs);
  const ap = readApprovals(root)[rel];
  const approved = !!ap && ap.sha === briefHash(text);
  return { file: rel, missing, placeholders, approved, changedAfterApproval: !!ap && !approved, ok: !missing.length && !placeholders.length && approved };
}

/** The owner said «утверждаю»: approve the most recent complete brief that is not approved in its current form. */
export function approveLatest(root: string): BriefCheck | null {
  for (const f of listBriefs(root)) {
    const c = checkBrief(root, f);
    if (c.approved) continue;
    if (Date.now() - fs.statSync(f).mtimeMs > 24 * 3600_000) return null;
    if (c.missing.length || c.placeholders.length) return c; // incomplete: not approved, the agent is told why
    const all = readApprovals(root);
    all[c.file] = { sha: briefHash(fs.readFileSync(f, 'utf8')), at: new Date().toISOString() };
    fs.mkdirSync(briefsDir(root), { recursive: true });
    fs.writeFileSync(approvalsFile(root), JSON.stringify(all, null, 2) + '\n');
    return checkBrief(root, f);
  }
  return null;
}

export function describe(c: BriefCheck, lang: Lang = appLanguage()): string {
  const lines = [pick(lang, `Бриф ${c.file}:`, `Brief ${c.file}:`)];
  if (c.missing.length) lines.push(pick(lang, `- не хватает разделов: ${c.missing.join(', ')}`, `- missing sections: ${c.missing.join(', ')}`));
  if (c.placeholders.length) lines.push(pick(lang, `- заглушки вместо решений: ${c.placeholders.map((p) => `«${p.slice(0, 80)}»`).join('; ')}`, `- placeholders instead of decisions: ${c.placeholders.map((p) => `«${p.slice(0, 80)}»`).join('; ')}`));
  if (c.approved) lines.push(pick(lang, '- утверждён владельцем в текущей версии', '- approved by the owner in its current version'));
  else if (c.changedAfterApproval) lines.push(pick(lang, '- изменён после утверждения: покажите владельцу, что поменялось, и попросите написать «утверждаю» снова', '- changed after approval: show the owner what changed and ask them to write «approve the brief» again'));
  else lines.push(pick(lang, '- не утверждён: владелец должен написать «утверждаю»', '- not approved: the owner has to write «approve the brief»'));
  if (c.ok) lines.push(pick(lang, 'Можно выполнять.', 'Ready to execute.'));
  return lines.join('\n');
}
