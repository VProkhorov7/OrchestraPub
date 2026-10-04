/* «Расходы»: сколько потрачено, на что и что получено; сверка оценки с настоящим балансом у провайдера. Только читает сохранённые запуски. */
const sp = { days: 3, labels: {}, ledger: [] };
const spUsd = (n) => '$' + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
const spPct = (x) => Math.round(x * 100) + '%';
const spName = (id) => sp.labels[id] || id;
const SP_STATUS = { merged: 'слито', discarded: 'отброшено', failed: 'ошибка', timeout: 'таймаут', done: 'готово', running: 'работает', queued: 'в очереди' };

function spBar(v, max) {
  return `<span class="spBar"><i style="width:${max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0}%"></i></span>`;
}

function spKpi(title, value, sub) {
  return `<div class="spKpi"><div class="spKv mono">${value}</div><div class="spKt">${title}</div>${sub ? `<div class="spKs">${sub}</div>` : ''}</div>`;
}

function spRecon(r) {
  const unit = r.unitUsd === 1 ? '$' : `×${r.unitUsd}`;
  const verdict = r.factor === null
    ? 'Пока нечего сравнивать: нужно хотя бы два замера баланса с работой между ними.'
    : `Настоящий расход: ${spUsd(r.realUsd)}, оценка Orchestra: ${spUsd(r.estimatedUsd)}. ` +
      (r.factor > 1.15 ? `Реально дороже в ${r.factor.toFixed(2)} раза: цены в настройках занижены.`
        : r.factor < 0.85 ? `Реально дешевле (${r.factor.toFixed(2)} от оценки): цены в настройках завышены.`
        : 'Сходится.');
  const last = r.last ? `последний замер ${esc(fmtDate(r.last.ts))}: ${r.last.balance} (${unit})` : 'замеров нет';
  return `<div class="spRecon"><div class="spRh"><b>${esc(spName(r.id))}</b><span class="meta">${last}${r.topUps ? ` · пополнений учтено: ${r.topUps}` : ''}</span></div><div class="spRv">${verdict}</div></div>`;
}

