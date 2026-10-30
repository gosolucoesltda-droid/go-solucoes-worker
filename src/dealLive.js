// Variáveis do Funil "ao vivo" durante a execução: quando uma requisição de API ou a ação "Mover no funil"
// muda o negócio, {{deal_nome}}, {{deal_value}}, {{deal_date}}, {{deal_datetime}} e {{deal_stage}} já valem
// nos blocos seguintes — inclusive no fluxo de destino de um salto (opts.dealVars é compartilhado).
/* global module */
const { dealVars, loadDealVars } = require('./dealVars');
const { applyDealVars, parseMoney } = require('./dealFieldMap');
const { dealDue } = require('./dealDue');
const { stageNameOf } = require('./dealNotices');

let pool = null;
function setDealLivePool(p) { pool = p; }

async function liveDealVars(opts) {
  if (opts.dealVars === undefined) {
    opts.dealVars = await loadDealVars(null, { dealId: opts.context?.deal_id, companyId: opts.companyId, connectionId: opts.connectionId, phone: opts.phone });
  }
  return opts.dealVars;
}

// Requisição de API que preencheu variáveis do Funil
async function applyDealPatch(opts, vars, patch) {
  const dv = await liveDealVars(opts);
  applyDealVars(dv, patch);
  Object.assign(vars, dv);
}

// Ação "Mover no funil": nova etapa (ou negócio novo, se criado)
async function applyMoveFunnel(node, vars, opts, render) {
  const moves = ((node.data || node.config || {}).actions || []).filter((a) => a.type === 'move_funnel' && a.stage_id);
  for (const a of moves) {
    const dv = await liveDealVars(opts);
    const stage = pool ? await stageNameOf(pool, a.stage_id).catch(() => '') : '';
    if ('deal_nome' in dv) dv.deal_stage = stage;
    else if (a.create_if_missing) {
      const title = render(a.deal_title_template || 'Negocio - {{nome}}', { ...vars, nome: opts.sim?.nome || vars.contact_phone });
      Object.assign(dv, dealVars({ title, value: parseMoney(render(String(a.value ?? ''), vars)), ...dealDue(a, render), stage_name: stage }));
    }
    Object.assign(vars, dv);
  }
}

module.exports = { applyDealPatch, applyMoveFunnel, setDealLivePool };