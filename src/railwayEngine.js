// ═══════════════════════════════════════════════════════════
// Fase 4 — Motor de fluxos no Railway (piloto, modo híbrido)
// Só processa bots listados em RAILWAY_ENGINE_PHONE_IDS (separados por vírgula).
// O Railway decide qual fluxo "inbound_any" dispara e já inicia o fluxo pelo
// workerTrigger (sem esperar o webhook do Base44). Ele grava a trava
// claim_flow_trigger antes, então quando o Base44 processar a mesma mensagem
// a trava já está ocupada e ele não dispara de novo.
// Sempre retorna false: o Base44 continua salvando a mensagem e cuidando
// de palavras-chave, botões e demais gatilhos.
// ═══════════════════════════════════════════════════════════
const PILOT_IDS = (process.env.RAILWAY_ENGINE_PHONE_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const WORKER_SECRET = process.env.WORKER_SECRET;

const INBOUND_TRIGGERS = ['keyword', 'button_click', 'inbound_any', 'inbound_audio', 'inbound_image', 'inbound_file', 'inbound_referral'];
const UNIT_SECONDS = { minutes: 60, hours: 3600, days: 86400 };

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

  const { rows: claim } = await pool.query(`select claim_flow_trigger($1, $2, $3) as won`, [flow.base44_id, msg.from, Math.round(secs)]);
  if (!claim[0]?.won) return console.log(`[ENGINE] id=${ev.id} "${flow.name}" já disparado — ignorado`);

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
  console.log(`[ENGINE] id=${ev.id} DISPAROU "${flow.name}" status=${res.status} em ${Date.now() - t0}ms`);
}

async function processEvent(ev, pool) {
  const msg = parseMessage(ev.body);
  if (!msg) {
    console.log(`[ENGINE] id=${ev.id} status (sem mensagem) — ignorado`);
    return false;
  }

  const { rows: contacts } = await pool.query(
    `select id, company_id, connection_id, subscriber_active, automation_paused_until from crm_contacts where telefone = $1 order by updated_at desc limit 1`,
    [msg.from]
  );
  const contact = contacts[0];
  console.log(`[ENGINE] id=${ev.id} de=${msg.from} tipo=${msg.type} texto="${msg.text.slice(0, 60)}" contato=${contact ? contact.id : 'NOVO'}`);
  if (!contact) return false;
  if (contact.subscriber_active === false || (contact.automation_paused_until && new Date(contact.automation_paused_until) > new Date())) {
    console.log(`[ENGINE] id=${ev.id} contato inativo ou automação pausada — sem disparo`);
    return false;
  }

  const { rows: flows } = await pool.query(
    `select base44_id, name, trigger_type, trigger_config from flows where company_id = $1 and connection_id = $2 and status = 'active' and trigger_type = any($3)`,
    [contact.company_id, contact.connection_id, INBOUND_TRIGGERS]
  );
  const anyFlows = flows.filter((f) => f.trigger_type === 'inbound_any');
  console.log(`[ENGINE] id=${ev.id} fluxos ativos=${flows.length} inbound_any=[${anyFlows.map((f) => f.name).join(', ')}]`);

  for (const flow of anyFlows) {
    await startInboundAny(ev, pool, flow, contact, msg).catch((e) => console.error(`[ENGINE] id=${ev.id} erro em "${flow.name}":`, e.message));
  }
  return false; // Base44 continua salvando a mensagem e tratando os demais gatilhos
}

module.exports = { isPilot, processEvent };