#!/usr/bin/env node
// Снимок статистики для разбора: все задачи всех запусков в tasks.csv, сводка по провайдерам в summary.json,
// копия serve.log по дням. Идемпотентно: можно запускать сколько угодно раз. Токены не тратит.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const home = process.env.ORCHESTRA_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'Orchestra');
const out = path.join(home, 'stats');
fs.mkdirSync(out, { recursive: true });

const rows = [];
const runsDir = path.join(home, 'runs');
for (const d of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(runsDir, d, 'run.json'), 'utf8')).state; } catch { continue; }
  for (const t of s.tasks ?? []) {
    rows.push({
      run: s.runId, repo: path.basename(s.repo ?? ''), run_status: s.status, task: t.id, title: t.title, provider: t.providerId, model: t.model,
      status: t.status, started: t.startedAt ? new Date(t.startedAt).toISOString() : '', minutes: t.startedAt && t.finishedAt ? ((t.finishedAt - t.startedAt) / 60000).toFixed(1) : '',
      cost_usd: (t.costUsd ?? 0).toFixed(4), estimated: t.costEstimated ? 1 : 0, api_equiv_usd: (t.apiEquivUsd ?? 0).toFixed(4),
      tokens_in: t.tokensIn ?? 0, tokens_out: t.tokensOut ?? 0, error: (t.error ?? '').replace(/\s+/g, ' ').slice(0, 120),
    });
  }
}
rows.sort((a, b) => a.started.localeCompare(b.started));
const cols = rows[0] ? Object.keys(rows[0]) : [];
const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => `"${String(r[c]).replace(/"/g, '""')}"`).join(','))].join('\n');
fs.writeFileSync(path.join(out, 'tasks.csv'), csv + '\n');

const byProvider = {};
for (const r of rows) {
  const p = (byProvider[r.provider] ??= { tasks: 0, cost_usd: 0, tokens_in: 0, tokens_out: 0, failed: 0, merged: 0, discarded: 0, estimated: 0 });
  p.tasks++; p.cost_usd += +r.cost_usd; p.tokens_in += r.tokens_in; p.tokens_out += r.tokens_out; p.estimated += r.estimated;
  if (r.status === 'failed' || r.status === 'timeout') p.failed++;
  if (r.status === 'merged') p.merged++;
  if (r.status === 'discarded') p.discarded++;
}
for (const p of Object.values(byProvider)) p.cost_usd = +p.cost_usd.toFixed(4);
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), tasks: rows.length, total_usd: +Object.values(byProvider).reduce((a, p) => a + p.cost_usd, 0).toFixed(4), byProvider }, null, 2));

const log = path.join(home, 'logs', 'serve.log');
if (fs.existsSync(log)) fs.copyFileSync(log, path.join(out, `serve-${new Date().toISOString().slice(0, 10)}.log`));
console.log(`stats: ${rows.length} задач → ${out}`);
