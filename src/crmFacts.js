// Funil, tarefas e agendamentos do contato para as condições do fluxo.
// Lê os espelhos crm_deals / crm_tasks / crm_appointments. Mesma regra do Base44 (base44/shared/crmFacts.ts).
let pool = null;
const FACT_FIELDS = ['funnel_stage', 'deal_value', 'deal_exists', 'has_open_task', 'has_overdue_task', 'has_appointment', 'has_future_appointment', 'appointment_status'];

function setFactsPool(p) { pool = p; }
const needsFacts = (nodes) => { const s = JSON.stringify(nodes || []); return FACT_FIELDS.some((f) => s.includes(`"${f}"`)); };

function computeFacts(openTasks, appts, now = Date.now()) {
  const today = new Date(now - 3 * 3600000).toISOString().slice(0, 10); // Brasília
  const t = (a) => new Date(a.start_datetime).getTime();
  const dated = appts.filter((a) => a.start_datetime && !isNaN(t(a)));
  const future = dated.filter((a) => t(a) > now).sort((a, b) => t(a) - t(b));
  const past = dated.filter((a) => t(a) <= now).sort((a, b) => t(b) - t(a));
  return {
    has_open_task: openTasks.length > 0,
    has_overdue_task: openTasks.some((x) => x.due_date && String(x.due_date).slice(0, 10) < today),
    has_future_appointment: future.some((a) => a.status === 'scheduled' || a.status === 'confirmed'),
    appointment_status: (future[0] || past[0])?.status || null,
  };
}

// null = não conseguiu ler (o Base44 avalia)
async function loadFacts(companyId, phone) {
  if (!pool) return null;
  try {
    const args = [companyId, phone];
    const [d, t, a] = await Promise.all([
      pool.query(`select stage_id, value from crm_deals where company_id = $1 and contact_phone = $2 and status = 'open' order by created_at desc limit 50`, args),
      pool.query(`select status, due_date from crm_tasks where company_id = $1 and contact_phone = $2 and (status is null or status not in ('Finalizado','Fechado')) limit 200`, args),
      pool.query(`select status, start_datetime from crm_appointments where company_id = $1 and contact_phone = $2 order by start_datetime desc nulls last limit 100`, args),
    ]);
    return { open_deals: d.rows.map((r) => ({ stage_id: r.stage_id, value: Number(r.value) || 0 })), ...computeFacts(t.rows, a.rows) };
  } catch (e) {
    console.error('[FACTS] leitura falhou (Base44 avalia):', e.message);
    return null;
  }
}

function compareNumber(actual, op, value) {
  const a = Number(actual), v = Number(value);
  switch (op) {
    case 'gt': return a > v; case 'gte': return a >= v; case 'lt': return a < v; case 'lte': return a <= v;
    case 'equals': return a === v; case 'not_equals': return a !== v;
    default: return false;
  }
}

// undefined = o Railway não sabe avaliar (campo desconhecido, sem dados ou dados alterados por uma ação no caminho)
function evalFact(field, filter, f) {
  if (!FACT_FIELDS.includes(field) || !f || f.stale) return undefined;
  const { operator: op, value } = filter;
  const deals = f.open_deals || [];
  switch (field) {
    case 'funnel_stage': { const has = deals.some((d) => d.stage_id === (filter.stage_id || value)); return op === 'is_in' || op === 'in_stage' ? has : !has; }
    case 'deal_value': return compareNumber(deals[0]?.value || 0, op, value);
    case 'deal_exists': return op === 'is_true' ? deals.length > 0 : deals.length === 0;
    case 'has_open_task': return op === 'is_true' ? f.has_open_task === true : f.has_open_task !== true;
    case 'has_overdue_task': return op === 'is_true' ? f.has_overdue_task === true : f.has_overdue_task !== true;
    case 'has_appointment': case 'has_future_appointment': return op === 'is_true' ? f.has_future_appointment === true : f.has_future_appointment !== true;
    case 'appointment_status': return op === 'is' ? f.appointment_status === value : f.appointment_status !== value;
    default: return undefined;
  }
}

module.exports = { setFactsPool, needsFacts, loadFacts, evalFact };