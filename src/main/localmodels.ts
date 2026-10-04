import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { ProviderConfig } from './types';
import type { Light } from './types';

/**
 * Local models: Ollama, LM Studio, and any other server that speaks the Anthropic Messages API
 * (llama.cpp's llama-server, vLLM, ...). A worker is headless Claude Code pointed at the server, so the model must handle
 * Claude Code's tool calls and, above all, have a large enough context: Claude Code alone sends about 16 000 tokens
 * with every turn. Ollama's default context on a Mac with up to 24 GB of memory is 4 096, which makes a worker fail.
 * This module checks the server, the model and the context, and can prepare an Ollama model with a larger context.
 */

export const MIN_CONTEXT = 16_384;
export const WANT_CONTEXT = 32_768;

export type LocalKind = 'ollama' | 'lmstudio' | 'other';

export function localKind(p: Pick<ProviderConfig, 'local' | 'preset'>): LocalKind | null {
  if (p.local === 'ollama' || p.local === 'lmstudio' || p.local === 'other') return p.local;
  if (p.preset === 'ollama') return 'ollama';
  if (p.preset === 'lmstudio') return 'lmstudio';
  if (p.preset === 'local-other') return 'other';
  return null;
}

export interface LocalCheck {
  light: Light;
  text: string;
  details: string[];
}

const trim = (u: string) => u.replace(/\/+$/, '');

async function http(url: string, init: RequestInit = {}, ms = 4000): Promise<{ ok: boolean; status: number; json: any }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    let json: any = null;
    try {
      json = await r.json();
    } catch {
      /* not JSON */
    }
    return { ok: r.ok, status: r.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  } finally {
    clearTimeout(t);
  }
}

const sample = (names: string[]) => (names.length ? names.slice(0, 6).join(', ') + (names.length > 6 ? ` и ещё ${names.length - 6}` : '') : 'ничего');
const ctxText = (n: number) => n.toLocaleString('ru-RU').replace(/ /g, ' ');

/** Context length a model really runs with, learnt by loading it for a moment (cached: loading takes RAM and seconds). */
const loadedCtx = new Map<string, { at: number; ctx: number | null }>();

async function ollamaLoadedContext(base: string, model: string): Promise<number | null> {
  const key = `${base}|${model}`;
  const hit = loadedCtx.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ctx;
  const read = async () => {
    const ps = await http(`${base}/api/ps`);
    const m = (ps.json?.models ?? []).find((x: any) => x.name === model || x.model === model || x.name === `${model}:latest`);
    return m?.context_length ? Number(m.context_length) : null;
  };
  let ctx = await read();
  if (ctx === null) {
    const wasIdle = !((await http(`${base}/api/ps`)).json?.models ?? []).length;
    // An empty prompt loads the model without generating anything.
    await http(`${base}/api/generate`, { method: 'POST', body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: '60s' }) }, 120_000);
    ctx = await read();
    if (wasIdle) await http(`${base}/api/generate`, { method: 'POST', body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 }) }, 20_000);
  }
  loadedCtx.set(key, { at: Date.now(), ctx });
  return ctx;
}

export function forgetLoadedContext() {
  loadedCtx.clear();
}

const fixContext = (kind: LocalKind) =>
  kind === 'ollama'
    ? 'Нажмите «Контекст 32K» на карточке (создаст копию модели с большим контекстом) или задайте OLLAMA_CONTEXT_LENGTH=32768 и перезапустите Ollama.'
    : 'Загрузите модель с контекстом от 32 768 (в LM Studio: настройка «Context Length» при загрузке).';

async function checkOllama(p: ProviderConfig, base: string): Promise<LocalCheck> {
  const tags = await http(`${base}/api/tags`);
  if (!tags.ok) return { light: 'red', text: `Ollama не отвечает на ${base}: запустите приложение Ollama или выполните «ollama serve»`, details: [] };
  const names: string[] = (tags.json?.models ?? []).map((m: any) => String(m.name));
  const want = p.model;
  const has = names.some((n) => n === want || n === `${want}:latest`);
  if (!has) return { light: 'red', text: `Модели «${want}» нет на сервере: выполните «ollama pull ${want}». Установлены: ${sample(names)}`, details: [] };
  const details = [`модели на сервере: ${sample(names)}`];
  // 1) a context fixed in the model itself; 2) what the loaded model runs with.
  const show = await http(`${base}/api/show`, { method: 'POST', body: JSON.stringify({ model: want }) });
  const num = /num_ctx\s+(\d+)/.exec(String(show.json?.parameters ?? ''))?.[1];
  const ctx = num ? Number(num) : await ollamaLoadedContext(base, want);
  if (ctx === null) return { light: 'green', text: 'работает (контекст не удалось определить)', details };
  details.push(`контекст ${ctxText(ctx)} токенов`);
  if (ctx < MIN_CONTEXT) return { light: 'yellow', text: `контекст ${ctxText(ctx)} токенов: для Claude Code нужно от ${ctxText(WANT_CONTEXT)}. ${fixContext('ollama')}`, details };
  return { light: 'green', text: 'работает', details };
}

