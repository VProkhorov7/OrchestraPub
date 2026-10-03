import { AppConfig, ProviderConfig } from './types';

/**
 * Time-of-day tariffs (DeepSeek: peak 01:00–04:00 and 06:00–10:00 UTC Mon–Fri, off-peak is half price).
 * Prices in Settings are the PEAK prices; off-peak cost = price × offPeakFactor.
 */
export interface PeakRule {
  /** ISO weekdays in UTC: 1 = Monday … 7 = Sunday. */
  days: number[];
  /** Peak hours in UTC, [from, to) in whole hours. */
  hoursUtc: Array<[number, number]>;
  /** Off-peak price = peak price × this. */
  offPeakFactor: number;
  /** UTC dates (YYYY-MM-DD) that are off-peak all day, e.g. Chinese public holidays. */
  holidays?: string[];
  /** Where the rule comes from and when it was checked. */
  source?: string;
}

/** Current time; ORCHESTRA_NOW (ISO) fixes it for tests. */
export function now(): Date {
  return process.env.ORCHESTRA_NOW ? new Date(process.env.ORCHESTRA_NOW) : new Date();
}

export function isPeak(rule: PeakRule | undefined, at: Date = now()): boolean {
  if (!rule) return false;
  const day = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
  if (!rule.days.includes(day)) return false;
  if (rule.holidays?.includes(at.toISOString().slice(0, 10))) return false;
  const h = at.getUTCHours() + at.getUTCMinutes() / 60;
  return rule.hoursUtc.some(([a, b]) => h >= a && h < b);
}

/** Price multiplier for a provider at a moment: 1 in peak or without a rule, offPeakFactor otherwise. */
export function priceFactor(p: ProviderConfig, at: Date = now()): number {
  if (!p.peak) return 1;
  return isPeak(p.peak, at) ? 1 : p.peak.offPeakFactor;
}

/** Providers whose price depends on the time of day and who can take tasks now. */
export function tariffProviders(cfg: AppConfig): ProviderConfig[] {
  return cfg.providers.filter((p) => p.enabled && p.peak && (p.kind ?? 'api') === 'api');
}

/** Cheap for every time-of-day provider. */
export function offPeakNow(cfg: AppConfig, at: Date = now()): boolean {
  return tariffProviders(cfg).every((p) => !isPeak(p.peak, at));
}

const STEP = 5 * 60_000;

/** End of the current cheap (or peak) stretch for all time-of-day providers, searched in 5-minute steps. */
export function stretchEnd(cfg: AppConfig, from: Date, cheap: boolean): Date {
  let t = from.getTime();
  const limit = t + 8 * 24 * 3600_000;
  while (t < limit && offPeakNow(cfg, new Date(t)) === cheap) t += STEP;
  return new Date(t);
}

/**
 * Start of the next cheap window at least `minHours` long (a short window is not worth a long run).
 * Returns `from` itself when it is already inside such a window, null when no provider has a tariff.
 */
export function nextWindow(cfg: AppConfig, from: Date = now(), minHours = 3): { start: Date; end: Date } | null {
  if (!tariffProviders(cfg).length) return null;
  let t = new Date(Math.ceil(from.getTime() / STEP) * STEP);
  for (let i = 0; i < 40; i++) {
    if (!offPeakNow(cfg, t)) t = stretchEnd(cfg, t, false);
    const end = stretchEnd(cfg, t, true);
    if (end.getTime() - t.getTime() >= minHours * 3600_000 || end.getTime() - from.getTime() > 8 * 24 * 3600_000) return { start: t, end };
    t = end;
  }
  return null;
}

/** For the panel: now cheap or not, until when, and the next good window. */
export function tariffStatus(cfg: AppConfig, at: Date = now()) {
  const ps = tariffProviders(cfg);
  if (!ps.length) return { has: false as const };
  const cheap = offPeakNow(cfg, at);
  const until = stretchEnd(cfg, at, cheap);
  const win = nextWindow(cfg, at);
  return {
    has: true as const,
    cheap,
    until: until.toISOString(),
    nextStart: win?.start.toISOString(),
    nextEnd: win?.end.toISOString(),
    providers: ps.map((p) => ({ id: p.id, label: p.label, factor: p.peak!.offPeakFactor })),
  };
}

/** DeepSeek's rule (api-docs.deepseek.com/quick_start/pricing, checked 28.09.2026). */
export const DEEPSEEK_PEAK: PeakRule = {
  days: [1, 2, 3, 4, 5],
  hoursUtc: [
    [1, 4],
    [6, 10],
  ],
  offPeakFactor: 0.5,
  // «excluding Chinese public holidays» (docs). The peak hours fall inside one Beijing day, so the UTC date is the holiday date.
  // National Day 2026: 1–7 October (State Council notice of 04.11.2025). Add the next year's holidays when the notice is out.
  holidays: [
    // 2026: National Day 1–7 Oct (State Council notice of 04.11.2025). The earlier 2026 holidays are past.
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
    // 2027 is PROVISIONAL: the State Council publishes it in early November 2026. Only days that two independent forecasts
    // (calendar sites and DeepSeek's own answer of 03.10.2026) both give as days off; a wrong day off costs only a missed
    // cheap hour, a wrong working day would mean paying double. Replace with the official notice in November 2026.
    '2027-01-01', '2027-01-02', '2027-01-03',
    '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-02-10', '2027-02-11',
    '2027-04-04', '2027-04-05',
    '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
    '2027-06-09',
    '2027-09-15',
    '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07',
  ],
  source: 'api-docs.deepseek.com/quick_start/pricing, 03.10.2026',
};