function spPaint(rep) {
  const max = Math.max(0, ...rep.byProvider.map((p) => p.usd));
  const rows = rep.byProvider.map((p) => `
    <tr><td>${esc(spName(p.id))}</td><td class="mono">${spUsd(p.usd)}</td><td class="spBarCell">${spBar(p.usd, max)}</td>
    <td class="mono">${p.merged}/${p.tasks}</td><td class="mono">${p.wasteUsd > 0 ? spUsd(p.wasteUsd) : '—'}</td><td class="mono">${spPct(p.cacheShare)}</td></tr>`).join('');
  const roles = rep.byRole.slice(0, 10).map((r) => `<tr><td>${esc(r.role)}</td><td>${esc(spName(r.provider))}</td><td class="mono">${spUsd(r.usd)}</td><td class="mono">${r.tasks}</td></tr>`).join('');
  const top = rep.top.filter((t) => t.usd > 0).map((t) => `<tr><td class="mono">${spUsd(t.usd)}</td><td>${esc(t.title)}</td><td>${esc(spName(t.provider))}</td><td>${esc(SP_STATUS[t.status] || t.status)}</td></tr>`).join('');
  const dmax = Math.max(0, ...rep.byDay.map((d) => d.usd));
  const days = rep.byDay.map((d) => `<tr><td class="mono">${esc(d.day.slice(5))}</td><td class="mono">${spUsd(d.usd)}</td><td class="spBarCell">${spBar(d.usd, dmax)}</td></tr>`).join('');
  const needs = sp.ledger.map(spRecon).join('') || '<div class="empty small">Замеров баланса пока нет.</div>';
  const options = Object.keys(sp.labels).map((id) => `<option value="${esc(id)}">${esc(sp.labels[id])}</option>`).join('');
  $('#spendBody').innerHTML = `
    <div class="spKpis">
      ${spKpi('Потрачено', spUsd(rep.totalUsd), `оркестратор: ${spUsd(rep.orchestratorUsd)}`)}
      ${spKpi('Слито задач', `${rep.merged} из ${rep.tasks}`, spPct(rep.mergedRate))}
      ${spKpi('Доллар за слитую', rep.usdPerMerged === null ? '—' : spUsd(rep.usdPerMerged), 'всё потраченное ÷ слитые')}
      ${spKpi('Впустую', spPct(rep.wasteShare), `${spUsd(rep.wasteUsd)}: отброшено, ошибки, таймауты`)}
    </div>
    <div class="spGrid">
      <div class="card"><h3>По подключениям</h3>
        <table class="spT"><thead><tr><th>Подключение</th><th>$</th><th></th><th>слито</th><th>впустую</th><th>кэш</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty small">За период задач не было.</td></tr>'}</tbody></table></div>
      <div class="card"><h3>По дням</h3>
        <table class="spT"><tbody>${days || '<tr><td class="empty small">Нет данных.</td></tr>'}</tbody></table></div>
      <div class="card"><h3>Роль × подключение</h3>
        <table class="spT"><thead><tr><th>Роль</th><th>Подключение</th><th>$</th><th>задач</th></tr></thead><tbody>${roles || '<tr><td colspan="4" class="empty small">Нет данных.</td></tr>'}</tbody></table></div>
      <div class="card"><h3>Самые дорогие задачи</h3>
        <table class="spT"><tbody>${top || '<tr><td class="empty small">Нет данных.</td></tr>'}</tbody></table></div>
    </div>
    <div class="card spLedger"><h3>Сверка с настоящим балансом</h3>
      <div class="hint">Введите баланс из кабинета провайдера (DeepSeek можно снять автоматически). Через какое-то время введите снова: падение баланса — настоящий расход, он сравнивается с оценкой по задачам. Пополнение баланса учитывается и не портит сравнение.</div>
      ${needs}
      <div class="row spForm">
        <select id="spId">${options}</select>
        <input id="spBal" type="number" step="any" min="0" placeholder="баланс из кабинета" />
        <input id="spUnit" type="number" step="any" min="0" placeholder="доллар за единицу (B.AI: 0.000001)" />
        <button id="spSave" class="primary small">Записать замер</button>
        <button id="spAuto" class="ghost small">Снять у DeepSeek</button>
      </div>
      <div id="spMsg" class="hint"></div>
    </div>`;
  $('#spSave').onclick = () => spSnap(true);
  $('#spAuto').onclick = () => spSnap(false);
}

async function spSnap(manual) {
  const msg = $('#spMsg');
  try {
    const id = manual ? $('#spId').value : (Object.keys(sp.labels).find((k) => /deepseek/i.test(k)) || '');
    const bal = manual ? $('#spBal').value : undefined;
    if (manual && bal === '') { msg.textContent = 'Введите баланс.'; return; }
    const unit = manual && $('#spUnit').value ? Number($('#spUnit').value) : undefined;
    sp.ledger = await orch.ledgerSnapshot(id, bal === undefined ? undefined : Number(bal), unit);
    await spLoad();
  } catch (e) { msg.textContent = e.message || String(e); }
}

async function spLoad() {
  const body = $('#spendBody');
  try {
    const cfg = await orch.getConfig();
    sp.labels = Object.fromEntries((cfg.providers || []).filter((p) => (p.kind || 'api') === 'api').map((p) => [p.id, p.label || p.id]));
    sp.ledger = await orch.ledger();
    spPaint(await orch.report(sp.days));
  } catch (e) {
    body.innerHTML = '<div class="empty small">Отчёт недоступен: перезапустите службу Orchestra (она старой версии).</div>';
  }
}

document.querySelector('[data-tab=spend]').addEventListener('click', spLoad);
$('#spendDays').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-days]');
  if (!b) return;
  sp.days = Number(b.dataset.days);
  for (const x of $('#spendDays').children) x.classList.toggle('active', x === b);
  spLoad();
});
