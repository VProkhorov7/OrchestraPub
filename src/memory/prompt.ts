import * as fs from 'fs';
import * as path from 'path';
import { ProjectMemory } from './store';

/**
 * What the orchestrator, the planner and each worker are told about the project's memory.
 * Empty when the repository has no `.memory/`.
 */
export function memoryBriefing(repo: string, task: string, who: 'orchestrator' | 'planner' | 'worker', language?: string): string {
  if (!ProjectMemory.exists(repo)) return '';
  const m = new ProjectMemory(repo);
  const cfg = m.config();
  const ctx = m.context(task, who === 'worker' ? 2500 : 6000);
  const invFile = path.join(repo, cfg.wikiDir, 'INVARIANTS.md');
  const inv = fs.existsSync(invFile)
    ? fs.readFileSync(invFile, 'utf8').split('\n').filter((l) => /^\s*[-*]\s/.test(l)).join('\n').slice(0, 2000)
    : '';
  const invBlock = inv ? `\nINVARIANTS — must never become false (wiki/INVARIANTS.md):\n${inv}\n` : '';
  if (who === 'worker') {
    return `${invBlock}\nProject memory relevant to this task (facts already established and decisions with their reasons; follow them, do not redo finished work):\n${ctx}\n\nDo not edit .memory/ or ${cfg.journal}; the lead engineer records memory. If the task changes behaviour, architecture or APIs, update the matching page in ${cfg.wikiDir}/ in the same commit.\n`;
  }
  if (who === 'planner') {
    return `${invBlock}\n\nProject memory (what is already known and done, and why things are the way they are). Plan around it: do not re-plan finished work, respect the decisions, and include a task to update ${cfg.wikiDir}/ when the change affects documented behaviour:\n${ctx}`;
  }
  return `

PROJECT MEMORY — read it before planning:
${ctx}
${invBlock}

Memory rules for this run:
- Do not redo what the memory says is done; follow recorded decisions. If a decision must change, record the new one with memory_add_decision (supersedes).
- Record new established facts with memory_add_fact and new decisions (with WHY and rejected alternatives) with memory_add_decision as you go.
- Review every diff against the invariants above: a change that breaks one is not merged. A test that guards an invariant must go red when the protected code is removed.
- Worker reports have four parts (DONE, WHY, RISKS, VERIFY). A report without VERIFY is not a verified result.
- The wiki (${cfg.wikiDir}/) must describe the result: before finishing, delegate a "docs" task that updates the wiki pages affected by what you merged (not ${cfg.journal}, not .memory/), review and merge it.
- ${language === 'en' ? 'End with a final report in English: first 2–3 plain sentences for the owner, then "Done:" bullets, then "Next:" bullets.' : 'End with a final report in Russian: first 2–3 plain sentences for the owner, then "Сделано:" bullets, then "Дальше:" bullets.'} It becomes the session entry in the journal and the log.`;
}
