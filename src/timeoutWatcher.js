// ═══════════════════════════════════════════════════════════
// Fase 5 — Tempos limite resolvidos pelo Railway (mesmas regras do Base44: flowTimeoutsCheck.ts)
// - pergunta/espera de resposta vencida ('reply')  → segue pela saída de tempo esgotado
// - espera do agente de IA vencida ('ai_agent')    → segue pela saída padrão do agente
// Lê crm_flow_executions a cada 10s. A trava (status waiting → running) evita retomada dupla;
// o Base44 só age como reserva 2 min depois do vencimento.
// ═══════════════════════════════════════════════════════════
/* global require, module */
const { runFast } = require('./fastPath');
const { liveTimeline } = require('./liveTimeline');
const { ownResume, saveMessages, mergeFast } = require('./flowOwner');

const INTERVAL_MS = 10000;
const nextOf = (n) => n?.next_node_id ?? n?.data?.next_node_id ?? n?.config?.next_node_id ?? null;
const WAIT_KEYS = ['_wait_type', '_wait_config', '_wait_node_id', '_wait_timeout_at'];
const AI_KEYS = ['_ai_responded', '_ai_call_count', '_ai_mapped_vars'];

const DUE_SQL = `
  select e.id, e.company_id, e.connection_id, e.flow_id, e.contact_phone, e.current_node_id, e.context,
         f.base44_id, f.name, f.trigger_type, f.nodes
  from crm_flow_executions e join flows f on f.base44_id = e.flow_id and f.connection_id = e.connection_id
  where e.status = 'waiting' and e.id not like 'rw\\_%' and e.context->>'_wait_type' in ('reply', 'ai_agent')
    and nullif(e.context->>'_wait_timeout_at', '')::timestamptz <= now()
    and nullif(e.context->>'_wait_timeout_at', '')::timestamptz > now() - interval '7 days'
  order by e.context->>'_wait_timeout_at' limit 30`;

const CONTACT_SQL = `
  select id, company_id, connection_id, nome, email, empresa, telefone, bsuid, subscriber_active, automation_paused_until,
         tags, custom_fields, ultima_inbound_em, ad_window_expires_at
  from crm_contacts where telefone = $1 and connection_id = $2 limit 1`;

function windowOpen(c) {
  const now = Date.now();
  return (c.ultima_inbound_em && now - new Date(c.ultima_inbound_em).getTime() < 24 * 3600000) ||
    (c.ad_window_expires_at && new Date(c.ad_window_expires_at).getTime() > now);
}

// Próximo bloco depois do tempo esgotado. null = encerra; false = cancela (modelo sem clique)
function timeoutNext(ex, node) {
  const wc = ex.context._wait_config || {};
  const d = node.data || node.config || {};
  if (ex.context._wait_type === 'ai_agent') return wc.next_node_id || nextOf(node) || null;
  const explicit = wc.next_node_timeout_id || node.next_node_timeout_id || d.next_node_timeout_id;
  if (wc.require_button_click && !explicit) return false;
  return explicit || nextOf(node) || null;
}

async function resolveOne(pool, ex, callBase44Function) {
  const node = (ex.nodes || []).find((n) => n.id === ex.current_node_id);
  if (!node) return; // bloco apagado do fluxo: o Base44 (reserva) resolve
  const next = timeoutNext(ex, node);
  const { rowCount } = await pool.query(
    `update crm_flow_executions set status = 'running', waiting_since = null, started_at = now(), updated_at = now() where id = $1 and status = 'waiting'`, [ex.id]);
  if (!rowCount) return;
  const isAi = ex.context._wait_type === 'ai_agent';
  console.log(`[TIMEOUT] ${isAi ? 'IA' : 'resposta'} vencida exec=${ex.id} → ${next === false ? 'cancelar' : next || 'fim'}`);
  if (isAi) {
    await pool.query(`update scheduled_jobs set status = 'completed', completed_at = now() where reference_id = $1 and status in ('pending','queued','running')`, [`ai_timeout_${ex.id}`])
      .catch((e) => console.warn('[TIMEOUT] job da IA:', e.message));
  }
  if (next === false) {
    await pool.query(`update crm_flow_executions set status = 'cancelled', completed_at = now(), error_message = $2, updated_at = now() where id = $1`,
      [ex.id, 'Modelo encerrado sem clique no botão de resposta.']);
    return;
  }
  const ctx = { ...ex.context };
  for (const k of [...WAIT_KEYS, ...(isAi ? AI_KEYS : [])]) delete ctx[k];
  if (!next) {
    await pool.query(`update crm_flow_executions set status = 'completed', completed_at = now(), context = $2, updated_at = now() where id = $1`, [ex.id, JSON.stringify(ctx)]);
    return;
  }
  const flow = { base44_id: ex.base44_id, name: ex.name, trigger_type: ex.trigger_type, nodes: ex.nodes };
  try {
    const { rows: [contact] } = await pool.query(CONTACT_SQL, [ex.contact_phone, ex.connection_id]);
    // Janela fechada ou contato não copiado: o Base44 continua (ele sabe pular o que exige janela)
    const open = contact && windowOpen(contact);
    const loadFlow = async (id) => (await pool.query(
      `select base44_id, name, nodes from flows where base44_id = $1 and connection_id = $2 and status = 'active' limit 1`, [id, ex.connection_id])).rows[0] || null;
    const live = open ? liveTimeline(pool, { companyId: ex.company_id, connectionId: ex.connection_id, contactId: contact.id, phone: ex.contact_phone }) : null;
    const fast = open ? await runFast(flow, next, { companyId: ex.company_id, connectionId: ex.connection_id, phone: ex.contact_phone, contact, loadFlow, context: ctx, fresh: true, windowOpen: true, live }) : null;
    if (fast && await ownResume(pool, { exec: ex, flow, contact, phone: ex.contact_phone, fast, ctx })) return;
    if (fast) await saveMessages(pool, contact, ex.contact_phone, fast, null);
    await pool.query(`update crm_flow_executions set context = $2, updated_at = now() where id = $1`, [ex.id, JSON.stringify(mergeFast(ctx, fast))]);
    const r = await callBase44Function('workerTrigger', { action: 'resumeExecution', company_id: ex.company_id, context: { execution_id: ex.id, node_id: next } });
    console.log(`[TIMEOUT] Base44 continua exec=${ex.id} a partir de ${next} ok=${r?.ok !== false}`);
  } catch (e) {
    // Devolve a espera: o Base44 (reserva) resolve em 2 min
    console.error(`[TIMEOUT] falhou exec=${ex.id} (Base44 assume):`, e.message);
    await pool.query(`update crm_flow_executions set status = 'waiting', waiting_since = now(), updated_at = now() where id = $1 and status = 'running'`, [ex.id]).catch(() => {});
  }
}

let busy = false;
async function checkTimeoutsNow(pool, callBase44Function) {
  if (busy || !pool) return;
  busy = true;
  try {
    const { rows } = await pool.query(DUE_SQL);
    for (const ex of rows) await resolveOne(pool, ex, callBase44Function);
  } catch (e) {
    console.error('[TIMEOUT] erro:', e.message);
  } finally {
    busy = false;
  }
}

function startTimeoutWatcher(pool, callBase44Function) {
  setInterval(() => checkTimeoutsNow(pool, callBase44Function), INTERVAL_MS);
  console.log(`[TIMEOUT] tempos limite pelo Railway a cada ${INTERVAL_MS / 1000}s`);
}

module.exports = { startTimeoutWatcher, checkTimeoutsNow };