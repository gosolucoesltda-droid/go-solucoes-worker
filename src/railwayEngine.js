// ═══════════════════════════════════════════════════════════
// Fase 4 — Motor de fluxos no Railway (piloto)
// Só processa bots listados em RAILWAY_ENGINE_PHONE_IDS (separados por vírgula).
// Retorna true quando processou; false = deixa o Base44 processar.
// Etapa 2: modo observação — lê mensagem, contato e fluxos candidatos,
// registra nos logs e devolve false (Base44 continua respondendo).
// ═══════════════════════════════════════════════════════════
const PILOT_IDS = (process.env.RAILWAY_ENGINE_PHONE_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const INBOUND_TRIGGERS = ['keyword', 'button_click', 'inbound_any', 'inbound_audio', 'inbound_image', 'inbound_file', 'inbound_referral'];

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

async function processEvent(ev, pool) {
  const msg = parseMessage(ev.body);
  if (!msg) {
    console.log(`[ENGINE] id=${ev.id} status (sem mensagem) — ignorado`);
    return false;
  }

  const { rows: contacts } = await pool.query(
    `select id, company_id, connection_id, nome, tags from crm_contacts where telefone = $1 order by updated_at desc limit 1`,
    [msg.from]
  );
  const contact = contacts[0];
  console.log(`[ENGINE] id=${ev.id} de=${msg.from} tipo=${msg.type} texto="${msg.text.slice(0, 60)}" contato=${contact ? contact.id : 'NOVO'}`);
  if (!contact) return false;

  const { rows: flows } = await pool.query(
    `select base44_id, name, trigger_type, trigger_config from flows where company_id = $1 and connection_id = $2 and status = 'active' and trigger_type = any($3)`,
    [contact.company_id, contact.connection_id, INBOUND_TRIGGERS]
  );
  const lower = msg.text.toLowerCase();
  const matches = flows.filter((f) => {
    if (f.trigger_type !== 'keyword') return f.trigger_type === 'inbound_any' || f.trigger_type === `inbound_${msg.type}`;
    const kws = [].concat(f.trigger_config?.keywords || f.trigger_config?.keyword || []);
    return kws.some((k) => k && lower.includes(String(k).toLowerCase()));
  });
  console.log(`[ENGINE] id=${ev.id} fluxos ativos=${flows.length} candidatos=[${matches.map((f) => f.name).join(', ')}]`);
  return false; // observação: Base44 continua processando
}

module.exports = { isPilot, processEvent };