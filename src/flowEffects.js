// ═══════════════════════════════════════════════════════════
// Efeitos do fluxo gravados pelo Railway (mesmas regras do Base44: flowNodeAction.ts,
// flowNodeApi.ts, flowNodeSheets.ts, contactFieldUpdater.ts).
// O fastPath só simula enquanto percorre o fluxo; os efeitos são gravados aqui de uma vez
// quando o Railway assume a execução. Se o Base44 assumir, nada é gravado e ele faz tudo como antes.
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');
const { parseFieldDate, calcScheduledFor } = require('./fieldDateSweep');
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const WORKER_SECRET = process.env.WORKER_SECRET;

const newId = () => crypto.randomBytes(12).toString('hex');
const same = (a, b) => String(a ?? '') === String(b ?? '');
// Converte "R$ 1.234,56", "1234.56" ou "150" em número (0 se não for número)
const parseMoney = (v) => {
  let s = String(v ?? '').replace(/[^\d.,-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Number(s) || 0;
};
const CONTACT_COLS = ['nome', 'email', 'empresa', 'telefone', 'assigned_to', 'observacoes'];

// Diferença entre o contato lido e o contato depois das ações percorridas
function contactDiff(orig, sim) {
  const oc = orig.custom_fields || {};
  const sc = sim.custom_fields || {};
  const patch = {}; const removed = []; const changes = [];
  for (const [k, v] of Object.entries(sc)) {
    if (k in oc && same(oc[k], v)) continue;
    patch[k] = v; changes.push({ key: k, old_value: oc[k] ?? null, new_value: v });
  }
  for (const k of Object.keys(oc)) if (!(k in sc)) { removed.push(k); changes.push({ key: k, old_value: oc[k], new_value: null }); }
  const cols = Object.fromEntries(CONTACT_COLS.filter((k) => k in sim && !same(orig[k], sim[k])).map((k) => [k, sim[k] ?? null]));
  const tags = JSON.stringify(orig.tags || []) !== JSON.stringify(sim.tags || []) ? sim.tags || [] : null;
  return { patch, removed, changes, cols, tags };
}

async function saveContact(pool, contact, d) {
  if (!Object.keys(d.patch).length && !d.removed.length && !Object.keys(d.cols).length && !d.tags) return;
  const args = [contact.id, JSON.stringify(d.patch), d.removed, d.tags !== null, d.tags || []];
  const sets = Object.entries(d.cols).map(([k, v]) => { args.push(v); return `${k} = $${args.length}`; });
  await pool.query(
    `update crm_contacts set custom_fields = (case when jsonb_typeof(custom_fields) = 'object' then custom_fields else '{}'::jsonb end || $2::jsonb) - $3::text[],
     tags = case when $4 then $5::text[] else tags end, ${sets.length ? sets.join(', ') + ',' : ''} updated_at = now() where id = $1`, args);
}

// Negócio, tarefa, nota e agendamento (mesmos campos que o Base44 grava)
async function saveRecord(pool, contact, phone, r) {
  const company = contact.company_id;
  if (r.type === 'move_funnel') {
    const { rows: [deal] } = await pool.query(
      `select id, stage_id from crm_deals where company_id = $1 and contact_phone = $2 and status = 'open' order by created_at desc limit 1`, [company, phone]);
    if (deal && deal.stage_id !== r.stage_id) {
      await pool.query(`update crm_deals set stage_id = $2, stage_entered_at = now(), updated_at = now() where id = $1`, [deal.id, r.stage_id]);
    } else if (!deal && r.create_if_missing) {
      await pool.query(
        `insert into crm_deals (id, company_id, pipeline_id, stage_id, title, contact_phone, value, status, stage_entered_at, position, due_date, due_time, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,'open',now(),0,$8,$9,now(),now())`, [newId(), company, r.pipeline_id || null, r.stage_id || null, r.title, phone, parseMoney(r.value), r.due_date || null, r.due_time || null]);
    }
  } else if (r.type === 'create_task') {
    await pool.query(
      `insert into crm_tasks (id, company_id, contact_phone, title, status, due_date, priority, position, is_recurring, tags, extra, created_at, updated_at)
       values ($1,$2,$3,$4,'Aberta',$5,$6,0,false,'[]'::jsonb,$7,now(),now())`,
      [newId(), company, phone, r.title, r.due_date, r.priority || 'Baixa', JSON.stringify({ description: r.description || '', responsible: r.responsible || '' })]);
  } else if (r.type === 'add_note') {
    await pool.query(
      `insert into crm_activities (id, company_id, connection_id, contact_phone, type, content, created_by, created_at) values ($1,$2,$3,$4,'note',$5,'Fluxo',$6)`,
      [newId(), company, contact.connection_id || null, phone, r.content, r.at]);
  } else if (r.type === 'create_appointment') {
    await pool.query(
      `insert into crm_appointments (id, company_id, contact_phone, title, status, start_datetime, end_datetime, assigned_to, reminder_sent, extra, created_at, updated_at)
       values ($1,$2,$3,$4,'scheduled',$5,$6,$7,false,$8,now(),now())`,
      [newId(), company, phone, r.title, r.start, r.end, r.assigned_to || null, JSON.stringify({ description: r.description || '' })]);
  }
}

// Data do campo mudou (campo vindo de requisição de API): troca os disparos "por data do campo"
async function dateJobs(pool, contact, phone, key, value) {
  await pool.query(
    `update scheduled_jobs set status = 'cancelled', error_message = 'Data do campo alterada'
     where contact_phone = $1 and reference_type = 'contact_field' and status = 'pending' and reference_id like $2`, [phone, `_%${contact.id}_${key}_%`]);
  const fieldDate = value ? parseFieldDate(value) : null;
  if (!fieldDate) return;
  const { rows: flows } = await pool.query(
    `select base44_id, name, connection_id, trigger_config from flows where company_id = $1 and status = 'active' and trigger_type = 'contact_field_date'`, [contact.company_id]);
  const now = Date.now();
  for (const f of flows) {
    const cfg = f.trigger_config || {};
    if (cfg.field_key !== key || (contact.connection_id && f.connection_id && f.connection_id !== contact.connection_id)) continue;
    let when = calcScheduledFor(fieldDate, cfg);
    if (when.getTime() <= now) { if (now - when.getTime() >= 5 * 60000) continue; when = new Date(now + 60000); }
    const ref = `${f.base44_id}_${contact.id}_${key}_${value}`;
    const { rows } = await pool.query(`select 1 from scheduled_jobs where reference_id = $1 and status in ('pending','queued','running') limit 1`, [ref]);
    if (rows.length) continue;
    await pool.query(
      `insert into scheduled_jobs (company_id, job_type, flow_base44_id, contact_phone, scheduled_for, status, attempts, max_attempts, reference_id, reference_type, context)
       values ($1,'flow_trigger',$2,$3,$4,'pending',0,3,$5,'contact_field',$6)`,
      [contact.company_id, f.base44_id, phone, when.toISOString(), ref, JSON.stringify({ contact_phone: phone, contact_name: contact.nome || phone, field_key: key,
        field_value: String(value), flow_name: f.name, connection_id: contact.connection_id || null, contact_id: contact.id, source: 'contact_field_update' })]);
  }
}

// Fluxos "campo alterado": o disparo continua no Base44 (só chama quando a empresa tem um ativo)
async function fieldChanged(pool, contact, phone, changes) {
  if (!changes.length) return;
  const { rows } = await pool.query(
    `select 1 from flows where company_id = $1 and status = 'active' and trigger_type = 'custom_field_changed' limit 1`, [contact.company_id]);
  if (!rows.length) return;
  await fetch(`${APP_URL}/functions/workerTrigger`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'fieldChanged', company_id: contact.company_id, contact_phone: phone, context: { connection_id: contact.connection_id || null, changes } }),
  });
}

