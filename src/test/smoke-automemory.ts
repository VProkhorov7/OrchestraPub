/**
 * Project memory by itself, on first use: no `init`. A fresh repository gets it, a branch without it takes the files over
 * from main (so merges stay clean), and it can be switched off. Run: as a step of `npm run smoke`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ensureMemory, setupRepo } from '../memory/setup';
import { ProjectMemory } from '../memory/store';
import { Hub } from '../main/hub';
import { tmpdir, check } from './helpers';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString();
const mkrepo = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
};

(async () => {
  const tmp = tmpdir('orch-automem-');
  process.env.ORCHESTRA_LANG = 'en';

  // 1. a fresh repository
  const r1 = mkrepo(path.join(tmp, 'one'));
  check(!ProjectMemory.exists(r1), 'no memory to begin with');
  const e1 = ensureMemory(r1);
  check(e1.created && ProjectMemory.exists(r1), 'first use creates the memory');
  check(fs.readFileSync(path.join(r1, 'CLAUDE.md'), 'utf8').includes('orchestra-memory:start') && fs.existsSync(path.join(r1, 'wiki', 'JOURNAL.md')), 'with the rules and the wiki pages');
  check(new ProjectMemory(r1).readLog().some((e) => /created automatically/.test(e.description) || /создана автоматически/.test(e.description)), 'and a note in the journal says it was automatic');
  check(ensureMemory(r1).skipped === 'exists' && !ensureMemory(r1).created, 'the second use does nothing');
  check(!git(r1, 'status', '--porcelain').trim() && /project memory created automatically/.test(git(r1, 'log', '-1', '--format=%s')), 'the files are committed (a run refuses a dirty repository), and nothing else is touched');
  // the owner's own uncommitted work in a memory file is never committed for them
  const rd = mkrepo(path.join(tmp, 'dirty'));
  fs.writeFileSync(path.join(rd, 'CLAUDE.md'), 'my own notes\n');
  ensureMemory(rd);
  check(ProjectMemory.exists(rd) && /CLAUDE.md/.test(git(rd, 'status', '--porcelain')), 'uncommitted work of the owner in CLAUDE.md is left uncommitted');

  // 2. switches
  const r2 = mkrepo(path.join(tmp, 'two'));
  fs.writeFileSync(path.join(r2, '.orchestra-no-memory'), '');
  check(ensureMemory(r2).skipped === 'marker' && !ProjectMemory.exists(r2), 'an empty .orchestra-no-memory keeps a repository out');
  const r3 = mkrepo(path.join(tmp, 'three'));
  process.env.ORCHESTRA_NO_AUTOMEMORY = '1';
  check(ensureMemory(r3).skipped === 'off' && !ProjectMemory.exists(r3), 'ORCHESTRA_NO_AUTOMEMORY switches it off');
  delete process.env.ORCHESTRA_NO_AUTOMEMORY;
  const notGit = path.join(tmp, 'plain');
  fs.mkdirSync(notGit);
  check(ensureMemory(notGit).skipped === 'not-git', 'a folder that is not a git repository is left alone');

  // 3. a branch made before the memory existed takes it over from main
  const r4 = mkrepo(path.join(tmp, 'four'));
  git(r4, 'branch', 'old'); // made from the commit without memory
  setupRepo(r4, {});
  const pm = new ProjectMemory(r4);
  pm.addFact({ text: 'The panel is served from renderer/', tags: [], files: [], author: 't' });
  git(r4, 'add', '-A');
  git(r4, 'commit', '-q', '-m', 'memory on main');
  git(r4, 'checkout', '-q', 'old');
  check(!ProjectMemory.exists(r4), 'the old branch has no memory');
  const e4 = ensureMemory(r4);
  check(e4.created && e4.adoptedFrom === 'main', `it is taken over from main: ${JSON.stringify(e4)}`);
  const onMain = git(r4, 'show', 'main:.memory/facts.json');
  check(fs.readFileSync(path.join(r4, '.memory', 'facts.json'), 'utf8') === onMain, 'the facts are the same file as on main (a later merge has nothing to fight over)');

  // 4. the CLI needs no init either
  const r5 = mkrepo(path.join(tmp, 'five'));
  const cli = path.join(__dirname, '..', 'memory', 'cli.js');
  const out = execFileSync('node', [cli, 'context', 'anything', '--repo', r5], { env: { ...process.env, ORCHESTRA_LANG: 'en' } }).toString();
  check(ProjectMemory.exists(r5) && /memory is still empty|facts/i.test(out), `orchestra-memory context works in a fresh repository: ${out.slice(0, 50)}`);

  // 5. the hub: choosing a repository in the panel is a first use
  const r6 = mkrepo(path.join(tmp, 'six'));
  const hub = new Hub(path.join(tmp, 'home'), () => {});
  check(hub.memoryStatus(r6).enabled === true && ProjectMemory.exists(r6), 'the panel status call creates the memory');

  console.log('SMOKE-AUTOMEMORY OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
