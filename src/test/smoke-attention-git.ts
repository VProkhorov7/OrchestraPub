/**
 * «Требует вас» for saved runs: a done task whose branch is gone or already merged into the base branch is closed
 * (run.json still says «done»), an open branch is reported, an unreachable repo is not filtered, old run.json is skipped.
 * Run: as a step of `npm run smoke`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Hub } from '../main/hub';
import { tmpdir, sh, makeRepo, check } from './helpers';

const root = tmpdir('orch-attgit-');
const repo = makeRepo(root);
const g = (...a: string[]) => sh('git', a, repo);
const commitOn = (branch: string, file: string) => {
  g('checkout', '-q', '-b', branch, 'main');
  fs.writeFileSync(path.join(repo, file), file);
  g('add', '.');
  g('commit', '-q', '-m', file);
  g('checkout', '-q', 'main');
};
commitOn('orch/open', 'a.txt');
commitOn('orch/merged', 'b.txt');
g('merge', '-q', '--no-ff', '-m', 'merge b', 'orch/merged');

const home = path.join(root, 'home');
const hub = new Hub(home, () => {});
const save = (runId: string, state: any, ageDays = 0) => {
  const d = path.join(home, 'runs', runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify({ version: 1, state: { runId, baseBranch: 'main', tasks: [], ...state }, messages: [], savedAt: 0 }));
  if (ageDays) fs.utimesSync(path.join(d, 'run.json'), new Date(Date.now() - ageDays * 86_400_000), new Date(Date.now() - ageDays * 86_400_000));
};
const t = (id: string, branch: string) => ({ id, title: id, providerId: 'glm', status: 'done', log: [], branch, finishedAt: 1 });
save('r1', { repo, tasks: [t('t01', 'orch/open'), t('t02', 'orch/merged'), t('t03', 'orch/missing')] });
save('r2', { repo: path.join(root, 'no-such-repo'), tasks: [t('t04', 'orch/x')] });
save('rold', { repo, tasks: [t('t05', 'orch/open')] }, 31);

const items = () => hub.attention().filter((i) => i.kind === 'unmerged').map((i) => i.taskId);
const got = items().sort().join();
check(got === 't01,t04', `open branch and unreachable repo stay; merged, missing branch and 31-day-old run are dropped: ${got}`);
check(hub.attention().every((i) => i.kind !== 'spend'), 'no spend items for saved runs');

// the answer is cached: a branch deleted right now is still reported until the cache expires
g('branch', '-q', '-D', 'orch/open');
check(items().includes('t01'), 'git answer is cached for a while');
console.log('smoke-attention-git OK');
