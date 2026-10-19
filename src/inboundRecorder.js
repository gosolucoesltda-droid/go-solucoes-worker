// ═══════════════════════════════════════════════════════════
// Fase 2 — O Railway grava a mensagem recebida direto no Supabase assim que
// ela chega e já manda a cópia para o painel (o chat atualiza na hora, antes
// do fluxo/IA rodar). O Base44 continua cuidando do resto (fluxos, mídia,
// transcrição), mas não grava a mensagem de novo.
// Contato novo, reação e cartão de contato ficam com o Base44 como antes.
// ═══════════════════════════════════════════════════════════
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const WORKER_SECRET = process.env.WORKER_SECRET;

// Mesmo formato que o Base44 grava (corpo + campos de mídia)
function inboundFields(msg) {
  const t = msg.type || 'text';
  const m = msg[t] || {};
  const media = (key) => ({ [key]: m.id || '', mime_type: m.mime_type || '' });
  switch (t) {
    case 'text': return { tipo: t, body: msg.text?.body || '' };
    case 'audio': return { tipo: t, body: '[Áudio]', ...media('audio_media_id') };
    case 'image': return { tipo: t, body: m.caption || '[Imagem]', ...media('image_media_id') };
    case 'video': return { tipo: t, body: m.caption || '[Vídeo]', ...media('video_media_id') };
    case 'document': return { tipo: t, body: m.filename || '[Documento]', file_name: m.filename || '', ...media('document_media_id') };
    case 'sticker': return { tipo: t, body: '[Sticker]', ...media('image_media_id') };
    case 'button': return { tipo: t, body: msg.button?.text || '[Botão]' };
    case 'interactive': return { tipo: t, body: msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[Interação]' };
    case 'reaction': case 'contacts': return null;
    default: return { tipo: t, body: `[${t}]` };
  }
}

async function recordInbound(pool, ev) {
  const value = JSON.parse(ev.body).entry?.[0]?.changes?.[0]?.value || {};
  const msg = value.messages?.[0];
  const fields = msg?.id ? inboundFields(msg) : null;
  if (!fields) return null;
  const { rows: [contact] } = await pool.query(
    `select id, company_id, connection_id from crm_contacts
     where telefone = $1 and connection_id = (select connection_id from flows where phone_number_id = $2 limit 1) limit 1`,
    [msg.from, ev.phone_number_id]
  );
  if (!contact) return null;

  const t0 = Date.now();
  const at = new Date(parseInt(msg.timestamp) * 1000).toISOString();
  const mediaId = fields.audio_media_id || fields.image_media_id || fields.video_media_id || fields.document_media_id || null;
  const { rows: ins } = await pool.query(
    `insert into crm_messages (id, company_id, contact_id, connection_id, direction, body, status, tipo, whatsapp_message_id, media_id, file_name, mime_type, sent_at, created_at, is_ai_generated)
     select $1, $2, $3, $4, 'inbound', $5, 'received', $6, $7, $8, $9, $10, $11, now(), false
     where not exists (select 1 from crm_messages where whatsapp_message_id = $7) returning id`,
    [`wa_${msg.id}`, contact.company_id, contact.id, contact.connection_id, fields.body, fields.tipo, msg.id, mediaId, fields.file_name || null, fields.mime_type || null, at]
  );
  if (!ins.length) return null; // já gravada (reenvio da Meta)

  const nome = value.contacts?.[0]?.profile?.name || msg.from;
  const bsuid = msg.from_user_id || value.contacts?.[0]?.user_id || '';
  await pool.query(
    `update crm_contacts set nome = $2, ultima_mensagem = $3, ultima_mensagem_em = $4, ultima_inbound_em = $4,
       nao_lidas = nao_lidas + 1, bsuid = coalesce(bsuid, nullif($5, '')), updated_at = now() where id = $1`,
    [contact.id, nome, fields.body, at, bsuid]
  );

  // Cópia para o painel (o chat do Base44 recebe em tempo real)
  const res = await fetch(`${APP_URL}/functions/workerTrigger`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'recordInbound', company_id: contact.company_id, contact_phone: msg.from,
      context: { connection_id: contact.connection_id, contact_id: contact.id, nome, bsuid, message: { whatsapp_message_id: msg.id, timestamp: at, ...fields } },
    }),
  });
  const data = await res.json().catch(() => ({}));
  console.log(`[INBOUND] id=${ev.id} gravada no Supabase, cópia no painel ok=${!!data.ok} em ${Date.now() - t0}ms ${data.error || ''}`);
  return data.ok ? data : null;
}

module.exports = { recordInbound };