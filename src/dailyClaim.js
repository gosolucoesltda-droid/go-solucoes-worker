// Trava diária das varreduras do Railway (worker_heartbeats): uma instância, uma vez por dia (Brasília),
// a partir de minHour. Falha pode tentar de novo depois de 30 min. O Base44 confere status 'done' para pular a reserva.
/* global module */
async function claimDaily(pool, id, minHour = 0) {
  const { rowCount } = await pool.query(
    `insert into worker_heartbeats (worker_id, last_heartbeat, status, updated_at, created_at)
     select $1, now(), 'running', now(), now() where extract(hour from now() at time zone 'America/Sao_Paulo') >= $2
     on conflict (worker_id) do update set last_heartbeat = now(), status = 'running', updated_at = now()
     where (worker_heartbeats.last_heartbeat at time zone 'America/Sao_Paulo')::date < (now() at time zone 'America/Sao_Paulo')::date
        or worker_heartbeats.status = 'failed' and worker_heartbeats.last_heartbeat < now() - interval '30 minutes'
     returning worker_id`, [id, minHour]);
  return rowCount > 0;
}

async function finishDaily(pool, id, ok, metadata) {
  await pool.query(`update worker_heartbeats set status = $2, metadata = $3, updated_at = now() where worker_id = $1`,
    [id, ok ? 'done' : 'failed', JSON.stringify(metadata || {})]).catch(() => {});
}

// Roda a varredura uma vez por dia; confere a cada 10 min
function startDaily(pool, id, minHour, run, tag) {
  if (!pool) return;
  const tick = async () => {
    try {
      if (!(await claimDaily(pool, id, minHour))) return;
      const t0 = Date.now();
      try {
        const res = await run(pool);
        await finishDaily(pool, id, true, res);
        console.log(`[${tag}] varredura concluída em ${Date.now() - t0}ms:`, JSON.stringify(res));
      } catch (e) {
        await finishDaily(pool, id, false, { error: e.message });
        console.error(`[${tag}] varredura falhou:`, e.message);
      }
    } catch (e) { console.error(`[${tag}] trava:`, e.message); }
  };
  tick();
  setInterval(tick, 10 * 60 * 1000);
}

module.exports = { startDaily };