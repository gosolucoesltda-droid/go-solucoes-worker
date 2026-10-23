// Envio manual do chat: o Base44 valida e monta a mensagem, o Railway entrega na Meta.
// Resposta { sent: true, message_id } ou { sent: false, error } — em ambos o Railway assumiu o envio.
const WORKER_SECRET = process.env.WORKER_SECRET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handleManualSend(req, res) {
  const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if ((req.headers.authorization || '') !== `Bearer ${WORKER_SECRET}`) return reply(401, { ok: false });
  let body = '';
  for await (const chunk of req) body += chunk;
  const t0 = Date.now();
  try {
    const { phone_number_id, access_token, payload } = JSON.parse(body);
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`https://graph.facebook.com/v22.0/${phone_number_id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json();
      const id = data.messages?.[0]?.id;
      if (id) {
        console.log(`[MANUAL-SEND] RAILWAY ENVIOU para ${payload.to} em ${Date.now() - t0}ms`);
        return reply(200, { ok: true, sent: true, message_id: id });
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