/**
 * Subscription limit windows (CodexBar):
 *  - a near-limit window (5 часов >=85%, неделя >=95%) flips the connection to yellow with limitResetsAt;
 *  - scoped windows (usage.extraRateWindows) are informational only and never trip the light;
 *  - the Hub re-checks limits on a timer (ORCHESTRA_LIMIT_POLL_MS), so a near-limit light clears once the window resets.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { checkAll, codexBarQuotas, checkOne, readCodexBar, resetCodexBarCache } from '../main/health';
import { fromPreset } from '../main/catalog';
import { Hub } from '../main/hub';
import { tmpdir, makeFakeClaude, check, testConfig } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A codexbar stub that just cats a JSON fixture; rewrite the fixture per case. */
function makeCodexbar(root: string, fixture: any): string {
  const fx = path.join(root, 'codexbar-fixture.json');
  fs.writeFileSync(fx, JSON.stringify(fixture));
  const bin = path.join(root, 'codexbar');
  fs.writeFileSync(bin, `#!/bin/sh\ncat "${fx}"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** A codexbar stub that prints `body` verbatim and then exits 1 (real CodexBar exits 1 when any provider fails). */
function makeCodexbarExit1(root: string, body: string): string {
  const fx = path.join(root, 'codexbar-body');
  fs.writeFileSync(fx, body);
  const bin = path.join(root, 'codexbar');
  fs.writeFileSync(bin, `#!/bin/sh\ncat "${fx}"\nexit 1\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** The exact CodexBar shape for Claude from the task: weekly 100% + a scoped "Fable only" window. */
const fixtureA = [
  {
    rateWindowLabels: { secondary: 'Weekly', primary: 'Session' },
    source: 'claude',
    provider: 'claude',
    usage: {
      secondary: { usedPercent: 100, resetDescription: 'resets Oct 2 at 4:59pm (Europe/Moscow)', resetsAt: '2026-10-02T13:59:00Z', windowMinutes: 10080 },
      extraRateWindows: [{ window: { resetDescription: 'resets Oct 2 at 4:59pm (Europe/Moscow)', resetsAt: '2026-10-02T13:59:00Z', usedPercent: 18, windowMinutes: 10080 }, title: 'Fable only', id: 'claude-weekly-scoped-fable' }],
      dataConfidence: 'percentOnly',
      updatedAt: '2026-10-01T17:29:08Z',
      identity: { providerID: 'claude' },
      tertiary: null,
      primary: { usedPercent: 2, resetDescription: 'resets Oct 2 at 12:59am (Europe/Moscow)', resetsAt: '2026-10-01T21:59:00Z', windowMinutes: 300 },
    },
  },
];

/** A minimal one-provider fixture: session and weekly windows plus optional scoped extras. */
function claudeFixture(primary: number, weekly: number, opts: { primaryResetsAt?: string; weeklyResetsAt?: string; extra?: any[]; provider?: string } = {}) {
  const provider = opts.provider ?? 'claude';
  return [
    {
      source: provider,
      provider,
      usage: {
        primary: { usedPercent: primary, resetsAt: opts.primaryResetsAt, windowMinutes: 300 },
        secondary: { usedPercent: weekly, resetsAt: opts.weeklyResetsAt, windowMinutes: 10080 },
        extraRateWindows: opts.extra ?? [],
      },
    },
  ];
}

async function checkFixture(fixture: any) {
  const tmp = tmpdir('orch-limits-');
  const claude = makeFakeClaude(tmp);
  const quotas = await codexBarQuotas(makeCodexbar(tmp, fixture));
  return checkOne(fromPreset('claude-sub'), testConfig(claude), quotas);
}

/** The same chain, but the codexbar stub exits 1 after printing the fixture. */
async function checkFixtureExit1(fixture: any) {
  const tmp = tmpdir('orch-limits-');
  const claude = makeFakeClaude(tmp);
  const quotas = await codexBarQuotas(makeCodexbarExit1(tmp, JSON.stringify(fixture)));
  return checkOne(fromPreset('claude-sub'), testConfig(claude), quotas);
}

/** A codexbar stub that appends a line to a counter file on every call, then prints the fixture file. */
function makeCountingCodexbar(root: string, counter: string, fixtureFile: string): string {
  const dir = path.join(root, 'bin');
  fs.mkdirSync(dir);
  const bin = path.join(dir, 'codexbar');
  fs.writeFileSync(bin, `#!/bin/sh\necho >> "${counter}"\ncat "${fixtureFile}"\n`);
  fs.chmodSync(bin, 0o755);
  return dir;
}

const countCalls = (counter: string) => fs.readFileSync(counter, 'utf8').split('\n').length - 1;

/** A codexbar stub that records its argv to a file and prints `[]` (valid, empty). */
function makeRecordingCodexbar(root: string, argvLog: string): string {
  const bin = path.join(root, 'codexbar-record');
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${argvLog}"\necho '[]'\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** A codexbar stub that hangs for 30 s; `exec -a` keeps the marker in the sleeping process so a leak is findable. */
function makeSleepingCodexbar(root: string, marker: string): string {
  const bin = path.join(root, `codexbar-slow-${marker}`);
  fs.writeFileSync(bin, `#!/bin/bash\nexec -a "${marker}" sleep 30\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** A fake `codex` binary: `codex login status` reports logged in. */
function makeFakeCodex(root: string): string {
  const f = path.join(root, 'codex');
  fs.writeFileSync(f, `#!/bin/sh\necho 'Logged in using ChatGPT'\n`);
  fs.chmodSync(f, 0o755);
  return f;
}

/**
 * A codexbar stub that dispatches on its `--provider` argument. `claudeSh`/`codexSh` are shell
 * snippets (file paths already baked in); neither may contain a `${` that the shell should see.
 */
function makeDispatchingCodexbar(root: string, claudeSh: string, codexSh: string): string {
  const bin = path.join(root, 'codexbar');
  fs.writeFileSync(bin, `#!/bin/sh
p=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--provider" ]; then p="$a"; fi
  prev="$a"
done
if [ "$p" = "claude" ]; then
${claudeSh}
elif [ "$p" = "codex" ]; then
${codexSh}
fi
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** Shell snippet: print the given fixture file verbatim and exit 1 (real CodexBar exits 1 when any provider fails). */
function catFixtureSh(root: string, name: string, fixture: any): string {
  const fx = path.join(root, name);
  fs.writeFileSync(fx, JSON.stringify(fixture));
  return `cat '${fx}'\nexit 1`;
}

/** pgrep -f that returns '' when nothing matches (pgrep exits 1 in that case). */
function pgrep(pattern: string): string {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

/** readCodexBar status/quotas rules: ok, missing, timeout (with a killed child), failed. */
async function readStatusTests() {
  resetCodexBarCache();
  {
    const tmp = tmpdir('orch-limits-read-');
    const r = await readCodexBar(makeCodexbarExit1(tmp, JSON.stringify(claudeFixture(2, 100))));
    check(r.status === 'ok', `(a) exit-1 JSON status ok: ${r.status}`);
    const q = r.quotas.claude ?? [];
    check(q.length === 2 && q[0].label === '5 часов' && q[0].usedPercent === 2 && q[1].label === 'неделя' && q[1].usedPercent === 100, `(a) claude quotas: ${JSON.stringify(q)}`);
    check(!('codex' in r.quotas), `(a) no codex quotas: ${JSON.stringify(Object.keys(r.quotas))}`);
  }

  resetCodexBarCache();
  {
    const tmp = tmpdir('orch-limits-read-');
    const r = await readCodexBar(path.join(tmp, 'no-such-codexbar'));
    check(r.status === 'missing', `(b) nonexistent binary missing: ${r.status}`);
    check(Object.keys(r.quotas).length === 0, `(b) quotas empty: ${JSON.stringify(r.quotas)}`);
  }

  resetCodexBarCache();
  {
    const tmp = tmpdir('orch-limits-read-');
    const marker = `zzsleep${process.pid}`;
    const t0 = Date.now();
    const r = await readCodexBar(makeSleepingCodexbar(tmp, marker), 600);
    const elapsed = Date.now() - t0;
    check(r.status === 'timeout', `(c) sleeping stub timeout: ${r.status}`);
    check(elapsed < 3000, `(c) elapsed < 3000 ms: ${elapsed}`);
    await sleep(150); // give an orphan a moment to show up before pgrep
    check(!pgrep(marker).trim(), `(c) no leftover sleeping process: ${JSON.stringify(pgrep(marker))}`);
  }

  resetCodexBarCache();
  {
    const tmp = tmpdir('orch-limits-read-');
    const bin = path.join(tmp, 'codexbar-notjson');
    fs.writeFileSync(bin, `#!/bin/sh\necho 'not json'\n`);
    fs.chmodSync(bin, 0o755);
    const r = await readCodexBar(bin);
    check(r.status === 'failed', `(d) not-json failed: ${r.status}`);
    check(Object.keys(r.quotas).length === 0, `(d) quotas empty: ${JSON.stringify(r.quotas)}`);
  }
}

/** Card text/lights per status via checkOne: cache reuse, no-cache timeout, missing, and per-provider argv. */
async function cardStatusTests() {
  resetCodexBarCache();
  const tmp = tmpdir('orch-limits-card-');
  const claude = makeFakeClaude(tmp);
  const cfg = testConfig(claude);
  const sub = fromPreset('claude-sub');

  // (e) a successful weekly-96 read, then a timeout: the cache keeps the light yellow.
  resetCodexBarCache();
  {
    const ok = await readCodexBar(makeCodexbarExit1(tmp, JSON.stringify(claudeFixture(10, 96))));
    check(ok.status === 'ok' && ok.quotas.claude?.[1]?.usedPercent === 96, `(e) seed read ok: ${ok.status} ${JSON.stringify(ok.quotas.claude)}`);
    const h = await checkOne(sub, cfg, ok.quotas, ok.status);
    check(h.light === 'yellow', `(e) seed yellow: ${h.light} (${h.text})`);
  }
  {
    const marker = `zze${process.pid}`;
    const slow = await readCodexBar(makeSleepingCodexbar(tmp, marker), 600);
    check(slow.status === 'timeout', `(e) timeout read: ${slow.status}`);
    const h = await checkOne(sub, cfg, slow.quotas, slow.status);
    check(h.light === 'yellow', `(e) cache keeps yellow: ${h.light} (${h.text})`);
    check(!!h.details?.some((d) => d.includes('не ответил')), `(e) details mention «не ответил»: ${JSON.stringify(h.details)}`);
    check(!!h.details?.some((d) => d.includes('данные от')), `(e) details mention «данные от»: ${JSON.stringify(h.details)}`);
  }

  // (f) timeout without any cache: green, no flicker, explicit permission hint.
  resetCodexBarCache();
  {
    const marker = `zzf${process.pid}`;
    const slow = await readCodexBar(makeSleepingCodexbar(tmp, marker), 600);
    check(slow.status === 'timeout' && Object.keys(slow.quotas).length === 0, `(f) timeout no cache: ${slow.status} ${JSON.stringify(slow.quotas)}`);
    const h = await checkOne(sub, cfg, slow.quotas, slow.status);
    check(h.light === 'green', `(f) green: ${h.light} (${h.text})`);
    check(!!h.details?.some((d) => d.includes('не ответил за')), `(f) details mention «не ответил за»: ${JSON.stringify(h.details)}`);
    check(!!h.details?.some((d) => d.includes('разрешений macOS')), `(f) details mention «разрешений macOS»: ${JSON.stringify(h.details)}`);
  }

  // (g) missing binary: the old «установите CodexBar» text.
  resetCodexBarCache();
  {
    const miss = await readCodexBar(path.join(tmp, 'no-codexbar-here'));
    check(miss.status === 'missing', `(g) missing status: ${miss.status}`);
    const h = await checkOne(sub, cfg, miss.quotas, miss.status);
    check(h.light === 'green', `(g) green: ${h.light} (${h.text})`);
    check(!!h.details?.some((d) => d.includes('установите CodexBar')), `(g) details mention «установите CodexBar»: ${JSON.stringify(h.details)}`);
  }

  // (h) readCodexBar asks per provider, never `--provider all`.
  resetCodexBarCache();
  {
    const argvLog = path.join(tmp, 'argv.log');
    const r = await readCodexBar(makeRecordingCodexbar(tmp, argvLog));
    check(r.status === 'ok', `(h) recording read ok: ${r.status}`);
    const calls = fs.readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean);
    check(calls.length === 2, `(h) exactly two calls: ${JSON.stringify(calls)}`);
    check(calls.some((c) => c.includes('--provider claude')), `(h) called with --provider claude: ${JSON.stringify(calls)}`);
    check(calls.some((c) => c.includes('--provider codex')), `(h) called with --provider codex: ${JSON.stringify(calls)}`);
    check(!calls.join(' ').includes('--provider all'), `(h) never --provider all: ${JSON.stringify(calls)}`);
  }
}

/** Per-provider statuses: a card is only affected by its own provider's read, never the other provider's problem. */
async function perProviderStatusTests() {
  resetCodexBarCache();
  const tmp = tmpdir('orch-limits-provider-');
  const claude = makeFakeClaude(tmp);
  const codex = makeFakeCodex(tmp);
  const cfg = testConfig(claude, { providers: [fromPreset('claude-sub'), fromPreset('codex-sub')] });
  cfg.orchestrator.codexPath = codex;
  const claudeSub = fromPreset('claude-sub');
  const codexSub = fromPreset('codex-sub');
  const claudeOk = (root: string) => catFixtureSh(root, 'claude.json', claudeFixture(10, 96));
  const codexOk = (root: string) => catFixtureSh(root, 'codex.json', claudeFixture(10, 96, { provider: 'codex' }));
  const useOnPath = (dir: string) => { process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`; };

  // (a) codex prints nothing and exits 1: aggregate failed, but the Claude card keeps its numbers.
  resetCodexBarCache();
  {
    const dir = path.join(tmp, 'a');
    fs.mkdirSync(dir);
    makeDispatchingCodexbar(dir, claudeOk(dir), 'exit 1');
    useOnPath(dir);
    const r = await readCodexBar(path.join(dir, 'codexbar'));
    check(r.statuses.claude === 'ok' && r.statuses.codex === 'failed', `(a) statuses: ${JSON.stringify(r.statuses)}`);
    check(r.status === 'failed', `(a) aggregate failed: ${r.status}`);
    const h = await checkAll(cfg);
    check(h['claude-sub'].light === 'yellow', `(a) claude yellow: ${h['claude-sub'].light} (${h['claude-sub'].text})`);
    check(h['claude-sub'].text.includes('96%'), `(a) claude text 96%: ${h['claude-sub'].text}`);
    check(!(h['claude-sub'].details ?? []).some((d) => d.includes('не JSON')), `(a) claude details no «не JSON»: ${JSON.stringify(h['claude-sub'].details)}`);
    check((h['codex-sub'].details ?? []).some((d) => d.includes('не JSON')), `(a) codex details «не JSON»: ${JSON.stringify(h['codex-sub'].details)}`);
  }

  // (b) codex hangs, claude ok: timeout aggregate, but the Claude card keeps its yellow light.
  resetCodexBarCache();
  {
    const dir = path.join(tmp, 'b');
    fs.mkdirSync(dir);
    const stub = makeDispatchingCodexbar(dir, claudeOk(dir), 'exec sleep 30');
    const t0 = Date.now();
    const r = await readCodexBar(stub, 600);
    const elapsed = Date.now() - t0;
    check(r.statuses.claude === 'ok', `(b) claude ok: ${r.statuses.claude}`);
    check(r.statuses.codex === 'timeout', `(b) codex timeout: ${r.statuses.codex}`);
    check(r.status === 'timeout', `(b) aggregate timeout: ${r.status}`);
    check(elapsed < 3000, `(b) elapsed < 3000 ms: ${elapsed}`);
    const claudeCard = await checkOne(claudeSub, cfg, r.quotas, r.statuses.claude);
    check(claudeCard.light === 'yellow', `(b) claude yellow: ${claudeCard.light} (${claudeCard.text})`);
    check(claudeCard.text.includes('96%'), `(b) claude text 96%: ${claudeCard.text}`);
    check(!(claudeCard.details ?? []).some((d) => d.includes('не ответил')), `(b) claude details no «не ответил»: ${JSON.stringify(claudeCard.details)}`);
    const codexCard = await checkOne(codexSub, cfg, r.quotas, r.statuses.codex);
    check((codexCard.details ?? []).some((d) => d.includes('не ответил')), `(b) codex details «не ответил»: ${JSON.stringify(codexCard.details)}`);
  }

  // (c) claude hangs, codex ok: the reverse of (b).
  resetCodexBarCache();
  {
    const dir = path.join(tmp, 'c');
    fs.mkdirSync(dir);
    const stub = makeDispatchingCodexbar(dir, 'exec sleep 30', codexOk(dir));
    const t0 = Date.now();
    const r = await readCodexBar(stub, 600);
    const elapsed = Date.now() - t0;
    check(r.statuses.claude === 'timeout', `(c) claude timeout: ${r.statuses.claude}`);
    check(r.statuses.codex === 'ok', `(c) codex ok: ${r.statuses.codex}`);
    check(r.status === 'timeout', `(c) aggregate timeout: ${r.status}`);
    check(elapsed < 3000, `(c) elapsed < 3000 ms: ${elapsed}`);
    const codexCard = await checkOne(codexSub, cfg, r.quotas, r.statuses.codex);
    check(codexCard.light === 'yellow', `(c) codex yellow: ${codexCard.light} (${codexCard.text})`);
    check(codexCard.text.includes('96%'), `(c) codex text 96%: ${codexCard.text}`);
    check(!(codexCard.details ?? []).some((d) => d.includes('не ответил')), `(c) codex details no «не ответил»: ${JSON.stringify(codexCard.details)}`);
    const claudeCard = await checkOne(claudeSub, cfg, r.quotas, r.statuses.claude);
    check((claudeCard.details ?? []).some((d) => d.includes('не ответил')), `(c) claude details «не ответил»: ${JSON.stringify(claudeCard.details)}`);
  }

  // (d) both providers fine: both cards yellow with their own percents.
  resetCodexBarCache();
  {
    const dir = path.join(tmp, 'd');
    fs.mkdirSync(dir);
    makeDispatchingCodexbar(dir, claudeOk(dir), codexOk(dir));
    useOnPath(dir);
    const r = await readCodexBar(path.join(dir, 'codexbar'));
    check(r.statuses.claude === 'ok' && r.statuses.codex === 'ok', `(d) both ok: ${JSON.stringify(r.statuses)}`);
    check(r.status === 'ok', `(d) aggregate ok: ${r.status}`);
    const h = await checkAll(cfg);
    check(h['claude-sub'].light === 'yellow' && h['claude-sub'].text.includes('96%'), `(d) claude yellow 96%: ${h['claude-sub'].light} (${h['claude-sub'].text})`);
    check(h['codex-sub'].light === 'yellow' && h['codex-sub'].text.includes('96%'), `(d) codex yellow 96%: ${h['codex-sub'].light} (${h['codex-sub'].text})`);
  }

  // (e) old-style checkOne(claude-sub) with no quotas: uses the Claude status only, even though codex failed.
  resetCodexBarCache();
  {
    const dir = path.join(tmp, 'e');
    fs.mkdirSync(dir);
    makeDispatchingCodexbar(dir, claudeOk(dir), 'exit 1');
    useOnPath(dir);
    const h = await checkOne(claudeSub, testConfig(claude));
    check(h.light === 'yellow', `(e) claude yellow: ${h.light} (${h.text})`);
    check(h.text.includes('96%'), `(e) claude text 96%: ${h.text}`);
    check(!(h.details ?? []).some((d) => d.includes('не JSON')), `(e) claude details no «не JSON»: ${JSON.stringify(h.details)}`);
  }
}

/** The Hub's limit timer: re-polls claude-sub/codex-sub, clears and re-trips the light, and skips disabled providers. */
async function timerTest() {
  const tmp = tmpdir('orch-limits-hub-');
  const claude = makeFakeClaude(tmp);
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const configFile = path.join(home, 'config.json');
  const counter = path.join(tmp, 'counter.txt');
  const fixtureFile = path.join(tmp, 'fixture.json');
  fs.writeFileSync(fixtureFile, JSON.stringify(claudeFixture(10, 96)));
  const binDir = makeCountingCodexbar(tmp, counter, fixtureFile);
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  const cfg = testConfig(claude, { providers: [fromPreset('claude-sub')] });
  cfg.orchestrator.codexPath = '/nonexistent/codex'; // checkAll also checks the (disabled) codex-sub card: fail fast
  fs.writeFileSync(configFile, JSON.stringify(cfg));

  process.env.ORCHESTRA_LIMIT_POLL_MS = '200';
  const hub = new Hub(home, () => {});
  hub.init();

  // (i) weekly 96 → yellow after a manual refresh.
  await hub.refreshHealth();
  check(hub.health['claude-sub'].light === 'yellow', `(i) weekly 96 yellow: ${hub.health['claude-sub'].light} (${hub.health['claude-sub'].text})`);

  // (ii) back to session 10 / weekly 10: the timer clears the light by itself, no manual refresh.
  fs.writeFileSync(fixtureFile, JSON.stringify(claudeFixture(10, 10)));
  const polled = countCalls(counter);
  let light = hub.health['claude-sub'].light;
  for (let i = 0; i < 60 && light !== 'green'; i++) { await sleep(50); light = hub.health['claude-sub'].light; }
  check(light === 'green', `(ii) timer cleared to green: ${light} (${hub.health['claude-sub'].text})`);
  check(countCalls(counter) > polled, '(ii) the timer really polled');

  // (iii) session 90 → yellow again with the percent, still without a manual refresh.
  fs.writeFileSync(fixtureFile, JSON.stringify(claudeFixture(90, 10)));
  const afterIi = countCalls(counter);
  light = hub.health['claude-sub'].light;
  for (let i = 0; i < 60 && light !== 'yellow'; i++) { await sleep(50); light = hub.health['claude-sub'].light; }
  check(light === 'yellow' && hub.health['claude-sub'].text.includes('90%'), `(iii) yellow with 90%: ${light} (${hub.health['claude-sub'].text})`);
  // (iv) the counter kept increasing between (ii) and (iii): the timer really polls.
  check(countCalls(counter) > afterIi, '(iv) counter increased between (ii) and (iii)');

  // (v) disabled providers are not polled.
  const disabled = hub.config();
  disabled.providers = disabled.providers.map((p) => (p.id === 'claude-sub' ? { ...p, enabled: false } : p));
  fs.writeFileSync(configFile, JSON.stringify(disabled));
  await sleep(300); // let an in-flight poll finish before recording the baseline
  const settled = countCalls(counter);
  await sleep(1000);
  check(countCalls(counter) === settled, `(v) disabled provider not polled: ${countCalls(counter)} vs ${settled}`);
}

(async () => {
  let h = await checkFixture(fixtureA);
  check(h.light === 'yellow', `(a) yellow, got ${h.light} (${h.text})`);
  check(h.text.includes('исчерпан'), '(a) text mentions "исчерпан"');
  check(h.limitResetsAt === '2026-10-02T13:59:00Z', `(a) limitResetsAt: ${h.limitResetsAt}`);
  check(!!h.quotas?.some((q) => q.label === 'Fable only' && q.scoped === true), '(a) Fable window parsed as scoped');

  // Boundaries: the session window trips at >=85%, the weekly window at >=95%.
  h = await checkFixture(claudeFixture(84, 10));
  check(h.light === 'green' && !h.nearLimit, `session 84 green: ${h.light} (${h.text})`);
  h = await checkFixture(claudeFixture(85, 10));
  check(h.light === 'yellow' && h.text.includes('85%'), `session 85 yellow: ${h.light} (${h.text})`);
  h = await checkFixture(claudeFixture(86, 10));
  check(h.light === 'yellow' && h.text.includes('86%'), `session 86 yellow: ${h.light} (${h.text})`);
  h = await checkFixture(claudeFixture(10, 94));
  check(h.light === 'green' && !h.nearLimit, `weekly 94 green: ${h.light} (${h.text})`);
  h = await checkFixture(claudeFixture(10, 95));
  check(h.light === 'yellow' && h.text.includes('95%'), `weekly 95 yellow: ${h.light} (${h.text})`);
  h = await checkFixture(claudeFixture(10, 96));
  check(h.light === 'yellow' && h.text.includes('96%'), `weekly 96 yellow: ${h.light} (${h.text})`);

  // Reset text: a future reset shows «сброс в HH:MM»; a tripped window without resetsAt does not mention «сброс».
  h = await checkFixture(claudeFixture(90, 10, { primaryResetsAt: '2099-01-01T00:00:00Z' }));
  check(h.light === 'yellow' && /сброс в .*\d{2}:\d{2}/.test(h.text), `reset text: ${h.text}`);
  h = await checkFixture(claudeFixture(90, 10));
  check(h.light === 'yellow' && !h.text.includes('сброс'), `no reset text: ${h.text}`);

  h = await checkFixture(claudeFixture(10, 10, { extra: [{ window: { usedPercent: 99, resetsAt: '2026-10-02T13:59:00Z' }, title: 'Fable only' }] }));
  check(h.light === 'green' && !h.nearLimit, `scoped never trips: ${h.light}`);

  h = await checkFixture(claudeFixture(90, 96, { primaryResetsAt: '2026-10-01T21:59:00Z', weeklyResetsAt: '2026-10-02T13:59:00Z' }));
  check(h.limitResetsAt === '2026-10-02T13:59:00Z', `later reset kept: ${h.limitResetsAt}`);
  check(h.text.includes('неделя') && h.text.includes('96%'), `mentions the highest window: ${h.text}`);

  // CodexBar exits 1 when some providers fail, but still prints JSON for the ones that worked.
  const mixed = [...claudeFixture(2, 100), { provider: 'codex', error: { message: 'x' } }, { provider: 'openai', error: {} }];
  let quotas = await codexBarQuotas(makeCodexbarExit1(tmpdir('orch-limits-'), JSON.stringify(mixed)));
  check(JSON.stringify(Object.keys(quotas)) === JSON.stringify(['claude']), `(b) exit-1 keys: ${JSON.stringify(Object.keys(quotas))}`);
  const q = quotas.claude ?? [];
  check(q.length === 2 && q[0].label === '5 часов' && q[0].usedPercent === 2 && q[1].label === 'неделя' && q[1].usedPercent === 100, `(b) exit-1 percents: ${JSON.stringify(q)}`);

  resetCodexBarCache();
  quotas = await codexBarQuotas(makeCodexbarExit1(tmpdir('orch-limits-'), 'not json'));
  check(Object.keys(quotas).length === 0, `(c) exit-1 not-json returns {}: ${JSON.stringify(quotas)}`);

  resetCodexBarCache();
  quotas = await codexBarQuotas(makeCodexbarExit1(tmpdir('orch-limits-'), ''));
  check(Object.keys(quotas).length === 0, `(d) exit-1 empty stdout returns {}: ${JSON.stringify(quotas)}`);

  h = await checkFixtureExit1(claudeFixture(90, 10));
  check(h.light === 'yellow' && h.text.includes('90%'), `(e) exit-1 chain still yellow: ${h.light} (${h.text})`);

  await readStatusTests();
  await cardStatusTests();
  await perProviderStatusTests();

  resetCodexBarCache();
  await timerTest();

  console.log('SMOKE-LIMITS OK');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
