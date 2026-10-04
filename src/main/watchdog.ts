import * as fs from 'fs';
import { Alerts } from './alerts';
import { pick } from '../memory/lang';
import type { TaskEngine } from './engine';
import type { AppConfig, Light } from './types';
import type { HubEvent } from './hub';

/**
 * The watchdogs inside the service. Every 30 seconds they look at what is running; they also react to events.
 * What they report (as alerts, see alerts.ts):
 *   a worker that shows no activity for a while · a working task whose folder (worktree) has disappeared ·
 *   a run close to or at its budget, a worker close to or at its spend cap · a task that failed or timed out ·
 *   a connection that turned red or yellow (and when it recovers) · a run that failed, stopped or was interrupted.
 * The external watchdog (orchestra-ctl watch) covers what this one cannot: the service itself not answering.
 */

export interface WatchHost {
  liveEngines(): TaskEngine[];
}

const SILENT_DEFAULT_MIN = 8;
/** One task that has already cost this much while still running is worth a look (cfg.notify.taskCostWarnUsd). */
const TASK_COST_WARN_USD = 1;
/** The worker's last words are a question or a request for permission: it stopped and waits for a human. */
const WAITING = /\?\s*$|нужн\w+ (ваш|разрешени)|жду (ваш|разрешени|ответ|ok)|\bneed your\b|\bpermission\b|\bapprove\b|\bconfirm\b|разрешени/i;

