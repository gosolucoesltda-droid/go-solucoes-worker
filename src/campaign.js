// Disparo de campanhas pelo Railway: o Base44 entrega a lista pronta, o Railway envia
// em paralelo pela Meta, grava as mensagens no Supabase e devolve os resultados em blocos.
const WORKER_SECRET = process.env.WORKER_SECRET;
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const CONCURRENCY = 8;
const FLUSH_EVERY = 50;
const running = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendOne(job, s) {
  const template = { name: job.template.name, language: { code: job.template.language || 'pt_BR' }, ...(s.components?.length ? { components: s.components } : {}) };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://graph.facebook.com/v22.0/${job.phone_number_id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${job.access_token}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: s.phone, type: 'template', template }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json();
      const id = data.messages?.[0]?.id;
      if (id) return { wa_id: id };
      const code = data.error?.code;
      // Limite de envio da Meta ou instabilidade: espera e tenta de novo
      if ((code === 130429 || code === 80007 || res.status >= 500) && attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      return { error: data.error?.message || `HTTP ${res.status}` };
    } catch (e) {
      if (attempt < 2) { await sleep(2000); continue; }
      return { error: e.message };
    }
  }
}

async function report(job, results, totals, done) {
  const body = JSON.stringify({ campaign_id: job.campaign_id, company_id: job.company_id, connection_id: job.connection_id, display: job.display, results, ...totals, done });
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`${APP_URL}/functions/campaignResults`, { method: 'POST', headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' }, body });
      if (res.ok) return;
      console.warn(`[CAMPAIGN] registro no Base44 falhou (${res.status}) — tentando de novo`);
    } catch (e) { console.warn('[CAMPAIGN] registro no Base44 falhou:', e.message); }
    await sleep(5000 * (i + 1));
  }
  console.error(`[CAMPAIGN] ${job.campaign_id}: bloco de ${results.length} resultados não registrado`);
}

async function recordSupabase(pool, job, results) {
  if (!pool) return;
  for (const r of results.filter((x) => x.wa_id && x.contact_id)) {
    await pool.query(
      `insert into crm_messages (id, company_id, contact_id, connection_id, direction, body, status, tipo, whatsapp_message_id, interactive_data, sent_at, created_at, is_ai_generated)
       values ($1, $2, $3, $4, 'outbound', $5, 'sent', $6, $7, $8, $9, now(), false) on conflict (id) do nothing`,
      [`wa_${r.wa_id}`, job.company_id, r.contact_id, job.connection_id, r.body || '', job.display?.tipo || 'template', r.wa_id,
        job.display?.interactive_data ? JSON.stringify(job.display.interactive_data) : null, r.at]
    ).catch((e) => console.warn('[CAMPAIGN] Supabase:', e.message));
  }
}

async function run(job, pool) {
  const t0 = Date.now();
  let next = 0, sent = 0, failed = 0, pending = [];
  let chain = Promise.resolve();
  const flush = (done) => {
    const batch = pending; pending = [];
    const totals = { sent, failed };
    chain = chain.then(() => Promise.all([report(job, batch, totals, done), recordSupabase(pool, job, batch)]));
    return chain;
  };
  try {
    const worker = async () => {
      while (next < job.sends.length) {
        const s = job.sends[next++];
        const r = await sendOne(job, s);
        r.wa_id ? sent++ : failed++;
        pending.push({ phone: s.phone, contact_id: s.contact_id, body: s.body, at: new Date().toISOString(), ...r });
        if (pending.length >= FLUSH_EVERY) flush(false);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } catch (e) {
    console.error(`[CAMPAIGN] ${job.campaign_id} erro:`, e.message);
  } finally {
    await flush(true);
    running.delete(job.campaign_id);
    console.log(`[CAMPAIGN] ${job.campaign_id} concluída: ${sent} enviadas, ${failed} falhas em ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}

async function handleCampaign(req, res, pool) {
  const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if ((req.headers.authorization || '') !== `Bearer ${WORKER_SECRET}`) return reply(401, { ok: false, error: 'Unauthorized' });
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let job;
  try { job = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'JSON inválido' }); }
  if (!job.campaign_id || !job.phone_number_id || !job.access_token || !Array.isArray(job.sends)) return reply(400, { ok: false, error: 'Dados da campanha incompletos' });
  if (running.has(job.campaign_id)) return reply(409, { ok: false, error: 'Campanha já em envio' });
  running.add(job.campaign_id);
  console.log(`[CAMPAIGN] ${job.campaign_id}: ${job.sends.length} destinatários`);
  reply(202, { ok: true, total: job.sends.length });
  run(job, typeof pool === 'function' ? pool() : pool);
}

module.exports = { handleCampaign };