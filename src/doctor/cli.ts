#!/usr/bin/env node
/**
 * orchestra-doctor: diagnostics and modes for Orca + Orchestra.
 *   orchestra-doctor                 interactive menu (what Orchestra.command opens)
 *   orchestra-doctor --json          report as JSON
 *   orchestra-doctor --plan <mode>   what would change
 *   orchestra-doctor --mode <mode> --yes   apply (together | orca | orchestra)
 *   orchestra-doctor --undo --yes    undo the last apply
 */
import * as readline from 'readline';
import { spawn } from 'child_process';
import { Hub } from '../main/hub';
import { orchestraHome, fixPath } from '../main/paths';
import { Doctor, DoctorMode, DoctorReport, defaultProjectRoots, discoverProjects, modeLabel, Check } from '../main/doctor';
import { loadToken, panelUrl } from '../main/service';

const tty = process.stdout.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1');
const dim = c('2');
const green = c('32');
const yellow = c('33');
const red = c('31');
const cyan = c('36');

const MARK: Record<string, string> = { ok: green('●'), warn: yellow('●'), err: red('●'), off: dim('○') };
const GROUPS: Record<Check['group'], string> = { system: 'Система', orchestra: 'Orchestra', orca: 'Orca', projects: 'Проекты' };
const MODES: DoctorMode[] = ['together', 'orca', 'orchestra'];

function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length);
}

function print(rep: DoctorReport) {
  const now = new Date(rep.at);
  console.log('');
  console.log(`${bold(cyan('ORCHESTRA'))} ${dim('· диагностика')}   ${dim(now.toLocaleString('ru-RU'))}`);
  console.log(`Сейчас: ${bold(rep.mode === 'mixed' ? 'смешанный режим' : modeLabel(rep.mode))}   ${green(String(rep.summary.ok))} ${dim('в порядке')}  ${yellow(String(rep.summary.warn))} ${dim('внимание')}  ${red(String(rep.summary.err))} ${dim('ошибки')}`);
  for (const g of Object.keys(GROUPS) as Check['group'][]) {
    const list = rep.checks.filter((x) => x.group === g);
    if (!list.length) continue;
    console.log('\n' + bold(GROUPS[g]));
    for (const ch of list) {
      console.log(`  ${MARK[ch.state]} ${pad(ch.label, 28)} ${ch.state === 'err' ? red(ch.detail) : ch.state === 'warn' ? yellow(ch.detail) : dim(ch.detail)}`);
      if (ch.fix) console.log(`    ${dim('→ ' + ch.fix)}`);
    }
  }
  if (!rep.projects.length) console.log(`\n${bold('Проекты')}\n  ${dim('не найдены — пункт 6 меню')}`);
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, (a) => res(a.trim())));
}

async function freshHealth(hub: Hub) {
  process.stdout.write(dim('Проверяю подключения… '));
  await Promise.race([hub.refreshHealth().catch(() => {}), new Promise((r) => setTimeout(r, 25_000))]);
  process.stdout.write('\r' + ' '.repeat(30) + '\r');
}

function openUrl(url: string) {
  if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  else console.log(url);
}

function showResult(r: { done: string[]; failed: string[] }) {
  for (const d of r.done) console.log(`  ${green('✓')} ${d}`);
  for (const f of r.failed) console.log(`  ${red('✗')} ${f}`);
  if (!r.done.length && !r.failed.length) console.log(dim('  менять нечего — уже так'));
}

