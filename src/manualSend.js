// Envio manual do chat: o Base44 valida e monta a mensagem, o Railway entrega na Meta.
// Com `media` (áudio, imagem, vídeo, arquivo), o Railway também sobe o arquivo e coloca o id em payload[payload.type].id.
// Resposta { sent: true, message_id, media_id } ou { sent: false, error } — em ambos o Railway assumiu o envio.
const WORKER_SECRET = process.env.WORKER_SECRET;
const GRAPH = 'https://graph.facebook.com/v22.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mediaBytes(media) {
  if (media.url) {
    const r = await fetch(media.url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('Falha ao baixar o arquivo da URL');
    return Buffer.from(await r.arrayBuffer());
  }
  const clean = media.base64.includes(',') ? media.base64.split(',')[1] : media.base64;
  return Buffer.from(clean, 'base64');
}

async function uploadMedia(phone_number_id, access_token, media) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', media.mime_type);
  form.append('file', new Blob([await mediaBytes(media)], { type: media.mime_type }), media.filename);
  const r = await fetch(`${GRAPH}/${phone_number_id}/media`, {
    method: 'POST', headers: { Authorization: `Bearer ${access_token}` }, body: form, signal: AbortSignal.timeout(40000),
  });
  const data = await r.json();
  if (!data.id) throw new Error(data.error?.message || 'Falha no upload do arquivo');
  return data.id;
}

async function handleManualSend(req, res) {
  const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if ((req.headers.authorization || '') !== `Bearer ${WORKER_SECRET}`) return reply(401, { ok: false });
  let body = '';
  for await (const chunk of req) body += chunk;
  const t0 = Date.now();
  try {
    const { phone_number_id, access_token, payload, media } = JSON.parse(body);
    let media_id;
    if (media) {
      media_id = await uploadMedia(phone_number_id, access_token, media);
      payload[payload.type] = { ...payload[payload.type], id: media_id };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`${GRAPH}/${phone_number_id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json();
      const id = data.messages?.[0]?.id;
      if (id) {
        console.log(`[MANUAL-SEND] RAILWAY ENVIOU ${payload.type} para ${payload.to} em ${Date.now() - t0}ms`);
        return reply(200, { ok: true, sent: true, message_id: id, media_id });
      }
      const code = data.error?.code;
      // Limite da Meta ou instabilidade dela: a mensagem não saiu, tenta de novo
      if ((code === 130429 || code === 80007 || r.status >= 500) && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
      console.warn('[MANUAL-SEND] Meta recusou:', JSON.stringify(data.error || r.status));
      return reply(200, { ok: true, sent: false, error: data.error?.message || `HTTP ${r.status}` });
    }
  } catch (e) {
    console.error('[MANUAL-SEND] falhou:', e.message);
    return reply(200, { ok: true, sent: false, error: e.message });
  }
}

module.exports = { handleManualSend };