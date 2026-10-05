/**
 * Unit tests for the pure helpers in src/main/ratelimit.ts: rate-limit detection,
 * pause scheduling and the clock formatter. No network or filesystem is touched.
 */
import { check } from './helpers';
import { clock, clearPauses, isRateLimitError, pauseProvider, pausedUntil } from '../main/ratelimit';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const TEN_MIN = 10 * 60_000;

// 1. isRateLimitError
check(isRateLimitError('API Error: 429 Too Many Requests'), '429 "Too Many Requests" is a rate limit');
check(isRateLimitError('Rate limit reached'), '"Rate limit reached" is a rate limit');
check(isRateLimitError('quota exceeded'), '"quota exceeded" is a rate limit');
check(isRateLimitError('free-models-per-day limit'), '"free-models-per-day" is a rate limit');
check(isRateLimitError('100 requests per minute'), '"requests per minute" is a rate limit');
check(!isRateLimitError('simulated worker failure'), 'an ordinary worker failure is not a rate limit');
check(!isRateLimitError('превышен лимит воркера bai: $2'), 'our worker cap is not a rate limit');
check(!isRateLimitError('исчерпан бюджет запуска $3'), 'our budget cap is not a rate limit');
check(!isRateLimitError(''), 'an empty string is not a rate limit');
check(!isRateLimitError('429 и превышен лимит воркера bai: $2'), 'our own cap wins even when 429 is also present');

// 2. pauseProvider
const until = pauseProvider('p-non-daily', 'rate limit reached', NOW);
check(until === NOW + TEN_MIN, `a non-daily limit pauses for 10 minutes (got ${until - NOW} ms)`);
const dailyUntil = pauseProvider('p-daily', 'free-models-per-day limit', NOW);
check(dailyUntil === Date.UTC(2026, 9, 6, 0, 0, 0), `a daily limit pauses until midnight UTC next day (got ${new Date(dailyUntil).toISOString()})`);

// 3. pausedUntil
check(pausedUntil('p-non-daily', NOW) === until, 'inside the pause: returns the end');
check(pausedUntil('p-daily', NOW) === dailyUntil, 'inside the daily pause: returns the end');
check(pausedUntil('p-non-daily', until) === 0, 'at the exact end of the pause: returns 0');
check(pausedUntil('p-non-daily', until + 1) === 0, 'after the pause: returns 0');
check(pausedUntil('p-non-daily', until + 1) === 0, 'repeated call after the pause: still 0');
check(pausedUntil('unknown', NOW) === 0, 'an unknown id is not paused');

// 4. clearPauses
clearPauses();
check(pausedUntil('p-daily', NOW) === 0, 'after clearPauses: the daily id is gone');
check(pausedUntil('p-non-daily', NOW) === 0, 'after clearPauses: the non-daily id is gone');

// 5. clock
check(clock(Date.UTC(2026, 9, 5, 7, 5, 0)) === '07:05 UTC', `clock formats HH:MM UTC (got ${clock(Date.UTC(2026, 9, 5, 7, 5, 0))})`);

clearPauses();
console.log('SMOKE-RATELIMIT-UNIT OK');
