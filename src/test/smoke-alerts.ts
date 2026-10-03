/**
 * Watchdogs and alerts: de-duplication, persistence and notifications; the in-service watchdog (silent worker, lost
 * worktree, budgets, failures, connection lights, run endings); the external watchdog's decisions; and the message for
 * a missing working directory. Run: as a step of `npm run smoke`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Alerts, readAlerts } from '../main/alerts';
import { Watchdog } from '../main/watchdog';
import { run } from '../main/git';
import { watchStep, readWatch, writeWatch } from '../server/ctl';
import { Alert } from '../main/types';
import { tmpdir, check } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = tmpdir('orch-alerts-');
  const out = path.join(tmp, 'notified.txt');
  const notifier = path.join(tmp, 'notify.sh');
  fs.writeFileSync(notifier, `#!/bin/sh\necho "$1|$2" >> "${out}"\n`, { mode: 0o755 });
  process.env.ORCHESTRA_NOTIFY_CMD = notifier;
  const notified = () => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean) : []);

  // ---- Alerts
  let t = 1_000_000;
  const cfg: any = { language: 'en', notify: { macos: true, macosLevel: 'error' }, providers: [{ id: 'glm', label: 'GLM', enabled: true }] };
  const emitted: Alert[] = [];
  const alerts = new Alerts(path.join(tmp, 'alerts.json'), () => cfg, (a) => emitted.push(a), () => t);
  check(alerts.raise({ key: 'k', level: 'error', title: 'Boom', text: 'x' }) !== null, 'first alert is raised');
  check(alerts.raise({ key: 'k', level: 'error', title: 'Boom', text: 'x' }) === null, 'the same key inside the cool-down is not raised again');
  t += 11 * 60_000;
  check(alerts.raise({ key: 'k', level: 'error', title: 'Boom', text: 'x' }) !== null, 'after the cool-down it is raised again');
  alerts.raise({ key: 'w', level: 'warn', title: 'Careful', text: 'y' });
  await sleep(1500);
  check(notified().length === 2 && notified().every((l) => l.startsWith('error|Boom')), `macOS notifier only for errors: ${notified().join(' / ')}`);
  check(readAlerts(path.join(tmp, 'alerts.json')).length === 3 && emitted.length === 3, 'alerts are stored (newest first) and emitted');
  alerts.clear('k', 'Fine again', 'ok');
  check(alerts.list()[0].level === 'info' && alerts.list()[0].title === 'Fine again', 'clearing leaves an «ok again» note');
  check(alerts.raise({ key: 'k', level: 'error', title: 'Boom', text: 'x' }) !== null, 'a cleared problem is raised at once when it comes back');
  alerts.clearAll();
  check(alerts.list().length === 0, 'clearAll empties the list');

  // ---- Watchdog
  const mk = (over: any = {}) => ({
    state: { runId: 'r1', repo: '/r', goal: 'g', status: 'running', tasks: [] as any[], ...over },
    budget: () => 10,
    spent: () => ({ total: 0, byProvider: {} as Record<string, number> }),
    cfg: { providers: [{ id: 'glm', maxUsdPerRun: 3 }] },
  });
  const eng: any = mk();
  const wt = path.join(tmp, 'wt');
  fs.mkdirSync(wt);
  const task: any = { id: 't02', title: 'panel labels', providerId: 'glm', status: 'running', log: ['> Edit a.ts'], tokensIn: 10, tokensOut: 1, costUsd: 0.1, worktree: wt };
  eng.state.tasks.push(task);
  let now = 5_000_000;
  const emitted2: Alert[] = [];
  const a2 = new Alerts(path.join(tmp, 'alerts2.json'), () => cfg, (a) => emitted2.push(a), () => now);
  const wd = new Watchdog({ liveEngines: () => [eng] }, a2, () => ({ ...cfg, notify: { ...cfg.notify, silentMinutes: 8 } }), () => now);
  const titles = () => emitted2.map((a) => a.title);

  wd.tick();
  now += 5 * 60_000;
  wd.tick();
  check(emitted2.length === 0, 'a worker that was active 5 minutes ago is fine');
  now += 4 * 60_000; // 9 minutes without any change
  wd.tick();
  check(titles().some((x) => /silent for 9 min/.test(x)), `a silent worker is reported: ${titles()}`);
  task.log.push('> Edit b.ts');
  wd.tick();
  check(titles().some((x) => /active again/.test(x)), 'activity clears the silence alert with an «again» note');

  fs.rmSync(wt, { recursive: true });
  wd.tick();
  check(emitted2.some((a) => a.level === 'error' && /lost its working folder/.test(a.title)), 'a running task without its worktree is an error');
  fs.mkdirSync(wt);

  eng.spent = () => ({ total: 8.5, byProvider: { glm: 2.8 } });
  wd.tick();
  check(titles().some((x) => /80%/.test(x)) && titles().some((x) => /GLM|glm: 90%/.test(x)), `budget 85% and a cap at 93% are reported: ${titles().slice(-3)}`);
  eng.spent = () => ({ total: 10.2, byProvider: { glm: 3.1 } });
  wd.tick();
  check(emitted2.some((a) => a.level === 'error' && /budget is used up/.test(a.title)) && emitted2.some((a) => /Spend cap of glm reached/.test(a.title)), 'full budget and full cap are errors');

  const before = emitted2.length;
  wd.onEvent({ type: 'task', runId: 'r1', task: { ...task, status: 'failed', error: 'git status --porcelain failed' } } as any);
  wd.onEvent({ type: 'task', runId: 'r1', task: { ...task, status: 'failed', error: 'git status --porcelain failed' } } as any);
  check(emitted2.length === before + 1 && /Task t02 \(glm\): error/.test(emitted2[emitted2.length - 1].title), 'a failed task is reported once (not on every event)');

  const H = (light: string, text = '') => ({ glm: { light, text, checkedAt: 0 } });
  wd.onEvent({ type: 'health', health: H('green') } as any);
  wd.onEvent({ type: 'health', health: H('red', 'key rejected') } as any);
  check(emitted2.some((a) => /Connection «GLM»: down/.test(a.title) && a.text === 'key rejected'), 'a connection turning red is reported');
  wd.onEvent({ type: 'health', health: H('green', 'ok') } as any);
  check(emitted2.some((a) => /works again/.test(a.title)), 'and its recovery too');

  wd.onEvent({ type: 'state', runId: 'r9', state: { status: 'interrupted', goal: 'x', stopReason: '' } } as any);
  check(emitted2.some((a) => /Run r9: interrupted/.test(a.title)), 'an interrupted run is reported');

  // ---- the external watchdog
  let st = { fails: 0, paused: false };
  let r = watchStep(st, true, 0);
  check(r.action === 'none', 'service answers: nothing to do');
  r = watchStep(st, false, 0);
  check(r.action === 'none' && r.state.fails === 1, 'one miss is not an outage (a restart may be in progress)');
  r = watchStep(r.state, false, 0);
  check(r.action === 'recover' && r.state.fails === 2, 'two misses in a row: bring the service back');
  r = watchStep(r.state, true, 0);
  check(r.action === 'recovered' && r.state.fails === 0, 'answering again after an outage is reported once');
  r = watchStep({ fails: 5, paused: true }, false, 0);
  check(r.action === 'none', 'after «stop» the service is not brought back');
  writeWatch(tmp, { fails: 2, paused: true });
  check(readWatch(tmp).paused === true && readWatch(path.join(tmp, 'nowhere')).fails === 0, 'watch state is stored and has a default');

  // ---- a missing working directory is not «command not found»
  const g = await run('git', ['status'], path.join(tmp, 'gone'));
  check(g.code === 128 && /working directory does not exist/.test(g.stderr) && !/command not found/.test(g.stderr), `missing cwd gets its own message: ${g.stderr}`);
  const ok = await run('git', ['--version'], tmp);
  check(ok.code === 0, 'git itself still runs');

  delete process.env.ORCHESTRA_NOTIFY_CMD;
  console.log('SMOKE-ALERTS OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
