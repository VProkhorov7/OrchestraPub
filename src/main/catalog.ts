import { DEEPSEEK_PEAK } from './tariff';
import { ProviderConfig } from './types';

/**
 * Connections the user can add from the drop-down in Settings.
 * Model ids and prices change often: they are defaults, editable on the card.
 */
export interface Preset {
  /** Stable catalog id; also the provider id the orchestrator sees. */
  id: string;
  group: 'Подписки' | 'API, оплата за токены' | 'Coding-планы (фикс. цена)';
  /** Where to get a key / how to log in. */
  help: string;
  /** Can this connection run worker tasks (Codex is orchestrator-only for now). */
  canWork: boolean;
  /** Can this connection be the orchestrator. */
  canOrchestrate: boolean;
  template: Omit<ProviderConfig, 'token' | 'enabled'>;
}

export const PRESETS: Preset[] = [
  // ---------- subscriptions (official CLIs) ----------
  {
    id: 'claude-sub',
    group: 'Подписки',
    help: 'Claude Pro/Max через официальный Claude Code. Ключ не нужен: в терминале выполните `claude` и войдите в аккаунт (/login). Лимиты общие с вашим обычным Claude Code.',
    canWork: true,
    canOrchestrate: true,
    template: {
      id: 'claude-sub',
      kind: 'claude-sub',
      billing: 'subscription',
      preset: 'claude-sub',
      label: 'Claude (подписка)',
      baseUrl: '',
      model: '',
      notes: 'Claude Code on the Claude subscription. Strong, but shares limits with the orchestrator: only for the hardest tasks.',
      roles: ['feature', 'bugfix', 'review'],
    },
  },
  {
    id: 'codex-sub',
    group: 'Подписки',
    help: 'ChatGPT (Plus/Pro/Business) через официальный Codex CLI. Установите `npm i -g @openai/codex` и выполните `codex login`.',
    canWork: false,
    canOrchestrate: true,
    template: {
      id: 'codex-sub',
      kind: 'codex-sub',
      billing: 'subscription',
      preset: 'codex-sub',
      label: 'ChatGPT / Codex (подписка)',
      baseUrl: '',
      model: '',
      notes: 'Orchestrator only.',
      roles: [],
    },
  },

  // ---------- pay per token ----------
  {
    id: 'anthropic',
    group: 'API, оплата за токены',
    help: 'Ключ: console.anthropic.com → API Keys. Используется и оркестратором в режиме API.',
    canWork: true,
    canOrchestrate: true,
    template: {
      id: 'anthropic',
      kind: 'api',
      billing: 'api',
      preset: 'anthropic',
      label: 'Claude API',
      baseUrl: '',
      model: 'claude-sonnet-5',
      notes: 'Expensive. Reserve for the hardest pieces where cheaper workers failed twice.',
      roles: ['feature', 'bugfix', 'review'],
      maxUsdPerRun: 5,
    },
  },
  {
    id: 'deepseek',
    group: 'API, оплата за токены',
    help: 'Ключ: platform.deepseek.com → API keys. Баланс показывается на карточке.',
    canWork: true,
    canOrchestrate: false,
    template: {
      id: 'deepseek',
      kind: 'api',
      billing: 'api',
      preset: 'deepseek',
      label: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-pro',
      smallModel: 'deepseek-flash',
      notes: 'Very cheap, 1M context. Good for mechanical bulk work: tests, boilerplate, pattern refactors, migrations. Give it small, precise specs.',
      roles: ['tests', 'refactor', 'docs'],
      // api-docs.deepseek.com/quick_start/pricing, 28.09.2026, peak rates (off-peak is half): the budget errs on the safe side.
      priceIn: 1.32,
      priceOut: 3.96,
      priceCacheRead: 0.044,
      peak: DEEPSEEK_PEAK,
    },
  },
  {
    id: 'glm',
    group: 'API, оплата за токены',
    help: 'Ключ: z.ai → API Keys (оплата за токены).',
    canWork: true,
    canOrchestrate: false,
    template: {
      id: 'glm',
      kind: 'api',
      billing: 'api',
      preset: 'glm',
      label: 'GLM (z.ai API)',
      baseUrl: 'https://api.z.ai/api/anthropic',
      model: 'glm-5.3',
      smallModel: 'glm-5.3-flash',
      notes: 'Strong agentic coder. Good for features that need some autonomy across several files.',
      roles: ['feature', 'bugfix', 'refactor'],
      priceIn: 1.4,
      priceOut: 4.4,
      priceCacheRead: 0.26,
    },
  },
  {
    id: 'kimi',
    group: 'API, оплата за токены',
    help: 'Ключ: platform.moonshot.ai → API Keys. Проверьте актуальный id модели.',
    canWork: true,
    canOrchestrate: false,
    template: {
      id: 'kimi',
      kind: 'api',
      billing: 'api',
      preset: 'kimi',
      label: 'Kimi (Moonshot)',
      baseUrl: 'https://api.moonshot.ai/anthropic',
      model: 'kimi-k3',
      notes: 'Good agentic coder with long context.',
      roles: ['feature', 'bugfix', 'tests'],
    },
  },
  {
    id: 'minimax',
    group: 'API, оплата за токены',
    help: 'Ключ: platform.minimax.io. Проверьте актуальный id модели.',
    canWork: true,
    canOrchestrate: false,
    template: {
      id: 'minimax',
      kind: 'api',
      billing: 'api',
      preset: 'minimax',
      label: 'MiniMax',
      baseUrl: 'https://api.minimax.io/anthropic',
      model: 'MiniMax-M3',
      notes: 'Cheap and fast; fine for tests and refactors.',
      roles: ['tests', 'refactor', 'docs'],
      priceIn: 0.3,
      priceOut: 1.2,
    },
  },
  {
    id: 'qwen',
    group: 'API, оплата за токены',
    help: 'Ключ Alibaba Cloud Model Studio (оплата за токены). Ключ Coding/Token Plan сюда не подходит: условия плана запрещают неинтерактивное использование.',
    canWork: true,
    canOrchestrate: false,
    template: {
      id: 'qwen',
      kind: 'api',
      billing: 'api',
      preset: 'qwen',
      label: 'Qwen (Alibaba API)',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
      model: 'qwen3-coder-plus',
      notes: 'Solid agentic coder, long context.',
      roles: ['feature', 'bugfix', 'tests'],
      priceIn: 1,
      priceOut: 5,
    },
  },
  {
    id: 'openrouter',
    group: 'API, оплата за токены',
    help: 'Ключ: openrouter.ai/keys. Один ключ на сотни моделей; id модели в формате vendor/model.',
    canWork: true,
    canOrchestrate: false,
    template: {
      id: 'openrouter',
      kind: 'api',
      billing: 'api',
      preset: 'openrouter',
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api',
      model: 'deepseek/deepseek-v4-pro',
      notes: 'Aggregator; model set per connection.',
      roles: [],
    },
  },

  // ---------- coding plans ----------
  {
    id: 'glm-plan',
    group: 'Coding-планы (фикс. цена)',
    help: 'Ключ GLM Coding Plan (z.ai). Расход считается в кредитах плана, а не в долларах. Перед использованием из автоматизации проверьте условия плана.',
    canWork: true,
    canOrchestrate: false,
    template: {
      id: 'glm-plan',
      kind: 'api',
      billing: 'plan',
      preset: 'glm-plan',
      label: 'GLM Coding Plan',
      baseUrl: 'https://api.z.ai/api/anthropic',
      model: 'glm-5.3',
      smallModel: 'glm-5.3-flash',
      notes: 'Flat-price plan: prefer it over pay-per-token workers while its quota lasts.',
      roles: ['feature', 'bugfix', 'refactor', 'tests'],
    },
  },
  {
    id: 'minimax-plan',
    group: 'Coding-планы (фикс. цена)',
    help: 'Ключ MiniMax Token Plan. Проверьте условия плана.',
    canWork: true,
    canOrchestrate: false,
    template: {
      id: 'minimax-plan',
      kind: 'api',
      billing: 'plan',
      preset: 'minimax-plan',
      label: 'MiniMax Token Plan',
      baseUrl: 'https://api.minimax.io/anthropic',
      model: 'MiniMax-M3',
      notes: 'Flat-price plan: prefer it over pay-per-token workers while its quota lasts.',
      roles: ['tests', 'refactor', 'docs'],
    },
  },
];

export function presetFor(p: Pick<ProviderConfig, 'id' | 'preset'>): Preset | undefined {
  return PRESETS.find((x) => x.id === (p.preset ?? p.id));
}

export function fromPreset(id: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  const pr = PRESETS.find((x) => x.id === id);
  if (!pr) throw new Error(`unknown preset ${id}`);
  return { ...structuredClone(pr.template), token: '', enabled: true, ...overrides } as ProviderConfig;
}

export function canWork(p: ProviderConfig): boolean {
  return (p.kind ?? 'api') !== 'codex-sub';
}
