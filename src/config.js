// ══════════════════════════════════════════════════════════
// config.js — Todas as variáveis de ambiente centralizadas
// ══════════════════════════════════════════════════════════
require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[CONFIG] ⚠️  Variável obrigatória ausente: ${name}`);
  }
  return v;
}

module.exports = {
  // Supabase
  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_KEY: required('SUPABASE_SERVICE_KEY'),

  // Redis (Upstash) — usado pela fila BullMQ
  REDIS_URL: required('REDIS_URL'),

  // Base44 — endpoint do workerTrigger
  BASE44_WORKER_ENDPOINT: required('BASE44_WORKER_ENDPOINT'),
  WORKER_SECRET: required('WORKER_SECRET'),

  // Ajustes de escala (com defaults seguros)
  // Quantos jobs cada worker processa em paralelo
  WORKER_CONCURRENCY: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),

  // Rate limit GLOBAL da fila: máximo de jobs por intervalo
  // Protege a Meta API e o Base44 de picos
  QUEUE_MAX_JOBS_PER_INTERVAL: parseInt(process.env.QUEUE_MAX_JOBS_PER_INTERVAL || '30', 10),
  QUEUE_INTERVAL_MS: parseInt(process.env.QUEUE_INTERVAL_MS || '1000', 10),

  // Rate limit POR EMPRESA: quantas mensagens/segundo por empresa
  // Evita que uma empresa sozinha estoure o limite da Meta dela
  PER_COMPANY_MAX_PER_SECOND: parseInt(process.env.PER_COMPANY_MAX_PER_SECOND || '10', 10),

  // Retry: tentativas e backoff
  JOB_ATTEMPTS: parseInt(process.env.JOB_ATTEMPTS || '4', 10),
  JOB_BACKOFF_MS: parseInt(process.env.JOB_BACKOFF_MS || '3000', 10),

  // Papel deste processo: 'scheduler', 'worker' ou 'all'
  // Em escala: 1 réplica scheduler + N réplicas worker
  ROLE: process.env.ROLE || 'all',

  PORT: parseInt(process.env.PORT || '3000', 10),
};
