// ══════════════════════════════════════════════════════════
// index.js — Orquestrador. O papel (ROLE) decide o que roda:
//   ROLE=poller   → só busca jobs e enfileira + scheduler diário
//   ROLE=worker   → só consome a fila e dispara
//   ROLE=all      → tudo junto (dev / poucas empresas)
//
// Em escala (100+ empresas):
//   1 réplica  ROLE=poller
//   3+ réplicas ROLE=worker
// ══════════════════════════════════════════════════════════
const express = require('express');
const cron = require('node-cron');
const config = require('./config');
const { pollAndEnqueue } = require('./poller');
const { startConsumer } = require('./consumer');
const { scheduleRecurring } = require('./scheduler');
const { flowQueue } = require('./queue');

const app = express();
app.use(express.json());

const ROLE = config.ROLE;
console.log(`[WORKER] GO Soluções Worker v2.0 iniciando... | ROLE=${ROLE}`);

// ── Health check ──
app.get('/health', async (req, res) => {
  let queueStats = null;
  try {
    const counts = await flowQueue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    queueStats = counts;
  } catch (e) {
    queueStats = { error: e.message };
  }
  res.json({
    ok: true,
    role: ROLE,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    queue: queueStats,
  });
});

// ── Rota de teste: forçar scheduler (protegida) ──
app.post('/run-scheduler', async (req, res) => {
  if (req.headers.authorization !== `Bearer ${config.WORKER_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await scheduleRecurring();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Rota de teste: forçar poll (protegida) ──
app.post('/run-poller', async (req, res) => {
  if (req.headers.authorization !== `Bearer ${config.WORKER_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await pollAndEnqueue();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
// POLLER — busca jobs vencidos e enfileira (1 réplica só!)
// ══════════════════════════════════════════════════════════
if (ROLE === 'poller' || ROLE === 'all') {
  // A cada 30 segundos: buscar jobs vencidos → fila
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await pollAndEnqueue();
    } catch (e) {
      console.error('[POLLER] Erro no ciclo:', e.message);
    }
  });

  // Scheduler diário: cria jobs de contact_inactive, balance_low, recurring
  cron.schedule('5 3 * * *', async () => {
    console.log(`[DAILY-00h] ${new Date().toISOString()}`);
    try { await scheduleRecurring(); } catch (e) { console.error('[DAILY-00h]', e.message); }
  });
  cron.schedule('0 11 * * *', async () => {
    console.log(`[DAILY-08h] ${new Date().toISOString()}`);
    try { await scheduleRecurring(); } catch (e) { console.error('[DAILY-08h]', e.message); }
  });

  console.log('[WORKER] Poller ativo (1min) + scheduler diário (00h/08h)');
}

// ══════════════════════════════════════════════════════════
// CONSUMER — consome a fila e dispara (N réplicas)
// ══════════════════════════════════════════════════════════
if (ROLE === 'worker' || ROLE === 'all') {
  startConsumer();
  console.log('[WORKER] Consumer ativo');
}

// ── Servidor HTTP (health + rotas de teste) ──
app.listen(config.PORT, () => {
  console.log(`[WORKER] Rodando na porta ${config.PORT}`);
});
