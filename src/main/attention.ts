import type { Health, ProviderConfig, WorkerTask } from './types';

/**
 * «Требует вас»: everything that waits for the owner, collected in one list (the block at the top of the panel).
 * A pure function over plain data: no I/O, no clock. The alerts (alerts.ts) are not touched: they stay a journal of events,
 * this is the current state of what is still open. Text is Russian: it is shown to the owner as is.
 */

export type AttentionKind = 'question' | 'decision' | 'unmerged' | 'capped' | 'connection' | 'spend';

export interface AttentionItem {
  kind: AttentionKind;
  /** Red = stuck until the owner acts, yellow = will be a problem if left. */
  level: 'error' | 'warn';
  /** What happened, one short sentence. */
  what: string;
  /** Which task or connection (with the run for a task). */
  who: string;
  /** What to do. */
  hint: string;
  runId?: string;
  taskId?: string;
}

export interface AttentionRun {
  runId: string;
  tasks: WorkerTask[];
  /** Run budget in dollars; 0 = none. */
  budgetUsd: number;
  spentTotal: number;
  spentByProvider: Record<string, number>;
}

export interface AttentionInput {
  runs: AttentionRun[];
  providers: ProviderConfig[];
  health: Record<string, Health>;
  /** Provider id → end of its 429 pause (ms), only paused ones. */
  pausedUntil: Record<string, number>;
  /** notify.unmergedWarnMinutes; 0 = off. */
  unmergedWarnMinutes: number;
  now: number;
}

/** Most urgent first: a question and a decision block work, the rest can wait a little. */
const ORDER: AttentionKind[] = ['question', 'decision', 'unmerged', 'capped', 'connection', 'spend'];
const SPEND_WARN = 0.9;
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16) + ' UTC';
const money = (n: number) => `$${n.toFixed(2)}`;

export function collectAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const { now } = input;

  for (const run of input.runs) {
    const closed = (t: WorkerTask) => run.tasks.some((x) => x.continuedFrom === t.id || x.id === t.retriedAs);
    for (const t of run.tasks) {
      if (t.status === 'merged' || t.status === 'discarded' || t.status === 'cancelled') continue;
      const who = `${t.title} (${t.id}, ${t.providerId}, запуск ${run.runId})`;
      const at = { runId: run.runId, taskId: t.id };
      if (t.needsAnswer && t.status === 'done') {
        if (closed(t)) continue;
        items.push({ kind: 'question', level: 'error', what: `Воркер остановился и спрашивает: ${t.needsAnswer}`, who, hint: `ответить воркеру: delegate с continue_from=${t.id} и ответом в брифе`, ...at });
      } else if (t.capped) {
        if (closed(t)) continue;
        items.push({ kind: 'capped', level: 'warn', what: `Задача остановлена по лимиту стоимости (${money(t.costUsd ?? 0)}), частичный результат сохранён`, who, hint: `продолжить с continue_from=${t.id} или слить то, что есть`, ...at });
      } else if (t.escalated && (t.status === 'failed' || t.status === 'timeout')) {
        if (closed(t)) continue;
        items.push({ kind: 'decision', level: 'error', what: 'Задача не выполнена после автоповторов, нужно ваше решение', who, hint: 'выбрать: другой исполнитель, упростить бриф, сделать самому или отложить', ...at });
      } else if (t.status === 'done' && !closed(t) && input.unmergedWarnMinutes > 0 && t.finishedAt && now - t.finishedAt > input.unmergedWarnMinutes * 60_000) {
        const mins = Math.round((now - t.finishedAt) / 60_000);
        items.push({ kind: 'unmerged', level: 'warn', what: `Готово ${mins} мин назад, но не слито`, who, hint: 'слить (merge) или отбросить (discard)', ...at });
      }
    }

    const ratio = run.budgetUsd > 0 ? run.spentTotal / run.budgetUsd : 0;
    if (ratio >= SPEND_WARN)
      items.push({ kind: 'spend', level: ratio >= 1 ? 'error' : 'warn', what: ratio >= 1 ? `Бюджет запуска исчерпан: ${money(run.spentTotal)} из $${run.budgetUsd}` : `Запуск израсходовал ${Math.floor(ratio * 100)}% бюджета: ${money(run.spentTotal)} из $${run.budgetUsd}`, who: `запуск ${run.runId}`, hint: 'поднять бюджет запуска в настройках или остановить запуск', runId: run.runId });
    for (const p of input.providers) {
      const cap = p.maxUsdPerRun ?? 0;
      const used = run.spentByProvider[p.id] ?? 0;
      if (cap > 0 && used >= cap * SPEND_WARN)
        items.push({ kind: 'spend', level: used >= cap ? 'error' : 'warn', what: used >= cap ? `Лимит исполнителя достигнут: ${money(used)} из $${cap}` : `Исполнитель израсходовал ${Math.floor((used / cap) * 100)}% лимита: ${money(used)} из $${cap}`, who: `${p.label} (запуск ${run.runId})`, hint: 'пополнить баланс или поднять лимит исполнителя в настройках', runId: run.runId });
    }
  }

  for (const p of input.providers) {
    if (!p.enabled) continue;
    const until = input.pausedUntil[p.id] ?? 0;
    const h = input.health[p.id];
    if (until > now) items.push({ kind: 'connection', level: 'warn', what: `Лимит запросов у провайдера, подключение на паузе до ${clock(until)}`, who: p.label, hint: 'подождать конца паузы или подключить другого исполнителя' });
    else if (h?.light === 'red') items.push({ kind: 'connection', level: 'error', what: `Подключение не работает: ${h.text}`, who: p.label, hint: 'проверить ключ и баланс в настройках' });
    else if (h?.light === 'yellow') items.push({ kind: 'connection', level: 'warn', what: `Есть проблема с подключением: ${h.text}`, who: p.label, hint: 'пополнить баланс или дождаться сброса лимита' });
  }

  return items.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}
