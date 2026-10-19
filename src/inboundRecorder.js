// ═══════════════════════════════════════════════════════════
// O Railway grava a mensagem recebida direto no Supabase assim que ela chega
// (o chat atualiza na hora, antes do fluxo/IA rodar). Contato novo é criado aqui
// e o áudio é transcrito aqui (quando a empresa tem chave OpenAI).
// O Base44 continua cuidando do resto (fluxos, links personalizados, anúncios) e só troca a linha provisória pela definitiva.
// Reação e cartão de contato ficam com o Base44 como antes.
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');
const { transcribeAudio } = require('./audioTranscribe');

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

const CONTACT_SQL = `select id, company_id, connection_id from crm_contacts where telefone = $1 and connection_id = $2 order by created_at limit 1`;

// Busca o contato do bot ou cria (mesmo id de 24 caracteres do Base44). A trava evita dois contatos
// quando duas mensagens do mesmo número novo chegam juntas.
async function ensureContact(pool, conn, phone, nome) {
  const { rows: [found] } = await pool.query(CONTACT_SQL, [phone, conn.id]);
  if (found) return found;
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`contact:${conn.id}:${phone}`]);
    let { rows: [ct] } = await c.query(CONTACT_SQL, [phone, conn.id]);
    if (!ct) {
      ({ rows: [ct] } = await c.query(
        `insert into crm_contacts (id, company_id, connection_id, telefone, nome, nao_lidas, created_at, updated_at)
         values ($1, $2, $3, $4, $5, 0, now(), now()) returning id, company_id, connection_id`,
        [crypto.randomBytes(12).toString('hex'), conn.company_id, conn.id, phone, nome]
      ));
      console.log(`[INBOUND] contato novo criado no Supabase: ${ct.id}`);
    }
    await c.query('commit');
    return ct;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function recordInbound(pool, ev) {
  const value = JSON.parse(ev.body).entry?.[0]?.changes?.[0]?.value || {};
  const msg = value.messages?.[0];
  const fields = msg?.id ? inboundFields(msg) : null;
  if (!fields) return null;
  const { rows: [conn] } = await pool.query(
    `select id, company_id from crm_whatsapp_connections where phone_number_id = $1 limit 1`, [ev.phone_number_id]);
  if (!conn) return null;
  const nome = value.contacts?.[0]?.profile?.name || msg.from;
  const contact = await ensureContact(pool, conn, msg.from, nome);

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

  const bsuid = msg.from_user_id || value.contacts?.[0]?.user_id || '';
  await pool.query(
    `update crm_contacts set nome = $2, ultima_mensagem = $3, ultima_mensagem_em = $4, ultima_inbound_em = $4,
       nao_lidas = nao_lidas + 1, bsuid = coalesce(bsuid, nullif($5, '')), updated_at = now() where id = $1`,
    [contact.id, nome, fields.body, at, bsuid]
  );
  // O Supabase é o banco do painel: o chat recebe em tempo real direto daqui (sem cópia no Base44)
  console.log(`[INBOUND] id=${ev.id} gravada no Supabase em ${Date.now() - t0}ms`);

  // Áudio: transcreve e troca o "[Áudio]" pelo texto (o Base44 reaproveita e não transcreve de novo)
  const transcript = fields.tipo !== 'audio' ? Promise.resolve(null)
    : transcribeAudio(contact.company_id, contact.connection_id, mediaId, fields.mime_type).then(async (text) => {
      if (!text) return null;
      await pool.query(`update crm_messages set body = $2 where id = $1`, [`wa_${msg.id}`, text]);
      await pool.query(`update crm_contacts set ultima_mensagem = $2 where id = $1`, [contact.id, text.slice(0, 200)]);
      return text;
    }).catch((e) => { console.error('[INBOUND] transcrição não gravada:', e.message); return null; });
  return { ok: true, transcript };
}

module.exports = { recordInbound };