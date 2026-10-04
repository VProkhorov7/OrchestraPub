/* Кнопка «Только free» в шапке: режим, в котором используется только то, что ничего не стоит. Настройка хранится в службе
   (`freeOnly`), поэтому её соблюдают и запуски из панели, и MCP, и автопилот. Правила «что бесплатно» повторяют freetier.ts. */
window.isFreeProvider = (p) => {
  if (p.kind === 'claude-sub' || p.kind === 'codex-sub' || p.billing === 'plan' || p.billing === 'subscription') return true;
  if (p.local || p.freeTier) return true;
  if (/openrouter\.ai/.test(p.baseUrl ?? '')) return /:free$/.test(p.model ?? '') || p.model === 'openrouter/free';
  return p.priceIn === 0 && p.priceOut === 0;
};

function freePaint() {
  const on = !!state.config?.freeOnly;
  const b = $('#freeBtn');
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  $('#freeLabel').textContent = on ? 'Free: вкл' : 'Free';
}

$('#freeBtn').addEventListener('click', async () => {
  try {
    const cfg = await orch.getConfig();
    cfg.freeOnly = !cfg.freeOnly;
    await orch.saveConfig(cfg);
    state.config = cfg;
    freePaint();
    renderConns();
    toast(cfg.freeOnly
      ? 'Включён режим «только бесплатное»: платные исполнители и оркестратор по API-ключу отключены.'
      : 'Режим «только бесплатное» выключен.');
    if (cfg.freeOnly && !cfg.providers.some((p) => p.enabled && p.kind !== 'codex-sub' && window.isFreeProvider(p) && p.kind !== 'claude-sub')) {
      toast('Бесплатных исполнителей пока нет: подключите локальную модель или «OpenRouter · бесплатные модели» (Настройки → Подключения).', 'error');
    }
  } catch (e) { toast(e.message ?? String(e), 'error'); }
});

// конфигурация приходит чуть позже загрузки страницы: перекрашиваем кнопку, когда она появится
const freeWait = setInterval(() => { if (state.config) { freePaint(); clearInterval(freeWait); } }, 300);