export class Watchdog {
  private act = new Map<string, { sig: string; at: number }>();
  private taskStatus = new Map<string, string>();
  private light = new Map<string, Light | string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private host: WatchHost,
    private alerts: Alerts,
    private cfg: () => AppConfig,
    private now: () => number = Date.now,
  ) {}

  start(everyMs = 30_000) {
    this.stop();
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        /* the watchdog must not take the service down */
      }
    }, everyMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick() {
    const cfg = this.cfg();
    const L = cfg.language;
    const silentMs = (cfg.notify?.silentMinutes ?? SILENT_DEFAULT_MIN) * 60_000;
    const t = this.now();
    const seen = new Set<string>();
    for (const e of this.host.liveEngines()) {
      const s = e.state;
      for (const task of s.tasks) {
        const k = `${s.runId}:${task.id}`;
        if (task.status !== 'running') continue;
        seen.add(k);
        const sig = `${task.log.length}|${task.tokensIn ?? 0}|${task.tokensOut ?? 0}|${task.costUsd ?? 0}`;
        const prev = this.act.get(k);
        if (!prev || prev.sig !== sig) {
          this.act.set(k, { sig, at: t });
          this.alerts.clear(`silent:${k}`, pick(L, `Воркер ${task.id} снова работает`, `Worker ${task.id} is active again`), `${task.title} (${task.providerId})`);
        } else if (t - prev.at > silentMs) {
          const mins = Math.round((t - prev.at) / 60_000);
          const last = (task.log[task.log.length - 1] ?? '').slice(0, 140);
          this.alerts.raise({
            key: `silent:${k}`,
            level: 'warn',
            runId: s.runId,
            title: pick(L, `Воркер ${task.id} (${task.providerId}) молчит ${mins} мин`, `Worker ${task.id} (${task.providerId}) silent for ${mins} min`),
            text: pick(
              L,
              `${task.title}. Последняя строка: ${last || 'нет'}. Возможно, провайдер завис: задачу можно отбросить и поручить другому исполнителю.`,
              `${task.title}. Last line: ${last || 'none'}. The provider may be stuck: the task can be discarded and given to another worker.`,
            ),
          });
        }
        const warnUsd = cfg.notify?.taskCostWarnUsd ?? TASK_COST_WARN_USD;
        if (warnUsd > 0 && (task.costUsd ?? 0) >= warnUsd)
          this.alerts.raise(
            {
              key: `taskcost:${k}`,
              level: 'warn',
              runId: s.runId,
              title: pick(L, `Задача ${task.id} (${task.providerId}) уже стоит $${(task.costUsd ?? 0).toFixed(2)}`, `Task ${task.id} (${task.providerId}) has cost $${(task.costUsd ?? 0).toFixed(2)} already`),
              text: `${task.title}. ` + pick(L, 'Она ещё идёт. Если это не ожидаемо, отбросьте её, пока не потрачено больше.', 'It is still running. If this is unexpected, discard it before more is spent.'),
            },
            24 * 60 * 60_000,
          );
        if (!fs.existsSync(task.worktree)) {
          this.alerts.raise({
            key: `worktree:${k}`,
            level: 'error',
            runId: s.runId,
            title: pick(L, `У задачи ${task.id} пропала рабочая папка`, `Task ${task.id} lost its working folder`),
            text: pick(
              L,
              `${task.worktree} не существует, а воркер ещё работает: его правки пропадут. Часто так бывает, если задачу отбросили, пока она шла.`,
              `${task.worktree} does not exist while the worker is still running: its changes will be lost. This often happens when the task was discarded while running.`,
            ),
          });
        }
      }
      this.checkBudgets(e, L);
    }
    for (const k of [...this.act.keys()]) if (!seen.has(k)) this.act.delete(k);
  }

  private checkBudgets(e: TaskEngine, L: AppConfig['language']) {
    const s = e.state;
    const b = e.budget();
    const spent = e.spent();
    if (b > 0) {
      const r = spent.total / b;
      if (r >= 1)
        this.alerts.raise({ key: `budget:${s.runId}:full`, level: 'error', runId: s.runId, title: pick(L, 'Бюджет запуска исчерпан', 'The run budget is used up'), text: pick(L, `$${spent.total.toFixed(2)} из $${b}. Новые задачи не начинаются.`, `$${spent.total.toFixed(2)} of $${b}. No new tasks start.`) }, 60 * 60_000);
      else if (r >= 0.8)
        this.alerts.raise({ key: `budget:${s.runId}:80`, level: 'warn', runId: s.runId, title: pick(L, 'Запуск израсходовал 80% бюджета', 'The run has used 80% of its budget'), text: `$${spent.total.toFixed(2)} / $${b}` }, 60 * 60_000);
    }
    for (const p of e.cfg.providers) {
      const cap = p.maxUsdPerRun ?? 0;
      const used = spent.byProvider[p.id] ?? 0;
      if (cap <= 0 || used < cap * 0.9) continue;
      this.alerts.raise(
        {
          key: `cap:${s.runId}:${p.id}:${used >= cap ? 'full' : '90'}`,
          level: used >= cap ? 'error' : 'warn',
          runId: s.runId,
          title: used >= cap ? pick(L, `Лимит исполнителя ${p.id} достигнут`, `Spend cap of ${p.id} reached`) : pick(L, `${p.id}: израсходовано 90% лимита`, `${p.id}: 90% of the spend cap used`),
          text: `$${used.toFixed(2)} / $${cap}`,
        },
        60 * 60_000,
      );
    }
  }

  /** Event-driven checks: task transitions, connection lights, run endings. */
  onEvent(ev: HubEvent) {
    const cfg = this.cfg();
    const L = cfg.language;
    if (ev.type === 'task' && ev.runId) {
      const k = `${ev.runId}:${ev.task.id}`;
      const prev = this.taskStatus.get(k);
      this.taskStatus.set(k, ev.task.status);
      const retries = cfg.autoRetry ?? 3;
      const willRetry = retries > 0 && (ev.task.attempt ?? 1) <= retries && !/превышен лимит|исчерпан бюджет/.test(ev.task.error ?? '');
      if (ev.task.escalated && !this.alerts.isActive(`ask:${ev.task.jobId ?? k}`)) {
        this.alerts.raise({
          key: `ask:${ev.task.jobId ?? k}`,
          level: 'error',
          runId: ev.runId,
          title: pick(L, `Нужно ваше решение: «${ev.task.title}» не выполняется`, `Your decision is needed: «${ev.task.title}» does not work`),
          text: ev.task.question ?? '',
        });
      } else if (prev !== ev.task.status && ev.task.status === 'done' && WAITING.test((ev.task.log[ev.task.log.length - 1] ?? '').trim())) {
        this.alerts.raise({
          key: `waiting:${k}`,
          level: 'error',
          runId: ev.runId,
          title: pick(L, `Воркер ${ev.task.id} (${ev.task.providerId}) остановился и ждёт ответа`, `Worker ${ev.task.id} (${ev.task.providerId}) stopped and is waiting for an answer`),
          text: `${ev.task.title}. ` + (ev.task.log[ev.task.log.length - 1] ?? '').slice(0, 300),
        });
      } else if (prev !== ev.task.status && (ev.task.status === 'failed' || ev.task.status === 'timeout')) {
        this.alerts.raise({
          key: `task:${k}`,
          level: willRetry ? 'warn' : 'error',
          runId: ev.runId,
          title: pick(L, `Задача ${ev.task.id} (${ev.task.providerId}): ${ev.task.status === 'timeout' ? 'таймаут' : 'ошибка'}`, `Task ${ev.task.id} (${ev.task.providerId}): ${ev.task.status === 'timeout' ? 'timeout' : 'error'}`),
          text: `${ev.task.title}. ${(ev.task.error ?? '').slice(0, 200)}${willRetry ? pick(L, ' Перезапускается автоматически.', ' Restarting automatically.') : ''}`,
        });
      }
    } else if (ev.type === 'health') {
      for (const p of cfg.providers) {
        const h = ev.health[p.id];
        if (!h) continue;
        const prev = this.light.get(p.id);
        this.light.set(p.id, h.light);
        if (prev === h.light || !p.enabled) continue;
        if (h.light === 'red' || h.light === 'yellow') {
          if (prev === undefined && h.light === 'yellow' && /лимит|limit/i.test(h.text)) continue; // a subscription near its window end is normal, not an incident
          this.alerts.raise(
            { key: `health:${p.id}`, level: h.light === 'red' ? 'error' : 'warn', title: pick(L, `Подключение «${p.label}»: ${h.light === 'red' ? 'не работает' : 'есть проблема'}`, `Connection «${p.label}»: ${h.light === 'red' ? 'down' : 'has a problem'}`), text: h.text },
            30 * 60_000,
          );
        } else if (h.light === 'green' && (prev === 'red' || prev === 'yellow')) {
          this.alerts.clear(`health:${p.id}`, pick(L, `Подключение «${p.label}» снова работает`, `Connection «${p.label}» works again`), h.text);
        }
      }
    } else if (ev.type === 'state' && ev.runId && ['failed', 'stopped', 'interrupted'].includes(ev.state.status)) {
      const st = ev.state.status as 'failed' | 'stopped' | 'interrupted';
      this.alerts.raise({
        key: `run:${ev.runId}:${st}`,
        level: st === 'failed' ? 'error' : 'warn',
        runId: ev.runId,
        title: pick(L, `Запуск ${ev.runId}: ${{ failed: 'ошибка', stopped: 'остановлен по бюджету', interrupted: 'прерван' }[st]}`, `Run ${ev.runId}: ${{ failed: 'failed', stopped: 'stopped by the budget', interrupted: 'interrupted' }[st]}`),
        text: (ev.state.stopReason ?? ev.state.goal ?? '').slice(0, 200),
      });
    }
  }
}
