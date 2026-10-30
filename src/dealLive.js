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

// Mesma regra do aviso do Base44/flowEffects: com hora de vencimento avisa só {{deal_datetime}}; sem hora só {{deal_date}}
function varChanges(a, b) {
  const skip = b.deal_datetime !== b.deal_date ? 'deal_date' : 'deal_datetime';
  return ['deal_nome', 'deal_value', 'deal_date', 'deal_datetime', 'deal_stage']
    .filter((k) => k !== skip && (a[k] || '') !== (b[k] || ''))
    .map((k) => ({ key: k, old_value: a[k] || null, new_value: b[k] || null }));
}

// Aviso "Campo atualizado" na hora (o registro definitivo depois assume esta mesma linha)
async function noticeChanges(before, after, notice) {
  if (!notice || !('deal_nome' in before)) return;
  for (const c of varChanges(before, after)) await notice('field_updated', c.key, { field: c.key, ...c });
}

// Requisição de API que preencheu variáveis do Funil
async function applyDealPatch(opts, vars, patch, notice) {
  const dv = await liveDealVars(opts);
  const before = { ...dv };
  applyDealVars(dv, patch);
  Object.assign(vars, dv);
  await noticeChanges(before, dv, notice);
}

// Ação "Mover no funil": nova etapa (ou negócio novo, se criado)
async function applyMoveFunnel(node, vars, opts, render, notice) {
  const moves = ((node.data || node.config || {}).actions || []).filter((a) => a.type === 'move_funnel' && a.stage_id);
  for (const a of moves) {
    const dv = await liveDealVars(opts);
    const stage = pool ? await stageNameOf(pool, a.stage_id).catch(() => '') : '';
    if ('deal_nome' in dv) {
      const before = { ...dv };
      dv.deal_stage = stage;
      if (stage && before.deal_stage && before.deal_stage !== stage) await noticeChanges(before, dv, notice);
    }
    else if (a.create_if_missing) {
      const title = render(a.deal_title_template || 'Negocio - {{nome}}', { ...vars, nome: opts.sim?.nome || vars.contact_phone });
      Object.assign(dv, dealVars({ title, value: parseMoney(render(String(a.value ?? ''), vars)), ...dealDue(a, render), stage_name: stage }));
    }
    Object.assign(vars, dv);
  }
}

module.exports = { applyDealPatch, applyMoveFunnel, setDealLivePool };