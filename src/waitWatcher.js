// ═══════════════════════════════════════════════════════════
// Railway retoma direto as execuções em espera (sem scheduled_jobs):
// - bloco de atraso (_wait_type = 'delay')       → retoma no próximo nó
// - saída padrão do agente de IA ('ai_agent')    → checkFlowTimeouts
// Lê crm_flow_executions (espelho do Base44) a cada 10s; uma trava
// claim_flow_trigger por execução + horário evita retomada dupla.
// ═══════════════════════════════════════════════════════════
const INTERVAL_MS = 10000;
const { runFast } = require('./fastPath');

// Continua o fluxo depois do atraso enviando direto pela Meta; o Base44 só registra e segue
async function continueFast(pool, ex, nextId) {
  try {
    const { rows: [flow] } = await pool.query(`select base44_id, name, nodes from flows where base44_id = $1 limit 1`, [ex.flow_id]);
    const { rows: [contact] } = await pool.query(
      `select id, nome, email, empresa, telefone, subscriber_active, automation_paused_until, tags, custom_fields from crm_contacts
       where telefone = $1 and connection_id = $2 limit 1`, [ex.contact_phone, ex.connection_id]);
    if (!flow || !contact || contact.subscriber_active === false || (contact.automation_paused_until && new Date(contact.automation_paused_until) > new Date())) return null;
    const loadFlow = async (id) => (await pool.query(
      `select base44_id, name, nodes from flows where base44_id = $1 and connection_id = $2 and status = 'active' limit 1`, [id, ex.connection_id])).rows[0] || null;
    const fast = await runFast(flow, nextId, { companyId: ex.company_id, connectionId: ex.connection_id, phone: ex.contact_phone, contact, loadFlow, context: ex.context || {} });
    if (fast) console.log(`[WAIT] RAILWAY ENVIOU ${(fast._railway_messages || []).length} msg(s) após atraso exec=${ex.id}`);
    return fast;
  } catch (e) {
    console.error(`[WAIT] envio direto falhou (Base44 assume) exec=${ex.id}:`, e.message);
    return null;
  }
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
           and context->>'_wait_type' in ('delay','ai_agent')
         order by delay_until limit 50`
      );
      let aiDue = false;
      for (const ex of rows) {
        const key = `wait:${ex.id}:${new Date(ex.delay_until).getTime()}`;
        const { rows: c } = await pool.query(`select claim_flow_trigger($1, $2, $3) as won`, [key, ex.contact_phone, 86400]);
        if (!c[0]?.won) continue;
        if (ex.context?._wait_type === 'ai_agent') { aiDue = true; continue; }
        const nextId = ex.context?._wait_next_node_id || null;
        const fast = nextId ? await continueFast(pool, ex, nextId) : null;
        const r = await callBase44Function('workerTrigger', {
          action: 'startFlow', flow_id: ex.flow_id, contact_phone: ex.contact_phone, company_id: ex.company_id,
          context: { connection_id: ex.connection_id, _delay_resume_execution_id: ex.id, _delay_resume_next_node_id: nextId, ...(fast ? { _railway_fast: fast } : {}) },
          reference_id: key,
        }).catch((e) => ({ ok: false, error: e.message }));
        console.log(`[WAIT] atraso retomado exec=${ex.id} ok=${r?.ok} ${r?.error || ''}`);
      }
      if (aiDue) {
        const r = await callBase44Function('checkFlowTimeouts', {}).catch((e) => ({ ok: false, error: e.message }));
        console.log(`[WAIT] saída padrão da IA processada ok=${r?.ok !== false}`);
      }
    } catch (e) {
      console.error('[WAIT] erro:', e.message);
    } finally {
      busy = false;
    }
  }, INTERVAL_MS);
}

module.exports = { startWaitWatcher };