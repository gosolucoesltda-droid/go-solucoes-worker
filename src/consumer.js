// ══════════════════════════════════════════════════════════
// consumer.js — Consome a fila e dispara os fluxos
// PODE TER MÚLTIPLAS RÉPLICAS. Cada uma processa N jobs em
// paralelo (WORKER_CONCURRENCY). Aplica rate limit por empresa
// via Redis para não estourar o limite da Meta de cada uma.
// ══════════════════════════════════════════════════════════
const { Worker, RateLimitError } = require('bullmq');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { connection, QUEUE_NAME } = require('./queue');
const config = require('./config');

function getSupabase() {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
}

// ── Rate limit POR EMPRESA usando Redis ──
// Janela deslizante simples: conta disparos por empresa no último segundo.
// Se a empresa já atingiu o limite, o job é adiado (throttle).
async function checkCompanyRateLimit(companyId) {
  const key = `ratelimit:company:${companyId}`;
  const limit = config.PER_COMPANY_MAX_PER_SECOND;

  // INCR + EXPIRE atômico: conta quantos disparos neste segundo
  const count = await connection.incr(key);
  if (count === 1) {
    await connection.expire(key, 1); // janela de 1 segundo
  }

  return count <= limit;
}

// ── Disparar o fluxo no Base44 ──
async function dispararFluxoNoBase44(jobData) {
  const res = await axios.post(
    config.BASE44_WORKER_ENDPOINT,
    {
      action: 'startFlow',
      flow_id: jobData.flow_base44_id,
      contact_phone: jobData.contact_phone,
      company_id: jobData.company_id,
      context: jobData.context || {},
      reference_id: jobData.reference_id,
      reference_type: jobData.reference_type,
    },
    {
      headers: {
        Authorization: `Bearer ${config.WORKER_SECRET}`,
        'Content-Type': 'application/json',
      },
      timeout: 25000,
    }
  );

  const ok = res.status >= 200 && res.status < 300 && res.data?.ok !== false;
  return { ok, status: res.status, data: res.data };
}

// ── Processador de cada job da fila ──
// Recebe o worker para poder usar o rate limit nativo do BullMQ
async function processDispatch(job, workerRef) {
  const supabase = getSupabase();
  const jobData = job.data;
  const sjId = jobData.scheduled_job_id;

  // 1. Rate limit por empresa — se estourou, ADIA sem gastar tentativa
  const allowed = await checkCompanyRateLimit(jobData.company_id);
  if (!allowed) {
    // Adia o job por 1 segundo usando o mecanismo nativo do BullMQ.
    // NÃO conta como tentativa falhada — o job volta pra fila.
    await workerRef.rateLimit(1000);
    throw new RateLimitError();
  }

  // 2. Marcar scheduled_job como running
  await supabase
    .from('scheduled_jobs')
    .update({
      status: 'running',
      last_attempt_at: new Date().toISOString(),
    })
    .eq('id', sjId);

  // 3. Disparar no Base44
  const result = await dispararFluxoNoBase44(jobData);

  if (!result.ok) {
    // Falha — lança para o BullMQ re-tentar
    throw new Error(`Base44 respondeu ${result.status}: ${JSON.stringify(result.data)}`);
  }

  // 4. Sucesso — marcar completed + registrar log
  await supabase
    .from('scheduled_jobs')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      error_message: null,
    })
    .eq('id', sjId);

  await supabase.from('automation_logs').insert({
    company_id: jobData.company_id,
    automation_type: 'flow',
    automation_id: jobData.flow_base44_id,
    automation_name: jobData.context?.flow_name || 'Automação',
    contact_phone: jobData.contact_phone,
    status: 'triggered',
    triggered_at: new Date().toISOString(),
    reference_id: jobData.reference_id,
  });

  console.log(`[CONSUMER] ✅ Disparado: ${jobData.contact_phone} (empresa ${jobData.company_id})`);
  return { ok: true };
}

// ── Iniciar o worker consumidor ──
function startConsumer() {
  const worker = new Worker(
    QUEUE_NAME,
    (job) => processDispatch(job, worker),
    {
      connection,
      concurrency: config.WORKER_CONCURRENCY,
      // Rate limit GLOBAL da fila (protege Base44 e Meta de picos totais)
      limiter: {
        max: config.QUEUE_MAX_JOBS_PER_INTERVAL,
        duration: config.QUEUE_INTERVAL_MS,
      },
    }
  );

  worker.on('failed', async (job, err) => {
    // RateLimitError é esperado (job adiado, não falhou de verdade)
    if (err.name === 'RateLimitError') return;

    console.error(`[CONSUMER] ❌ Job ${job?.id} falhou: ${err.message}`);

    // Se esgotou todas as tentativas, marcar scheduled_job como failed
    if (job && job.attemptsMade >= job.opts.attempts) {
      const supabase = getSupabase();
      await supabase
        .from('scheduled_jobs')
        .update({
          status: 'failed',
          error_message: err.message.substring(0, 500),
        })
        .eq('id', job.data.scheduled_job_id);
      console.error(`[CONSUMER] Job ${job.data.scheduled_job_id} marcado como FAILED (esgotou tentativas)`);
    }
  });

  worker.on('error', (e) => console.error('[CONSUMER] Worker erro:', e.message));

  console.log(`[CONSUMER] Iniciado | concorrência: ${config.WORKER_CONCURRENCY} | rate global: ${config.QUEUE_MAX_JOBS_PER_INTERVAL}/${config.QUEUE_INTERVAL_MS}ms`);
  return worker;
}

module.exports = { startConsumer };