async function checkLmStudio(p: ProviderConfig, base: string): Promise<LocalCheck> {
  const v0 = await http(`${base}/api/v0/models`);
  const list: any[] = v0.ok ? v0.json?.data ?? [] : [];
  let names = list.map((m) => String(m.id));
  if (!v0.ok) {
    const v1 = await http(`${base}/v1/models`);
    if (!v1.ok) return { light: 'red', text: `LM Studio не отвечает на ${base}: запустите локальный сервер (вкладка Developer → Start Server)`, details: [] };
    names = (v1.json?.data ?? []).map((m: any) => String(m.id));
  }
  if (!names.includes(p.model)) return { light: 'red', text: `Модели «${p.model}» нет в LM Studio. Доступны: ${sample(names)}`, details: [`модели на сервере: ${sample(names)}`] };
  const details = [`модели на сервере: ${sample(names)}`];
  const m = list.find((x) => x.id === p.model);
  if (m?.state === 'loaded' && m.loaded_context_length) {
    const ctx = Number(m.loaded_context_length);
    details.push(`контекст ${ctxText(ctx)} токенов`);
    if (ctx < MIN_CONTEXT) return { light: 'yellow', text: `контекст ${ctxText(ctx)} токенов: для Claude Code нужно от ${ctxText(WANT_CONTEXT)}. ${fixContext('lmstudio')}`, details };
  } else if (m) {
    details.push('модель не загружена: загрузится при первом запросе (проверьте контекст)');
  }
  return { light: 'green', text: 'работает', details };
}

async function checkOther(p: ProviderConfig, base: string): Promise<LocalCheck> {
  const r = await http(`${base}/v1/models`);
  if (!r.ok) return { light: 'red', text: `Сервер не отвечает на ${base}: запущен ли он и верен ли адрес?`, details: [] };
  const names: string[] = (r.json?.data ?? []).map((m: any) => String(m.id));
  if (names.length && p.model && !names.includes(p.model)) return { light: 'red', text: `Модели «${p.model}» нет на сервере. Доступны: ${sample(names)}`, details: [`модели на сервере: ${sample(names)}`] };
  return { light: 'green', text: 'работает', details: names.length ? [`модели на сервере: ${sample(names)}`] : [] };
}

export async function checkLocal(p: ProviderConfig): Promise<LocalCheck> {
  const kind = localKind(p) ?? 'other';
  const base = trim(p.baseUrl || '');
  if (!base) return { light: 'red', text: 'не указан адрес сервера', details: [] };
  if (!p.model) return { light: 'red', text: 'не указана модель', details: [] };
  if (kind === 'ollama') return checkOllama(p, base);
  if (kind === 'lmstudio') return checkLmStudio(p, base);
  return checkOther(p, base);
}

/** Model ids the server offers (for the model field of the card). */
export async function listLocalModels(p: ProviderConfig): Promise<{ ok: boolean; models: string[] }> {
  const base = trim(p.baseUrl || '');
  if (localKind(p) === 'ollama') {
    const r = await http(`${base}/api/tags`);
    return { ok: r.ok, models: (r.json?.models ?? []).map((m: any) => String(m.name)) };
  }
  const r = await http(`${base}/v1/models`);
  return { ok: r.ok, models: (r.json?.data ?? []).map((m: any) => String(m.id)) };
}

const isLocalHost = (base: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);

/**
 * Ollama only, on this machine: a copy of the model with `num_ctx` set (no weights are copied), so Claude Code gets
 * the context it needs without touching the server's settings. Returns the new model name.
 */
export async function prepareOllamaContext(p: ProviderConfig, tokens = WANT_CONTEXT): Promise<string> {
  if (localKind(p) !== 'ollama') throw new Error('Контекст можно подготовить только для Ollama');
  if (!isLocalHost(trim(p.baseUrl))) throw new Error('Подготовка модели работает только для Ollama на этом же компьютере; на другом задайте OLLAMA_CONTEXT_LENGTH на его сервере');
  const base = p.model.replace(/-\d+k$/, '');
  const name = `${base}-${Math.round(tokens / 1024)}k`;
  const file = path.join(os.tmpdir(), `orchestra-modelfile-${process.pid}-${Date.now()}`);
  fs.writeFileSync(file, `FROM ${p.model}\nPARAMETER num_ctx ${tokens}\n`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('ollama', ['create', name, '-f', file], { timeout: 5 * 60_000 }, (err, _so, se) => (err ? reject(new Error(`ollama create: ${String(se || err.message).trim().slice(-300)}`)) : resolve()));
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
  forgetLoadedContext();
  return name;
}
