/**
 * Time-of-day tariffs (DeepSeek), cost by the tariff at work time, «off-peak only» runs holding workers
 * during peak hours, and scheduling a run into the next cheap window. Time is fixed with ORCHESTRA_NOW.
 */
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir, makeRepo, makeFakeClaude, fakeApi, toolUse, check, testConfig } from './helpers';
import { isPeak, nextWindow, offPeakNow, DEEPSEEK_PEAK, tariffStatus } from '../main/tariff';
import { normalizeConfig } from '../main/config';
import { fromPreset } from '../main/catalog';
import { Hub } from '../main/hub';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const at = (iso: string) => (process.env.ORCHESTRA_NOW = iso);

(async () => {
  // 1. the rule: peak 01–04 and 06–10 UTC on weekdays
  check(isPeak(DEEPSEEK_PEAK, new Date('2026-09-28T02:00:00Z')), 'Monday 02:00 UTC (05:00 MSK) is peak');
  check(!isPeak(DEEPSEEK_PEAK, new Date('2026-09-28T05:00:00Z')), 'Monday 05:00 UTC (08:00 MSK) is off-peak');
  check(isPeak(DEEPSEEK_PEAK, new Date('2026-09-28T09:59:00Z')) && !isPeak(DEEPSEEK_PEAK, new Date('2026-09-28T10:00:00Z')), 'peak ends at 10:00 UTC (13:00 MSK)');
  check(!isPeak(DEEPSEEK_PEAK, new Date('2026-10-03T02:00:00Z')), 'Saturday is off-peak all day');
  check(!isPeak(DEEPSEEK_PEAK, new Date('2026-10-05T02:00:00Z')), 'Monday 5 Oct 2026 is a Chinese holiday: off-peak');
  check(isPeak(DEEPSEEK_PEAK, new Date('2026-10-08T02:00:00Z')), 'Thursday 8 Oct 2026, after the holiday: peak again');
  check(!isPeak(DEEPSEEK_PEAK, new Date('2027-10-04T02:00:00Z')) && !isPeak(DEEPSEEK_PEAK, new Date('2027-06-09T07:00:00Z')), '2027 holidays (provisional list) are off-peak');
  check(isPeak(DEEPSEEK_PEAK, new Date('2027-03-10T02:00:00Z')), 'an ordinary 2027 weekday is peak');

  const cfg = testConfig('claude', { providers: [fromPreset('deepseek', { token: 'k' })] });
  check(!!cfg.providers[0].peak, 'DeepSeek preset carries the tariff');
  // the 2-hour morning gap (04–06 UTC) is too short: the next window of 3+ hours starts at 10:00 UTC
  let w = nextWindow(cfg, new Date('2026-09-28T03:00:00Z'))!;
  check(w.start.toISOString() === '2026-09-28T10:00:00.000Z' && w.end.toISOString() === '2026-09-29T01:00:00.000Z', `next window from 03:00: ${w.start.toISOString()} – ${w.end.toISOString()}`);
  w = nextWindow(cfg, new Date('2026-09-28T12:00:00Z'))!;
  check(w.start.toISOString() === '2026-09-28T12:00:00.000Z', 'inside a long window: start now');
  w = nextWindow(cfg, new Date('2026-10-09T20:00:00Z'))!;
  check(w.end.toISOString() === '2026-10-12T01:00:00.000Z', `Friday evening runs to Monday 01:00 UTC (${w.end.toISOString()})`);
  w = nextWindow(cfg, new Date('2026-10-02T20:00:00Z'))!;
  check(w.end.toISOString() === '2026-10-08T01:00:00.000Z', `Friday evening in the National Day week runs to Thursday 8 Oct 01:00 UTC (${w.end.toISOString()})`);
  at('2026-09-28T08:00:00Z');
  const ts: any = tariffStatus(cfg);
  check(ts.has && !ts.cheap && ts.until === '2026-09-28T10:00:00.000Z', 'status: peak until 10:00 UTC');
  check(!offPeakNow(cfg), 'offPeakNow false at 08:00 UTC');

  // 2. a card saved before tariffs gets the rule on load
  const old = normalizeConfig({ providers: [{ ...fromPreset('deepseek', { token: 'k' }), peak: undefined }] } as any);
  check(!!old.providers.find((p) => p.id === 'deepseek')?.peak, 'old DeepSeek card gets the tariff');

  // 3. an off-peak-only run at peak: the worker waits; off-peak it runs and costs half
  const tmp = tmpdir('orch-tariff-');
  const repo = makeRepo(tmp);
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(testConfig(makeFakeClaude(tmp), { providers: [fromPreset('deepseek', { token: 'k' })] })));
  const api = await fakeApi([
    toolUse('a1', 'delegate', { provider: 'deepseek', role: 'docs', title: 'Edit hello', spec: 'Change hello.txt' }),
    toolUse('a2', 'wait_for', {}),
    toolUse('a3', 'merge_task', { task_id: 't01' }),
    toolUse('a4', 'finish', { report: 'ok' }),
  ]);
  const hub = new Hub(home, () => {});
  hub.health = { deepseek: { light: 'green', text: '', checkedAt: 0 } };
  at('2026-09-28T02:00:00Z'); // Monday 05:00 MSK: peak
  const runId = await hub.start(repo, 'Edit hello', undefined, undefined, { offPeakOnly: true });
  for (let i = 0; i < 50 && !hub.state(runId)!.tasks.length; i++) await sleep(100);
  await sleep(500);
  let t = hub.state(runId)!.tasks[0];
  check(t.status === 'queued' && t.log.some((l) => /ждёт льготного тарифа до 04:00/.test(l)), `held in peak: ${t.status} ${t.log.join(' | ')}`);
  check(api.requests.some((r) => JSON.stringify(r.messages).includes("waits for deepseek's off-peak price")), 'orchestrator told the task waits');
  at('2026-09-28T05:00:00Z'); // off-peak
  (hub as any).controllers.get(runId).engine.pump();
  for (let i = 0; i < 100 && ['idle', 'running'].includes(hub.state(runId)!.status); i++) await sleep(200);
  api.close();
  t = hub.state(runId)!.tasks[0];
  check(t.status === 'merged', `worker ran off-peak and was merged: ${t.status}`);
  check(Math.abs((t.costUsd ?? 0) - 0.1716 / 2) < 1e-6, `off-peak cost is half: ${t.costUsd}`);
  check(hub.state(runId)!.offPeakOnly === true, 'run remembers off-peak only');

  // 3b. peak hours with a second worker that has no tariff: the task goes to it instead of waiting
  {
    const tmp2 = tmpdir('orch-tariff-alt-');
    const repo2 = makeRepo(tmp2);
    const home2 = path.join(tmp2, 'home');
    fs.mkdirSync(home2);
    fs.writeFileSync(path.join(home2, 'config.json'), JSON.stringify(testConfig(makeFakeClaude(tmp2), { providers: [fromPreset('deepseek', { token: 'k' }), fromPreset('glm', { token: 'k' })] })));
    const apiAlt = await fakeApi([
      toolUse('c1', 'delegate', { provider: 'deepseek', role: 'refactor', title: 'Edit hello', spec: 'Change hello.txt' }),
      toolUse('c2', 'finish', { report: 'ok' }),
    ]);
    const hubAlt = new Hub(home2, () => {});
    hubAlt.health = { deepseek: { light: 'green', text: '', checkedAt: 0 }, glm: { light: 'green', text: '', checkedAt: 0 } };
    at('2026-09-28T02:00:00Z'); // peak
    const runAlt = await hubAlt.start(repo2, 'Edit hello', undefined, undefined, { offPeakOnly: true });
    for (let i = 0; i < 50 && !hubAlt.state(runAlt)!.tasks.length; i++) await sleep(100);
    const ta = hubAlt.state(runAlt)!.tasks[0];
    check(ta.providerId === 'glm', `in peak the task goes to the worker without a tariff: ${ta.providerId}`);
    check(apiAlt.requests.some((r) => JSON.stringify(r.messages).includes('on glm')), 'orchestrator told which worker took it');
    apiAlt.close();
    hubAlt.cancel?.(runAlt);
  }

  // 4. scheduling: at 11:00 MSK the run is put off to 13:00 MSK, then started by the minute tick
  at('2026-09-28T08:00:00Z');
  const s = await hub.schedule(repo, 'Второй запуск', undefined, undefined);
  check(s.at === '2026-09-28T10:00:00.000Z' && hub.scheduled().length === 1, `scheduled for 10:00 UTC: ${s.at}`);
  check(JSON.parse(fs.readFileSync(path.join(home, 'scheduled.json'), 'utf8')).length === 1, 'schedule survives a restart (file)');
  let dupRefused = false;
  try {
    await hub.schedule(repo, 'Второй запуск ', undefined, undefined);
  } catch {
    dupRefused = true;
  }
  check(dupRefused && hub.scheduled().length === 1, 'the same task is not scheduled twice');
  await hub.tickSchedule();
  check(hub.scheduled().length === 1, 'not started before its time');
  const api2 = await fakeApi([toolUse('b1', 'finish', { report: 'nothing to do' })]);
  at('2026-09-28T10:01:00Z');
  await hub.tickSchedule();
  check(hub.scheduled().length === 0, 'started at its time and removed from the list');
  const run2 = hub.currentId!;
  check(run2 !== runId && hub.state(run2)!.goal === 'Второй запуск', 'the scheduled run started');
  for (let i = 0; i < 50 && ['idle', 'running'].includes(hub.state(run2)!.status); i++) await sleep(100);
  check(hub.state(run2)!.offPeakOnly === true, 'a scheduled run is off-peak only');
  api2.close();
  // cancel
  const s2 = await hub.schedule(repo, 'Третий', undefined, undefined);
  hub.unschedule(s2.id);
  check(!hub.scheduled().length, 'unschedule');
  // 5. OmniRoute was dropped in 0.7.5: no preset, and a card saved in 0.7.4 disappears on load
  const { PRESETS } = await import('../main/catalog');
  check(!PRESETS.some((x: any) => x.id === 'omniroute'), 'no OmniRoute preset');
  const cleaned = normalizeConfig({ providers: [{ id: 'omniroute', kind: 'api', preset: 'omniroute', label: 'OmniRoute', baseUrl: 'http://127.0.0.1:20128', model: 'x', roles: [] }] } as any);
  check(!cleaned.providers.some((p) => p.id === 'omniroute'), 'saved OmniRoute card is removed');

  delete process.env.ORCHESTRA_NOW;
  console.log('SMOKE-TARIFF OK', tmp);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
