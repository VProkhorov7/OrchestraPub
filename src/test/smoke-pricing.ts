/**
 * Pricing: an explicit 0 is a real «free» price (cost exactly 0, not estimated);
 * only missing (undefined) prices fall back to Claude Code's reported figure.
 * Run: as the last step of `npm run smoke`.
 */
import { workerCost, Usage } from '../main/pricing';
import { fromPreset } from '../main/catalog';
import { check } from './helpers';

const usage: Usage = { input: 1_000_000, output: 500_000, cacheWrite: 0, cacheRead: 0 };

// Free model: 0 / 0 / 0 means free, not «price missing».
const c1 = workerCost(fromPreset('deepseek', { priceIn: 0, priceOut: 0, priceCacheRead: 0 }), usage);
check(c1.usd === 0, `free provider costs exactly 0, got ${c1.usd}`);
check(c1.estimated === false, `free provider is not estimated: ${c1.estimated}`);

// Priced model: exact dollars, not estimated.
const pricedUsage: Usage = { input: 1_000_000, output: 500_000, cacheWrite: 0, cacheRead: 100_000 };
const c2 = workerCost(fromPreset('deepseek', { priceIn: 1.32, priceOut: 3.96, priceCacheRead: 0.044 }), pricedUsage);
const expected = (1_000_000 * 1.32) / 1e6 + (500_000 * 3.96) / 1e6 + (100_000 * 0.044) / 1e6;
check(Math.abs(c2.usd - expected) < 1e-9, `priced cost ${c2.usd} ≈ ${expected}`);
check(c2.estimated === false, 'priced provider is not estimated');

// No prices at all: unchanged fallback to Claude Code's reported figure, marked estimated.
const c3 = workerCost(fromPreset('deepseek', { priceIn: undefined, priceOut: undefined, priceCacheRead: undefined }), usage, 0.22);
check(c3.usd === 0.22 && c3.estimated === true, `no prices falls back to reported figure: ${c3.usd} est=${c3.estimated}`);

// Only the input price is free: the output price still counts.
const c4 = workerCost(fromPreset('deepseek', { priceIn: 0, priceOut: 3.96, priceCacheRead: 0 }), usage);
check(Math.abs(c4.usd - (500_000 * 3.96) / 1e6) < 1e-9 && c4.estimated === false, `priceIn=0 costs only the output part: ${c4.usd}`);

// No prices and nothing reported yet (live usage): still a non-zero estimate, so the spend cap can stop the task.
const c5 = workerCost(fromPreset('deepseek', { priceIn: undefined, priceOut: undefined, priceCacheRead: undefined, model: 'claude-sonnet-5' }), usage);
check(c5.usd > 0 && c5.estimated === true, `unpriced live usage is estimated, not 0: ${c5.usd}`);

console.log('SMOKE-PRICING OK');
