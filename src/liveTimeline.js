// ═══════════════════════════════════════════════════════════
// Histórico em tempo real: enquanto o Railway percorre o fluxo, grava no Supabase
// cada mensagem enviada e cada aviso (fluxo iniciado, tag, campo) na hora em que acontece.
// O chat recebe tudo um a um, na ordem do fluxo.
// - Mensagens: linha provisória "wa_..." (trocada depois pela definitiva, como antes).
// - Avisos: marcados com _live; quem registra depois (Base44 ou Railway) assume a
//   mesma linha em vez de criar outra (sem aviso duplicado).
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');

const newId = () => crypto.randomBytes(12).toString('hex');

function interactiveOf(m) {
  if (m.list) return m.list;
  if (m.template_buttons) return { template_buttons: m.template_buttons };
  if (m.buttons?.length) return { buttons: m.buttons };
  return null;
}

function liveTimeline(pool, { companyId, connectionId, contactId, phone }) {
  const safe = (p) => p.catch((e) => console.warn('[LIVE] gravação falhou:', e.message));
  return {
    message: (m) => {
      if (!m.wa_id) return null;
      const json = interactiveOf(m);
      return safe(pool.query(
        `insert into crm_messages (id, company_id, contact_id, connection_id, direction, body, status, tipo, whatsapp_message_id, media_url, media_id, file_name, mime_type, interactive_data, sent_at, created_at, is_ai_generated)
         values ($1,$2,$3,$4,'outbound',$5,'sent',$6,$7,$8,$9,$10,$11,$12,$13,now(),false) on conflict (id) do nothing`,
        [`wa_${m.wa_id}`, companyId, contactId, connectionId, m.body || '', m.tipo || (m.buttons?.length ? 'interactive_buttons' : 'text'), m.wa_id,
          m.media_url || null, m.audio_media_id || null, m.file_name || null, m.audio_media_id ? 'audio/ogg' : null, json ? JSON.stringify(json) : null, m.at || new Date().toISOString()]
      ));
    },
    notice: (type, content, metadata) => safe(pool.query(
      `insert into crm_activities (id, company_id, connection_id, contact_phone, type, content, metadata, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,'Fluxo',$8)`,
      [newId(), companyId, connectionId, phone, type, content, JSON.stringify({ ...(metadata || {}), _live: true }), new Date().toISOString()]
    )),
  };
}

// Assume o aviso gravado ao vivo (mesmo tipo/conteúdo, últimos 10 min); senão cria um novo
async function claimOrInsertNotice(pool, a) {
  const { rowCount } = await pool.query(
    `update crm_activities set metadata = $6, created_by = $7 where id = (
       select id from crm_activities where company_id = $1 and connection_id is not distinct from $2 and contact_phone = $3 and type = $4
       and content is not distinct from $5 and metadata->>'_live' = 'true' and created_at > now() - interval '10 minutes' order by created_at limit 1)`,
    [a.company_id, a.connection_id, a.contact_phone, a.type, a.content, JSON.stringify(a.metadata || null), a.created_by]
  );
  if (rowCount) return;
  await pool.query(
    `insert into crm_activities (id, company_id, connection_id, contact_phone, type, content, metadata, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newId(), a.company_id, a.connection_id, a.contact_phone, a.type, a.content, a.metadata ? JSON.stringify(a.metadata) : null, a.created_by, a.created_at]
  );
}

module.exports = { liveTimeline, claimOrInsertNotice };