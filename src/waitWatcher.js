// ═══════════════════════════════════════════════════════════
// Railway retoma direto as execuções em espera (sem scheduled_jobs):
// - bloco de atraso (_wait_type = 'delay')       → retoma no próximo nó
// - saída padrão do agente de IA ('ai_agent')    → checkFlowTimeouts
// Lê crm_flow_executions (espelho do Base44) a cada 10s; uma trava
// claim_flow_trigger por execução + horário evita retomada dupla.
// ═══════════════════════════════════════════════════════════
const INTERVAL_MS = 10000;

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
        const r = await callBase44Function('workerTrigger', {
          action: 'startFlow', flow_id: ex.flow_id, contact_phone: ex.contact_phone, company_id: ex.company_id,
          context: { connection_id: ex.connection_id, _delay_resume_execution_id: ex.id, _delay_resume_next_node_id: ex.context?._wait_next_node_id || null },
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