import * as fs from 'fs';
import * as path from 'path';
import { AppConfig, ProviderConfig } from './types';
import { fromPreset, presetFor } from './catalog';

/** A fresh install starts with the two subscriptions; everything else is added from the drop-down in Settings. */
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  fromPreset('claude-sub', { enabled: false }),
  fromPreset('codex-sub', { enabled: false }),
];

export const DEFAULT_CONFIG: AppConfig = {
  orchestrator: { mode: 'claude-sub', claudeModel: '', codexModel: '', codexPath: 'codex' },
  anthropic: {
    apiKey: '',
    // Opus for planning/review judgement; switch to claude-sonnet-5 for small routine runs.
    model: 'claude-opus-5',
    maxTokens: 8192,
  },
  providers: DEFAULT_PROVIDERS,
  claudePath: 'claude',
  maxParallel: 3,
  workerTimeoutMin: 30,
  skipPermissions: true,
  workerPreamble: '',
  orchestratorPreamble: '',
  runBudgetUsd: 20,
  language: 'ru',
  autoRetry: 3,
  autoMemory: true,
  notify: { macos: true, macosLevel: 'error', silentMinutes: 8 },
  plannerPick: 'ask',
  serve: { host: '127.0.0.1', port: 7777 },
};

const DEFAULT_MAX_USD_PER_RUN = 3;

/** Fill kind/billing/preset for providers saved by older versions, and move to the 0.4 connection model once. */
export function normalizeConfig(parsed: Partial<AppConfig>): AppConfig {
  const legacy = !parsed.orchestrator; // saved before 0.4
  // OmniRoute was tried in 0.7.4 and dropped in 0.7.5: a card added then is removed.
  let providers: ProviderConfig[] = (parsed.providers ?? []).filter((p) => p.preset !== 'omniroute').map((p) => {
    const pr = presetFor(p);
    return {
      ...p,
      kind: p.kind ?? pr?.template.kind ?? 'api',
      billing: p.billing ?? pr?.template.billing ?? 'api',
      preset: p.preset ?? pr?.id,
      roles: p.roles ?? [],
      priceIn: p.priceIn ?? pr?.template.priceIn,
      priceOut: p.priceOut ?? pr?.template.priceOut,
      priceCacheRead: p.priceCacheRead ?? pr?.template.priceCacheRead,
      // A card added before tariffs were known gets its provider's rule.
      // Holidays come from the preset, so saved cards pick up new holiday lists.
      peak: p.peak ? { ...p.peak, holidays: pr?.template.peak?.holidays ?? p.peak.holidays } : pr?.template.peak,
      // Every pay-per-token connection gets a spend cap; an explicit 0 still means «no cap».
      maxUsdPerRun: p.maxUsdPerRun ?? ((p.kind ?? pr?.template.kind ?? 'api') === 'api' && (p.billing ?? pr?.template.billing ?? 'api') === 'api' ? DEFAULT_MAX_USD_PER_RUN : undefined),
    };
  });
  if (legacy) {
    // Old defaults shipped deepseek/glm/qwen/anthropic without keys: those were never connected, drop them.
    providers = providers.filter((p) => p.kind !== 'api' || p.token || (p.id === 'anthropic' && parsed.anthropic?.apiKey));
    const anth = providers.find((p) => p.id === 'anthropic');
    if (anth && !anth.token && parsed.anthropic?.apiKey) anth.token = parsed.anthropic.apiKey;
  }
  for (const d of DEFAULT_PROVIDERS) if (!providers.some((p) => p.id === d.id)) providers.unshift(structuredClone(d));
  return {
    ...structuredClone(DEFAULT_CONFIG),
    ...parsed,
    orchestrator: { ...DEFAULT_CONFIG.orchestrator, ...(parsed.orchestrator ?? {}) },
    serve: { ...DEFAULT_CONFIG.serve, ...(parsed.serve ?? {}) },
    anthropic: { ...DEFAULT_CONFIG.anthropic, ...(parsed.anthropic ?? {}) },
    providers,
    health: undefined,
  };
}

/** Key for Claude API calls (orchestrator in API mode, planner): the Claude API connection, else the legacy field. */
export function anthropicKey(cfg: AppConfig): string {
  return cfg.providers.find((p) => p.id === 'anthropic')?.token || cfg.anthropic.apiKey || '';
}

export class ConfigStore {
  constructor(private file: string) {}

  load(): AppConfig {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return normalizeConfig(JSON.parse(raw) as Partial<AppConfig>);
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  save(cfg: AppConfig): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const { health, ...rest } = cfg;
    fs.writeFileSync(this.file, JSON.stringify(rest, null, 2), { mode: 0o600 });
  }
}
