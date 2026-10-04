import Anthropic from '@anthropic-ai/sdk';
import { AppConfig, Plan, PlannedTask, ROLES } from './types';
import * as git from './git';
import { clip } from './worker';
import { canWork } from './catalog';
import { anthropicKey } from './config';
import { cliEnv } from './health';
import { memoryBriefing } from '../memory/prompt';
import { replyLang } from './lang';
import { freeOnlyReason } from './freetier';

export function describeWorkers(cfg: AppConfig): string {
  const billing = { api: 'pay per token', plan: 'flat-price coding plan (no extra $ per task)', subscription: 'subscription (shares limits with the orchestrator)' };
  const forced = cfg.forceProvider ? cfg.providers.find((p) => p.id === cfg.forceProvider) : undefined;
  const lines = cfg.providers
    .filter((p) => p.enabled && canWork(p))
    .map((p) => {
      const roles = p.roles?.length ? p.roles.join(', ') : 'any';
      const h = cfg.health?.[p.id];
      const paid = freeOnlyReason(cfg, p);
      const status = paid ? ` UNAVAILABLE (${paid}) — do not delegate to it.` : h && (h.light === 'red' || h.light === 'yellow') ? ` UNAVAILABLE (${h.text}) — do not delegate to it.` : '';
      const skipped = forced && p.id !== forced.id ? ' (не будет использован: включён принудительный маршрут)' : '';
      return `- id="${p.id}" (${p.label}, model ${p.model || 'default'}, ${billing[p.billing ?? 'api']}) roles: [${roles}]. ${p.notes}${status}${skipped}`;
    });
  if (forced) lines.push(`ВСЕ задачи принудительно идут к ${forced.id} (${forced.label}), роли не проверяются.`);
  return lines.join('\n');
}

export function describeRoles(): string {
  return ROLES.map((r) => `- ${r.id}: ${r.hint}`).join('\n');
}

/**
 * One-shot planning call: Claude reads the goal + file tree and proposes tasks with a role and a worker each.
 * The user can edit the plan before the run; the orchestrator receives it as a strong recommendation.
 */
export async function makePlan(cfg: AppConfig, repo: string, goal: string): Promise<Plan> {
  if (!(await git.isRepo(repo))) throw new Error('Выбранная папка не является git-репозиторием');
  const tree = clip(await git.listFiles(repo), 8000);
  if (cfg.orchestrator.mode !== 'api') return normalizePlan(cfg, await planViaCli(cfg, repo, goal, tree));
  const client = new Anthropic({ apiKey: anthropicKey(cfg) });

  const tool: Anthropic.Tool = {
    name: 'propose_plan',
    description: 'Propose a task plan.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: `Short ${replyLang(cfg)} summary of the approach (2-4 sentences).` },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'p1, p2, …' },
              title: { type: 'string', description: `Short ${replyLang(cfg)} title` },
              role: { type: 'string', enum: ROLES.map((r) => r.id) },
              providerId: { type: 'string', description: 'worker id from the list' },
              spec: {
                type: 'string',
                description:
                  `Full brief for the worker in ${replyLang(cfg)}: context, exact files, required behavior, acceptance criteria, test command, what not to touch.`,
              },
              dependsOn: { type: 'array', items: { type: 'string' }, description: 'ids of tasks that must be merged first' },
              reason: { type: 'string', description: `One ${replyLang(cfg)} sentence: why this worker/role.` },
            },
            required: ['id', 'title', 'role', 'providerId', 'spec', 'dependsOn', 'reason'],
          },
        },
      },
      required: ['summary', 'tasks'],
    },
  };

  const system = plannerSystem(cfg, tree);
  const res = await client.messages.create({
    model: cfg.anthropic.model,
    max_tokens: cfg.anthropic.maxTokens,
    system,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'propose_plan' },
    messages: [{ role: 'user', content: `Goal:\n${goal}${memoryBriefing(repo, goal, 'planner')}` }],
  });
  const tu = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!tu) throw new Error('Планировщик не вернул план');
  return normalizePlan(cfg, tu.input as Plan);
}

