// ═══════════════════════════════════════════════════════════
// GOcrm — Railway Worker Contínuo v2.0
// Processa scheduled_jobs via LISTEN/NOTIFY do Postgres.
//
// Endpoints HTTP:
//   POST /trigger      — dispara flowEngine.startFlow (legacy + fallback)
//   POST /proxy-fetch  — proxy IPv4 para chamadas de API
//   GET  /health       — status do worker
//
// Processamento contínuo:
//   - LISTEN no canal 'scheduled_jobs_notify' (acorda imediatamente)
//   - Timer para o próximo job futuro
//   - Reconciliação a cada 30s (safety net para notificações perdidas)
//   - Heartbeat a cada 30s
//   - Lease recovery: jobs 'running' expirados voltam para 'pending'
// ═══════════════════════════════════════════════════════════

const http = require('http');
const { Client } = require('pg');

const PORT = process.env.PORT || 3000;
const WORKER_SECRET = process.env.WORKER_SECRET;
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const WORKER_ID = process.env.WORKER_ID || 'default';
const RECONCILE_INTERVAL_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 30000;
const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 10;
const PROCESSING_CONCURRENCY = 5;

let pgClient = null;
let nextJobTimer = null;
let isProcessing = false;
const stats = { processed: 0, sent: 0, failed: 0, errors: 0, startedAt: new Date().toISOString() };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return healthHandler(res);
  }
  if (req.method === 'POST' && url.pathname === '/trigger') {
    return triggerHandler(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/proxy-fetch') {
    return proxyFetchHandler(req, res);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

function healthHandler(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    worker_id: WORKER_ID,
    pg_connected: pgClient?.connected || false,
    is_processing: isProcessing,
    stats,
    uptime: process.uptime(),
  }));
}

async function readJsonBody(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'JSON inválido' }));
    return null;
  }
}

