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
