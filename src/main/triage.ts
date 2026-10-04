import { replyLang } from './lang';
import { freeOnlyReason } from './freetier';
import { AppConfig, Health, PlannerChoice, ProviderConfig, Triage } from './types';
import { anthropicKey } from './config';
import { extractJson } from './planner';

/**
 * Choosing the model that plans and orchestrates a task.
 * A cheap model (or a heuristic) looks at the task and recommends one of the available planners;
 * the human approves or picks another (Settings → plannerPick decides whether to ask).
 */

const SUB_QUOTA_TIGHT = 80; // % of a subscription window after which we prefer something else

export function plannerChoices(cfg: AppConfig, health: Record<string, Health> = cfg.health ?? {}): PlannerChoice[] {
  const out: PlannerChoice[] = [];
  const has = (id: string) => cfg.providers.some((p) => p.id === id);
  const light = (id: string) => health[id]?.light ?? 'gray';
  if (has('claude-sub')) {
    out.push({ id: 'claude-sub:opus', mode: 'claude-sub', model: 'opus', label: 'Claude Opus · подписка', hint: 'лучшее качество плана и ревью; быстрее всего тратит лимит подписки', light: light('claude-sub') });
    out.push({ id: 'claude-sub:sonnet', mode: 'claude-sub', model: 'sonnet', label: 'Claude Sonnet · подписка', hint: 'хорошо для обычных задач, лимит тратится в разы медленнее', light: light('claude-sub') });
  }
  if (has('codex-sub')) {
    const m = cfg.orchestrator.codexModel;
    out.push({ id: `codex-sub:${m}`, mode: 'codex-sub', model: m, label: `ChatGPT${m ? ' ' + m : ''} · подписка`, hint: 'второй лимит, когда Claude занят; оркестрация через Codex экспериментальная', light: light('codex-sub') });
  }
  if (anthropicKey(cfg) && !cfg.freeOnly) {
    const l = light('anthropic');
    out.push({ id: 'api:claude-opus-5', mode: 'api', model: 'claude-opus-5', label: 'Claude Opus · API', hint: '$5 / $25 за 1M токенов; без лимитов подписки', light: l });
    out.push({ id: 'api:claude-sonnet-5', mode: 'api', model: 'claude-sonnet-5', label: 'Claude Sonnet · API', hint: '$2 / $10 за 1M; дёшево для простых задач', light: l });
    out.push({ id: 'api:claude-fable-5-1', mode: 'api', model: 'claude-fable-5-1', label: 'Claude Fable · API', hint: '$10 / $50 за 1M; только для сложной архитектуры', light: l });
  }
  return out;
}

/** The choice that matches current Settings (used when plannerPick = 'settings'). */
export function settingsChoice(cfg: AppConfig): PlannerChoice {
  const mode = cfg.orchestrator.mode;
  const model = mode === 'api' ? cfg.anthropic.model : mode === 'claude-sub' ? cfg.orchestrator.claudeModel : cfg.orchestrator.codexModel;
  const found = plannerChoices(cfg).find((c) => c.mode === mode && c.model === model);
  return found ?? { id: `${mode}:${model}`, mode, model, label: `${mode} ${model || 'по умолчанию'}`, hint: 'из настроек', light: 'gray' };
}

/** Settings for one run with the chosen planner/orchestrator. */
export function applyChoice(cfg: AppConfig, c: PlannerChoice | undefined): AppConfig {
  if (!c) return cfg;
  const out: AppConfig = { ...cfg, orchestrator: { ...cfg.orchestrator, mode: c.mode }, anthropic: { ...cfg.anthropic } };
  if (c.mode === 'api') out.anthropic.model = c.model;
  else if (c.mode === 'claude-sub') out.orchestrator.claudeModel = c.model;
  else out.orchestrator.codexModel = c.model;
  return out;
}

const HIGH = /архитект|спроектир|с нуля|миграц|перепис|рефакторинг (всего|всей|проекта|модул)|безопасн|уязвим|распредел[её]нн|многопоточ|конкурентн|производительн|оптимизац|схем[уаы] (бд|базы|данных)|интеграц|микросервис|авториз|аутентиф|oauth|платеж|оплат|биллинг|security|architecture|migrat|rewrite|concurren|performance|payment/i;
const LOW = /опечат|typo|readme|документац|переименов|комментари|форматир|lint|линтер|bump|обнов\w* зависим|цвет|отступ|текст кнопки|надпис|changelog/i;

export function heuristicComplexity(goal: string): Triage['complexity'] {
  const g = goal.trim();
  if (g.length > 2500 || HIGH.test(g)) return 'high';
  if (g.length < 400 && LOW.test(g)) return 'low';
  return 'medium';
}

