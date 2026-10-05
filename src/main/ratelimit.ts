/**
 * A provider's rate limit (HTTP 429, quota, «free-models-per-day») is a pause of that connection, not a failure of the task.
 * Pauses live in memory: restarting the service forgets them.
 */

const RATE_LIMIT = /\b429\b|rate.?limit|too many requests|quota|free-models-per-day|requests per (day|minute)/i;
const DAILY = /per day|daily|free-models-per-day/i;
/** Our own caps («worker limit exceeded», «budget exhausted») are not the provider's rate limit. */
const OUR_CAP = /превышен лимит|исчерпан бюджет/;
const DEFAULT_PAUSE_MS = 10 * 60_000;

const paused = new Map<string, number>();

export function isRateLimitError(text: string): boolean {
  return !OUR_CAP.test(text) && RATE_LIMIT.test(text);
}

/** Pause a connection: until the next midnight UTC for a daily limit, otherwise for 10 minutes. Returns the end (ms). */
export function pauseProvider(providerId: string, text: string, now = Date.now()): number {
  const d = new Date(now);
  const until = DAILY.test(text) ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) : now + DEFAULT_PAUSE_MS;
  paused.set(providerId, until);
  return until;
}

/** The end of the pause (ms), or 0 when the connection is not paused. */
export function pausedUntil(providerId: string, now = Date.now()): number {
  const until = paused.get(providerId) ?? 0;
  if (until <= now) {
    paused.delete(providerId);
    return 0;
  }
  return until;
}

export function clearPauses(): void {
  paused.clear();
}

export function clock(until: number): string {
  return new Date(until).toISOString().slice(11, 16) + ' UTC';
}
