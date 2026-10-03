/**
 * Report language: the models are told to write plans and reports in the language of the panel's RU/EN switch.
 * Run: as a step of `npm run smoke`.
 */
import { orchestratorSystemPrompt } from '../main/prompts';
import { memoryBriefing } from '../memory/prompt';
import { replyLang } from '../main/lang';
import { DEFAULT_CONFIG, normalizeConfig } from '../main/config';
import { check } from './helpers';

const ru = normalizeConfig({});
const en = normalizeConfig({ language: 'en' } as any);
check(ru.language === 'ru' && DEFAULT_CONFIG.language === 'ru', `default language is ru: ${ru.language}`);
check(en.language === 'en', 'language survives config normalization');
check(replyLang(ru) === 'Russian' && replyLang(en) === 'English' && replyLang(undefined) === 'Russian', 'replyLang');

const pRu = orchestratorSystemPrompt(ru, '/r', 'main', '');
const pEn = orchestratorSystemPrompt(en, '/r', 'main', '');
check(/reports in Russian/.test(pRu) && !/reports in English/.test(pRu), 'orchestrator prompt: Russian by default');
check(/reports in English/.test(pEn) && !/in Russian/.test(pEn), 'orchestrator prompt: English when the panel is English');

const repo = process.cwd();
const mRu = memoryBriefing(repo, 'x', 'orchestrator');
const mEn = memoryBriefing(repo, 'x', 'orchestrator', 'en');
if (mRu) {
  check(!mEn || !/final report in Russian/.test(mEn), 'memory briefing: no Russian report rule for English');
}
// ---- the memory workflow: rules, wiki, briefs, approvals and prod phrases switch with the language ----
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { setupRepo, upgradeNeeds } from '../memory/setup';
import { ProjectMemory } from '../memory/store';
import { checkBrief, describe as describeBrief, APPROVE_RE } from '../memory/brief';
import { GRANT_RE, REVOKE_RE, decide, GUARD_DEFAULTS } from '../memory/guard';
import { agentRules, globalRules, orchestraCommand } from '../memory/templates';
import { tmpdir } from './helpers';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString();
const tmp = tmpdir('orch-lang-');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(proj);
git(proj, 'init', '-q');
git(proj, 'config', 'user.email', 't@t');
git(proj, 'config', 'user.name', 't');

process.env.ORCHESTRA_LANG = 'en';
setupRepo(proj, { project: 'Demo' });
const claudeMd = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8');
check(claudeMd.includes('Project memory, wiki and logs') && claudeMd.includes("Karpathy") === false && claudeMd.includes('Think before coding') && claudeMd.includes('rtk proxy'), 'English rules: workflow, Karpathy principles and RTK');
check(!/[А-Яа-я]/.test(claudeMd), 'English rules contain no Russian');
check(!/[А-Яа-я]/.test(fs.readFileSync(path.join(proj, '.claude', 'commands', 'orchestra.md'), 'utf8')), '/orchestra command is English');
check(!/[А-Яа-я]/.test(fs.readFileSync(path.join(proj, 'wiki', 'INVARIANTS.md'), 'utf8')) && !/[А-Яа-я]/.test(fs.readFileSync(path.join(proj, 'wiki', 'JOURNAL.md'), 'utf8')) && !/[А-Яа-я]/.test(fs.readFileSync(path.join(proj, 'wiki', 'README.md'), 'utf8')), 'wiki starter pages are English');
check(!/[А-Яа-я]/.test(fs.readFileSync(path.join(proj, '.githooks', 'pre-commit'), 'utf8')), 'git hook comments are English');
check(upgradeNeeds(proj).filter((x) => /правила|команда/.test(x)).length === 0, 'English kit is current in an English project');
check(!/[А-Яа-я]/.test(globalRules('en')) && /Think before coding/.test(globalRules('en')), 'global block (Karpathy) is English');

const m = new ProjectMemory(proj);
check(m.config().language === 'en', 'project follows the app language');
m.sessionStart('t');
m.sessionEnd({ author: 't', summary: 'Did a thing.', done: ['one'], next: ['two'] });
const journal = fs.readFileSync(path.join(proj, 'wiki', 'JOURNAL.md'), 'utf8');
check(journal.includes('**Done:**') && journal.includes('**Next task:**') && !/Сделано/.test(journal), 'journal labels are English');
check(/Previous session|In memory:|still empty/.test(m.context('')) && !/[А-Яа-я]/.test(m.context('')), 'context headings are English');

// briefs: either language's headings are accepted; the report speaks the project's language
fs.mkdirSync(path.join(proj, '.memory', 'briefs'), { recursive: true });
const brief = path.join('.memory', 'briefs', '2026-10-03-demo.md');
fs.writeFileSync(path.join(proj, brief), ['Goal', 'What is already known', 'Boundaries', 'Subtasks', 'Done when', 'How to verify', 'Questions'].map((h) => `**${h}**\ntext`).join('\n\n'));
const c = checkBrief(proj, brief);
check(c.missing.length === 0, `English brief headings accepted: missing=${c.missing}`);
check(/not approved: the owner has to write/.test(describeBrief(c, 'en')) && /не утверждён/.test(describeBrief(c, 'ru')), 'brief report follows the language');
fs.writeFileSync(path.join(proj, brief), '**Goal**\nx');
check(checkBrief(proj, brief).missing[0] === 'What is already known', 'missing sections are named in English');

// owner phrases work in both languages
check(['approve the brief', 'I approve the brief', 'brief approved', 'approved', 'утверждаю'].every((p) => APPROVE_RE.test(p)), 'approval phrases');
check(!APPROVE_RE.test('I approve of that idea') && !APPROVE_RE.test('was it approved by legal?'), 'casual «approve» is not an approval');
check(['allow prod', 'Allow deploy please', 'green light for production', 'разрешаю прод'].every((p) => GRANT_RE.test(p)), 'prod grant phrases');
check(!GRANT_RE.test('do not allow anything yet') && !GRANT_RE.test('what does the prod guard do?'), 'casual text is not a prod grant');
check(['revoke prod', 'cancel deploy', 'запрещаю прод'].every((p) => REVOKE_RE.test(p)), 'prod revoke phrases');
const d = decide('Bash', { command: 'npm run deploy' }, proj, { ...GUARD_DEFAULTS }, false, 'en');
check(d.decision === 'deny' && /This changes production/.test((d as any).reason) && /allow prod/.test((d as any).reason), 'prod guard speaks English');

// switching back: Russian project, Russian rules
process.env.ORCHESTRA_LANG = 'ru';
check(m.config().language === 'ru' && /правила/.test(upgradeNeeds(proj).join(' ')), 'after switching to Russian the English rules are reported as outdated');
check(agentRules('ru').includes('Память проекта') && orchestraCommand('ru').includes('Задача владельца'), 'Russian templates unchanged');

console.log('SMOKE-LANG OK');
