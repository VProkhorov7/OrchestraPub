#!/usr/bin/env node
/**
 * Control of the background service for the desktop launcher (scripts/desktop/Orchestra.command):
 *
 *   orchestra-ctl up        make sure the service runs under launchd and answers; print the panel address
 *   orchestra-ctl restart   the same after a restart, but refuse while workers are busy (--force overrides, --when-idle waits)
 *   orchestra-ctl stop      stop the service and keep it from starting at login
 *   orchestra-ctl status    what runs, where, and whether any run is busy
 *   orchestra-ctl url       the panel address with the token
 *   orchestra-ctl watch     one probe of the external watchdog (launchd runs it every minute): bring the service back if it is down
 *
 * The launchd agent is rewritten whenever it does not match this checkout (a moved or renamed folder no longer
 * leaves a service that cannot start). Exit codes: 0 ok, 2 the service does not answer, 3 workers are busy.
 */
import * as fs from 'fs';
import * as path from 'path';
import { orchestraHome } from '../main/paths';
import {
  hasLaunchd, launchdKickstart, launchdLoad, launchdLoaded, launchdUnload, loadToken, manualServicePids,
  panelUrl, plistPath, plistText, serviceAnswers, watchLoad, watchLoaded, watchPlistPath, watchPlistText, watchUnload, writePlist, writeWatchPlist,
} from '../main/service';
import { appendAlert, deliver } from '../main/alerts';

export interface Busy {
  runId: string;
  repo: string;
  tasks: string[];
}

/** Runs that are doing work now: an app run that is going, or an MCP session with a queued or running worker. */
export function busyRuns(home: string): Busy[] {
  const dir = path.join(home, 'runs');
  const out: Busy[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, n, 'run.json'), 'utf8')).state;
      if (s.status !== 'running') continue;
      const active = (s.tasks ?? []).filter((t: any) => t.status === 'running' || t.status === 'queued');
      if (s.source === 'mcp' && !active.length) continue;
      out.push({ runId: s.runId, repo: s.repo, tasks: active.map((t: any) => `${t.id} (${t.providerId})`) });
    } catch {
      /* a half-written file: not busy */
    }
  }
  return out;
}

/** Polls until no run is busy: true when free, false when timeoutMs passed first. */
export async function waitIdle(home: string, opts: { timeoutMs: number; pollMs: number; onWait?: (busy: Busy[]) => void }): Promise<boolean> {
  const end = Date.now() + opts.timeoutMs;
  for (;;) {
    const busy = busyRuns(home);
    if (!busy.length) return true;
    if (Date.now() >= end) return false;
    opts.onWait?.(busy);
    await new Promise((r) => setTimeout(r, Math.min(opts.pollMs, Math.max(0, end - Date.now()))));
  }
}

export function servePort(home: string): { host: string; port: number } {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    return { host: c.serve?.host ?? '127.0.0.1', port: Number(c.serve?.port ?? 7777) };
  } catch {
    return { host: '127.0.0.1', port: 7777 };
  }
}

