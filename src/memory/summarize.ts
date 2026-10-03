import { AppConfig, ProviderConfig } from '../main/types';
import { extractJson } from '../main/planner';
import { ProjectMemory } from './store';

/**
 * Owner-facing summaries of the machine log, written by the cheapest working model
 * (a coding plan first, then the cheapest pay-per-token API). Without one, a mechanical digest.
 */
function cheapest(cfg: AppConfig): ProviderConfig | undefined {
  return cfg.providers
    .filter((p) => (p.kind ?? 'api') === 'api' && p.token && (cfg.health?.[p.id]?.light ?? 'green') === 'green')
    .sort((a, b) => (a.billing === 'plan' ? -1 : 0) - (b.billing === 'plan' ? -1 : 0) || (a.priceIn ?? 9) - (b.priceIn ?? 9))[0];
}

async function ask(p: ProviderConfig, prompt: string, maxTokens = 1500): Promise<string> {
  const base = (p.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 90_000);
  try {
    const r = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': p.token, authorization: `Bearer ${p.token}` },
      body: JSON.stringify({ model: p.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j: any = await r.json();
    return (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  } finally {
    clearTimeout(t);
  }
}

/** «Дай свежую выжимку»: a short Russian summary of the latest log records. */
export async function freshDigest(cfg: AppConfig, repo: string, limit = 80): Promise<{ text: string; by: string }> {
  const m = new ProjectMemory(repo);
  const raw = m.digest({ limit });
  const judge = cheapest(cfg);
  if (!judge || raw.startsWith('В логе нет')) return { text: raw, by: 'лог без обработки' };
  try {
    const text = await ask(
      judge,
      `Ниже подробный лог работы над проектом «${m.config().project}» (для ИИ). Сделай для владельца короткую понятную выжимку по-русски: что сделано, что решено и почему, что осталось или дальше. 5–12 пунктов, без мелких технических деталей (правки отдельных файлов, служебные команды), без выдумок.${cfg.language === 'en' ? ' Write the answer in English.' : ''}\n\n${raw}`,
    );
    return { text, by: `${judge.label} (${judge.model})` };
  } catch {
    return { text: raw, by: 'лог без обработки (модель не ответила)' };
  }
}

/** End of a stage: turn significant log events into Keep a Changelog sections and write them to CHANGELOG.md. */
export async function stageChangelog(cfg: AppConfig, repo: string, release?: string): Promise<{ sections: Record<string, string[]>; by: string }> {
  const m = new ProjectMemory(repo);
  const cand = m.changelogCandidates();
  const flat = Object.entries(cand)
    .map(([sec, evs]) => `${sec}:\n` + evs.map((e) => `- ${e.description}`).join('\n'))
    .join('\n\n');
  let sections: Record<string, string[]> = {};
  let by = 'из лога без обработки';
  const judge = cheapest(cfg);
  if (flat && judge) {
    try {
      const text = await ask(
        judge,
        `Сделай запись для CHANGELOG.md по-русски из событий ниже. Только основные изменения, понятные человеку; мелкие технические детали и служебные записи убери; похожие пункты объедини. Ответ: ТОЛЬКО JSON вида {"Added": ["…"], "Changed": [], "Fixed": [], "Security": [], "Removed": [], "Deprecated": []}; пустые разделы можно опустить.${cfg.language === 'en' ? ' Write the entries in English.' : ''}\n\n${flat}`,
      );
      sections = extractJson(text);
      by = `${judge.label} (${judge.model})`;
    } catch {
      sections = {};
    }
  }
  if (!Object.keys(sections).length) {
    for (const [sec, evs] of Object.entries(cand)) if (sec !== 'Сессии') sections[sec] = evs.map((e) => e.description);
  }
  if (Object.values(sections).some((v) => v?.length) || release) m.writeChangelog(sections, release);
  return { sections, by };
}
