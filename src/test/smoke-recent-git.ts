/**
 * «Недавно завершено» for saved runs: a done task whose branch is gone or merged is shown as merged, an open branch
 * and an unreachable repo stay done.
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
const t = (id: string, branch: string) => ({ id, title: id, providerId: 'glm', status: 'done', log: [], branch, finishedAt: Date.now() });
save('r1', { repo, tasks: [t('t01', 'orch/open'), t('t02', 'orch/merged'), t('t03', 'orch/missing')] });
save('r2', { repo: path.join(root, 'no-such-repo'), tasks: [t('t04', 'orch/x')] });

const st = (id: string) => hub.recent().find((i) => i.taskId === id)?.status;
check(st('t01') === 'done', `open branch stays done: ${st('t01')}`);
check(st('t02') === 'merged', `merged branch is merged: ${st('t02')}`);
check(st('t03') === 'merged', `missing branch is merged: ${st('t03')}`);
check(st('t04') === 'done', `unreachable repo stays done: ${st('t04')}`);
console.log('smoke-recent-git OK');
