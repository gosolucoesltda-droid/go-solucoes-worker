// ═══════════════════════════════════════════════════════════
// Vencimento de negócios — fluxos "Data de vencimento" e "Próximo vencimento do negócio".
// Totalmente reativo: o Supabase avisa por NOTIFY ('deal_due_plan', company_id) quando um negócio ou
// fluxo de vencimento muda, e a empresa é reagendada na hora. Cada disparo futuro fica em scheduled_jobs
// com o horário exato (trigger_config.time, padrão 09:00, Brasília) e o processador dispara na hora.
// Sem verificação periódica: só um reagendamento completo ao iniciar (avisos enviados com o servidor
// fora do ar não ficam guardados pelo Postgres). Horários que já passaram não são recuperados.
// ═══════════════════════════════════════════════════════════
/* global module */
const q = (pool, text, values) => pool.query({ text, values, query_timeout: 20000 });

const brtToday = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function normTime(t) {
  const [h, m] = String(t || '09:00').split(':');
  return `${String(Number(h) || 0).padStart(2, '0')}:${String(Number(m) || 0).padStart(2, '0')}`;
}

// "Data de vencimento": antes/depois/no mesmo dia do vencimento, no horário do negócio (se tiver) ou fixo
// (mesma regra do gatilho de data do campo do contato). Configuração antiga (só "time") = no dia, horário fixo.
const UNIT_MS = { minutes: 60000, hours: 3600000, days: 86400000 };
const offsetMs = (cfg) => (Number(cfg.offset_value) || 0) * (UNIT_MS[cfg.offset_unit] || 86400000);
function dueFireAt(d, cfg) {
  const dueTime = /^\d{1,2}:\d{2}/.test(d.due_time || '') ? normTime(d.due_time) : null;
  const base = Date.parse(`${d.due}T${dueTime || '00:00'}:00-03:00`);
  const dir = cfg.offset_direction || 'same_day';
  const off = dir === 'same_day' ? 0 : offsetMs(cfg);
  const target = dir === 'before' ? base - off : base + off;
  if (cfg.time_mode === 'field_time' && dueTime) return new Date(target);
  const day = new Date(target - 3 * 3600000).toISOString().slice(0, 10);
  return new Date(`${day}T${normTime(cfg.fixed_time || cfg.time)}:00-03:00`);
}

const dealDueStatus = { last_plan_at: null, last_error: null, jobs_created: 0, jobs_cancelled: 0 };
let poolRef = null;

async function planCompany(pool, companyId) {
  const { rows: flows } = await q(pool,
    `select base44_id, company_id, connection_id, trigger_type, trigger_config from flows
     where company_id = $1 and status = 'active' and trigger_type in ('deal_due_date', 'deal_due_soon')
       and base44_id is not null and connection_id is not null`, [companyId]);
  const nowMs = Date.now();
  const desired = [];
  for (const flow of flows) {
    const cfg = flow.trigger_config || {};
    const time = normTime(cfg.time);
    const isDue = flow.trigger_type === 'deal_due_date';
    const days = isDue ? 0 : Number(cfg.days_before ?? 1);
    // "Depois do vencimento": inclui vencimentos que já passaram dentro da correção
    const back = isDue && cfg.offset_direction === 'after' ? Math.ceil(offsetMs(cfg) / 86400000) + 1 : 0;
    // Só negócios do mesmo bot do fluxo — cada bot envia apenas para os próprios negócios.
    const { rows: deals } = await q(pool,
      `select id, contact_phone, pipeline_id, stage_id, title, left(due_date, 10) as due, due_time from crm_deals
       where company_id = $1 and connection_id = $3 and status = 'open' and left(due_date, 10) >= $2 and coalesce(contact_phone, '') <> ''`,
      [companyId, addDays(brtToday(), days - back), flow.connection_id]);
    for (const d of deals) {
      const at = isDue ? dueFireAt(d, cfg) : new Date(`${addDays(d.due, -days)}T${time}:00-03:00`);
      const phone = String(d.contact_phone).replace(/\D/g, '');
      if (!phone || isNaN(at) || at.getTime() <= nowMs) continue;
      desired.push({ flow, d, phone, at, time, days, ref: `deal_due_${flow.base44_id}_${d.id}_${at.toISOString()}` });
    }
  }
  // Pendentes futuros que não valem mais (vencimento/horário mudou, negócio fechado, fluxo pausado)
  const { rowCount: cancelled } = await q(pool,
    `update scheduled_jobs set status = 'cancelled', error_message = 'Vencimento ou horário alterado'
     where company_id = $1 and reference_type = 'deal_due' and status = 'pending' and scheduled_for > now()
       and not (reference_id = any($2::text[]))`, [companyId, desired.map((x) => x.ref)]);
  let created = 0;
  for (const x of desired) {
    const { rowCount } = await q(pool,
      `insert into scheduled_jobs (company_id, job_type, flow_base44_id, contact_phone, scheduled_for, status, attempts, max_attempts, reference_id, reference_type, context)
       values ($1, 'flow_trigger', $2, $3, $4, 'pending', 0, 3, $5, 'deal_due', $6) on conflict do nothing`,
      [companyId, x.flow.base44_id, x.phone, x.at.toISOString(), x.ref, JSON.stringify({
        trigger_type: x.flow.trigger_type, company_id: companyId, contact_phone: x.phone, deal_id: x.d.id,
        pipeline_id: x.d.pipeline_id, stage_id: x.d.stage_id, deal_title: x.d.title, days_before: x.days, due_time: x.time,
        connection_id: x.flow.connection_id || null, source: 'railway_deal_due',
      })]);
    created += rowCount;
  }
  dealDueStatus.jobs_created += created;
  dealDueStatus.jobs_cancelled += cancelled;
  if (created || cancelled) console.log(`[DEAL_DUE] empresa ${companyId}: ${created} agendado(s), ${cancelled} cancelado(s)`);
}

// Uma fila por empresa (sem planejamentos simultâneos) + espera curta para agrupar avisos em sequência
const chains = new Map();
const timers = new Map();
function requestDealDuePlan(companyId) {
  if (!poolRef || !companyId) return;
  clearTimeout(timers.get(companyId));
  timers.set(companyId, setTimeout(() => {
    timers.delete(companyId);
    const next = (chains.get(companyId) || Promise.resolve())
      .then(() => planCompany(poolRef, companyId))
      .then(() => { dealDueStatus.last_plan_at = new Date().toISOString(); dealDueStatus.last_error = null; })
      .catch((e) => { dealDueStatus.last_error = e.message; console.error('[DEAL_DUE] empresa:', companyId, e.message); });
    chains.set(companyId, next);
    next.finally(() => { if (chains.get(companyId) === next) chains.delete(companyId); });
  }, 1500));
}

function startDealDueSweep(pool) {
  if (!pool) return;
  poolRef = pool;
  // Reagendamento único ao iniciar — depois disso, só pelos avisos do Supabase
  q(pool, `select distinct company_id from flows where status = 'active' and trigger_type in ('deal_due_date', 'deal_due_soon') and company_id is not null`)
    .then(({ rows }) => rows.forEach((r) => requestDealDuePlan(r.company_id)))
    .catch((e) => { dealDueStatus.last_error = e.message; console.error('[DEAL_DUE] início:', e.message); });
  console.log('[DEAL_DUE] vencimento de negócios só por aviso do Supabase (NOTIFY deal_due_plan)');
}

module.exports = { startDealDueSweep, requestDealDuePlan, dealDueStatus };