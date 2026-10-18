import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Lang, pick } from './lang';

/**
 * Fact-forcing gate for Orchestra workers (idea: GateGuard in github.com/affaan-m/ECC, MIT).
 * The first Edit/Write of each file in a worker session is refused with a list of facts to gather;
 * the retry goes through. Cheap models guess about callers and data formats: looking them up is what the refusal forces.
 * Off for the owner's own session (only ORCHESTRA_WORKER) and with ORCHESTRA_NO_GATEGUARD.
 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export type GateDecision = { decision: 'allow' } | { decision: 'deny'; reason: string };

export function gate(tool: string, input: any, root: string, sessionId: string, lang?: Lang, stateDir = os.tmpdir()): GateDecision {
  if (!EDIT_TOOLS.has(tool)) return { decision: 'allow' };
  const raw = String(input?.file_path ?? input?.notebook_path ?? '');
  if (!raw) return { decision: 'allow' };
  const file = path.resolve(root, raw);
  const rel = path.relative(root, file);
  const state = path.join(stateDir, `orchestra-gate-${sessionId.replace(/[^\w.-]/g, '_') || 'none'}.json`);
  let seen: string[] = [];
  try {
    seen = JSON.parse(fs.readFileSync(state, 'utf8'));
  } catch {
    /* first call of the session */
  }
  if (seen.includes(file)) return { decision: 'allow' };
  try {
    fs.writeFileSync(state, JSON.stringify([...seen, file]));
  } catch {
    return { decision: 'allow' }; // a gate that cannot remember would block forever
  }
  const isNew = tool === 'Write' && !fs.existsSync(file);
  const facts = isNew
    ? pick(
        lang,
        [`Назови файл и строку, откуда новый файл будет вызываться.`, `Подтверди, что в репозитории нет файла с той же задачей (покажи, чем искал).`, `Если файл читает или пишет данные — назови поля и формат.`],
        [`Name the file and line that will call the new file.`, `Confirm no existing file serves the same purpose (show how you searched).`, `If it reads or writes data, name the fields and format.`],
      )
    : pick(
        lang,
        [`Перечисли файлы, которые импортируют или вызывают ${rel} (покажи поиск).`, `Перечисли публичные функции и классы, которые затрагивает правка.`, `Если файл читает или пишет данные — назови поля и формат.`],
        [`List the files that import or call ${rel} (show the search).`, `List the public functions and classes this change affects.`, `If the file reads or writes data, name the fields and format.`],
      );
  const quote = pick(lang, `Процитируй дословно ту часть задания, которую это закрывает.`, `Quote verbatim the part of the task this change serves.`);
  return {
    decision: 'deny',
    reason: pick(lang, `Перед первой правкой ${rel} назови факты, затем повтори ту же правку:`, `Before the first edit of ${rel}, present these facts, then repeat the same edit:`) + '\n' + [...facts, quote].map((f, i) => `${i + 1}. ${f}`).join('\n'),
  };
}