async function triggerHandler(req, res) {
  if (req.headers.authorization !== `Bearer ${WORKER_SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
  }

  const parsed = await readJsonBody(req, res);
  if (!parsed) return;

  const { action, flow_id, contact_phone, company_id, context, reference_id } = parsed;
  if (action !== 'startFlow' || !flow_id || !contact_phone || !company_id) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Campos obrigatórios: action=startFlow, flow_id, contact_phone, company_id' }));
  }

  console.log(`[TRIGGER] flow=${flow_id} phone=${contact_phone} company=${company_id}`);
  try {
    const result = await callBase44Function('workerTrigger', {
      action: 'startFlow', flow_id, contact_phone, company_id, context, reference_id,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e) {
    console.error('[TRIGGER] erro:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

async function proxyFetchHandler(req, res) {
  if (req.headers.authorization !== `Bearer ${WORKER_SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
  }

  const parsed = await readJsonBody(req, res);
  if (!parsed) return;

  const { method = 'GET', url, headers = {}, body: reqBody = null } = parsed;
  if (!url) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'url obrigatória' }));
  }

  try {
    const fetchOpts = { method, headers };
    if (reqBody !== null && reqBody !== undefined && method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = reqBody;
    }
    const upstream = await fetch(url, fetchOpts);
    const text = await upstream.text();
    const respHeaders = {};
    upstream.headers.forEach((v, k) => { respHeaders[k] = v; });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: upstream.status, ok: upstream.ok, headers: respHeaders, body: text }));
  } catch (e) {
    console.error('[proxy-fetch] erro:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

async function callBase44Function(functionName, payload) {
  const response = await fetch(`${APP_URL}/functions/${functionName}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WORKER_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Base44 ${functionName} returned ${response.status}: ${text.slice(0, 200)}`);
  }
  return data;
}

async function connectPostgres() {
  if (pgClient) {
    try { await pgClient.end(); } catch {}
  }

  pgClient = new Client({ connectionString: SUPABASE_DB_URL });

  pgClient.on('notification', (msg) => {
    console.log(`[LISTEN] notificação recebida: job_id=${msg.payload}`);
    scheduleProcessing();
  });
  pgClient.on('error', (err) => console.error('[PG] erro de conexão:', err.message));
  pgClient.on('end', () => {
    console.warn('[PG] conexão fechada — reconectando em 5s...');
    pgClient = null;
    setTimeout(connectPostgres, 5000);
  });

  await pgClient.connect();
  await pgClient.query('LISTEN scheduled_jobs_notify');
  console.log('[PG] Conectado e escutando canal: scheduled_jobs_notify');
}

async function scheduleProcessing() {
  if (nextJobTimer) {
    clearTimeout(nextJobTimer);
    nextJobTimer = null;
  }
  await processDueJobs();
  await scheduleNextJob();
}

async function processDueJobs() {
  if (isProcessing) {
    console.log('[PROCESS] já processando — pulando');
    return;
  }
  isProcessing = true;

  try {
    await recoverStaleJobs();
    let hasMore = true;
    while (hasMore) {
      const jobs = await claimDueJobs(BATCH_SIZE);
      if (jobs.length === 0) {
        hasMore = false;
        break;
      }
      console.log(`[PROCESS] processando lote de ${jobs.length} job(s)`);
      await processBatch(jobs);
    }
  } catch (e) {
    console.error('[PROCESS] erro:', e.message);
    stats.errors++;
  } finally {
    isProcessing = false;
  }
}

async function recoverStaleJobs() {
  try {
    const cutoff = new Date(Date.now() - LEASE_TIMEOUT_MS).toISOString();
    const result = await pgClient.query(`
      UPDATE scheduled_jobs
      SET status = 'pending', last_attempt_at = NOW()
      WHERE status = 'running'
        AND last_attempt_at < $1
        AND attempts < $2
    `, [cutoff, MAX_ATTEMPTS]);
    if (result.rowCount > 0) {
      console.log(`[RECOVER] ${result.rowCount} job(s) 'running' expirados → 'pending'`);
    }
  } catch (e) {
    console.error('[RECOVER] erro:', e.message);
  }
}

async function claimDueJobs(limit) {
  const now = new Date().toISOString();
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  try {
    const result = await pgClient.query(`
      UPDATE scheduled_jobs
      SET status = 'running',
          attempts = attempts + 1,
          last_attempt_at = $1
      WHERE id IN (
        SELECT id FROM scheduled_jobs
        WHERE status = 'pending'
          AND scheduled_for <= $1
          AND scheduled_for >= $2
          AND attempts < $3
        ORDER BY scheduled_for ASC
        LIMIT $4
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `, [now, thirtyMinAgo, MAX_ATTEMPTS, limit]);

    return result.rows;
  } catch (e) {
    console.error('[CLAIM] erro:', e.message);
    return [];
  }
}

async function processBatch(jobs) {
  const chunks = [];
  for (let i = 0; i < jobs.length; i += PROCESSING_CONCURRENCY) {
    chunks.push(jobs.slice(i, i + PROCESSING_CONCURRENCY));
  }
  for (const chunk of chunks) {
    await Promise.allSettled(chunk.map((job) => processJob(job)));
  }
}

async function processJob(job) {
  console.log(`[JOB] id=${job.id} tipo=${job.job_type} phone=${job.contact_phone}`);
  stats.processed++;

  let success = false;
  let errorMsg = null;

  try {
    if (job.job_type === 'flow_trigger') {
      success = await processFlowTriggerJob(job);
    } else if (job.job_type === 'appointment_reminder') {
      success = await processAppointmentJob(job);
    } else {
      console.warn(`[JOB] tipo desconhecido: ${job.job_type}`);
      success = true;
    }
  } catch (e) {
    console.error(`[JOB] exceção id=${job.id}:`, e.message);
    errorMsg = e.message;
  }

  await updateJobStatus(job, success, errorMsg);
  if (success && job.reference_type === 'recurring' && job.job_type === 'flow_trigger') {
    await createNextRecurringJob(job);
  }

  if (success) stats.sent++;
  else stats.failed++;
}

async function processFlowTriggerJob(job) {
  const context = job.context || {};
  const flowBase44Id = job.flow_base44_id;
  const flowResult = await pgClient.query(
    'SELECT status, connection_id FROM flows WHERE base44_id = $1 LIMIT 1',
    [flowBase44Id]
  );
  const flow = flowResult.rows[0];

  if (!flow || flow.status !== 'active') {
    console.log(`[JOB] flow indisponível ou inativo: ${flowBase44Id}`);
    return true;
  }

  const result = await callBase44Function('workerTrigger', {
    action: 'startFlow',
    flow_id: flowBase44Id,
    contact_phone: job.contact_phone,
    company_id: job.company_id,
    context: {
      ...context,
      reference_id: job.reference_id,
      connection_id: flow.connection_id || context.connection_id || null,
    },
    reference_id: job.reference_id,
  });

  console.log(`[JOB] workerTrigger resultado: ok=${result?.ok} exec=${result?.execution_id || '-'}`);
  await logAutomation(job, result?.ok ? 'sent' : 'failed');
  return !!result?.ok;
}

async function processAppointmentJob(job) {
  const context = job.context || {};
  const flowBase44Id = job.flow_base44_id;
  const flowResult = await pgClient.query(
    'SELECT status, connection_id FROM flows WHERE base44_id = $1 LIMIT 1',
    [flowBase44Id]
  );
  const flow = flowResult.rows[0];

  if (!flow || flow.status !== 'active') return true;

  const existingLog = await pgClient.query(
    'SELECT id FROM automation_logs WHERE automation_id = $1 AND reference_id = $2 LIMIT 1',
    [flowBase44Id, job.reference_id]
  );
  if (existingLog.rows.length > 0) {
    console.log(`[JOB] appointment já disparado para ref__=${job.reference_id} — pulando`);
    return true;
  }

  const result = await callBase44Function('flowEngine', {
    action: 'startFlow',
    flow_id: flowBase44Id,
    contact_phone: job.contact_phone,
    company_id: job.company_id,
    trigger_context: {
      ...context,
      reference_id: job.reference_id,
      connection_id: flow.connection_id || context.connection_id || null,
    },
  });

  console.log(`[JOB] flowEngine resultado: ok=${result?.ok} exec=${result?.execution_id || '-'}`);
  await logAutomation(job, result?.ok ? 'sent' : 'failed');
  return !!result?.ok;
}

async function logAutomation(job, status) {
  try {
    const flowResult = await pgClient.query(
      'SELECT name FROM flows WHERE base44_id = $1 LIMIT 1',
      [job.flow_base44_id]
    );
    const flowName = flowResult.rows[0]?.name || '';
    await pgClient.query(`
      INSERT INTO automation_logs
        (company_id, automation_type, automation_id, automation_name, contact_phone, status, triggered_at, reference_id)
      VALUES ($1, 'flow', $2, $3, $4, $5, NOW(), $6)
    `, [job.company_id, job.flow_base44_id, flowName, job.contact_phone, status, job.reference_id]);
  } catch (e) {
    console.warn('[LOG] erro ao registrar log:', e.message);
  }
}

async function updateJobStatus(job, success, errorMsg) {
  try {
    if (success) {
      await pgClient.query(
        "UPDATE scheduled_jobs SET status = 'completed', completed_at = NOW(), error_message = NULL WHERE id = $1",
        [job.id]
      );
    } else if (job.attempts >= MAX_ATTEMPTS) {
      await pgClient.query(
        "UPDATE scheduled_jobs SET status = 'failed', error_message = $2 WHERE id = $1",
        [job.id, errorMsg || 'Falha no envio']
      );
    } else {
      await pgClient.query(
        "UPDATE scheduled_jobs SET status = 'pending', error_message = $2 WHERE id = $1",
        [job.id, errorMsg || 'Falha — será reprocessado']
      );
    }
  } catch (e) {
    console.error('[JOB] erro ao atualizar status:', e.message);
  }
}

async function createNextRecurringJob(job) {
  try {
    const flowResult = await pgClient.query(
      'SELECT trigger_config, connection_id, name FROM flows WHERE base44_id = $1 LIMIT 1',
      [job.flow_base44_id]
    );
    const flow = flowResult.rows[0];
    if (!flow) return;

    const config = flow.trigger_config || {};
    if (!config.time || !config.recurrence_type) return;

    const weekdays = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
    const base = new Date(job.scheduled_for);
    base.setUTCDate(base.getUTCDate() + 1);

    let nextOccurrence = null;
    for (let i = 0; i < 60; i++) {
      const candidate = new Date(base);
      candidate.setUTCDate(base.getUTCDate() + i);

      let matches = false;
      if (config.recurrence_type === 'daily') matches = true;
      else if (config.recurrence_type === 'weekly') {
        matches = (config.recurrence_days || []).includes(weekdays[candidate.getUTCDay()]);
      } else if (config.recurrence_type === 'monthly') {
        matches = candidate.getUTCDate() === (config.day_of_month || 1);
      }

      if (matches) {
        nextOccurrence = candidate;
        break;
      }
    }

    if (!nextOccurrence) return;

    const [hour, minute] = config.time.split(':').map(Number);
    nextOccurrence.setUTCHours(hour || 8, minute || 0, 0, 0);
    const nextReference = `${job.flow_base44_id}_${job.contact_phone}_${nextOccurrence.toISOString().slice(0, 10)}`;

    const existing = await pgClient.query(
      "SELECT id FROM scheduled_jobs WHERE reference_id = $1 AND status IN ('pending', 'queued', 'running') LIMIT 1",
      [nextReference]
    );
    if (existing.rows.length > 0) return;

    await pgClient.query(`
      INSERT INTO scheduled_jobs
        (company_id, job_type, flow_base44_id, contact_phone, scheduled_for, reference_id, reference_type, context, status, attempts, max_attempts)
      VALUES ($1, 'flow_trigger', $2, $3, $4, $5, 'recurring', $6, 'pending', 0, 3)
    `, [
      job.company_id,
      job.flow_base44_id,
      job.contact_phone,
      nextOccurrence.toISOString(),
      nextReference,
      JSON.stringify({ ...job.context, flow_name: flow.name, connection_id: flow.connection_id || null }),
    ]);

    console.log(`[RECUR] próxima ocorrência: ${nextOccurrence.toISOString()} para ${job.contact_phone}`);
  } catch (e) {
    console.warn('[RECUR] erro:', e.message);
  }
}

async function scheduleNextJob() {
  if (nextJobTimer) {
    clearTimeout(nextJobTimer);
    nextJobTimer = null;
  }

  try {
    const result = await pgClient.query(`
      SELECT scheduled_for FROM scheduled_jobs
      WHERE status = 'pending' AND scheduled_for > NOW()
      ORDER BY scheduled_for ASC LIMIT 1
    `);
    if (result.rows.length === 0) return;

    const nextAt = new Date(result.rows[0].scheduled_for).getTime();
    const delay = Math.max(1000, nextAt - Date.now() + 500);
    console.log(`[TIMER] próximo job em ${Math.round(delay / 1000)}s (${result.rows[0].scheduled_for})`);
    nextJobTimer = setTimeout(() => scheduleProcessing(), delay);
  } catch (e) {
    console.error('[TIMER] erro:', e.message);
  }
}

function startReconciliation() {
  setInterval(async () => {
    await processDueJobs();
    await scheduleNextJob();
  }, RECONCILE_INTERVAL_MS);
  console.log(`[RECONCILE] reconciliação a cada ${RECONCILE_INTERVAL_MS / 1000}s`);
}

function startHeartbeat() {
  setInterval(async () => {
    try {
      await pgClient.query(`
        UPDATE worker_heartbeats
        SET last_heartbeat = NOW(), status = 'running',
            processed_count = $2, failed_count = $3, updated_at = NOW()
        WHERE worker_id = $1
      `, [WORKER_ID, stats.processed, stats.failed]);
    } catch (e) {
      console.warn('[HEARTBEAT] erro:', e.message);
    }
  }, HEARTBEAT_INTERVAL_MS);
  console.log(`[HEARTBEAT] heartbeat a cada ${HEARTBEAT_INTERVAL_MS / 1000}s`);
}

async function main() {
  console.log('══════════════════════════════════════════════════════');
  console.log('  GOcrm Railway Worker v2.0 — Contínuo');
  console.log(`  Worker ID: ${WORKER_ID}`);
  console.log(`  App URL:  ${APP_URL}`);
  console.log(`  Port:     ${PORT}`);
  console.log('══════════════════════════════════════════════════════');

  if (!WORKER_SECRET) {
    console.error('WORKER_SECRET não definido');
    process.exit(1);
  }
  if (!SUPABASE_DB_URL) {
    console.error('SUPABASE_DB_URL não definido');
    process.exit(1);
  }

  server.listen(PORT, () => console.log(`[HTTP] servidor ouvindo na porta ${PORT}`));

  await connectPostgres();
  await scheduleProcessing();
  startReconciliation();
  startHeartbeat();
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
