// Aviso "Campo atualizado" no chat quando as variáveis do Funil mudam:
// {{deal_nome}}, {{deal_value}}, {{deal_date}}, {{deal_datetime}} e {{deal_stage}}.
// Mesma regra do Base44: base44/shared/dealNotices.ts
/* global module */
const { dealVars } = require('./dealVars');
const { claimOrInsertNotice } = require('./liveTimeline');

// Negócio com hora de vencimento: avisa só {{deal_datetime}}; sem hora: só {{deal_date}}
function dealChanges(oldDeal, newDeal) {
  const a = dealVars(oldDeal);
  const b = dealVars(newDeal);
  const skip = b.deal_datetime !== b.deal_date ? 'deal_date' : 'deal_datetime';
  return ['deal_nome', 'deal_value', 'deal_date', 'deal_datetime', 'deal_stage']
    .filter((k) => k !== skip && (a[k] || '') !== (b[k] || ''))
    .map((k) => ({ key: k, old_value: a[k] || null, new_value: b[k] || null }));
}

async function logDealChanges(pool, { companyId, connectionId, phone, at }, oldDeal, newDeal) {
  for (const c of dealChanges(oldDeal, newDeal)) {
    await claimOrInsertNotice(pool, {
      company_id: companyId, connection_id: connectionId || null, contact_phone: phone, type: 'field_updated',
      content: c.key, metadata: { field: c.key, ...c }, created_by: 'Fluxo', created_at: at || new Date().toISOString(),
    });
  }
}

// Nome da etapa (para {{deal_stage}})
async function stageNameOf(pool, stageId) {
  if (!stageId) return '';
  const { rows: [s] } = await pool.query('select name from crm_stages where id = $1', [stageId]);
  return s?.name || '';
}

module.exports = { dealChanges, logDealChanges, stageNameOf };