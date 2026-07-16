// ══════════════════════════════════════════════════════════
// queue.js — Fila BullMQ + conexão Redis
// A fila é o coração da escala: enfileira disparos, controla
// concorrência e rate limit, faz retry automático.
// ══════════════════════════════════════════════════════════
const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const config = require('./config');

// ── Conexão Redis ──
// maxRetriesPerRequest: null é OBRIGATÓRIO para BullMQ workers
const connection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  // Upstash usa TLS — a URL rediss:// já ativa isso.
  // Se a URL for redis:// mas o Upstash exigir TLS, descomente:
  // tls: {},
});

connection.on('connect', () => console.log('[REDIS] Conectado'));
connection.on('error', (e) => console.error('[REDIS] Erro:', e.message));

// ── Nome da fila ──
const QUEUE_NAME = 'flow-dispatch';

// ── A fila (produtor) ──
const flowQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: config.JOB_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: config.JOB_BACKOFF_MS,
    },
    // Remove jobs concluídos após 1h e falhados após 24h
    // (evita encher o Redis — importante no plano Upstash)
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400, count: 5000 },
  },
});

flowQueue.on('error', (e) => console.error('[QUEUE] Erro:', e.message));

// ── Adicionar um disparo à fila ──
// jobData: { scheduled_job_id, flow_base44_id, contact_phone, company_id, context, reference_id, reference_type }
async function enqueueDispatch(jobData) {
  // jobId único evita enfileirar o mesmo scheduled_job duas vezes.
  // BullMQ NÃO aceita ':' no custom jobId — usar '_' como separador.
  const jobId = `dispatch_${jobData.scheduled_job_id}`;
  return flowQueue.add('dispatch', jobData, {
    jobId,
    // Chave de agrupamento por empresa (usada pelo rate limit por empresa no worker)
    // BullMQ Pro tem "groups"; na versão free usamos rate limit global + lógica no worker.
  });
}

module.exports = {
  connection,
  flowQueue,
  enqueueDispatch,
  QUEUE_NAME,
};
