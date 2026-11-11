/**
 * Memory record ids carry the branch code (D-FEA-0012) and never repeat:
 *  1. old ids (D-0001…D-0110) are read, found by id, superseded
 *  2. a branch without a code is refused with a hint; two branches cannot take one code
 *  3. two branches add decisions in parallel → after the merge the ids differ and both records are there
 *  4. deleting a record does not free its number
 *  5. doctor lists repeated ids; the pre-commit hook warns only about a repeat the commit brings
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { ProjectMemory } from '../memory/store';
import { tmpdir, sh, makeRepo, check } from './helpers';

const CLI = path.join(__dirname, '..', 'memory', 'cli.js');
const env = { ...process.env, ORCHESTRA_AUTHOR: 't', ORCHESTRA_MEMORY_OFF: '' } as NodeJS.ProcessEnv;
delete env.CLAUDECODE;
const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
const git = (cwd: string, ...args: string[]) => sh('git', args, cwd);
const dec = (id: string, title: string) => ({ id, title, decision: title, why: 'w', alternatives: [], facts: [], files: [], tags: [], author: 't', date: '2026-10-01T00:00:00Z', status: 'active' });
const writeList = (file: string, list: unknown[]) => fs.writeFileSync(file, '[\n' + list.map((x) => '  ' + JSON.stringify(x)).join(',\n') + '\n]\n');

const tmp = tmpdir('orch-memids-');
const repo = makeRepo(tmp);
const m = new ProjectMemory(repo);
m.init('Demo');
// An old memory: 110 decisions and 123 facts numbered by the old scheme.
writeList(path.join(repo, '.memory/logic.json'), Array.from({ length: 110 }, (_, i) => dec(`D-${String(i + 1).padStart(4, '0')}`, i === 40 ? 'Сейф хранит ключи в Keychain' : `решение ${i + 1}`)));
writeList(path.join(repo, '.memory/facts.json'), Array.from({ length: 123 }, (_, i) => ({ id: `F-${String(i + 1).padStart(4, '0')}`, text: `факт ${i + 1}`, tags: [], files: [], author: 't', created: '', updated: '', status: 'active' })));
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'old memory');

// 1. old ids
check(m.decisions().length === 110 && m.facts().length === 123, 'old records are read');
check((m.search('D-0041')[0]?.item as any)?.id === 'D-0041', 'search by an old id finds that record first');

// 2. no code → refused with a hint
let refused = '';
try {
  m.addDecision({ title: 'x', decision: 'x', why: 'x', author: 't' });
} catch (e: any) {
  refused = e.message;
}
check(/orchestra-memory prefix/.test(refused) && /main/.test(refused), 'a branch without a code is refused with a hint: ' + refused);
check(m.decisions().length === 110, 'nothing written without a code');
const noCode = cli(repo, 'add-fact', 'что-то');
check(noCode.status !== 0 && /orchestra-memory prefix/.test(noCode.stderr), 'CLI refuses too: ' + noCode.stderr);

// Two branches in their own worktrees, as parallel sessions work.
git(repo, 'branch', 'features');
git(repo, 'branch', 'android');
const wtF = path.join(tmp, 'wt-features');
const wtA = path.join(tmp, 'wt-android');
git(repo, 'worktree', 'add', '-q', wtF, 'features');
git(repo, 'worktree', 'add', '-q', wtA, 'android');
const mF = new ProjectMemory(wtF);
const mA = new ProjectMemory(wtA);
check(cli(wtF, 'prefix', 'fea').status === 0 && mF.branchCode() === 'FEA', 'features gets FEA (case is normalised)');
let taken = '';
try {
  mA.setBranchCode('FEA');
} catch (e: any) {
  taken = e.message;
}
check(/features/.test(taken), 'android cannot take the code of features: ' + taken);
check(/FEA\s+features/.test(cli(repo, 'prefix').stdout), 'the table of codes is visible from any worktree');
mA.setBranchCode('A');
let bad = false;
try {
  mA.setBranchCode('A1');
} catch {
  bad = true;
}
check(bad, 'a code is letters only');

// 3. parallel decisions, then merge
const dF = mF.addDecision({ title: 'Сейф в Features', decision: 'ключи в Secure Enclave', why: 'надёжнее', author: 't', supersedes: 'D-0041' });
const dA = mA.addDecision({ title: 'Обложки только Ultimate', decision: 'ИИ-обложки в тарифе Ultimate', why: 'дорого', author: 't' });
const fF = mF.addFact({ text: 'Features: факт', author: 't' });
check(dF.id === 'D-FEA-0001' && dA.id === 'D-A-0001' && fF.id === 'F-FEA-0001', `branch ids: ${dF.id} ${dA.id} ${fF.id}`);
check(mF.decisions().find((d) => d.id === 'D-0041')?.status === 'superseded', '--supersedes of an old id works');
check(mF.addDecision({ title: 'второе', decision: 'второе', why: 'w', author: 't', facts: ['F-0007', 'F-FEA-0001'] }).id === 'D-FEA-0002', 'the counter goes on within the code; --facts takes both kinds');
for (const wt of [wtF, wtA]) {
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'decision');
}
git(repo, 'merge', '-q', '--no-edit', 'features');
const merge = spawnSync('git', ['merge', '--no-edit', 'android'], { cwd: repo, encoding: 'utf8' });
if (merge.status !== 0) {
  // logic.json is one JSON array: two branches appending to it conflict, as they did before ids changed.
  // Resolve as a person would: keep every record of both sides.
  for (const f of ['.memory/logic.json', '.memory/facts.json', '.memory/log/' + fs.readdirSync(path.join(repo, '.memory/log')).find((x) => x.endsWith('.jsonl'))]) {
    const side = (n: number) => spawnSync('git', ['show', `:${n}:${f}`], { cwd: repo, encoding: 'utf8' }).stdout;
    if (!side(2)) continue;
    if (f.endsWith('.jsonl')) fs.writeFileSync(path.join(repo, f), [...new Set([...side(2).split('\n'), ...side(3).split('\n')].filter(Boolean))].join('\n') + '\n');
    else {
      const ours = JSON.parse(side(2));
      for (const x of JSON.parse(side(3))) if (!ours.some((o: any) => o.id === x.id)) ours.push(x);
      writeList(path.join(repo, f), ours);
    }
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--no-edit');
}
const ids = m.decisions().map((d) => d.id);
check(ids.includes('D-FEA-0001') && ids.includes('D-A-0001') && ids.includes('D-FEA-0002') && ids.length === 113, 'after the merge both branches\' decisions are there: ' + ids.slice(-4).join(' '));
check(new Set(ids).size === ids.length, 'and no id repeats');
check(cli(repo, 'doctor').status === 0, 'doctor: no repeats after the merge');

// 4. a deleted record keeps its number taken
const f2 = mA.addFact({ text: 'второй факт', author: 't' });
const f3 = mA.addFact({ text: 'третий факт', author: 't' });
writeList(path.join(wtA, '.memory/facts.json'), mA.facts().filter((f) => f.id !== f3.id));
const f4 = mA.addFact({ text: 'четвёртый факт', author: 't' });
check(f2.id === 'F-A-0001' && f3.id === 'F-A-0002' && f4.id === 'F-A-0003', `after deleting the last record its number is not given again: ${f2.id} ${f3.id} ${f4.id}`);
writeList(path.join(wtA, '.memory/facts.json'), mA.facts().filter((f) => f.id !== f2.id));
const f5 = mA.addFact({ text: 'пятый факт', author: 't' });
check(f5.id === 'F-A-0004' && !mA.facts().slice(0, -1).some((f) => f.id === f5.id), 'deleting from the middle does not repeat a number either: ' + f5.id);

// A code free in git config but already in the records (a deleted branch, another clone) needs --force.
git(repo, 'worktree', 'remove', wtF);
git(repo, 'branch', '-d', 'features'); // git drops the branch's config, the code with it
check(!new ProjectMemory(repo).branchCodes().features, 'a deleted branch frees its code in git config');
git(repo, 'branch', 'fast');
let reused = '';
try {
  new ProjectMemory(repo).setBranchCode('FEA', { branch: 'fast' });
} catch (e: any) {
  reused = e.message;
}
check(/D-FEA-0001/.test(reused) && /--force/.test(reused), 'a code already used in the records needs --force: ' + reused);
let elsewhere = '';
try {
  mA.setBranchCode('FEA', { branch: 'fast' }); // the android tree has no FEA records, main has
} catch (e: any) {
  elsewhere = e.message;
}
check(/D-FEA-0001/.test(elsewhere), 'records of other branches count too, not only this tree: ' + elsewhere);
const forced = cli(repo, 'prefix', '--branch', 'fast', '--force', 'FEA');
check(forced.status === 0 && new ProjectMemory(repo).branchCodes().fast === 'FEA', '--force is a flag: the code after it is still the code: ' + forced.stdout + forced.stderr);
let recode = '';
try {
  new ProjectMemory(repo).setBranchCode('FS', { branch: 'fast' });
} catch (e: any) {
  recode = e.message;
}
check(/--force/.test(recode), 'changing a branch\'s code needs --force: ' + recode);
check(new ProjectMemory(repo).setBranchCode('FS', { branch: 'fast', force: true }) === 'FS', 'with --force the code changes');
check((m.search('D-0041')[0]?.item as any)?.id === 'D-0041', 'a superseded old record is still found by its id');

// 5. doctor and the pre-commit warning
const logic = path.join(repo, '.memory/logic.json');
writeList(logic, [...m.decisions(), dec('D-0108', 'дубль')]);
git(repo, 'add', '-A');
const warn = cli(repo, 'hook', 'pre-commit');
check(/D-0108/.test(warn.stderr), 'pre-commit warns about a repeat the commit brings: ' + warn.stderr);
const doc = cli(repo, 'doctor');
check(doc.status === 1 && /logic\.json: D-0108/.test(doc.stdout), 'doctor lists the repeat: ' + doc.stdout);
git(repo, 'commit', '-q', '--no-verify', '-m', 'old repeat');
fs.appendFileSync(path.join(repo, 'hello.txt'), 'more\n');
git(repo, 'add', '-A');
check(!/D-0108/.test(cli(repo, 'hook', 'pre-commit').stderr), 'a repeat already in HEAD is not warned about again');

console.log(`\nSMOKE-MEMORY-IDS OK ${tmp}`);
process.exit(0);