const PREFERENCE: Record<Triage['complexity'], string[]> = {
  high: ['claude-sub:opus', 'api:claude-opus-5', 'codex-sub', 'claude-sub:sonnet', 'api:claude-sonnet-5'],
  medium: ['claude-sub:sonnet', 'claude-sub:opus', 'codex-sub', 'api:claude-sonnet-5', 'api:claude-opus-5'],
  low: ['claude-sub:sonnet', 'codex-sub', 'api:claude-sonnet-5', 'claude-sub:opus', 'api:claude-opus-5'],
};

function usable(c: PlannerChoice) {
  return c.light !== 'red' && c.light !== 'yellow';
}

/** A subscription whose 5-hour or weekly window is nearly used up. */
function tight(cfg: AppConfig, c: PlannerChoice): boolean {
  const q = cfg.health?.[c.mode === 'api' ? 'anthropic' : c.mode]?.quotas ?? [];
  return q.some((x) => x.usedPercent >= SUB_QUOTA_TIGHT);
}

function pick(cfg: AppConfig, choices: PlannerChoice[], complexity: Triage['complexity']): PlannerChoice | undefined {
  const ok = choices.filter(usable);
  const ranked = PREFERENCE[complexity]
    .map((pref) => ok.find((c) => c.id === pref || (pref === 'codex-sub' && c.mode === 'codex-sub')))
    .filter((c): c is PlannerChoice => !!c);
  return ranked.find((c) => !tight(cfg, c)) ?? ranked[0] ?? ok[0] ?? choices[0];
}

const REASON: Record<Triage['complexity'], string> = {
  high: 'задача сложная (архитектура, безопасность, миграции или большой объём): план и ревью лучше доверить самой сильной модели',
  medium: 'обычная задача: хватит сильной, но экономной модели',
  low: 'простая задача: дорогая модель не нужна',
};

/** Cheapest green pay-per-token or plan worker, for the one short triage call. */
function cheapestJudge(cfg: AppConfig): ProviderConfig | undefined {
  return cfg.providers
    .filter((p) => (p.kind ?? 'api') === 'api' && !p.local && p.token && cfg.health?.[p.id]?.light === 'green' && !freeOnlyReason(cfg, p))
    .sort((a, b) => (a.billing === 'plan' ? -1 : 0) - (b.billing === 'plan' ? -1 : 0) || (a.priceIn ?? 9) - (b.priceIn ?? 9))[0];
}

async function askModel(p: ProviderConfig, goal: string, choices: PlannerChoice[], lang = 'Russian'): Promise<{ complexity: Triage['complexity']; recommended: string; reason: string }> {
  const list = choices.map((c) => `- ${c.id}: ${c.label} — ${c.hint}${usable(c) ? '' : ' (UNAVAILABLE)'}`).join('\n');
  const prompt = `You pick which model should plan and orchestrate a software task for a team of cheap coding workers.
Planning quality matters most for complex tasks (architecture, security, migrations, many files); for simple ones prefer the cheaper option to save subscription limits.
Options:
${list}

Task:
${goal.slice(0, 6000)}

Answer with ONLY JSON: {"complexity": "low"|"medium"|"high", "recommended": "<option id, not UNAVAILABLE>", "reason": "<one ${lang} sentence>"}`;
  const base = (p.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 45_000);
  try {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': p.token, authorization: `Bearer ${p.token}` },
      body: JSON.stringify({ model: p.smallModel || p.model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j: any = await r.json();
    const text = (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    return extractJson(text);
  } finally {
    clearTimeout(t);
  }
}

/** Recommend a planner for this goal. Never throws: falls back to the heuristic. */
export async function triage(cfg: AppConfig, goal: string): Promise<Triage> {
  const choices = plannerChoices(cfg);
  if (!choices.length) throw new Error('Нет ни одной модели для планирования: добавьте подписку Claude или ChatGPT, или ключ Claude API');
  const judge = cheapestJudge(cfg);
  if (judge) {
    try {
      const a = await askModel(judge, goal, choices, replyLang(cfg));
      const rec = choices.find((c) => c.id === a.recommended && usable(c)) ?? choices.find((c) => a.recommended?.startsWith(c.mode) && usable(c));
      const complexity = (['low', 'medium', 'high'] as const).includes(a.complexity) ? a.complexity : heuristicComplexity(goal);
      const chosen = rec && !tight(cfg, rec) ? rec : pick(cfg, choices, complexity);
      if (chosen) {
        const note = rec && chosen.id !== rec.id ? ` (вместо ${rec.label}: у неё почти исчерпан лимит)` : '';
        return { complexity, recommended: chosen.id, reason: String(a.reason || REASON[complexity]) + note, by: `${judge.label} (${judge.smallModel || judge.model})`, choices };
      }
    } catch {
      /* fall through to the heuristic */
    }
  }
  const complexity = heuristicComplexity(goal);
  const chosen = pick(cfg, choices, complexity)!;
  const note = tight(cfg, chosen) ? ' Внимание: у выбранной подписки почти исчерпан лимит.' : '';
  return { complexity, recommended: chosen.id, reason: REASON[complexity] + note, by: 'эвристика', choices };
}
