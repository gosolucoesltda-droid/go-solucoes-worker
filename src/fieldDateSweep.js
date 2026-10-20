// ═══════════════════════════════════════════════════════════
// Varredura diária — fluxos por data de campo do contato (mesmas regras do Base44: checkContactFieldDates)
// Uma vez por dia (horário de Brasília) cria em scheduled_jobs os disparos das próximas 26h,
// lendo fluxos e contatos direto do Supabase. O disparo segue pelo NOTIFY como antes.
// O Base44 só roda a reserva (00:35) se esta varredura não terminou no dia.
// ═══════════════════════════════════════════════════════════
/* global module */
const { startDaily } = require('./dailyClaim');
const SWEEP_ID = 'sweep_field_dates';
const LOOK_AHEAD_MS = 26 * 3600000;
const FALLBACK_MS = 2 * 60000;
const DEDUP_WINDOW_MS = 6 * 3600000;
const UNIT_MS = { minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000 };

function parseFieldDate(raw) {
  const br = String(raw).match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[T\s]+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (br) { const [, dd, mm, yyyy, hh = '00', mi = '00'] = br; return new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:00-03:00`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) return new Date(`${raw}T00:00:00-03:00`);
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// Mesmo cálculo do contactFieldUpdater.ts (calcScheduledFor)
function calcScheduledFor(fieldDate, cfg) {
  const fieldMs = fieldDate.getTime();
  const offsetMs = (cfg.offset_value || 0) * (UNIT_MS[cfg.offset_unit || 'days'] || 86400000);
  const dir = cfg.offset_direction || 'same_day';
  const targetMs = dir === 'before' ? fieldMs - offsetMs : dir === 'after' ? fieldMs + offsetMs : fieldMs;
  const target = new Date(targetMs);
  const timeMode = cfg.time_mode || 'field_time';
  if (timeMode === 'fixed_time' && cfg.fixed_time) {
    const [h, m] = cfg.fixed_time.split(':').map(Number);
    return new Date(`${target.toISOString().slice(0, 10)}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-03:00`);
  }
  if (timeMode === 'field_time' && target.getUTCHours() === 0 && target.getUTCMinutes() === 0 && target.getUTCSeconds() === 0 && target.getUTCMilliseconds() === 0) {
    return new Date(targetMs + 3 * 3600000);
  }
  return target;
}

const CONTACTS_SQL = `
  select id, telefone, custom_fields, extra from crm_contacts
  where company_id = $1 and connection_id is not distinct from $2
    and (case when jsonb_typeof(custom_fields) = 'object'
           then exists (select 1 from jsonb_each_text(custom_fields) f where lower(f.key) = lower($3) and f.value <> '')
           else false end
         or (lower($3) = 'data_nascimento' and coalesce(extra->>'data_nascimento', '') <> ''))`;

function fieldValue(contact, key) {
  const cf = contact.custom_fields || {};
  if (cf[key]) return cf[key];
  const mk = Object.keys(cf).find((k) => k.toLowerCase() === key.toLowerCase());
  if (mk && cf[mk]) return cf[mk];
  return key.toLowerCase() === 'data_nascimento' ? contact.extra?.data_nascimento : null;
}

async function insertJob(pool, flow, phone, contact, cfg, rawVal, when, referenceId) {
  await pool.query(
    `insert into scheduled_jobs (company_id, job_type, flow_base44_id, contact_phone, scheduled_for, status, attempts, max_attempts, reference_id, reference_type, context)
     values ($1, 'flow_trigger', $2, $3, $4, 'pending', 0, 3, $5, 'contact_field', $6)`,
    [flow.company_id, flow.base44_id, phone, when.toISOString(), referenceId, JSON.stringify({
      field_key: cfg.field_key, field_value: rawVal, offset_value: Number(cfg.offset_value ?? 0), offset_unit: cfg.offset_unit || 'days',
      offset_direction: cfg.offset_direction || 'same_day', trigger_type: 'contact_field_date',
      connection_id: flow.connection_id || null, contact_id: contact.id, source: 'railway_field_date_sweep',
    })]);
}

async function sweepFlow(pool, flow, res) {
  const cfg = flow.trigger_config || {};
  const fieldKey = cfg.field_key;
  if (!fieldKey) return;
  const nowMs = Date.now();
  const yearBRT = new Date(nowMs - 3 * 3600000).getUTCFullYear();
  // Jobs já existentes deste fluxo perto da janela (criados aqui ou pelo contactFieldUpdater)
  const { rows: jobs } = await pool.query(
    `select contact_phone, scheduled_for from scheduled_jobs where flow_base44_id = $1 and reference_type = 'contact_field'
       and status in ('pending','queued','running','completed') and scheduled_for between now() - interval '8 hours' and now() + interval '34 hours'`,
    [flow.base44_id]);
  const existing = new Map();
  for (const j of jobs) existing.set(j.contact_phone, [...(existing.get(j.contact_phone) || []), new Date(j.scheduled_for).getTime()]);
  const { rows: contacts } = await pool.query(CONTACTS_SQL, [flow.company_id, flow.connection_id || null, fieldKey]);

  for (const contact of contacts) {
    try {
      res.contacts_checked++;
      const rawVal = fieldValue(contact, fieldKey);
      const fieldDt = rawVal && parseFieldDate(String(rawVal));
      if (!fieldDt) continue;
      const baseDt = new Date(fieldDt);
      if (cfg.repeat_yearly) baseDt.setUTCFullYear(baseDt.getUTCFullYear() + (yearBRT - new Date(fieldDt.getTime() - 3 * 3600000).getUTCFullYear()));
      let target = calcScheduledFor(baseDt, cfg);
      if (cfg.repeat_yearly && target.getTime() <= nowMs - FALLBACK_MS) {
        const next = new Date(baseDt); next.setUTCFullYear(next.getUTCFullYear() + 1);
        target = calcScheduledFor(next, cfg);
      }
      const t = target.getTime();
      const phone = String(contact.telefone || '').replace(/\D/g, '');
      if (!phone) continue;
      const referenceId = `${flow.base44_id}_${contact.id}_${fieldKey}_${target.toISOString().slice(0, 10)}`;

      // Alvo passou há menos de 2 min: dispara agora (se o fluxo não estiver rodando para o contato)
      if (t <= nowMs && nowMs - t < FALLBACK_MS) {
        const { rowCount } = await pool.query(
          `select 1 from crm_flow_executions where flow_id = $1 and contact_phone = $2 and company_id = $3 and status in ('running','waiting') limit 1`,
          [flow.base44_id, phone, flow.company_id]);
        if (rowCount) { res.skipped_dup++; continue; }
        await insertJob(pool, flow, phone, contact, cfg, rawVal, new Date(), referenceId);
        res.fired_immediately++;
        continue;
      }
      if (t <= nowMs || t >= nowMs + LOOK_AHEAD_MS) continue;
      if ((existing.get(phone) || []).some((ms) => Math.abs(ms - t) <= DEDUP_WINDOW_MS)) { res.skipped_dup++; continue; }
      await insertJob(pool, flow, phone, contact, cfg, rawVal, target, referenceId);
      existing.set(phone, [...(existing.get(phone) || []), t]);
      res.jobs_created++;
    } catch (e) { console.error('[FIELD_DATE] contato:', contact.id, e.message); }
  }
}

async function runSweep(pool) {
  const res = { flows_checked: 0, contacts_checked: 0, jobs_created: 0, fired_immediately: 0, skipped_dup: 0 };
  const { rows: flows } = await pool.query(
    `select base44_id, company_id, connection_id, trigger_config from flows where status = 'active' and trigger_type = 'contact_field_date' and base44_id is not null`);
  res.flows_checked = flows.length;
  for (const flow of flows) {
    try { await sweepFlow(pool, flow, res); } catch (e) { console.error('[FIELD_DATE] fluxo:', flow.base44_id, e.message); }
  }
  return res;
}

function startFieldDateSweep(pool) {
  startDaily(pool, SWEEP_ID, 0, runSweep, 'FIELD_DATE');
  console.log('[FIELD_DATE] varredura diária de datas pelo Railway');
}

module.exports = { startFieldDateSweep, runSweep };