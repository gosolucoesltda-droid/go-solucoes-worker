// ═══════════════════════════════════════════════════════════
// Railway retoma direto as execuções em espera (sem scheduled_jobs):
// - bloco de atraso (_wait_type = 'delay')       → retoma no próximo nó
// (tempos limite de resposta e da IA ficam no timeoutWatcher.js)
// Lê crm_flow_executions a cada 10s; uma trava claim_flow_trigger por
// execução + horário evita retomada dupla.
// Quando todo o caminho depois do atraso é do Railway, ele mesmo registra a
// execução (ownResume); senão o Base44 continua como antes.
// ═══════════════════════════════════════════════════════════
const INTERVAL_MS = 10000;
const { runFast } = require('./fastPath');
const { recordFast } = require('./supabaseRecorder');
const { liveTimeline } = require('./liveTimeline');
const { ownResume } = require('./flowOwner');

// Continua o fluxo depois do atraso enviando direto pela Meta
async function continueFast(pool, ex, nextId) {
  try {
    const { rows: [flow] } = await pool.query(`select base44_id, name, nodes, trigger_type from flows where base44_id = $1 limit 1`, [ex.flow_id]);
    const { rows: [contact] } = await pool.query(
      `select id, company_id, connection_id, nome, email, empresa, telefone, subscriber_active, automation_paused_until, tags, custom_fields from crm_contacts
       where telefone = $1 and connection_id = $2 limit 1`, [ex.contact_phone, ex.connection_id]);
    if (!flow || !contact || contact.subscriber_active === false || (contact.automation_paused_until && new Date(contact.automation_paused_until) > new Date())) return null;
    const loadFlow = async (id) => (await pool.query(
      `select base44_id, name, nodes from flows where base44_id = $1 and connection_id = $2 and status = 'active' limit 1`, [id, ex.connection_id])).rows[0] || null;
    const live = liveTimeline(pool, { companyId: ex.company_id, connectionId: ex.connection_id, contactId: contact.id, phone: ex.contact_phone });
    const fast = await runFast(flow, nextId, { companyId: ex.company_id, connectionId: ex.connection_id, phone: ex.contact_phone, contact, loadFlow, context: ex.context || {}, live });
    if (fast) console.log(`[WAIT] RAILWAY ENVIOU ${(fast._railway_messages || []).length} msg(s) após atraso exec=${ex.id}`);
    return fast ? { fast, flow, contact } : null;
  } catch (e) {
    console.error(`[WAIT] envio direto falhou (Base44 assume) exec=${ex.id}:`, e.message);
    return null;
  }
}

async function resumeDelay(pool, ex, callBase44Function, key) {
  const nextId = ex.context?._wait_next_node_id || null;
  const ctx = { ...(ex.context || {}) };
  delete ctx._wait_type; delete ctx._wait_next_node_id;
  if (!nextId) {
    await pool.query(`update crm_flow_executions set status = 'completed', completed_at = now(), delay_until = null, context = $2, updated_at = now() where id = $1`, [ex.id, JSON.stringify(ctx)]);
    console.log(`[WAIT] atraso no fim do fluxo — concluído exec=${ex.id}`);
    return;
  }
  const run = await continueFast(pool, ex, nextId);
  const fast = run?.fast || null;
  // Caminho todo do Railway: ele mesmo registra (sem chamar o Base44)
  if (fast) {
    const owned = await ownResume(pool, { exec: ex, flow: run.flow, contact: run.contact, phone: ex.contact_phone, fast, ctx })
      .catch((e) => { console.error(`[WAIT] registro falhou (Base44 assume) exec=${ex.id}:`, e.message); return false; });
    if (owned) return;
    // Só grava as mensagens: a execução continua "waiting" até o Base44 retomar e registrar
    await recordFast(pool, { companyId: ex.company_id, connectionId: ex.connection_id, contactId: run.contact.id, phone: ex.contact_phone, fast: { _railway_messages: fast._railway_messages || [], _railway_jump: fast._railway_jump } });
  }
  const r = await callBase44Function('workerTrigger', {
    action: 'startFlow', flow_id: ex.flow_id, contact_phone: ex.contact_phone, company_id: ex.company_id,
    context: { connection_id: ex.connection_id, _delay_resume_execution_id: ex.id, _delay_resume_next_node_id: nextId, ...(fast ? { _railway_fast: fast } : {}) },
    reference_id: key,
  }).catch((e) => ({ ok: false, error: e.message }));
  console.log(`[WAIT] atraso retomado pelo Base44 exec=${ex.id} ok=${r?.ok} ${r?.error || ''}`);
}

function startWaitWatcher(pool, callBase44Function) {
  let busy = false;
  setInterval(async () => {
    if (busy || !pool) return;
    busy = true;
    try {
      const { rows } = await pool.query(
        `select id, company_id, connection_id, flow_id, contact_phone, delay_until, context
         from crm_flow_executions
         where status = 'waiting' and delay_until <= now() and delay_until > now() - interval '7 days'
           and context->>'_wait_type' = 'delay'
         order by delay_until limit 50`
      );
      for (const ex of rows) {
        const key = `wait:${ex.id}:${new Date(ex.delay_until).getTime()}`;
        const { rows: c } = await pool.query(`select claim_flow_trigger($1, $2, $3) as won`, [key, ex.contact_phone, 86400]);
        if (!c[0]?.won) continue;
        await resumeDelay(pool, ex, callBase44Function, key).catch((e) => console.error(`[WAIT] erro exec=${ex.id}:`, e.message));
      }
    } catch (e) {
      console.error('[WAIT] erro:', e.message);
    } finally {
      busy = false;
    }
  }, INTERVAL_MS);
}

module.exports = { startWaitWatcher };