function plannerSystem(cfg: AppConfig, tree: string): string {
  return `You are a lead engineer planning work for a team of AI coding workers.
Split the goal into small, independent, well-specified tasks and assign each to the cheapest worker whose roles fit.
Rules:
- Respect worker roles: a task of role X may only go to a worker whose roles include X (or a worker with no role restriction).
- Tasks touching the same files must be serialized via dependsOn; otherwise keep them independent so they run in parallel.
- Briefs must be self-contained: the worker sees only the repository and the brief.
- Prefer 2-6 tasks. Do not invent files that don't exist; use the tree.
- Write titles, specs, reasons and summary in ${replyLang(cfg)}.

Roles:
${describeRoles()}

Workers:
${describeWorkers(cfg)}

Repository files (truncated):
${tree}
${cfg.orchestratorPreamble ? '\nProject-specific instructions:\n' + cfg.orchestratorPreamble : ''}`;
}

function normalizePlan(cfg: AppConfig, plan: Plan): Plan {
  const enabled = new Set(cfg.providers.filter((p) => p.enabled && canWork(p)).map((p) => p.id));
  plan.tasks = (plan.tasks ?? []).map((t: PlannedTask, i) => ({
    ...t,
    id: t.id || `p${i + 1}`,
    dependsOn: t.dependsOn ?? [],
    providerId: enabled.has(t.providerId) ? t.providerId : [...enabled][0],
  }));
  plan.summary ??= '';
  return plan;
}

/** Take the first {...} JSON object out of a model's text answer. */
export function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const a = src.indexOf('{');
  const b = src.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('в ответе нет JSON');
  return JSON.parse(src.slice(a, b + 1));
}

/** Planning on the subscription: one read-only run of Claude Code or Codex that answers with the plan as JSON. */
async function planViaCli(cfg: AppConfig, repo: string, goal: string, tree: string): Promise<Plan> {
  const prompt = `${plannerSystem(cfg, tree)}

You may read files in the repository to plan precisely, but do not change anything.
Answer with ONLY a JSON object, no prose:
{"summary": "<${replyLang(cfg)}, 2-4 sentences>", "tasks": [{"id": "p1", "title": "<${replyLang(cfg)}>", "role": "<one of: ${ROLES.map((r) => r.id).join(', ')}>", "providerId": "<worker id>", "spec": "<full ${replyLang(cfg)} brief>", "dependsOn": [], "reason": "<one ${replyLang(cfg)} sentence>"}]}

Goal:
${goal}${memoryBriefing(repo, goal, 'planner')}`;
  let text: string;
  if (cfg.orchestrator.mode === 'codex-sub') {
    const r = await git.run(cfg.orchestrator.codexPath || 'codex', ['exec', '--json', '-C', repo, '--sandbox', 'read-only', ...(cfg.orchestrator.codexModel ? ['-m', cfg.orchestrator.codexModel] : []), prompt], repo, { timeoutMs: 900_000, env: cliEnv() });
    const msgs = r.stdout
      .split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e?.type === 'item.completed' && ['agent_message', 'assistant_message'].includes(e.item?.type ?? e.item?.item_type))
      .map((e) => e.item.text as string);
    text = msgs[msgs.length - 1] ?? '';
    if (!text) throw new Error(`Codex не вернул план: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  } else {
    const args = ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Read,Grep,Glob'];
    if (cfg.orchestrator.claudeModel) args.push('--model', cfg.orchestrator.claudeModel);
    const r = await git.run(cfg.claudePath, args, repo, { timeoutMs: 900_000, env: cliEnv() });
    let out: any;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      throw new Error(`Claude Code не вернул план: ${(r.stderr || r.stdout).trim().slice(-300)}`);
    }
    if (out.is_error) throw new Error(`Claude Code: ${out.result ?? 'ошибка'}`);
    text = String(out.result ?? '');
  }
  try {
    return extractJson(text) as Plan;
  } catch (e: any) {
    throw new Error(`Не удалось разобрать план (${e.message}): ${text.slice(0, 300)}`);
  }
}

export function planToMessage(plan: Plan): string {
  const lines = plan.tasks.map(
    (t) =>
      `${t.id}. [${t.role}] "${t.title}" → worker "${t.providerId}"${t.dependsOn.length ? ` (after ${t.dependsOn.join(', ')})` : ''}\n   Why: ${t.reason}\n   Brief:\n${t.spec
        .split('\n')
        .map((l) => '   ' + l)
        .join('\n')}`,
  );
  return `The human approved this plan. Follow it: delegate these tasks with these workers and roles, respecting the dependencies (merge a task before starting the ones that depend on it). You may still split a task further, reassign after a failure, or add a fix task, but explain why in your text.\n\nSummary: ${plan.summary}\n\n${lines.join('\n\n')}`;
}
