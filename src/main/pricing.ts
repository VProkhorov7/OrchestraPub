import { ProviderConfig } from './types';

/** Token counts as reported by the Anthropic Messages API (and by Claude Code's stream-json). */
export interface Usage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

export function addUsage(a: Usage, u: any): Usage {
  if (!u) return a;
  a.input += u.input_tokens ?? 0;
  a.output += u.output_tokens ?? 0;
  a.cacheWrite += u.cache_creation_input_tokens ?? 0;
  a.cacheRead += u.cache_read_input_tokens ?? 0;
  return a;
}

/** USD per 1M input/output tokens for Claude models, by model-id prefix (Sept 2026 list prices). */
const CLAUDE_PRICES: Array<[string, number, number]> = [
  ['claude-fable', 10, 50],
  ['claude-mythos', 10, 50],
  ['claude-opus', 5, 25],
  ['claude-sonnet', 2, 10],
  ['claude-haiku', 1, 5],
];

export function priceFor(model: string): [number, number] {
  const hit = CLAUDE_PRICES.find(([prefix]) => model.startsWith(prefix));
  return hit ? [hit[1], hit[2]] : [5, 25];
}

/** Anthropic pricing: cache writes 1.25x input, cache reads 0.1x input. */
export function claudeCost(model: string, u: Usage): number {
  const [pin, pout] = priceFor(model);
  return (u.input * pin + u.cacheWrite * pin * 1.25 + u.cacheRead * pin * 0.1 + u.output * pout) / 1e6;
}

/**
 * Cost of a worker run. Third-party providers use the prices from Settings;
 * without prices we fall back to what Claude Code reported (which uses Anthropic prices and is only a rough guess).
 */
export function workerCost(p: ProviderConfig, u: Usage, reported?: number): { usd: number; estimated: boolean; apiEquiv?: number } {
  // Subscriptions and flat coding plans cost no extra dollars per task; keep what it would cost at API prices.
  if (p.kind === 'claude-sub') return { usd: 0, estimated: false, apiEquiv: reported ?? claudeCost('claude-sonnet', u) };
  if (p.billing === 'plan') {
    const equiv = p.priceIn || p.priceOut ? ((u.input + u.cacheWrite) * (p.priceIn ?? 0) + u.output * (p.priceOut ?? 0)) / 1e6 : undefined;
    return { usd: 0, estimated: false, apiEquiv: equiv };
  }
  if (!p.baseUrl) return { usd: reported ?? claudeCost(p.model, u), estimated: reported == null };
  // An explicit 0 is a real «free» price; only missing (undefined) prices fall back to the estimate.
  if (typeof p.priceIn === 'number' && typeof p.priceOut === 'number') {
    const pin = p.priceIn;
    const cacheRead = p.priceCacheRead ?? pin * 0.1;
    const usd = ((u.input + u.cacheWrite) * pin + u.cacheRead * cacheRead + u.output * p.priceOut) / 1e6;
    return { usd, estimated: false };
  }
  // No prices: estimate by Anthropic prices live, so the spend cap can still stop the task mid-flight.
  return { usd: reported ?? claudeCost(p.model, u), estimated: true };
}