async function main() {
  fixPath();
  const home = orchestraHome();
  const hub = new Hub(home, () => {});
  const doctor = new Doctor({ home, config: () => hub.config(), saveConfig: (x) => hub.store.save(x), health: () => hub.health });
  const argv = process.argv.slice(2);
  const val = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const yes = argv.includes('--yes') || argv.includes('-y');

  if (argv.includes('--json')) {
    await freshHealth(hub);
    console.log(JSON.stringify(await doctor.report(), null, 2));
    return;
  }
  if (val('--plan')) {
    const acts = await doctor.plan(val('--plan') as DoctorMode);
    console.log(acts.length ? acts.map((a) => `- ${a.label}`).join('\n') : 'менять нечего');
    return;
  }
  if (val('--mode')) {
    const mode = val('--mode') as DoctorMode;
    if (!MODES.includes(mode)) throw new Error(`режим: ${MODES.join(' | ')}`);
    if (!yes) {
      const acts = await doctor.plan(mode);
      console.log(`${modeLabel(mode)}:\n${acts.map((a) => `- ${a.label}`).join('\n') || 'менять нечего'}\nДобавьте --yes, чтобы применить.`);
      return;
    }
    const r = await doctor.apply(mode);
    showResult(r);
    process.exitCode = r.failed.length ? 1 : 0;
    return;
  }
  if (argv.includes('--undo')) {
    if (!yes) return console.log('Добавьте --yes, чтобы отменить последние изменения.');
    showResult(await doctor.undo());
    return;
  }

  // ---- interactive
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await freshHealth(hub);
  for (;;) {
    const rep = await doctor.report();
    print(rep);
    const cfg = hub.config();
    console.log('\n' + bold('Что сделать?'));
    console.log(`  ${cyan('1')}  Orca и Orchestra вместе ${dim('— служба в фоне, Orchestra подключена к Claude Code в каждом проекте')}`);
    console.log(`  ${cyan('2')}  Только Orca ${dim('— Orchestra выключена, агенты в Orca работают сами; память проектов остаётся')}`);
    console.log(`  ${cyan('3')}  Только Orchestra ${dim('— служба и панель работают, в проектах Orca она не подключена')}`);
    console.log(`  ${cyan('4')}  Отменить последние изменения ${rep.undo ? dim(`(${modeLabel(rep.undo.mode)}, ${new Date(rep.undo.at).toLocaleString('ru-RU')})`) : dim('(нечего отменять)')}`);
    console.log(`  ${cyan('5')}  Открыть панель Orchestra ${rep.service.answers ? '' : dim('(служба выключена)')}`);
    console.log(`  ${cyan('6')}  Проекты: где искать ${dim(`(${(cfg.projects?.length ? 'список сохранён' : (cfg.projectRoots?.join(', ') || defaultProjectRoots().join(', ')))})`)}`);
    console.log(`  ${cyan('7')}  Проверить заново`);
    console.log(`  ${cyan('0')}  Выход`);
    const a = await ask(rl, '\n› ');
    if (a === '0' || a === '' || /^q/i.test(a)) break;
    if (['1', '2', '3'].includes(a)) {
      const mode = MODES[Number(a) - 1];
      const acts = await doctor.plan(mode, rep);
      console.log('\n' + bold(modeLabel(mode)) + (acts.length ? ' — будет сделано:' : ''));
      if (!acts.length) {
        console.log(dim('  всё уже так, менять нечего'));
        continue;
      }
      for (const x of acts) console.log(`  • ${x.label}`);
      const ok = await ask(rl, `\nПрименить? ${dim('(д — да, другое — нет)')} `);
      if (!/^[дdyY]/.test(ok)) {
        console.log(dim('  отменено, ничего не менялось'));
        continue;
      }
      showResult(await doctor.apply(mode));
      console.log(dim('  Вернуть как было — пункт 4.'));
    } else if (a === '4') {
      if (!rep.undo) {
        console.log(dim('  отменять нечего'));
        continue;
      }
      const ok = await ask(rl, `Вернуть состояние до «${modeLabel(rep.undo.mode)}»? ${dim('(д/н)')} `);
      if (/^[дdyY]/.test(ok)) showResult(await doctor.undo());
    } else if (a === '5') {
      if (!rep.service.answers) console.log(yellow('  Служба выключена: сначала пункт 1 или 3.'));
      else openUrl(panelUrl(rep.service.host, rep.service.port, loadToken(home)));
    } else if (a === '6') {
      const cur = cfg.projectRoots?.length ? cfg.projectRoots : defaultProjectRoots();
      const r = await ask(rl, `Папки с проектами через запятую ${dim(`[${cur.join(', ')}]`)}: `);
      const roots = r ? r.split(',').map((x) => x.trim()).filter(Boolean) : cur;
      const found = discoverProjects(roots);
      console.log(`Найдено ${found.length}:`);
      found.forEach((p, i) => console.log(`  ${cyan(String(i + 1))} ${p}`));
      const drop = await ask(rl, `Убрать из списка ${dim('(номера через пробел, Enter — оставить все)')}: `);
      const skip = new Set(drop.split(/[\s,]+/).filter(Boolean).map(Number));
      doctor.setProjects(found.filter((_, i) => !skip.has(i + 1)), roots);
      console.log(green('  список проектов сохранён'));
    } else if (a === '7') await freshHealth(hub);
  }
  rl.close();
}

main().catch((e) => {
  console.error(red(String(e?.message ?? e)));
  process.exitCode = 1;
});
