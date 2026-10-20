// ═══════════════════════════════════════════════════════════
// Fase 3.1 — Gateway do webhook da Meta no Railway
//   GET  /webhook/whatsapp — verificação da Meta (hub.challenge)
//   POST /webhook/whatsapp — valida assinatura, grava em webhook_events,
//                            responde 200 na hora e repassa ao Base44.
// Eventos que falharem ficam 'pending' e são reenviados a cada 15s.
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');
const engine = require('./railwayEngine');
const { recordInbound } = require('./inboundRecorder');

const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;
const MAX_ATTEMPTS = 5;
const RETRY_INTERVAL_MS = 15000;

function validSignature(raw, signature) {
  if (!APP_SECRET || !/^sha256=[a-f0-9]{64}$/i.test(signature || '')) return false;
  const expected = crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature.slice(7), 'hex'));
}

function phoneNumberIdOf(raw) {
  try { return JSON.parse(raw).entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id || null; }
  catch { return null; }
}

async function forward(getPool, ev) {
  const pool = getPool();
  // Grava a mensagem no Supabase (e cria o contato novo) antes do motor procurar pelo contato
  const recorded = recordInbound(pool, ev).catch((e) => { console.error(`[INBOUND] gravação falhou id=${ev.id} (Base44 grava):`, e.message); return null; });
  try {
    if (engine.isPilot(ev.phone_number_id)) {
      await recorded;
      const handled = await engine.processEvent(ev, pool).catch((e) => {
        console.error(`[ENGINE] falhou id=${ev.id}, usando Base44:`, e.message);
        return false;
      });
      if (handled) {
        await pool.query(`update webhook_events set status='done', attempts=attempts+1, processed_at=now() where id=$1`, [ev.id]);
        return;
      }
    }
    // O Base44 só processa depois que a cópia existe (evita mensagem duplicada) e o áudio foi transcrito
    await (await recorded)?.transcript;
    const res = await fetch(`${APP_URL}/functions/whatsappWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': ev.signature },
      body: ev.body,
    });
    if (!res.ok) throw new Error(`status ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await pool.query(`update webhook_events set status='done', attempts=attempts+1, processed_at=now() where id=$1`, [ev.id]);
  } catch (e) {
    console.error(`[WEBHOOK] repasse falhou id=${ev.id}:`, e.message);
    await pool.query(
      `update webhook_events set attempts=attempts+1, last_error=$2, status=case when attempts+1 >= $3 then 'failed' else 'pending' end where id=$1`,
      [ev.id, e.message, MAX_ATTEMPTS]
    );
  }
}

async function handleWebhook(req, res, url, getPool) {
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === VERIFY_TOKEN;
    res.writeHead(ok ? 200 : 403, { 'Content-Type': 'text/plain' });
    return res.end(ok ? url.searchParams.get('hub.challenge') : 'Forbidden');
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const signature = req.headers['x-hub-signature-256'] || '';
  if (!validSignature(raw, signature)) {
    res.writeHead(401);
    return res.end('Unauthorized');
  }

  const { rows } = await getPool().query(
    `insert into webhook_events (body, signature, phone_number_id) values ($1,$2,$3) returning id, body, signature, phone_number_id`,
    [raw, signature, phoneNumberIdOf(raw)]
  );
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
  forward(getPool, rows[0]);
}

function startWebhookRetries(getPool) {
  setInterval(async () => {
    const pool = getPool();
    if (!pool) return;
    const { rows } = await pool.query(
      `select id, body, signature, phone_number_id from webhook_events where status='pending' and received_at < now() - interval '20 seconds' order by received_at limit 20`
    ).catch(() => ({ rows: [] }));
    for (const ev of rows) await forward(getPool, ev);
  }, RETRY_INTERVAL_MS);
}

module.exports = { handleWebhook, startWebhookRetries };