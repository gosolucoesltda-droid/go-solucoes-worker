// ═══════════════════════════════════════════════════════════
// Fase 4 — Motor de fluxos no Railway (modo híbrido)
// Só processa bots listados em RAILWAY_ENGINE_PHONE_IDS (separados por vírgula).
// O Railway decide quais fluxos "inbound_any" e "keyword" disparam e já inicia
// pelo workerTrigger. Ele grava a trava claim_flow_trigger antes, então quando o
// Base44 processar a mesma mensagem a trava já está ocupada e ele não dispara de novo.
// Sempre retorna false: o Base44 continua salvando a mensagem e cuidando
// de botões, mídia e demais gatilhos.
// ═══════════════════════════════════════════════════════════
const PILOT_IDS = (process.env.RAILWAY_ENGINE_PHONE_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const WORKER_SECRET = process.env.WORKER_SECRET;

const UNIT_SECONDS = { minutes: 60, hours: 3600, days: 86400 };
const KEYWORD_CLAIM_SECONDS = 30; // mesma janela usada pelo Base44

function isPilot(phoneNumberId) {
  return !!phoneNumberId && PILOT_IDS.includes(phoneNumberId);
}

function parseMessage(body) {
  const value = JSON.parse(body).entry?.[0]?.changes?.[0]?.value || {};
  const msg = value.messages?.[0];
  if (!msg) return null; // status de entrega/leitura
  const text = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '';
  return { from: msg.from, type: msg.type, text, name: value.contacts?.[0]?.profile?.name || '' };
}

function cooldownSeconds(cfg = {}) {
  if (Number(cfg.cooldown_value) > 0) return Number(cfg.cooldown_value) * (UNIT_SECONDS[cfg.cooldown_unit || 'minutes'] || 60);
  if (Number(cfg.inbound_any_interval) > 0) return Number(cfg.inbound_any_interval) * (UNIT_SECONDS[cfg.inbound_any_interval_unit || 'hours'] || 3600);
  return 0;
}

function keywordMatches(cfg = {}, text) {
  const msg = (text || '').toLowerCase();
  if (!msg) return false;
  const match = cfg.match || 'contains';
  return (cfg.keywords || []).some((kw) => {
    const k = (kw || '').toLowerCase();
    if (!k) return false;
    return match === 'exact' ? msg === k : match === 'starts_with' ? msg.startsWith(k) : match === 'contains' ? msg.includes(k) : false;
  });
}

// true/false = passou ou não; null = filtro que o Railway não sabe avaliar (fica com o Base44)
function passesContactFilters(filters, contact) {
  if (!filters?.length) return true;
  for (const f of filters) {
    const op = f.operator || 'equals';
    if (f.type === 'tag') {
      const tags = contact.tags || [];
      if (op === 'equals' && !tags.includes(f.value)) return false;
      if (op === 'not_equals' && tags.includes(f.value)) return false;
      if (op === 'is_empty' && tags.length > 0) return false;
      if (op === 'is_not_empty' && tags.length === 0) return false;
    } else if (f.type === 'custom_field') {
      const raw = (contact.custom_fields || {})[f.field_key];
      const val = String(raw ?? '').toLowerCase().trim();
      const want = String(f.value ?? '').toLowerCase().trim();
      const empty = raw === undefined || raw === null || val === '';
      if (op === 'is_empty' && !empty) return false;
      if (op === 'is_not_empty' && empty) return false;
      if (op === 'equals' && val !== want) return false;
      if (op === 'not_equals' && val === want) return false;
      if (op === 'contains' && !val.includes(want)) return false;
      if (op === 'not_contains' && val.includes(want)) return false;
    } else if (f.type) {
      return null;
    }
  }
  return true;
}

async function startFlow(ev, flow, contact, msg) {
  const t0 = Date.now();
  const res = await fetch(`${APP_URL}/functions/workerTrigger`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'startFlow',
      flow_id: flow.base44_id,
      contact_phone: msg.from,
      company_id: contact.company_id,
      context: { connection_id: contact.connection_id, message_text: msg.text, message_type: msg.type, whatsapp_window_open: true, _source: 'railway_engine' },
    }),
  });
  console.log(`[ENGINE] id=${ev.id} DISPAROU "${flow.name}" (${flow.trigger_type}) status=${res.status} em ${Date.now() - t0}ms`);
}