/** The agent file starts this checkout's service on this host and port (the PATH inside it may differ and is ignored). */
export function plistCurrent(host: string, port: number): boolean {
  const args = (xml: string) => {
    const m = /<key>ProgramArguments<\/key><array>([\s\S]*?)<\/array>/.exec(xml);
    return m ? [...m[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((x) => x[1]).join('\0') : '';
  };
  try {
    return args(fs.readFileSync(plistPath(), 'utf8')) === args(plistText(host, port));
  } catch {
    return false;
  }
}

async function waitUp(host: string, port: number, seconds = 25): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    if (await serviceAnswers(host, port, 1500)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function logTail(home: string): string {
  try {
    return fs.readFileSync(path.join(home, 'logs', 'serve.log'), 'utf8').trim().split('\n').slice(-6).join('\n');
  } catch {
    return '';
  }
}

// ---------- the external watchdog ----------

export interface WatchState {
  /** Consecutive probes that got no answer. */
  fails: number;
  /** After `stop`: the owner stopped the service on purpose, do not bring it back. */
  paused: boolean;
  lastNotifiedAt?: number;
}

export type WatchAction = 'none' | 'recover' | 'recovered';

/** One probe: what to do, and the next state. Two misses in a row are an outage (one can be a restart in progress). */
export function watchStep(state: WatchState, answers: boolean, now: number): { state: WatchState; action: WatchAction } {
  if (state.paused) return { state: { ...state, fails: 0 }, action: 'none' };
  if (answers) return { state: { ...state, fails: 0 }, action: state.fails >= 2 ? 'recovered' : 'none' };
  const fails = state.fails + 1;
  return { state: { ...state, fails }, action: fails >= 2 ? 'recover' : 'none' };
}

function watchFile(home: string) {
  return path.join(home, 'watch.json');
}

export function readWatch(home: string): WatchState {
  try {
    return { fails: 0, paused: false, ...JSON.parse(fs.readFileSync(watchFile(home), 'utf8')) };
  } catch {
    return { fails: 0, paused: false };
  }
}

export function writeWatch(home: string, s: WatchState) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(watchFile(home), JSON.stringify(s));
}

function appConfig(home: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Make sure the watchdog agent is installed and loaded (launchd runs it every minute). */
async function ensureWatchAgent() {
  if (!hasLaunchd()) return;
  const want = watchPlistText();
  let have = '';
  try {
    have = fs.readFileSync(watchPlistPath(), 'utf8');
  } catch {
    /* not installed yet */
  }
  const args = (x: string) => (/<key>ProgramArguments<\/key><array>([\s\S]*?)<\/array>/.exec(x)?.[1] ?? '');
  const loaded = await watchLoaded();
  if (args(have) !== args(want)) {
    if (loaded) await watchUnload();
    writeWatchPlist();
    await watchLoad();
  } else if (!loaded) {
    await watchLoad();
  }
}

async function watch(home: string): Promise<number> {
  const { host, port } = servePort(home);
  const alertsFile = path.join(home, 'alerts.json');
  const cfg = appConfig(home);
  const L = cfg.language === 'en' ? 'en' : 'ru';
  const say = (ru: string, en: string) => (L === 'en' ? en : ru);
  const prev = readWatch(home);
  const answers = await serviceAnswers(host, port, 4000);
  const step = watchStep(prev, answers, Date.now());
  let next = step.state;
  if (step.action === 'recovered') {
    appendAlert(alertsFile, { key: 'service:down', level: 'info', title: say('Служба снова отвечает', 'The service answers again'), text: `${host}:${port}` });
  } else if (step.action === 'recover') {
    console.log(`Служба не отвечает ${step.state.fails} проверок подряд: перезапускаю.`);
    let ok = false;
    try {
      if (!(await launchdLoaded())) await launchdLoad();
      else await launchdKickstart();
      ok = await waitUp(host, port, 25);
    } catch (e: any) {
      console.error(e?.message ?? e);
    }
    const quiet = next.lastNotifiedAt && Date.now() - next.lastNotifiedAt < 10 * 60_000;
    if (!quiet) {
      const alert = appendAlert(alertsFile, {
        key: 'service:down',
        level: 'error',
        title: ok ? say('Служба не отвечала и была перезапущена', 'The service was not answering and was restarted') : say('Служба не отвечает и не поднимается', 'The service is down and does not start'),
        text: ok ? say(`${host}:${port} не отвечал ${step.state.fails} проверок подряд. Идущие задачи воркеров могли оборваться.`, `${host}:${port} did not answer ${step.state.fails} probes in a row. Running worker tasks may have been cut off.`) : say(`Последние строки лога:\n${logTail(home)}`, `Last log lines:\n${logTail(home)}`),
      });
      deliver(cfg, alert);
      next = { ...next, lastNotifiedAt: Date.now() };
    }
    if (ok) next = { ...next, fails: 0 };
  }
  // The statistics collector (if installed) should have written a snapshot in the last 3 hours.
  try {
    const stat = fs.statSync(path.join(home, 'stats', 'summary.json'));
    if (Date.now() - stat.mtimeMs > 3 * 3600_000 && Date.now() - ((next as any).statsAlertAt ?? 0) > 6 * 3600_000) {
      const alert = appendAlert(alertsFile, { key: 'stats:stale', level: 'warn', title: say('Статистика не собирается', 'Statistics are not being collected'), text: say('Снимок stats/summary.json старше 3 часов.', 'stats/summary.json is older than 3 hours.') });
      deliver(cfg, alert);
      (next as any).statsAlertAt = Date.now();
    }
  } catch {
    /* no collector installed: nothing to watch */
  }
  writeWatch(home, next);
  return 0;
}

async function bringUp(home: string, restart: boolean): Promise<number> {
  const { host, port } = servePort(home);
  writeWatch(home, { ...readWatch(home), paused: false, fails: 0 });
  if (!hasLaunchd()) {
    console.error('Автозапуск службы есть только на macOS. Запустите её вручную: npm run serve');
    return 2;
  }
  const rewritten = !plistCurrent(host, port);
  if (rewritten) {
    console.log(`Служба: записываю ${plistPath()} (путь или настройки изменились).`);
    writePlist(host, port);
  }
  const answers = await serviceAnswers(host, port, 1500);
  if (!(await launchdLoaded())) {
    const manual = answers ? await manualServicePids(port) : [];
    if (manual.length) console.log(`На порту ${port} уже работает служба, запущенная вручную (pid ${manual.join(', ')}); оставляю её.`);
    else await launchdLoad();
  } else if (rewritten) {
    // launchd keeps the old job definition until it is loaded again.
    await launchdUnload();
    await launchdLoad();
  } else if (restart || !answers) {
    await launchdKickstart();
  }
  if (!(await waitUp(host, port))) {
    console.error(`Служба не отвечает на ${host}:${port}.\nПоследние строки лога (${path.join(home, 'logs', 'serve.log')}):\n${logTail(home)}`);
    if (/EPERM|not permitted/i.test(logTail(home))) console.error('\nПохоже, службе не хватает доступа к диску с проектами: дайте программе node доступ в «Системные настройки → Конфиденциальность → Полный доступ к диску».');
    return 2;
  }
  await ensureWatchAgent().catch((e) => console.error(`Сторож: ${e?.message ?? e}`));
  console.log(`Служба работает: http://${host}:${port}/`);
  console.log(`URL ${panelUrl(host, port, loadToken(home))}`);
  return 0;
}

async function main(): Promise<number> {
  const home = orchestraHome();
  const cmd = process.argv[2] ?? 'up';
  const force = process.argv.includes('--force');
  const { host, port } = servePort(home);
  switch (cmd) {
    case 'up':
      return bringUp(home, false);
    case 'restart': {
      const busy = busyRuns(home);
      if (busy.length && !force && process.argv.includes('--when-idle')) {
        const arg = process.argv.find((a) => a.startsWith('--timeout-min='));
        const min = arg ? Number(arg.slice('--timeout-min='.length)) : 120;
        const end = Date.now() + min * 60000;
        let lastSaid = 0;
        const free = await waitIdle(home, {
          timeoutMs: min * 60000,
          pollMs: 10000,
          onWait: (b) => {
            if (Date.now() - lastSaid < 60000) return;
            lastSaid = Date.now();
            console.log(`Жду, пока освободится служба: ${b.map((x) => x.runId).join(', ')} (осталось ждать не более ${Math.ceil((end - Date.now()) / 60000)} мин)`);
          },
        });
        if (free) return bringUp(home, true);
        console.error(`Не дождался: служба занята дольше ${min} мин. Служба не перезапущена.`);
        return 3;
      }
      if (busy.length && !force) {
        console.error('Не перезапускаю: сейчас идут задачи воркеров (перезапуск оборвёт их и запуск):');
        for (const b of busy) console.error(`  ${b.runId}  ${b.repo}  ${b.tasks.join(', ') || 'идёт запуск'}`);
        console.error('Дождитесь окончания или перезапустите с --force.');
        return 3;
      }
      return bringUp(home, true);
    }
    case 'watch':
      return watch(home);
    case 'stop':
      writeWatch(home, { ...readWatch(home), paused: true });
      if (await launchdLoaded()) await launchdUnload();
      console.log('Служба остановлена и не запустится при входе. Включить снова: Orchestra.command.');
      return 0;
    case 'status': {
      const up = await serviceAnswers(host, port, 1500);
      const busy = busyRuns(home);
      console.log(`Служба: ${up ? 'отвечает' : 'не отвечает'} на ${host}:${port}; launchd: ${(await launchdLoaded()) ? 'загружена' : 'не загружена'}; файл агента: ${plistCurrent(host, port) ? 'актуален' : 'устарел'}`);
      console.log(busy.length ? `Идут запуски: ${busy.map((b) => b.runId).join(', ')}` : 'Активных запусков нет');
      return up ? 0 : 2;
    }
    case 'url':
      console.log(`URL ${panelUrl(host, port, loadToken(home))}`);
      return 0;
    default:
      console.error('orchestra-ctl up | restart [--force | --when-idle [--timeout-min=N]] | stop | status | url | watch');
      return 1;
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e?.message ?? e);
      process.exit(2);
    },
  );
}
