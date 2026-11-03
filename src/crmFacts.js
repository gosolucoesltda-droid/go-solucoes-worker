// Funil, tarefas e agendamentos do contato para as condições do fluxo.
// Lê os espelhos crm_deals / crm_tasks / crm_appointments. Mesma regra do Base44 (base44/shared/crmFacts.ts).
const { normText } = require('./textNorm');
let pool = null;
const FACT_FIELDS = ['funnel_stage', 'deal_title', 'deal_value', 'deal_date', 'deal_responsible', 'deal_created', 'deal_exists', 'has_open_task', 'has_overdue_task', 'has_appointment', 'has_future_appointment', 'appointment_status'];

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
      pool.query(`select stage_id, value, title, due_date, responsible, created_at from crm_deals where company_id = $1 and contact_phone = $2 and status = 'open' order by created_at desc limit 50`, args),
      pool.query(`select status, due_date from crm_tasks where company_id = $1 and contact_phone = $2 and (status is null or status not in ('Finalizado','Fechado')) limit 200`, args),
      pool.query(`select status, start_datetime from crm_appointments where company_id = $1 and contact_phone = $2 order by start_datetime desc nulls last limit 100`, args),
    ]);
    return {
      open_deals: d.rows.map((r) => ({
        stage_id: r.stage_id,
        value: Number(r.value) || 0,
        title: r.title || '',
        due_date: r.due_date || '',
        responsible: r.responsible || '',
        created: r.created_at || '',
      })),
      ...computeFacts(t.rows, a.rows),
    };
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

function compareText(actual, op, value) {
  const a = normText(actual);
  const v = normText(value);
  switch (op) {
    case 'equals': return a === v;
    case 'not_equals': return a !== v;
    case 'contains': return a.includes(v);
    case 'not_contains': return !a.includes(v);
    case 'starts_with': return a.startsWith(v);
    case 'ends_with': return a.endsWith(v);
    case 'empty': return !a;
    case 'not_empty': return !!a;
    default: return false;
  }
}

// Datas do negócio (yyyy-mm-dd): vazio não casa com "antes/depois/igual"
const day = (v) => String(v || '').slice(0, 10);
function compareDate(actual, op, value) {
  const a = day(actual), v = day(value);
  if (!a) return op === 'empty';
  switch (op) {
    case 'before': return a < v;
    case 'after': return a > v;
    case 'equals': return a === v;
    case 'not_equals': return a !== v;
    case 'empty': return false;
    case 'not_empty': return true;
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
    case 'deal_title': return compareText(deals[0]?.title, op, value);
    case 'deal_responsible': return compareText(deals[0]?.responsible, op, value);
    case 'deal_date': return compareDate(deals[0]?.due_date, op, value);
    case 'deal_created': return compareDate(deals[0]?.created, op, value);
    case 'deal_value': return compareNumber(deals[0]?.value || 0, op, value);
    case 'deal_exists': return op === 'is_true' ? deals.length > 0 : deals.length === 0;
    case 'has_open_task': return op === 'is_true' ? f.has_open_task === true : f.has_open_task !== true;
    case 'has_overdue_task': return op === 'is_true' ? f.has_overdue_task === true : f.has_overdue_task !== true;
    case 'has_appointment': case 'has_future_appointment': return op === 'is_true' ? f.has_future_appointment === true : f.has_future_appointment !== true;
    case 'appointment_status': return op === 'is' ? f.appointment_status === value : f.appointment_status !== value;
    default: return undefined;
  }
}

// Efeito de uma ação do fluxo nos dados lidos (mesma regra do bloco de ação do Base44),
// para as condições seguintes continuarem no Railway. Agendamentos: o Base44 avalia.
function applyFactAction(f, a) {
  if (!f) return;
  if (a.type === 'move_funnel') {
    const deals = f.open_deals || (f.open_deals = []);
    if (deals.length) deals[0].stage_id = a.stage_id;
    else if (a.create_if_missing) deals.unshift({ stage_id: a.stage_id, value: Number(a.value) || 0 });
  } else if (a.type === 'create_deal') {
    const deals = f.open_deals || (f.open_deals = []);
    deals.unshift({ stage_id: a.stage_id, value: Number(a.value) || 0 });
  } else if (a.type === 'edit_deal') {
    const d = (f.open_deals || [])[0];
    if (!d) return;
    if (a.stage_id) d.stage_id = a.stage_id;
    // Nome/valor com variável ou digitado: as condições seguintes ficam com o Base44
    if (String(a.title_template || '').includes('{{') || String(a.value ?? '').includes('{{')) f.stale = true;
  } else if (a.type === 'create_task') {
    let due = a.due_date || null;
    if (a.due_date_type === 'relative' || (!a.due_date_type && a.due_date_days != null)) {
      due = new Date(Date.now() + Number(a.due_date_days ?? 1) * 86400000).toISOString().slice(0, 10);
    }
    f.has_open_task = true;
    if (due && String(due).slice(0, 10) < new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10)) f.has_overdue_task = true;
  } else if (a.type === 'create_appointment' || a.type === 'appointment_status') {
    f.stale = true;
  }
}

// Filtro de etapa do gatilho (mesma regra do Base44): null = sem dados (o Base44 avalia)
function passesStageFilter(f, facts) {
  if (!facts) return null;
  const deals = facts.open_deals || [];
  const inStage = deals.some((d) => d.stage_id === f.value);
  const op = f.operator || 'equals';
  if (op === 'equals') return inStage;
  if (op === 'not_equals') return !inStage;
  if (op === 'is_empty') return deals.length === 0;
  if (op === 'is_not_empty') return deals.length > 0;
  return true;
}

module.exports = { setFactsPool, needsFacts, loadFacts, evalFact, applyFactAction, passesStageFilter };