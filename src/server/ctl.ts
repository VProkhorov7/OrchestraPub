#!/usr/bin/env node
/**
 * Control of the background service for the desktop launcher (scripts/desktop/Orchestra.command):
 *
 *   orchestra-ctl up        make sure the service runs under launchd and answers; print the panel address
 *   orchestra-ctl restart   the same after a restart, but refuse while workers are busy (--force overrides)
 *   orchestra-ctl stop      stop the service and keep it from starting at login
 *   orchestra-ctl status    what runs, where, and whether any run is busy
 *   orchestra-ctl url       the panel address with the token
 *
 * The launchd agent is rewritten whenever it does not match this checkout (a moved or renamed folder no longer
 * leaves a service that cannot start). Exit codes: 0 ok, 2 the service does not answer, 3 workers are busy.
 */
import * as fs from 'fs';
import * as path from 'path';
import { orchestraHome } from '../main/paths';
import {
  hasLaunchd, launchdKickstart, launchdLoad, launchdLoaded, launchdUnload, loadToken, manualServicePids,
  panelUrl, plistPath, plistText, serviceAnswers, writePlist,
} from '../main/service';

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

async function bringUp(home: string, restart: boolean): Promise<number> {
  const { host, port } = servePort(home);
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
      if (busy.length && !force) {
        console.error('Не перезапускаю: сейчас идут задачи воркеров (перезапуск оборвёт их и запуск):');
        for (const b of busy) console.error(`  ${b.runId}  ${b.repo}  ${b.tasks.join(', ') || 'идёт запуск'}`);
        console.error('Дождитесь окончания или перезапустите с --force.');
        return 3;
      }
      return bringUp(home, true);
    }
    case 'stop':
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
      console.error('orchestra-ctl up | restart [--force] | stop | status | url');
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
