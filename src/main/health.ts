import { AppConfig, Health, ProviderConfig } from './types';
import { run } from './git';
import { checkLocal, localKind } from './localmodels';

/**
 * Traffic light per connection:
 *   green  — connected and answering
 *   yellow — connected (key/login accepted) but no money or the quota is used up
 *   red    — not connected: no key, rejected key, not logged in, CLI missing, endpoint unreachable
 */

const MONEY = /insufficient|balance|credit|quota|billing|payment|recharge|arrear|exceeded your current|usage limit|limit reached|out of|余额|欠费|额度/i;

const now = () => Date.now();
const H = (light: Health['light'], text: string, extra: Partial<Health> = {}): Health => ({ light, text, checkedAt: now(), ...extra });

/** Pull a human message out of an API error body. */
function errorText(body: string): string {
  try {
    const j = JSON.parse(body);
    return String(j?.error?.message ?? j?.message ?? j?.error ?? j?.msg ?? body).slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

/** Classify one API answer. Exported for tests. */
export function classifyApi(status: number, body: string): Health {
  if (status >= 200 && status < 300) return H('green', 'работает');
  const msg = errorText(body);
  if (status === 401) return H('red', `ключ не принят: ${msg}`);
  if (status === 402 || MONEY.test(msg)) return H('yellow', `подключён, нет денег или лимит исчерпан: ${msg}`);
  if (status === 429) return H('green', 'работает (упёрлись в частоту запросов)');
  if (status === 403) return H('red', `доступ запрещён: ${msg}`);
  if (status === 404) return H('red', `адрес или модель не найдены: ${msg}`);
  return H('red', `ошибка ${status}: ${msg}`);
}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 20_000): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Tiny request to the Anthropic-compatible endpoint: proves key, model and balance in one go. */
async function checkApi(p: ProviderConfig, cfg: AppConfig): Promise<Health> {
  if (localKind(p)) {
    const r = await checkLocal(p);
    return H(r.light, r.text, { details: r.details });
  }
  const key = p.token || (p.id === 'anthropic' ? cfg.anthropic.apiKey : '');
  if (!key) return H('red', 'нет ключа');
  const base = (p.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  let h: Health;
  try {
    const r = await fetchWithTimeout(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': key,
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: p.model || 'claude-haiku-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
    });
    h = classifyApi(r.status, await r.text());
  } catch (e: any) {
    return H('red', `нет связи: ${e?.name === 'AbortError' ? 'таймаут' : e?.message ?? e}`);
  }
  if (p.preset === 'deepseek' && h.light !== 'red') h = await withDeepseekBalance(key, h, base);
  if (p.billing === 'plan') h.details = [...(h.details ?? []), 'coding-план: расход в кредитах плана, не в долларах'];
  return h;
}

/** A pay-per-token connection shows a yellow light only when every wallet has less than this many units left. */
export const LOW_BALANCE = 1;

/** Highest balance across currencies; `low` is true only when every entry is under LOW_BALANCE (unparsable entries are ignored). */
export function balanceStatus(infos: any[]): { low: boolean; best?: { currency: string; amount: number } } {
  let best: { currency: string; amount: number } | undefined;
  for (const b of infos ?? []) {
    const amount = parseFloat(b?.total_balance);
    if (Number.isNaN(amount)) continue;
    if (!best || amount > best.amount) best = { currency: String(b?.currency ?? ''), amount };
  }
  return { low: best ? best.amount < LOW_BALANCE : false, best };
}

/** DeepSeek's dollar balance (null when the API does not answer or has no USD wallet). */
export async function deepseekBalanceUsd(key: string, base: string): Promise<number | null> {
  try {
    const r = await fetchWithTimeout(`${new URL(base).origin}/user/balance`, { headers: { authorization: `Bearer ${key}` } }, 10_000);
    if (!r.ok) return null;
    const j: any = await r.json();
    const usd = (j?.balance_infos ?? []).find((b: any) => b?.currency === 'USD');
    const n = parseFloat(usd?.total_balance);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

async function withDeepseekBalance(key: string, h: Health, base: string): Promise<Health> {
  try {
    const origin = new URL(base).origin;
    const r = await fetchWithTimeout(`${origin}/user/balance`, { headers: { authorization: `Bearer ${key}` } }, 10_000);
    if (!r.ok) return h;
    const j: any = await r.json();
    const infos: any[] = j?.balance_infos ?? [];
    const line = infos.map((b) => `${b.total_balance} ${b.currency}`).join(', ');
    if (line) h.details = [...(h.details ?? []), `баланс: ${line}`];
    if (j?.is_available === false) return { ...h, light: 'yellow', text: 'подключён, баланс исчерпан' };
    const bs = balanceStatus(infos);
    if (bs.low && bs.best) return { ...h, light: 'yellow', text: `подключён, мало денег: осталось ${bs.best.amount} ${bs.best.currency} (порог ${LOW_BALANCE})`, details: h.details };
  } catch {
    /* balance is a bonus */
  }
  return h;
}

// ---------- subscriptions (official CLIs) ----------

export function cliEnv(): NodeJS.ProcessEnv {
  // Ask about the subscription login, not about keys that happen to be in the app's environment.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.CLAUDECODE;
  return env;
}

async function checkClaudeSub(cfg: AppConfig, quotas: CodexBarQuotas, status: CodexBarStatus = 'ok'): Promise<Health> {
  const r = await run(cfg.claudePath, ['auth', 'status'], process.cwd(), { timeoutMs: 20_000, env: cliEnv() });
  if (r.code === 127 || /ENOENT|not found/i.test(r.stderr) && !r.stdout) return H('red', 'Claude Code не установлен (npm i -g @anthropic-ai/claude-code)');
  let loggedIn: boolean | undefined;
  const details: string[] = [];
  try {
    const j = JSON.parse(r.stdout);
    loggedIn = typeof j.loggedIn === 'boolean' ? j.loggedIn : undefined;
    const plan = j.subscriptionType ?? j.subscription ?? j.plan;
    const method = j.authMethod ?? j.method;
    if (plan) details.push(`план: ${plan}`);
    if (method) details.push(`вход: ${method}`);
    if (j.email) details.push(String(j.email));
  } catch {
    if (/not logged in|logged out|please run \/login/i.test(r.stdout + r.stderr)) loggedIn = false;
    else if (/logged in/i.test(r.stdout)) loggedIn = true;
  }
  if (loggedIn === false) return H('red', 'вход не выполнен: запустите `claude` и войдите через /login');
  if (loggedIn === undefined && r.code !== 0) return H('red', `не удалось проверить вход: ${(r.stderr || r.stdout).trim().slice(0, 160)}`);
  return withQuotas(H('green', 'подписка подключена', { details }), quotas.claude, status, 'claude');
}

async function checkCodexSub(cfg: AppConfig, quotas: CodexBarQuotas, status: CodexBarStatus = 'ok'): Promise<Health> {
  const r = await run(cfg.orchestrator.codexPath || 'codex', ['login', 'status'], process.cwd(), { timeoutMs: 20_000, env: cliEnv() });
  const out = (r.stdout + '\n' + r.stderr).trim();
  if (r.code === 127 || (/ENOENT/i.test(out) && !r.stdout)) return H('red', 'Codex CLI не установлен (npm i -g @openai/codex)');
  if (r.code !== 0 || /not logged in/i.test(out)) return H('red', 'вход не выполнен: выполните `codex login`');
  const details = [out.split('\n')[0]];
  if (/api key/i.test(out)) details.push('вход по API-ключу, а не по подписке ChatGPT');
  return withQuotas(H('green', 'подписка подключена', { details }), quotas.codex, status, 'codex');
}

// ---------- CodexBar (optional): subscription limits ----------

/** Near-limit thresholds: the 5-hour session window trips at 85%, the weekly window at 95%. */
export const LIMIT_SESSION_PCT = 85;
export const LIMIT_WEEKLY_PCT = 95;

type CodexBarQuotas = Record<string, Health['quotas']>;

/** How a CodexBar read ended: missing binary, killed by the timeout, non-JSON output, or fine. */
export type CodexBarStatus = 'ok' | 'missing' | 'timeout' | 'failed';

export interface CodexBarRead {
  quotas: CodexBarQuotas;
  status: CodexBarStatus;
  /** Per-provider read result: a card is only affected by its own provider's read. */
  statuses: { claude: CodexBarStatus; codex: CodexBarStatus };
}

/** Last good quotas per provider, kept so a hang does not flip a near-limit light back to green. */
const CODEXBAR_CACHE_TTL_MS = 30 * 60_000;
const codexBarCache = new Map<string, { at: number; quotas: NonNullable<Health['quotas']> }>();
/** Providers whose quotas in the latest read came from the cache rather than a fresh answer. */
let codexBarReused = new Set<string>();
let codexBarTimeoutMs = 10_000;

/** Clear the stale-quota cache (tests). */
export function resetCodexBarCache() {
  codexBarCache.clear();
  codexBarReused = new Set();
}

/** One provider's quota windows from a CodexBar JSON entry. */
function quotaLines(p: any): NonNullable<Health['quotas']> {
  const u = p?.usage ?? {};
  const q: NonNullable<Health['quotas']> = [];
  if (u.primary?.usedPercent != null) q.push({ label: '5 часов', usedPercent: u.primary.usedPercent, resetsAt: u.primary.resetsAt });
  if (u.secondary?.usedPercent != null) q.push({ label: 'неделя', usedPercent: u.secondary.usedPercent, resetsAt: u.secondary.resetsAt });
  for (const w of u.extraRateWindows ?? []) {
    const win = w?.window ?? {};
    if (w?.title && win.usedPercent != null) q.push({ label: String(w.title), usedPercent: win.usedPercent, resetsAt: win.resetsAt, scoped: true });
  }
  return q;
}

/** Classify one `codexbar usage --provider X` run. Exit code is ignored when stdout holds valid JSON. */
function readProvider(r: { code: number; stdout: string; timedOut: boolean }, provider: string): { status: CodexBarStatus; quotas: NonNullable<Health['quotas']> } {
  if (r.code === 127) return { status: 'missing', quotas: [] };
  if (r.timedOut) return { status: 'timeout', quotas: [] };
  if (!r.stdout.trim()) return { status: 'failed', quotas: [] };
  try {
    const parsed = JSON.parse(r.stdout);
    const list: any[] = Array.isArray(parsed) ? parsed : parsed?.providers ?? [parsed];
    for (const p of list) {
      if (String(p?.provider ?? '').toLowerCase() === provider) return { status: 'ok', quotas: quotaLines(p) };
    }
    return { status: 'ok', quotas: [] }; // valid JSON without this provider is fine, just no quotas
  } catch {
    return { status: 'failed', quotas: [] };
  }
}

/**
 * Read claude and codex limit windows in parallel (only what the cards need, not `--provider all`).
 * A timeout/failed read falls back to the last good quotas for that provider, up to 30 minutes old.
 */
export async function readCodexBar(bin = 'codexbar', timeoutMs = 10_000): Promise<CodexBarRead> {
  codexBarTimeoutMs = timeoutMs;
  const [claudeR, codexR] = await Promise.all([
    run(bin, ['usage', '--format', 'json', '--provider', 'claude', '--json-only'], process.cwd(), { timeoutMs }),
    run(bin, ['usage', '--format', 'json', '--provider', 'codex', '--json-only'], process.cwd(), { timeoutMs }),
  ]);
  const reads = { claude: readProvider(claudeR, 'claude'), codex: readProvider(codexR, 'codex') };
  const statuses = { claude: reads.claude.status, codex: reads.codex.status };
  const status: CodexBarStatus =
    statuses.claude === 'missing' || statuses.codex === 'missing' ? 'missing'
    : statuses.claude === 'timeout' || statuses.codex === 'timeout' ? 'timeout'
    : statuses.claude === 'failed' || statuses.codex === 'failed' ? 'failed'
    : 'ok';

  const quotas: CodexBarQuotas = {};
  const reused = new Set<string>();
  for (const [provider, read] of Object.entries(reads)) {
    if (read.status === 'ok') {
      if (read.quotas.length) {
        quotas[provider] = read.quotas;
        codexBarCache.set(provider, { at: Date.now(), quotas: read.quotas });
      }
    } else {
      const cached = codexBarCache.get(provider);
      if (cached && Date.now() - cached.at <= CODEXBAR_CACHE_TTL_MS) {
        quotas[provider] = cached.quotas;
        reused.add(provider);
      }
    }
  }
  codexBarReused = reused;
  return { quotas, status, statuses };
}

/** Old callers/tests: just the quotas. */
export async function codexBarQuotas(bin = 'codexbar'): Promise<CodexBarQuotas> {
  return (await readCodexBar(bin)).quotas;
}

/** «сегодня в HH:MM» for the current day, «2 окт. в 04:59» otherwise. */
function fmtReset(resetsAt: string): string {
  const d = new Date(resetsAt);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return d.toLocaleString('ru-RU', sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Local HH:MM for the stale-cache note. */
function fmtClock(ts: number): string {
  return new Date(ts).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** Apply the 85/95 thresholds to quota windows (the light logic is unchanged). */
function applyQuotas(h: Health, q?: Health['quotas']): Health {
  if (!q?.length) return { ...h, details: [...(h.details ?? []), 'лимиты: установите CodexBar, чтобы видеть проценты'] };
  const thresholdOf = (x: NonNullable<Health['quotas']>[number]) => (x.label === 'неделя' ? LIMIT_WEEKLY_PCT : LIMIT_SESSION_PCT);
  const tripped = q.filter((x) => !x.scoped && x.usedPercent >= thresholdOf(x));
  if (!tripped.length) return { ...h, quotas: q };
  const top = tripped.reduce((a, b) => (b.usedPercent >= a.usedPercent ? b : a));
  const resets = tripped.map((x) => x.resetsAt).filter(Boolean) as string[];
  const reset = resets.length ? resets.reduce((a, b) => (b > a ? b : a)) : undefined;
  const when = reset ? `, сброс в ${fmtReset(reset)}` : '';
  const text = top.usedPercent >= 100
    ? `подключена, лимит «${top.label}» исчерпан${when}`
    : `подключена, лимит «${top.label}» ${top.usedPercent}%${when}`;
  return { ...h, light: 'yellow', text, quotas: q, nearLimit: true, ...(reset ? { limitResetsAt: reset } : {}) };
}

function withQuotas(h: Health, q: Health['quotas'] | undefined, status: CodexBarStatus = 'ok', provider?: string): Health {
  if (status === 'missing') {
    return { ...h, details: [...(h.details ?? []), 'лимиты: установите CodexBar, чтобы видеть проценты'] };
  }
  if ((status === 'timeout' || status === 'failed') && provider && codexBarReused.has(provider)) {
    const cached = codexBarCache.get(provider);
    if (cached) return applyQuotas({ ...h, details: [...(h.details ?? []), `лимиты: CodexBar не ответил, данные от ${fmtClock(cached.at)}`] }, cached.quotas);
  }
  if (status === 'timeout') {
    const sec = Math.max(1, Math.round(codexBarTimeoutMs / 1000));
    return { ...h, details: [...(h.details ?? []), `лимиты: CodexBar не ответил за ${sec} с (проверьте окно разрешений macOS на этом Mac)`] };
  }
  if (status === 'failed') {
    return { ...h, details: [...(h.details ?? []), 'лимиты: CodexBar вернул не JSON'] };
  }
  return applyQuotas(h, q);
}

// ---------- entry points ----------

export async function checkOne(p: ProviderConfig, cfg: AppConfig, quotas?: CodexBarQuotas, status: CodexBarStatus = 'ok'): Promise<Health> {
  try {
    const kind = p.kind ?? 'api';
    if (kind === 'claude-sub') {
      if (quotas === undefined) {
        const read = await readCodexBar();
        quotas = read.quotas;
        status = read.statuses.claude;
      }
      return await checkClaudeSub(cfg, quotas, status);
    }
    if (kind === 'codex-sub') {
      if (quotas === undefined) {
        const read = await readCodexBar();
        quotas = read.quotas;
        status = read.statuses.codex;
      }
      return await checkCodexSub(cfg, quotas, status);
    }
    return await checkApi(p, cfg);
  } catch (e: any) {
    return H('red', `проверка упала: ${e?.message ?? e}`);
  }
}

export async function checkAll(cfg: AppConfig): Promise<Record<string, Health>> {
  const hasSub = cfg.providers.some((p) => p.kind === 'claude-sub' || p.kind === 'codex-sub');
  const read = hasSub
    ? await readCodexBar()
    : { quotas: {} as CodexBarQuotas, status: 'ok' as CodexBarStatus, statuses: { claude: 'ok' as CodexBarStatus, codex: 'ok' as CodexBarStatus } };
  const entries = await Promise.all(cfg.providers.map(async (p) => {
    const status = p.kind === 'codex-sub' ? read.statuses.codex : p.kind === 'claude-sub' ? read.statuses.claude : read.status;
    return [p.id, await checkOne(p, cfg, read.quotas, status)] as const;
  }));
  return Object.fromEntries(entries);
}
