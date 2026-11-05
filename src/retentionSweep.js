// Retenção diária no Supabase (roda 1x/dia, a partir das 04h de Brasília).
// Tabelas de webhook, log de execução, fila de jobs e travas de disparo crescem a cada mensagem:
// sem poda viram o maior consumidor de IO do banco (e derrubam o Disk IO Budget).
/* global module */
const { startDaily } = require('./dailyClaim');

const STEPS = [
  { table: 'webhook_events', sql: `delete from webhook_events where status in ('done','failed') and received_at < now() - interval '3 days'` },
  { table: 'crm_flow_execution_logs', sql: `delete from crm_flow_execution_logs where executed_at < now() - interval '7 days'` },
  { table: 'crm_flow_executions', sql: `delete from crm_flow_executions where status in ('completed','cancelled','failed') and created_at < now() - interval '7 days'` },
  { table: 'scheduled_jobs', sql: `delete from scheduled_jobs where status in ('completed','cancelled','failed') and created_at < now() - interval '3 days'` },
  { table: 'flow_trigger_claims', sql: `delete from flow_trigger_claims where claimed_at < now() - interval '2 days'` },
];

async function runRetention(pool) {
  const deleted = {};
  for (const step of STEPS) {
    try {
      const { rowCount } = await pool.query(step.sql);
      deleted[step.table] = rowCount;
      if (rowCount) console.log(`[RETENTION] ${step.table}: ${rowCount} registros removidos`);
    } catch (e) {
      deleted[step.table] = `erro: ${e.message}`;
      console.error(`[RETENTION] ${step.table} falhou:`, e.message);
    }
  }
  // Atualiza as estatísticas do planner depois da poda (evita planos ruins nas consultas seguintes)
  await pool.query('vacuum (analyze) webhook_events, crm_flow_execution_logs, crm_flow_executions, scheduled_jobs, flow_trigger_claims')
    .catch((e) => console.warn('[RETENTION] vacuum:', e.message));
  return deleted;
}

function startRetentionSweep(pool) {
  if (!pool) return;
  startDaily(pool, 'db_retention', 4, runRetention, 'RETENTION');
}

module.exports = { startRetentionSweep, runRetention };