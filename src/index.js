// ═══════════════════════════════════════════════════════════
// GOcrm — Railway Worker Contínuo v2.0
// ═══════════════════════════════════════════════════════════

const http = require('http');
const { Client, Pool } = require('pg');

// ── Config ──
const PORT = process.env.PORT || 3000;
const WORKER_SECRET = process.env.WORKER_SECRET;
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const WORKER_ID = process.env.WORKER_ID || 'default';
const RECONCILE_INTERVAL_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 30000;
const TIMEOUT_CHECK_INTERVAL_MS = 30000;
const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 10;
const PROCESSING_CONCURRENCY = 1;
const INTER_CHUNK_DELAY_MS = 5000;
const INTER_BATCH_DELAY_MS = 2000;
const RATE_LIMIT_BACKOFF_MS = [5000, 15000, 30000];
const RATE_LIMIT_GLOBAL_PAUSE_MS = 60000;

// ── Estado global ──
let pgClient = null;
let pgPool = null;
let nextJobTimer = null;
let isProcessing = false;
let isScheduling = false;
let rateLimitedUntil = 0;
let stats = { processed: 0, sent: 0, failed: 0, errors: 0, startedAt: new Date().toISOString() };

// ═══════════════ HTTP SERVER ═══════════════

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/health') return healthHandler(req, res);
  if (req.method === 'POST' && url.pathname === '/trigger') return triggerHandler(req, res);
  if (req.method === 'POST' && url.pathname === '/proxy-fetch') return proxyFetchHandler(req, res);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

function healthHandler(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true, worker_id: WORKER_ID,
    pg_connected: !!pgClient,
    pg_pool_total: pgPool?.totalCount || 0,
    pg_pool_idle: pgPool?.idleCount || 0,
    is_processing: isProcessing, stats, uptime: process.uptime(),
  }));
}

async function readJson(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'JSON inválido' }));
    return null;
  }
}

function isAuthorized(req, res) {
  if ((req.headers.authorization || '') === `Bearer ${WORKER_SECRET}`) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
  return false;
}