// meta: o que o fastPath simulou (contato final, registros, origem de cada campo)
async function commitEffects(pool, { contact, phone, meta }) {
  if (!meta?.sim) return;
  const d = contactDiff(contact, meta.sim);
  await saveContact(pool, contact, d);
  for (const r of meta.records || []) await saveRecord(pool, contact, phone, r).catch((e) => console.error(`[EFFECTS] ${r.type}:`, e.message));
  const src = meta.sources || {};
  const changed = d.changes.filter((c) => src[c.key] === 'flow' || src[c.key] === 'api');
  await fieldChanged(pool, contact, phone, changed).catch((e) => console.error('[EFFECTS] campo alterado:', e.message));
  for (const c of d.changes.filter((x) => src[x.key] === 'api')) {
    await dateJobs(pool, contact, phone, c.key, c.new_value).catch((e) => console.error('[EFFECTS] disparo por data:', e.message));
  }
}

// Contexto da execução com os mesmos campos que o Base44 atualiza ao passar pelos blocos
function contextPatch(ctx, contact, meta) {
  if (!meta?.sim) return ctx;
  const d = contactDiff(contact, meta.sim);
  const collected = { ...(ctx.collected || {}) };
  for (const [k, v] of Object.entries(d.patch)) if (k !== 'attendance_status') collected[k] = v;
  for (const k of d.removed) delete collected[k];
  Object.assign(collected, meta.collected || {});
  const out = { ...ctx, collected, tags: meta.sim.tags || ctx.tags };
  if ('attendance_status' in d.patch) out.attendance_status = d.patch.attendance_status;
  if ('assigned_to' in d.cols) out.assigned_to = d.cols.assigned_to;
  for (const k of ['nome', 'email', 'empresa']) if (k in d.cols) out[k] = d.cols[k];
  if ('nome' in d.cols) { out.contact_name = d.cols.nome; out.primeiro_nome = String(d.cols.nome || '').split(' ')[0]; }
  return out;
}

module.exports = { commitEffects, contextPatch };