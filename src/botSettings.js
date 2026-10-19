// Credenciais de envio e configuração da IA lidas direto do Supabase (sem pedir ao Base44).
// null = ainda não copiado ou falhou: quem chama pede ao Base44 como antes.
const { unseal } = require('./seal');
let pool = null;

function setBotSettingsPool(p) { pool = p; }

async function loadCreds(companyId, connectionId) {
  if (!pool || !connectionId) return null;
  try {
    const { rows: [r] } = await pool.query(
      `select phone_number_id, waba_id, access_token_sealed from crm_whatsapp_connections where id = $1 and company_id = $2`,
      [connectionId, companyId],
    );
    if (!r?.phone_number_id || !r.access_token_sealed) return null;
    return { ok: true, phone_number_id: r.phone_number_id, access_token: await unseal(r.access_token_sealed), waba_id: r.waba_id || null };
  } catch (e) {
    console.error('[SETTINGS] credenciais pelo Supabase falharam (Base44 assume):', e.message);
    return null;
  }
}

async function loadAiBundle(companyId) {
  if (!pool) return null;
  try {
    const { rows: [r] } = await pool.query(
      `select agent, openai_key_sealed, elevenlabs, elevenlabs_key_sealed from crm_ai_settings where company_id = $1`,
      [companyId],
    );
    if (!r) return null;
    return {
      ok: true,
      agent: r.agent || null,
      openai_key: r.openai_key_sealed ? await unseal(r.openai_key_sealed) : null,
      el: { ...(r.elevenlabs || {}), key: r.elevenlabs_key_sealed ? await unseal(r.elevenlabs_key_sealed) : null },
    };
  } catch (e) {
    console.error('[SETTINGS] IA pelo Supabase falhou (Base44 assume):', e.message);
    return null;
  }
}

module.exports = { setBotSettingsPool, loadCreds, loadAiBundle };