async function triggerHandler(req, res) {
  if (!isAuthorized(req, res)) return;
  const parsed = await readJson(req, res);
  if (!parsed) return;
  const { action, flow_id, contact_phone, company_id, context, reference_id } = parsed;
  if (action !== 'startFlow' || !flow_id || !contact_phone || !company_id) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Campos obrigatórios: action=startFlow, flow_id, contact_phone, company_id' }));
  }
  console.log(`[TRIGGER] flow=${flow_id} phone=${contact_phone} company=${company_id}`);
  try {
    const result = await callBase44Function('workerTrigger', { action: 'startFlow', flow_id, contact_phone, company_id, context, reference_id });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e) {
    console.error('[TRIGGER] erro:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

async function proxyFetchHandler(req, res) {
  if (!isAuthorized(req, res)) return;
  const parsed = await readJson(req, res);
  if (!parsed) return;
  const { method = 'GET', url, headers = {}, body: reqBody = null } = parsed;
  if (!url) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'url obrigatória' }));
  }
  try {
    const fetchOpts = { method, headers };
    if (reqBody !== null && reqBody !== undefined && method !== 'GET' && method !== 'HEAD') fetchOpts.body = reqBody;
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

// ═══════════════ BASE44 ═══════════════

async function callBase44Function(functionName, payload, _retries = 0) {
  const res = await fetch(`${APP_URL}/functions/${functionName}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  const isRateLimit = res.status === 429 || /rate limit/i.test(text);
  if (isRateLimit && _retries < RATE_LIMIT_BACKOFF_MS.length) {
    const waitMs = RATE_LIMIT_BACKOFF_MS[_retries];
    console.warn(`[BASE44] rate limit em ${functionName} — retry em ${waitMs}ms (${_retries + 1}/${RATE_LIMIT_BACKOFF_MS.length})`);
    await new Promise(r => setTimeout(r, waitMs));
    return callBase44Function(functionName, payload, _retries + 1);
  }
  if (!res.ok) throw new Error(`Base44 ${functionName} returned ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

// ═══════════════ POSTGRES ═══════════════

async function connectPostgres() {
  if (pgPool) { try { await pgPool.end(); } catch {} }
  pgPool = new Pool({ connectionString: SUPABASE_DB_URL, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 });
  console.log('[PG-POOL] pool criado (max=10 conexões)');

  if (pgClient) { try { await pgClient.end(); } catch {} }
  pgClient = new Client({ connectionString: SUPABASE_DB_URL });

  // Debounce: agrupa rajadas de notificações em um único ciclo a cada 2s
  let notifyTimer = null;
  pgClient.on('notification', () => {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => { notifyTimer = null; scheduleProcessing(); }, 2000);
  });
  pgClient.on('error', (err) => console.error('[PG] erro de conexão (listen):', err.message));
  pgClient.on('end', () => {
    console.warn('[PG] conexão listen fechada — reconectando em 5s...');
    pgClient = null;
    setTimeout(connectPostgres, 5000);
  });

  await pgClient.connect();
  await pgClient.query(`LISTEN scheduled_jobs_notify`);
  console.log('[PG] Conectado e escutando canal: scheduled_jobs_notify');
}

// ═══════════════ PROCESSAMENTO ═══════════════

async function scheduleProcessing() {
  if (isScheduling) return;
  isScheduling = true;
  try {
    if (nextJobTimer) { clearTimeout(nextJobTimer); nextJobTimer = null; }
    await processDueJobs();
    await scheduleNextJob();
  } finally {
    isScheduling = false;
  }
}

async function processDueJobs() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    await recoverStaleJobs();
    while (true) {
      const jobs = await claimDueJobs(BATCH_SIZE);
      if (jobs.length === 0) break;
      console.log(`[PROCESS] processando lote de ${jobs.length} job(s)`);
      await processBatch(jobs);
      await new Promise(r => setTimeout(r, INTER_BATCH_DELAY_MS));
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
    const res = await pgPool.query(
      `UPDATE scheduled_jobs SET status = 'pending', last_attempt_at = NOW()
       WHERE status = 'running' AND last_attempt_at < $1 AND attempts < $2`,
      [cutoff, MAX_ATTEMPTS]
    );
    if (res.rowCount > 0) console.log(`[RECOVER] ${res.rowCount} job(s) expirados → 'pending'`);
  } catch (e) {
    console.error('[RECOVER] erro:', e.message);
  }
}

async function claimDueJobs(limit) {
  const now = new Date().toISOString();
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  try {
    const res = await pgPool.query(`
      UPDATE scheduled_jobs
      SET status = 'running', attempts = attempts + 1, last_attempt_at = $1
      WHERE id IN (
        SELECT id FROM scheduled_jobs
        WHERE status = 'pending' AND scheduled_for <= $1 AND scheduled_for >= $2 AND attempts < $3
        ORDER BY scheduled_for ASC LIMIT $4
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `, [now, thirtyMinAgo, MAX_ATTEMPTS, limit]);
    return res.rows;
  } catch (e) {
    console.error('[CLAIM] erro:', e.message);
    return [];
  }
}

async function processBatch(jobs) {
  for (let i = 0; i < jobs.length; i += PROCESSING_CONCURRENCY) {
    if (Date.now() < rateLimitedUntil) {
      const wait = rateLimitedUntil - Date.now();
      console.log(`[PROCESS] pausando ${Math.round(wait / 1000)}s (rate limit global)`);
      await new Promise(r => setTimeout(r, wait));
    }
    await Promise.allSettled(jobs.slice(i, i + PROCESSING_CONCURRENCY).map(processJob));
    if (i + PROCESSING_CONCURRENCY < jobs.length) await new Promise(r => setTimeout(r, INTER_CHUNK_DELAY_MS));
  }
}

async function processJob(job) {
  stats.processed++;
  console.log(`[JOB] id=${job.id} tipo=${job.job_type} phone=${job.contact_phone || '-'}`);
  try {
    if (job.job_type === 'flow_trigger') {
      const result = await processFlowTriggerJob(job);
      success = result.ok;
      errorMsg = result.error || null;
      retry = result.retry !== false;
      } else if (job.job_type === 'flow_timeout') {
      // Timeout de IA / menu: o checkFlowTimeouts resolve todas as expirações vencidas
      const result = await callBase44Function('checkFlowTimeouts', {});
      success = result?.ok !== false;
    } else if (job.job_type === 'appointment_reminder') {
      success = await processAppointmentJob(job);
    } else {
      console.warn(`[JOB] tipo desconhecido: ${job.job_type}`);
      success = true;
    }
  } catch (e) {
    console.error(`[JOB] exceção id=${job.id}:`, e.message);
    errorMsg = e.message;
    if (/rate limit/i.test(e.message)) {
      rateLimitedUntil = Date.now() + RATE_LIMIT_GLOBAL_PAUSE_MS;
      console.warn(`[JOB] rate limit — pausa global de ${RATE_LIMIT_GLOBAL_PAUSE_MS / 1000}s`);
    }
  }
  await updateJobStatus(job, success, errorMsg, retry);
  if (success && job.reference_type === 'recurring' && job.job_type === 'flow_trigger') await createNextRecurringJob(job);
  if (success) stats.sent++; else stats.failed++;
}

async function processFlowTriggerJob(job) {
  const context = job.context || {};
  const flowBase44Id = job.flow_base44_id;
  const isDelayResume = !!context._delay_resume_execution_id;

  let flowConnectionId = context.connection_id || null;
  if (!isDelayResume) {
    const flowRes = await pgPool.query(
      `SELECT status, connection_id, name, trigger_type FROM flows WHERE base44_id = $1 LIMIT 1`,
      [flowBase44Id]
    );
    const flow = flowRes.rows[0];
    if (!flow) { console.warn(`[JOB] flow não encontrado: ${flowBase44Id}`); return { ok: true }; }
    if (flow.status !== 'active') { console.log(`[JOB] flow não ativo (${flow.status}) — cancelando job`); return { ok: true }; }
    flowConnectionId = flow.connection_id || flowConnectionId;
  }

  const result = await callBase44Function('workerTrigger', {
    action: 'startFlow',
    flow_id: flowBase44Id,
    contact_phone: job.contact_phone,
    company_id: job.company_id,
    context: { ...context, reference_id: job.reference_id, connection_id: flowConnectionId },
    reference_id: job.reference_id,
  });

  if (!result?.ok || result?.skipped) {
    console.log(`[JOB] phone=${job.contact_phone} ok=${result?.ok} skipped=${result?.skipped} reason=${result?.reason || result?.error || '-'}`);
  }

  const reason = result?.reason || result?.error;
  if (reason === 'connection_mismatch' || String(result?.error || '').startsWith('connection_mismatch:')) {
    const error = result?.error || `connection_mismatch: job.context.connection_id=${context.connection_id || null}, flow.connection_id=${flowConnectionId || null}`;
    console.error(`[JOB] ${error}`);
    await logAutomation(job, 'failed');
    return { ok: false, retry: false, error };
  }
  if (reason === 'Already running') return { ok: true, retry: false };

  const isSuccess = result?.ok === true;
  await logAutomation(job, isSuccess ? 'sent' : 'failed');
  return { ok: isSuccess, retry: result?.retry !== false, error: isSuccess ? null : (result?.error || result?.reason || 'Falha no envio') };
}

async function processAppointmentJob(job) {
  const context = job.context || {};
  const flowBase44Id = job.flow_base44_id;
  const flowRes = await pgPool.query(`SELECT status, connection_id, name FROM flows WHERE base44_id = $1 LIMIT 1`, [flowBase44Id]);
  const flow = flowRes.rows[0];
  if (!flow || flow.status !== 'active') return true;

  const existingLog = await pgPool.query(
    `SELECT id FROM automation_logs WHERE automation_id = $1 AND reference_id = $2 LIMIT 1`,
    [flowBase44Id, job.reference_id]
  );
  if (existingLog.rows.length > 0) return true;

  const result = await callBase44Function('flowEngine', {
    action: 'startFlow',
    flow_id: flowBase44Id,
    contact_phone: job.contact_phone,
    company_id: job.company_id,
    trigger_context: { ...context, reference_id: job.reference_id, connection_id: flow.connection_id || context.connection_id || null },
  });
  console.log(`[JOB] flowEngine resultado: ok=${result?.ok} exec=${result?.execution_id || '-'}`);
  await logAutomation(job, result?.ok ? 'sent' : 'failed');
  return !!result?.ok;
}

async function logAutomation(job, status) {
  try {
    const flowRes = await pgPool.query(`SELECT name FROM flows WHERE base44_id = $1 LIMIT 1`, [job.flow_base44_id]);
    await pgPool.query(
      `INSERT INTO automation_logs (company_id, automation_type, automation_id, automation_name, contact_phone, status, triggered_at, reference_id)
       VALUES ($1, 'flow', $2, $3, $4, $5, NOW(), $6)`,
      [job.company_id, job.flow_base44_id, flowRes.rows[0]?.name || '', job.contact_phone, status, job.reference_id]
    );
  } catch (e) {
    console.warn('[LOG] erro ao registrar log:', e.message);
  }
}

async function updateJobStatus(job, success, errorMsg, retry = true) {
  try {
    if (success) {
      await pgPool.query(`UPDATE scheduled_jobs SET status = 'completed', completed_at = NOW(), error_message = NULL WHERE id = $1`, [job.id]);
    } else if (!retry || job.attempts >= MAX_ATTEMPTS) {
      await pgPool.query(`UPDATE scheduled_jobs SET status = 'failed', error_message = $2 WHERE id = $1`, [job.id, errorMsg || 'Falha no envio']);
      console.log(`[JOB] ❌ ${job.id} phone=${job.contact_phone} | ${errorMsg || 'Falha'}`);
    } else {
      // Reagenda com atraso crescente (2 min, 4 min) em vez de repetir na hora
      await pgPool.query(
        `UPDATE scheduled_jobs SET status = 'pending', error_message = $2,
           scheduled_for = NOW() + ($3 || ' minutes')::interval WHERE id = $1`,
        [job.id, errorMsg || 'Falha — será reprocessado', String(2 * job.attempts)]
      );
      console.log(`[JOB] ⚠️ ${job.id} phone=${job.contact_phone} retry ${job.attempts}/${MAX_ATTEMPTS}`);
    }
  } catch (e) {
    console.error('[JOB] erro ao atualizar status:', e.message);
  }
}

async function createNextRecurringJob(job) {
  try {
    const flowRes = await pgPool.query(`SELECT name, trigger_config, connection_id FROM flows WHERE base44_id = $1 LIMIT 1`, [job.flow_base44_id]);
    const flow = flowRes.rows[0];
    if (!flow) return;
    const cfg = flow.trigger_config || {};
    if (!cfg.time || !cfg.recurrence_type) return;

    const diasSemana = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
    const base = new Date(job.scheduled_for);
    base.setUTCDate(base.getUTCDate() + 1);

    let nextOccurrence = null;
    for (let i = 0; i < 60; i++) {
      const candidate = new Date(base);
      candidate.setUTCDate(base.getUTCDate() + i);
      let match = false;
      if (cfg.recurrence_type === 'daily') match = true;
      else if (cfg.recurrence_type === 'weekly') match = (cfg.recurrence_days || []).includes(diasSemana[candidate.getUTCDay()]);
      else if (cfg.recurrence_type === 'monthly') match = candidate.getUTCDate() === (cfg.day_of_month || 1);
      if (match) { nextOccurrence = candidate; break; }
    }
    if (!nextOccurrence) return;

    const [h, m] = (cfg.time || '08:00').split(':').map(Number);
    nextOccurrence.setUTCHours((h || 8) + 3, m || 0, 0, 0);
    const nextRefId = `${job.flow_base44_id}_${job.contact_phone}_${nextOccurrence.toISOString().slice(0, 10)}`;

    const existing = await pgPool.query(
      `SELECT id FROM scheduled_jobs WHERE reference_id = $1 AND status IN ('pending', 'queued', 'running') LIMIT 1`,
      [nextRefId]
    );
    if (existing.rows.length > 0) return;

    await pgPool.query(
      `INSERT INTO scheduled_jobs (company_id, job_type, flow_base44_id, contact_phone, scheduled_for, reference_id, reference_type, context, status, attempts, max_attempts)
       VALUES ($1, 'flow_trigger', $2, $3, $4, $5, 'recurring', $6, 'pending', 0, 3)`,
      [job.company_id, job.flow_base44_id, job.contact_phone, nextOccurrence.toISOString(), nextRefId,
       JSON.stringify({ ...job.context, flow_name: flow.name, connection_id: flow.connection_id || null })]
    );
    console.log(`[RECUR] próxima ocorrência: ${nextOccurrence.toISOString()} para ${job.contact_phone}`);
  } catch (e) {
    console.warn('[RECUR] erro:', e.message);
  }
}

// ═══════════════ TIMER / LOOPS ═══════════════

async function scheduleNextJob() {
  if (nextJobTimer) { clearTimeout(nextJobTimer); nextJobTimer = null; }
  try {
    const res = await pgPool.query(
      `SELECT scheduled_for FROM scheduled_jobs WHERE status = 'pending' AND scheduled_for > NOW() ORDER BY scheduled_for ASC LIMIT 1`
    );
    if (res.rows.length === 0) return;
    const delay = Math.max(1000, new Date(res.rows[0].scheduled_for).getTime() - Date.now() + 500);
    nextJobTimer = setTimeout(() => scheduleProcessing(), delay);
  } catch (e) {
    console.error('[TIMER] erro:', e.message);
  }
}

function startReconciliation() {
  setInterval(() => scheduleProcessing(), RECONCILE_INTERVAL_MS);
  console.log(`[RECONCILE] a cada ${RECONCILE_INTERVAL_MS / 1000}s`);
}

function startTimeoutChecks() {
  setInterval(async () => {
    try { await callBase44Function('checkContactFieldDates', {}); }
    catch (e) { console.warn('[TIMEOUT_CHECK] checkContactFieldDates erro:', e.message); }
    try { await callBase44Function('checkFlowTimeouts', {}); }
    catch (e) { console.warn('[TIMEOUT_CHECK] checkFlowTimeouts erro:', e.message); }
  }, TIMEOUT_CHECK_INTERVAL_MS);
  console.log(`[TIMEOUT_CHECK] a cada ${TIMEOUT_CHECK_INTERVAL_MS / 1000}s`);
}

function startHeartbeat() {
  setInterval(async () => {
    try {
      await pgPool.query(
        `UPDATE worker_heartbeats SET last_heartbeat = NOW(), status = 'running',
           processed_count = $2, failed_count = $3, updated_at = NOW() WHERE worker_id = $1`,
        [WORKER_ID, stats.processed, stats.failed]
      );
    } catch (e) {
      console.warn('[HEARTBEAT] erro:', e.message);
    }
  }, HEARTBEAT_INTERVAL_MS);
  console.log(`[HEARTBEAT] a cada ${HEARTBEAT_INTERVAL_MS / 1000}s`);
}

// ═══════════════ STARTUP ═══════════════

async function main() {
  console.log(`GOcrm Railway Worker v2.1 | id=${WORKER_ID} | app=${APP_URL} | port=${PORT}`);
  if (!WORKER_SECRET) { console.error('WORKER_SECRET não definido'); process.exit(1); }
  if (!SUPABASE_DB_URL) { console.error('SUPABASE_DB_URL não definido'); process.exit(1); }

  server.listen(PORT, () => console.log(`[HTTP] ouvindo na porta ${PORT}`));
  await connectPostgres();
  await scheduleProcessing();
  startReconciliation();
  startHeartbeat();
  startTimeoutChecks();
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
