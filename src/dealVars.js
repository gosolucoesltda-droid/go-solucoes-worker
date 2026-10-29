// Variáveis do negócio para as mensagens dos fluxos (mesma regra do Base44: base44/shared/dealVars.ts):
// {{deal_nome}}, {{deal_value}}, {{deal_date}} (dd/mm/aaaa), {{deal_datetime}} (dd/mm/aaaa HH:MM) e {{deal_stage}}.
// Vale para qualquer gatilho (manual, mensagem, palavra-chave…): sem negócio no disparo, usa o
// negócio aberto mais recente do contato no bot.
/* global module */
let pool = null;
function setDealVarsPool(p) { pool = p; }

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
    deal_stage: deal.stage_name || '',
  };
}

// O fluxo usa alguma variável do negócio em algum bloco?
const usesDealVars = (flow) => /\{\{\s*deal_/.test(JSON.stringify(flow?.nodes || []));

const SELECT = `select d.title, d.value, d.due_date, d.due_time, s.name as stage_name
  from crm_deals d left join crm_stages s on s.id = d.stage_id`;

async function loadDealVars(p, { dealId, companyId, connectionId, phone }) {
  const db = p || pool;
  if (!db) return {};
  try {
    if (dealId) {
      const { rows: [deal] } = await db.query(`${SELECT} where d.id = $1 limit 1`, [dealId]);
      if (deal) return dealVars(deal);
    }
    const digits = String(phone || '').replace(/\D/g, '');
    if (!companyId || !digits) return {};
    const { rows: [deal] } = await db.query(
      `${SELECT} where d.company_id = $1 and d.contact_phone = $2 and coalesce(d.status, 'open') = 'open'
         and (d.connection_id is null or d.connection_id = $3::text)
       order by (d.connection_id = $3::text) desc nulls last, d.updated_at desc nulls last limit 1`,
      [companyId, digits, connectionId || null]);
    return dealVars(deal);
  } catch (e) {
    console.error('[DEAL_VARS] leitura falhou:', e.message);
    return {};
  }
}

// Disparo com negócio (ex.: vencimento, parado na etapa): lê o negócio na hora do envio
async function withDealVars(p, ctx) {
  if (!ctx?.deal_id) return ctx;
  return { ...ctx, ...(await loadDealVars(p, { dealId: ctx.deal_id })) };
}

module.exports = { dealVars, withDealVars, loadDealVars, usesDealVars, setDealVarsPool };