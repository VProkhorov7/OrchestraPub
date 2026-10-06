/**
 * «Требует вас»: collectAttention gives every kind of what waits for the owner (question, decision, unmerged, capped,
 * connection, spend), nothing when all is well, the urgent first, and unmergedWarnMinutes=0 turns «unmerged» off.
 * Run: as a step of `npm run smoke`.
 */
import { collectAttention, AttentionInput, AttentionKind } from '../main/attention';
import { check } from './helpers';

const NOW = 10_000_000_000;
const task = (id: string, extra: any = {}) => ({ id, title: `Task ${id}`, providerId: 'glm', status: 'done', log: [], ...extra });
const prov = (id: string, extra: any = {}) => ({ id, label: id.toUpperCase(), enabled: true, ...extra });
const input = (tasks: any[], extra: Partial<AttentionInput> = {}, budget = 0, spent = 0, byProvider: Record<string, number> = {}, live = true): AttentionInput => ({
  runs: [{ runId: 'r1', tasks, budgetUsd: budget, spentTotal: spent, spentByProvider: byProvider, live }],
  providers: [prov('glm') as any],
  health: {},
  pausedUntil: {},
  unmergedWarnMinutes: 60,
  now: NOW,
  ...extra,
});
const kinds = (i: AttentionInput) => collectAttention(i).map((a) => a.kind);
const old = NOW - 61 * 60_000;

// empty
check(collectAttention(input([])).length === 0, 'nothing waits: an empty list');
check(collectAttention(input([task('t01', { status: 'merged' }), task('t02', { status: 'running' }), task('t03', { finishedAt: NOW - 5 * 60_000 })], { health: { glm: { light: 'green', text: 'ok', checkedAt: NOW } } })).length === 0, 'merged, running, fresh-done tasks and a green light are not reported');

// 1 question
let r = collectAttention(input([task('t01', { needsAnswer: 'which port?' })]));
check(r.length === 1 && r[0].kind === 'question' && /which port\?/.test(r[0].what) && /Task t01/.test(r[0].who) && /continue_from=t01/.test(r[0].hint), `question: ${JSON.stringify(r)}`);
check(kinds(input([task('t01', { needsAnswer: 'q' }), task('t02', { continuedFrom: 't01', status: 'running' })])).length === 0, 'an answered question (continued) is not reported');

// 2 decision
r = collectAttention(input([task('t01', { status: 'failed', escalated: true })]));
check(r.length === 1 && r[0].kind === 'decision' && r[0].level === 'error', `decision: ${JSON.stringify(r)}`);

// 3 unmerged, and the switch-off
r = collectAttention(input([task('t01', { finishedAt: old })]));
check(r.length === 1 && r[0].kind === 'unmerged' && /слить/.test(r[0].hint), `unmerged: ${JSON.stringify(r)}`);
check(kinds(input([task('t01', { finishedAt: old })], { unmergedWarnMinutes: 0 })).length === 0, 'unmergedWarnMinutes=0 skips the unmerged item');
check(kinds(input([task('t01', { finishedAt: old }), task('t02', { continuedFrom: 't01', status: 'running' })])).length === 0, 'a done task that was continued is not reported as unmerged');
check(kinds(input([task('t01', { status: 'cancelled', capped: true })])).length === 0, 'a cancelled task is not reported');
check(kinds(input([task('t01', { finishedAt: old, needsAnswer: 'q' })])).join() === 'question', 'a done task with a question is one item, not two');

// 4 capped
r = collectAttention(input([task('t01', { status: 'failed', capped: true, costUsd: 1.5 })]));
check(r.length === 1 && r[0].kind === 'capped' && /continue_from=t01/.test(r[0].hint), `capped: ${JSON.stringify(r)}`);
check(kinds(input([task('t01', { status: 'failed', capped: true }), task('t02', { continuedFrom: 't01', status: 'running' })])).length === 0, 'a continued capped task is not reported');
check(kinds(input([task('t01', { status: 'discarded', capped: true })])).length === 0, 'a discarded capped task is not reported');

// 5 connections: paused, red, yellow; disabled ones are skipped
const provs = [prov('a'), prov('b'), prov('c'), prov('d', { enabled: false })] as any[];
r = collectAttention(input([], { providers: provs, pausedUntil: { a: NOW + 600_000 }, health: { b: { light: 'red', text: 'нет ключа', checkedAt: NOW }, c: { light: 'yellow', text: 'мало денег', checkedAt: NOW }, d: { light: 'red', text: 'x', checkedAt: NOW } } }));
check(r.length === 3 && r.every((x) => x.kind === 'connection') && r.map((x) => x.who).join() === 'A,B,C', `connections: ${JSON.stringify(r)}`);
check(/пауз/.test(r[0].what), 'the 429 pause says so');

// 6 spend: run budget and provider cap, 90% and over; below 90% nothing
check(kinds(input([], {}, 10, 9)).join() === 'spend', 'run budget at 90%');
check(kinds(input([], {}, 10, 8.9)).length === 0, 'run budget below 90% is quiet');
r = collectAttention(input([], { providers: [prov('glm', { maxUsdPerRun: 5 }) as any] }, 0, 4.6, { glm: 4.6 }));
check(r.length === 1 && r[0].kind === 'spend' && /GLM/.test(r[0].who), `provider cap at 92%: ${JSON.stringify(r)}`);

// finished runs (live=false): task items stay, spend items go
const dead = (tasks: any[], budget = 0, spent = 0, byProvider: Record<string, number> = {}, extra: Partial<AttentionInput> = {}) => input(tasks, extra, budget, spent, byProvider, false);
check(kinds(dead([task('t01', { finishedAt: old })])).join() === 'unmerged', 'a finished run still reports an unmerged task');
check(kinds(dead([task('t01', { finishedAt: old })], 10, 9.5)).join() === 'unmerged', 'a finished run at 95% of budget: no spend item');
check(kinds(dead([], 10, 9.5, { glm: 9.5 }, { providers: [prov('glm', { maxUsdPerRun: 5 }) as any] })).length === 0, 'a finished run over the provider cap: no spend item');
check(kinds(input([task('t01', { finishedAt: old })], {}, 10, 9.5)).join() === 'unmerged,spend', 'a live run at 95% of budget: spend item');
check(kinds(input([task('t01', { status: 'failed', escalated: true, retriedAs: 't02' }), task('t02', { status: 'running' })])).length === 0, 'a task whose retry exists is closed');
check(kinds(input([task('t01', { status: 'failed', escalated: true, retriedAs: 't09' })])).join() === 'decision', 'a retriedAs that points nowhere does not close the task');

// ordering: urgent first whatever the input order
const all = input(
  [task('t01', { finishedAt: old }), task('t02', { status: 'failed', capped: true }), task('t03', { status: 'failed', escalated: true }), task('t04', { needsAnswer: 'q' })],
  { pausedUntil: { glm: NOW + 1000 } },
  10,
  10,
);
const order: AttentionKind[] = ['question', 'decision', 'unmerged', 'capped', 'connection', 'spend'];
check(kinds(all).join() === order.join(), `order: ${kinds(all).join()}`);
console.log('SMOKE-ATTENTION OK');