async function claim(pool, flow, phone, secs) {
  const { rows } = await pool.query(`select claim_flow_trigger($1, $2, $3) as won`, [flow.base44_id, phone, Math.round(secs)]);
  return !!rows[0]?.won;
}

async function startInboundAny(ev, pool, flow, contact, msg) {
  const secs = cooldownSeconds(flow.trigger_config);
  if (!secs) return console.log(`[ENGINE] id=${ev.id} "${flow.name}" sem cooldown — fica com o Base44`);

  const { rows: last } = await pool.query(
    `select created_at from crm_flow_executions where flow_id = $1 and contact_phone = $2 order by created_at desc limit 1`,
    [flow.base44_id, msg.from]
  );
  if (last[0] && Date.now() - new Date(last[0].created_at).getTime() < secs * 1000) {
    return console.log(`[ENGINE] id=${ev.id} "${flow.name}" em cooldown — não dispara`);
  }
  if (!(await claim(pool, flow, msg.from, secs))) return console.log(`[ENGINE] id=${ev.id} "${flow.name}" já disparado — ignorado`);
  await startFlow(ev, flow, contact, msg);
}

async function startKeyword(ev, pool, flow, contact, msg) {
  if (!keywordMatches(flow.trigger_config, msg.text)) return;
  const { rows: active } = await pool.query(
    `select 1 from crm_flow_executions where flow_id = $1 and contact_phone = $2 and status in ('running','waiting') limit 1`,
    [flow.base44_id, msg.from]
  );
  if (active.length) return console.log(`[ENGINE] id=${ev.id} "${flow.name}" já em andamento — não dispara`);
  if (!(await claim(pool, flow, msg.from, KEYWORD_CLAIM_SECONDS))) return console.log(`[ENGINE] id=${ev.id} "${flow.name}" já disparado — ignorado`);
  await startFlow(ev, flow, contact, msg);
}

async function processEvent(ev, pool) {
  const msg = parseMessage(ev.body);
  if (!msg) {
    console.log(`[ENGINE] id=${ev.id} status (sem mensagem) — ignorado`);
    return false;
  }

  const { rows: contacts } = await pool.query(
    `select id, company_id, connection_id, subscriber_active, automation_paused_until, tags, custom_fields from crm_contacts where telefone = $1 order by updated_at desc limit 1`,
    [msg.from]
  );
  const contact = contacts[0];
  console.log(`[ENGINE] id=${ev.id} de=${msg.from} tipo=${msg.type} texto="${msg.text.slice(0, 60)}" contato=${contact ? contact.id : 'NOVO'}`);
  if (!contact) return false;
  if (contact.subscriber_active === false || (contact.automation_paused_until && new Date(contact.automation_paused_until) > new Date())) {
    console.log(`[ENGINE] id=${ev.id} contato inativo ou automação pausada — sem disparo`);
    return false;
  }

  // Botões ficam com o Base44 (dependem de campanhas e menus aguardando clique)
  const types = msg.type === 'text' ? ['inbound_any', 'keyword'] : ['inbound_any'];
  const { rows: flows } = await pool.query(
    `select base44_id, name, trigger_type, trigger_config from flows where company_id = $1 and connection_id = $2 and status = 'active' and trigger_type = any($3)`,
    [contact.company_id, contact.connection_id, types]
  );
  console.log(`[ENGINE] id=${ev.id} candidatos=[${flows.map((f) => `${f.name}(${f.trigger_type})`).join(', ')}]`);

  for (const flow of flows) {
    const passes = passesContactFilters(flow.trigger_config?.contact_filters, contact);
    if (passes === null) { console.log(`[ENGINE] id=${ev.id} "${flow.name}" tem filtro de etapa — fica com o Base44`); continue; }
    if (!passes) continue;
    const run = flow.trigger_type === 'keyword' ? startKeyword : startInboundAny;
    await run(ev, pool, flow, contact, msg).catch((e) => console.error(`[ENGINE] id=${ev.id} erro em "${flow.name}":`, e.message));
  }
  return false;
}

module.exports = { isPilot, processEvent };