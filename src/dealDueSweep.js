// ═══════════════════════════════════════════════════════════
// Vencimento de negócios — fluxos "Data de vencimento" e "Próximo vencimento do negócio".
// Confere de hora em hora (hh:00, horário de Brasília) e dispara os fluxos cuja hora do gatilho
// (trigger_config.time, padrão 09:00) é a hora atual, uma vez por dia por fluxo, criando os jobs em scheduled_jobs
// (processados na hora pelo NOTIFY). Trava por fluxo + dia (deal_due:<fluxo>) evita disparo duplo
// entre instâncias. Toda a conferência roda aqui — o Base44 não confere mais.
// ═══════════════════════════════════════════════════════════
/* global module */
// Query com limite de tempo: conexão caída não deixa a conferência presa para sempre
const q = (pool, text, values) => pool.query({ text, values, query_timeout: 20000 });

function brtNow(offsetDays = 0) {
  return new Date(Date.now() - 3 * 3600000 + offsetDays * 86400000);
}
const brtDate = (offsetDays = 0) => brtNow(offsetDays).toISOString().slice(0, 10);
const toHour = (hhmm) => Number(String(hhmm || '09:00').split(':')[0]) || 0;

async function fireFlow(pool, flow, today) {
  const cfg = flow.trigger_config || {};
  const time = cfg.time || '09:00';
  const days = flow.trigger_type === 'deal_due_soon' ? Number(cfg.days_before ?? 1) : 0;
  const { rows: deals } = await q(pool, 
    `select id, contact_phone, pipeline_id, stage_id, title from crm_deals
     where company_id = $1 and status = 'open' and due_date = $2 and coalesce(contact_phone, '') <> ''`,
    [flow.company_id, brtDate(days)]);
  let created = 0;
  for (const d of deals) {
    const phone = String(d.contact_phone).replace(/\D/g, '');
    if (!phone) continue;
    await q(pool, 
      `insert into scheduled_jobs (company_id, job_type, flow_base44_id, contact_phone, scheduled_for, status, attempts, max_attempts, reference_id, reference_type, context)
       values ($1, 'flow_trigger', $2, $3, now(), 'pending', 0, 3, $4, 'deal_due', $5)`,
      [flow.company_id, flow.base44_id, phone, `deal_due_${flow.base44_id}_${d.id}_${today}_${time}`, JSON.stringify({
        trigger_type: flow.trigger_type, company_id: flow.company_id, contact_phone: phone, deal_id: d.id,
        pipeline_id: d.pipeline_id, stage_id: d.stage_id, deal_title: d.title, days_before: days, due_time: time,
        connection_id: flow.connection_id || null, source: 'railway_deal_due',
      })]);
    created++;
  }
  console.log(`[DEAL_DUE] "${flow.name}" ${time}: ${created} negócio(s) disparado(s)`);
}

async function tick(pool) {
  const now = brtNow();
  const nowHour = now.getUTCHours();
  const today = brtDate();
  const { rows: flows } = await q(pool, 
    `select base44_id, name, company_id, connection_id, trigger_type, trigger_config from flows
     where status = 'active' and trigger_type in ('deal_due_date', 'deal_due_soon') and base44_id is not null and connection_id is not null`);
  for (const flow of flows) {
    try {
      // Só dispara na hora configurada — horário que já passou não é recuperado
      if (toHour(flow.trigger_config?.time) !== nowHour) continue;
      // Trava por fluxo + horário + dia: mudar o horário no mesmo dia permite um novo disparo
      const time = flow.trigger_config?.time || '09:00';
      const { rows: [claim] } = await q(pool, `select claim_flow_trigger($1, $2, $3) as won`, [`deal_due:${flow.base44_id}:${time}`, today, 20 * 3600]);
      if (!claim?.won) continue;
      await fireFlow(pool, flow, today);
    } catch (e) { console.error('[DEAL_DUE] fluxo:', flow.base44_id, e.message); }
  }
}

// Confere uma vez por hora, logo após a virada (hh:00). A próxima hora é agendada ANTES de rodar,
// então uma conferência travada não interrompe as seguintes. Sem conferência ao iniciar o worker.
function startDealDueSweep(pool) {
  if (!pool) return;
  const scheduleNext = () => {
    setTimeout(() => {
      scheduleNext();
      tick(pool).catch((e) => console.error('[DEAL_DUE] varredura:', e.message));
    }, 3600000 - (Date.now() % 3600000) + 2000);
  };
  scheduleNext();
  console.log('[DEAL_DUE] vencimento de negócios pelo Railway (conferência de hora em hora)');
}

module.exports = { startDealDueSweep };