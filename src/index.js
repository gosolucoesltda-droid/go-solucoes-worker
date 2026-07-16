require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { processJobs } = require('./processor');
const { scheduleRecurring } = require('./scheduler');

const app = express();
app.use(express.json());

console.log('[WORKER] GO Soluções Worker v1.0 iniciando...');

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ── Endpoint para receber jobs diretos ──
app.post('/process-job', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.WORKER_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await processJobs([req.body]);
    res.json({ ok: true, result });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Cron a cada 1 MINUTO — processa jobs pendentes ──
cron.schedule('* * * * *', async () => {
  console.log(`[1MIN] ${new Date().toISOString()}`);
  try {
    const result = await processJobs();
    if (result.processed > 0) {
      console.log(`[1MIN] Resultado: ${JSON.stringify(result)}`);
    }
  } catch(e) {
    console.error('[1MIN] Erro:', e.message);
  }
});

// Scheduler roda às 03:05 UTC (00:05 BRT) — cria os jobs do dia
cron.schedule('5 3 * * *', async () => {
  console.log(`[DAILY-00h] ${new Date().toISOString()}`);
  try { await scheduleRecurring(); } catch(e) { console.error('[DAILY-00h]', e.message); }
});

// E às 11:00 UTC (08:00 BRT) — vencidas/paradas/inativas do dia
cron.schedule('0 11 * * *', async () => {
  console.log(`[DAILY-08h] ${new Date().toISOString()}`);
  try { await scheduleRecurring(); } catch(e) { console.error('[DAILY-08h]', e.message); }
});

// ── Cron a cada 5min — verificar saúde do sistema ──
cron.schedule('*/5 * * * *', async () => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
    const { count } = await supabase
      .from('scheduled_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');
    console.log(`[HEALTH] Jobs pendentes: ${count ?? 0}`);
  } catch(e) {
    console.error('[HEALTH] Erro:', e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[WORKER] Rodando na porta ${PORT}`);
  console.log('[WORKER] Crons ativos: 1min, daily 11h UTC, health 5min');
});

app.post('/run-scheduler', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.WORKER_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    console.log('[MANUAL] Rodando scheduler sob demanda...');
    await scheduleRecurring();
    res.json({ ok: true, message: 'Scheduler executado' });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
