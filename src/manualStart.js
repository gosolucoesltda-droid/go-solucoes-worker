// Botão "Iniciar fluxo" do painel: Railway envia os primeiros blocos direto pela Meta
// e devolve o que enviou; o Base44 só registra e continua o restante.
const { runFast, firstNodeId } = require('./fastPath');
const { recordFast } = require('./supabaseRecorder');
const WORKER_SECRET = process.env.WORKER_SECRET;

async function handleManualStart(req, res, pool) {
  const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if ((req.headers.authorization || '') !== `Bearer ${WORKER_SECRET}`) return reply(401, { ok: false });
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { flow_id, contact_phone, company_id, connection_id } = JSON.parse(body);
    const { rows: [flow] } = await pool.query(
      `select base44_id, name, nodes from flows where base44_id = $1 and status = 'active' limit 1`, [flow_id]);
    const { rows: [contact] } = await pool.query(
      `select id, nome, email, empresa, telefone, tags, custom_fields from crm_contacts where telefone = $1 and connection_id = $2 limit 1`,
      [contact_phone, connection_id]);
    if (!flow || !contact) return reply(200, { fast: null });
    const loadFlow = async (id) => (await pool.query(
      `select base44_id, name, nodes from flows where base44_id = $1 and connection_id = $2 and status = 'active' limit 1`, [id, connection_id])).rows[0] || null;
    const fast = await runFast(flow, firstNodeId(flow), { companyId: company_id, connectionId: connection_id, phone: contact_phone, contact, loadFlow, fresh: true, windowOpen: true });
    if (fast) console.log(`[MANUAL] RAILWAY ENVIOU ${(fast._railway_messages || []).length} msg(s) de "${flow.name}"`);
    await recordFast(pool, { companyId: company_id, connectionId: connection_id, contactId: contact.id, phone: contact_phone, flow, fast, startNodeId: firstNodeId(flow) });
    reply(200, { fast });
  } catch (e) {
    console.error('[MANUAL] falhou (Base44 assume):', e.message);
    reply(200, { fast: null });
  }
}

module.exports = { handleManualStart };