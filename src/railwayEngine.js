// ═══════════════════════════════════════════════════════════
// Fase 4 — Motor de fluxos no Railway (piloto)
// Só processa bots listados em RAILWAY_ENGINE_PHONE_IDS (separados por vírgula).
// Retorna true quando processou; false = deixa o Base44 processar.
// Etapa 1: apenas o desvio — o motor ainda devolve false (Base44 de reserva).
// ═══════════════════════════════════════════════════════════
const PILOT_IDS = (process.env.RAILWAY_ENGINE_PHONE_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function isPilot(phoneNumberId) {
  return !!phoneNumberId && PILOT_IDS.includes(phoneNumberId);
}

async function processEvent(ev) {
  console.log(`[ENGINE] piloto recebeu evento id=${ev.id} phone_number_id=${ev.phone_number_id}`);
  return false; // etapas 2+ implementam o processamento aqui
}

module.exports = { isPilot, processEvent };