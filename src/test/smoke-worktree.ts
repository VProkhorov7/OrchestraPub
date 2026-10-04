/**
 * «Открыть worktree»: the service opens the task's folder (a stub opener in the test), and when it cannot, says why:
 * the task is unknown, or the folder is gone. A remote browser gets the path instead. Run: as a step of `npm run smoke`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Hub } from '../main/hub';
import { tmpdir, check } from './helpers';

(async () => {
  const tmp = tmpdir('orch-wt-');
  const home = path.join(tmp, 'home');
  const out = path.join(tmp, 'opened.txt');
  const opener = path.join(tmp, 'open.sh');
  fs.writeFileSync(opener, `#!/bin/sh\necho "$1" >> "${out}"\n`, { mode: 0o755 });
  process.env.ORCHESTRA_OPEN_CMD = opener;

  const there = path.join(tmp, 'worktrees', 'r1', 't01');
  fs.mkdirSync(there, { recursive: true });
  const gone = path.join(tmp, 'worktrees', 'r1', 't02');
  const mk = (id: string, status: string, wt: string) => ({ id, title: id, providerId: 'glm', model: 'm', spec: '', status, branch: `orch/r1-${id}`, worktree: wt, baseSha: 'abc', createdAt: 1, log: [] });
  fs.mkdirSync(path.join(home, 'runs', 'r1'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'runs', 'r1', 'run.json'),
    JSON.stringify({ version: 1, messages: [], savedAt: 1, state: { runId: 'r1', repo: '/r', baseBranch: 'main', goal: 'g', status: 'interrupted', source: 'mcp', transcript: [], tasks: [mk('t01', 'failed', there), mk('t02', 'failed', gone), mk('t03', 'discarded', gone)] } }),
  );
  const hub = new Hub(home, () => {});

  let r = await hub.openWorktree('r1', 't01');
  check(r.opened && r.path === there && fs.readFileSync(out, 'utf8').trim() === there, `an interrupted task's folder is opened: ${r.message}`);
  r = await hub.openWorktree('r1', 't02');
  check(!r.opened && /Рабочей папки больше нет/.test(r.message) && /orch\/r1-t02/.test(r.message), `a missing folder says why and names the branch: ${r.message.slice(0, 60)}`);
  r = await hub.openWorktree('r1', 't03');
  check(!r.opened && /тоже удалена/.test(r.message), 'for a discarded task it also says the branch is gone');
  r = await hub.openWorktree('r1', 't09');
  check(!r.opened && /не найдена/.test(r.message), 'an unknown task is reported');
  const before = fs.readFileSync(out, 'utf8');
  r = await hub.openWorktree('r1', 't01', false);
  check(!r.opened && r.path === there && fs.readFileSync(out, 'utf8') === before, 'a remote browser: nothing is opened on the server, the path is returned');

  delete process.env.ORCHESTRA_OPEN_CMD;
  console.log('SMOKE-WORKTREE OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
