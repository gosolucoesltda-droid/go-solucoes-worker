// Variáveis do negócio para as mensagens dos fluxos (mesma regra do Base44: base44/shared/dealVars.ts):
// {{deal_nome}}, {{deal_value}}, {{deal_date}} (dd/mm/aaaa) e {{deal_datetime}} (dd/mm/aaaa HH:MM).
/* global module */
function dealVars(deal) {
  if (!deal) return {};
  const m = String(deal.due_date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  const time = /^\d{2}:\d{2}/.test(String(deal.due_time || '')) ? String(deal.due_time).slice(0, 5) : '';
  return {
    deal_nome: deal.title || '',
    deal_title: deal.title || '',
    deal_value: 'R$ ' + (Number(deal.value) || 0).toFixed(2),
    deal_date: date,
    deal_datetime: date && time ? `${date} ${time}` : date,
  };
}

// Disparo com negócio (ex.: vencimento, parado na etapa): lê o negócio na hora do envio
async function withDealVars(pool, ctx) {
  if (!ctx?.deal_id) return ctx;
  const { rows: [deal] } = await pool.query(
    `select title, value, due_date, due_time from crm_deals where id = $1 limit 1`, [ctx.deal_id]);
  return deal ? { ...ctx, ...dealVars(deal) } : ctx;
}

module.exports = { dealVars, withDealVars };