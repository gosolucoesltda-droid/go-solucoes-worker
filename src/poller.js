// ══════════════════════════════════════════════════════════
// poller.js — Busca jobs vencidos no Supabase → empurra pra fila
// Roda a cada minuto (1 réplica só, para não duplicar).
// NÃO dispara nada — só enfileira. Quem dispara é o consumer.
// ══════════════════════════════════════════════════════════
const { createClient } = require('@supabase/supabase-js');
const { enqueueDispatch } = require('./queue');
const config = require('./config');

function getSupabase() {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
}

// Busca jobs pending vencidos e os empurra para a fila.
// Marca cada um como 'queued' de forma atômica para evitar
// que dois pollers (se houver) peguem o mesmo job.
async function pollAndEnqueue() {
  const supabase = getSupabase();
  const now = new Date();
  const result = { found: 0, enqueued: 0, errors: 0 };

  // 1. Buscar jobs pending vencidos
  const { data: jobs, error } = await supabase
    .from('scheduled_jobs')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_for', now.toISOString())
    .lt('attempts', 3)
    .order('scheduled_for', { ascending: true })
    .limit(200); // processa até 200 por ciclo

  if (error) {
    console.error('[POLLER] Erro ao buscar jobs:', error.message);
    return result;
  }

  if (!jobs || jobs.length === 0) return result;

  result.found = jobs.length;
  console.log(`[POLLER] ${jobs.length} jobs vencidos encontrados`);

  for (const job of jobs) {
    // 2. Marcar como 'queued' ATOMICAMENTE (só se ainda for pending)
    // Isso evita que o próximo ciclo do poller pegue o mesmo job
    const { data: claimed } = await supabase
      .from('scheduled_jobs')
      .update({
        status: 'queued',
        last_attempt_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'pending') // condição: só se ainda pending
      .select();

    if (!claimed || claimed.length === 0) {
      // Outro poller já pegou — pular
      continue;
    }

    // 3. Empurrar para a fila
    try {
      await enqueueDispatch({
        scheduled_job_id: job.id,
        flow_base44_id: job.flow_base44_id,
        contact_phone: job.contact_phone,
        company_id: job.company_id,
        context: job.context || {},
        reference_id: job.reference_id,
        reference_type: job.reference_type,
      });
      result.enqueued++;
    } catch (e) {
      result.errors++;
      console.error(`[POLLER] Erro ao enfileirar job ${job.id}:`, e.message);
      // Reverter para pending para tentar de novo no próximo ciclo
      await supabase
        .from('scheduled_jobs')
        .update({ status: 'pending' })
        .eq('id', job.id);
    }
  }

  console.log(`[POLLER] Enfileirados: ${result.enqueued}/${result.found}`);
  return result;
}

module.exports = { pollAndEnqueue };
