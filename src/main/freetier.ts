import { AppConfig, ProviderConfig } from './types';

/**
 * «Free only» mode: nothing that costs money is used. A worker counts as free when it is
 *  - a local model (Ollama, LM Studio, ...),
 *  - on a free tier the owner has marked (`freeTier`), or priced at an explicit 0,
 *  - an OpenRouter model that is free there (`:free`, or priced at 0 in OpenRouter's own list, which is the source of truth),
 *  - a subscription or a flat-price coding plan: they cost nothing more per task (the money is already paid).
 * Everything else (pay per token) is switched off while the mode is on, and so is an orchestrator that works by API key.
 */

const MODELS_URL = () => process.env.ORCHESTRA_OPENROUTER_MODELS_URL || 'https://openrouter.ai/api/v1/models';
const TTL_MS = 60 * 60_000;

export interface FreeModel {
  id: string;
  name: string;
  context: number;
  tools: boolean;
}

let freeSet = new Set<string>();
let freeList: FreeModel[] = [];
let freeAt = 0;

/** OpenRouter's current free models (priced at 0), cached for an hour. Public list, no key needed. */
export async function refreshFreeModels(force = false): Promise<FreeModel[]> {
  if (!force && freeList.length && Date.now() - freeAt < TTL_MS) return freeList;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);
  try {
    const r = await fetch(MODELS_URL(), { signal: ac.signal });
    const data: any[] = ((await r.json()) as any).data ?? [];
    freeList = data
      .filter((m) => m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)
      .map((m) => ({ id: String(m.id), name: String(m.name ?? m.id), context: Number(m.context_length ?? 0), tools: (m.supported_parameters ?? []).includes('tools') }))
      .sort((a, b) => Number(b.tools) - Number(a.tools) || b.context - a.context);
    freeSet = new Set(freeList.map((m) => m.id));
    freeAt = Date.now();
  } catch {
    /* offline: the cached list (or the :free suffix) is all there is */
  } finally {
    clearTimeout(t);
  }
  return freeList;
}

export function forgetFreeModels() {
  freeSet = new Set();
  freeList = [];
  freeAt = 0;
}

export const isOpenRouter = (p: Pick<ProviderConfig, 'baseUrl'>) => /openrouter\.ai/.test(p.baseUrl ?? '');

export function isFreeProvider(p: ProviderConfig): boolean {
  if (p.kind === 'claude-sub' || p.kind === 'codex-sub' || p.billing === 'plan' || p.billing === 'subscription') return true;
  if (p.local || p.freeTier) return true;
  if (isOpenRouter(p)) return freeSet.has(p.model) || /:free$/.test(p.model);
  return p.priceIn === 0 && p.priceOut === 0;
}

/** Why a worker is off in free-only mode, or null when it may be used. */
export function freeOnlyReason(cfg: Pick<AppConfig, 'freeOnly' | 'language'>, p: ProviderConfig): string | null {
  if (!cfg.freeOnly || isFreeProvider(p)) return null;
  const en = cfg.language === 'en';
  return isOpenRouter(p)
    ? en
      ? `free-only mode: the OpenRouter model «${p.model}» is paid (use a free one, e.g. openrouter/free)`
      : `режим «только бесплатное»: модель OpenRouter «${p.model}» платная (возьмите бесплатную, например openrouter/free)`
    : en
      ? 'free-only mode: this worker is paid'
      : 'режим «только бесплатное»: исполнитель платный';
}
