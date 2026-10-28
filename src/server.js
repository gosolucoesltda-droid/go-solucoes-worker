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
//   - Heartbeat a cada 30s (para o fallback Base44 saber que estamos ativos)
//   - Lease recovery: jobs 'running' expirados voltam para 'pending'
// ═══════════════════════════════════════════════════════════

const http = require('http');
const { Client, Pool } = require('pg');
const { handleWebhook, startWebhookRetries } = require('./webhookGateway');
const { runFast, firstNodeId } = require('./fastPath');
const { liveTimeline } = require('./liveTimeline');
const { ownStart } = require('./flowOwner');
const { startWaitWatcher } = require('./waitWatcher');
const { startTimeoutWatcher, checkTimeoutsNow } = require('./timeoutWatcher');
const { startFieldDateSweep } = require('./fieldDateSweep');
const { startStaleDealsSweep } = require('./staleDealsSweep');
const { startDealDueSweep } = require('./dealDueSweep');
const { handleAi } = require('./aiAgent');
const { handleManualStart } = require('./manualStart');
const { handleCampaign } = require('./campaign');
const { handleManualSend } = require('./manualSend');
const { setFactsPool } = require('./crmFacts');
const { setBotSettingsPool } = require('./botSettings');
const { serveAudio } = require('./voiceAudio');
const { handlePublicApi } = require('./publicApi');

// ── Config ──
const PORT = process.env.PORT || 3000;
const WORKER_SECRET = process.env.WORKER_SECRET;
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
const WORKER_ID = process.env.WORKER_ID || 'default';
const RECONCILE_INTERVAL_MS = 30000;  // 30s
const HEARTBEAT_INTERVAL_MS = 30000;  // 30s
const TIMEOUT_CHECK_INTERVAL_MS = 60000;  // 60s — o Base44 também roda 1x/min; 30s dobrava a carga
const LEASE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — jobs 'running' expiram
const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 10;
const PROCESSING_CONCURRENCY = 10;  // lote de 10 em paralelo — o Railway envia direto (sem o limite do Base44)
const INTER_CHUNK_DELAY_MS = 1000;  // pausa curta entre lotes dentro do mesmo ciclo
const INTER_BATCH_DELAY_MS = 1000;   // pausa entre lotes quando há mais jobs
const RATE_LIMIT_BACKOFF_MS = [5000, 15000, 30000];  // backoff exponencial mais longo ao bater rate limit
const RATE_LIMIT_GLOBAL_PAUSE_MS = 60000;  // pausa global de 60s quando rate limit é detectado

// ── Estado global ──
let pgClient = null;  // cliente dedicado para LISTEN/NOTIFY
let pgPool = null;    // pool para queries concorrentes (jobs em paralelo)
let nextJobTimer = null;
let isProcessing = false;
let isScheduling = false;  // previne scheduleProcessing concorrente (notificações + reconciliação + timer)
let rateLimitedUntil = 0;  // timestamp até qual pausar processamento após rate limit
let stats = { processed: 0, sent: 0, failed: 0, errors: 0, startedAt: new Date().toISOString() };

// ═══════════════════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return healthHandler(req, res);
  }

  if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
    return serveAudio(res, pgPool, url.pathname.slice(7)).catch((e) => {
      console.error('[AUDIO] erro:', e.message);
      if (!res.headersSent) { res.writeHead(500); res.end('Error'); }
    });
  }

  if (req.method === 'POST' && url.pathname === '/trigger') {
    return triggerHandler(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/proxy-fetch') {
    return proxyFetchHandler(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/flow/manual') {
    return handleManualStart(req, res, pgPool);
  }

  if (req.method === 'POST' && url.pathname === '/message/send') {
    return handleManualSend(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/campaign/send') {
    return handleCampaign(req, res, () => pgPool);
  }

  if (req.method === 'POST' && url.pathname === '/ai/process') {
    return handleAi(req, res, pgPool);
  }

  if (url.pathname === '/webhook/whatsapp' && (req.method === 'GET' || req.method === 'POST')) {
    return handleWebhook(req, res, url, () => pgPool).catch((e) => {
      console.error('[WEBHOOK] erro:', e.message);
      if (!res.headersSent) { res.writeHead(500); res.end('Error'); }
    });
  }

  // API pública (mesmas rotas de gocrm.pro/functions/<nome>)
  if (url.pathname.startsWith('/functions/')) {
    return handlePublicApi(req, res, url, pgPool, callBase44Function);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

// ── /health ──
function healthHandler(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    worker_id: WORKER_ID,
    pg_connected: pgClient?.connected || false,
    pg_pool_total: pgPool?.totalCount || 0,
    pg_pool_idle: pgPool?.idleCount || 0,
    is_processing: isProcessing,
    voice_ready: !!process.env.RAILWAY_PUBLIC_DOMAIN,
    stats,
    uptime: process.uptime(),
  }));
}

// ── /trigger — dispara flowEngine.startFlow via Base44 workerTrigger ──
async function triggerHandler(req, res) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${WORKER_SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed;
  try { parsed = JSON.parse(body); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'JSON inválido' }));
  }

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

// ── /proxy-fetch — proxy IPv4 ──
async function proxyFetchHandler(req, res) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${WORKER_SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed;
  try { parsed = JSON.parse(body); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'JSON inválido' }));
  }

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

// ═══════════════════════════════════════════════════════════
// BASE44 FUNCTION CALLER
// ═══════════════════════════════════════════════════════════

async function callBase44Function(functionName, payload, _retries = 0) {
  const url = `${APP_URL}/functions/${functionName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WORKER_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  // ── Retry com backoff para rate limit da plataforma (429 ou 500 "Rate limit exceeded") ──
  // A plataforma Base44 limita invocações de função por minuto. Quando muitos
  // jobs de vencimento disparam ao mesmo tempo, o worker bate esse limite.
  // Sem retry, o job falha e volta para 'pending', criando mais carga no ciclo
  // seguinte. Com backoff, o worker espera e tenta novamente dentro do mesmo ciclo.
  const isRateLimit = res.status === 429 ||
    (res.status === 500 && /rate limit/i.test(text)) ||
    /rate limit exceeded/i.test(text);

  if (isRateLimit && _retries < RATE_LIMIT_BACKOFF_MS.length) {
    const waitMs = RATE_LIMIT_BACKOFF_MS[_retries];
    console.warn(`[BASE44] rate limit em ${functionName} — aguardando ${waitMs}ms antes de retry (${_retries + 1}/${RATE_LIMIT_BACKOFF_MS.length})`);
    await new Promise(r => setTimeout(r, waitMs));
    return callBase44Function(functionName, payload, _retries + 1);
  }

  if (!res.ok) {
    throw new Error(`Base44 ${functionName} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return data;
}

// ═══════════════════════════════════════════════════════════
// POSTGRES LISTEN CONNECTION
// ═══════════════════════════════════════════════════════════

async function connectPostgres() {
  // ── Pool para queries concorrentes ──
  // O processamento em paralelo (Promise.allSettled) dispara múltiplas queries
  // simultaneamente. Um único Client não suporta queries concorrentes (gera
  // DeprecationWarning no pg@8 e vai falhar no pg@9). O Pool gerencia múltiplas
  // conexões e distribui as queries.
  // O pool é criado uma única vez: as rotinas (vencimento, datas, esperas…) guardam
  // esta referência ao iniciar. Recriá-lo na reconexão do LISTEN deixava todas elas
  // presas num pool encerrado, falhando em silêncio. O pool se reconecta sozinho.
  if (!pgPool) {
    pgPool = new Pool({
      connectionString: SUPABASE_DB_URL,
      max: 10,              // máx 10 conexões concorrentes
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      keepAlive: true,      // detecta conexões caídas em vez de deixar queries presas
    });
    pgPool.on('error', (err) => console.error('[PG-POOL] conexão ociosa caiu:', err.message));
    console.log('[PG-POOL] pool criado (max=10 conexões)');
    setFactsPool(pgPool);
    setBotSettingsPool(pgPool);
  }

  // ── Cliente dedicado para LISTEN/NOTIFY ──
  // LISTEN precisa de uma conexão persistente exclusiva — não pode usar o Pool.
  if (pgClient) {
    try { await pgClient.end(); } catch {}
  }

  pgClient = new Client({ connectionString: SUPABASE_DB_URL });

  // Debounce: cada UPDATE em scheduled_jobs gera uma notificação. Sem agrupar,
  // centenas de notificações por segundo viram centenas de ciclos + logs.
  let notifyTimer = null;
  pgClient.on('notification', () => {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => { notifyTimer = null; scheduleProcessing(); }, 2000);
  });

  pgClient.on('error', (err) => {
    console.error('[PG] erro de conexão (listen):', err.message);
  });

  pgClient.on('end', () => {
    console.warn('[PG] conexão listen fechada — reconectando em 5s...');
    pgClient = null;
    setTimeout(connectPostgres, 5000);
  });

  await pgClient.connect();
  await pgClient.query(`LISTEN scheduled_jobs_notify`);
  console.log('[PG] Conectado e escutando canal: scheduled_jobs_notify');
}

// ═══════════════════════════════════════════════════════════
// JOB PROCESSING
// ═══════════════════════════════════════════════════════════

async function scheduleProcessing() {
  // Guard: previne múltiplas chamadas concorrentes (notificações LISTEN + timer + reconciliação).
  // Sem este guard, duas chamadas simultâneas disparam pgPool.query() ao mesmo tempo,
  // e o Pool pode reutilizar uma conexão com query pendente — gerando o DeprecationWarning
  // "client.query() when already executing a query" do pg@8.
  if (isScheduling) return;
  isScheduling = true;
  try {
    // Cancela timer anterior e processa imediatamente
    if (nextJobTimer) {
      clearTimeout(nextJobTimer);
      nextJobTimer = null;
    }
    await processDueJobs();
    await scheduleNextJob();
  } finally {
    isScheduling = false;
  }
}

async function processDueJobs() {
  if (isProcessing) {
    return;  // não logar — reduz volume de logs
  }
  isProcessing = true;

  try {
    // ── 1. Recuperar jobs 'running' expirados (lease recovery) ──
    await recoverStaleJobs();

    // ── 2. Buscar e processar jobs vencidos ──
    let hasMore = true;
    while (hasMore) {
      const jobs = await claimDueJobs(BATCH_SIZE);
      if (jobs.length === 0) {
        hasMore = false;
        break;
      }
      console.log(`[PROCESS] processando lote de ${jobs.length} job(s)`);
      // Processa em paralelo com concorrência limitada
      await processBatch(jobs);
      // Lote incompleto = fila vazia; senão uma pausa curta antes do próximo lote
      if (jobs.length < BATCH_SIZE) break;
      await new Promise(r => setTimeout(r, INTER_BATCH_DELAY_MS));
    }
  } catch (e) {
    console.error('[PROCESS] erro:', e.message);
    stats.errors++;
  } finally {
    isProcessing = false;
  }
}

// ── Recuperar jobs 'running' cujo lease expirou ──
async function recoverStaleJobs() {
  try {
    const cutoff = new Date(Date.now() - LEASE_TIMEOUT_MS).toISOString();
    const res = await pgPool.query(`
      UPDATE scheduled_jobs
      SET status = 'pending', last_attempt_at = NOW()
      WHERE status = 'running'
        AND last_attempt_at < $1
        AND attempts < $2
    `, [cutoff, MAX_ATTEMPTS]);
    if (res.rowCount > 0) {
      console.log(`[RECOVER] ${res.rowCount} job(s) 'running' expirados → 'pending'`);
    }
  } catch (e) {
    console.error('[RECOVER] erro:', e.message);
  }
}

// ── Claim atômico de jobs vencidos ──
async function claimDueJobs(limit) {
  const now = new Date().toISOString();
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  try {
    // Atomic claim: marca como 'running' e incrementa attempts em uma query só
    const res = await pgPool.query(`
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

    return res.rows;
  } catch (e) {
    console.error('[CLAIM] erro:', e.message);
    return [];
  }
}

// ── Processar lote de jobs ──
async function processBatch(jobs) {
  const chunks = [];
  for (let i = 0; i < jobs.length; i += PROCESSING_CONCURRENCY) {
    chunks.push(jobs.slice(i, i + PROCESSING_CONCURRENCY));
  }
  for (let ci = 0; ci < chunks.length; ci++) {
    // Verificar pausa global de rate limit antes de processar próximo chunk
    if (Date.now() < rateLimitedUntil) {
      const wait = rateLimitedUntil - Date.now();
      console.log(`[PROCESS] pausando ${Math.round(wait / 1000)}s (rate limit global)`);
      await new Promise(r => setTimeout(r, wait));
    }
    await Promise.allSettled(chunks[ci].map(job => processJob(job)));
    // Pausa entre chunks para não saturar o rate limit da plataforma
    if (ci < chunks.length - 1) {
      await new Promise(r => setTimeout(r, INTER_CHUNK_DELAY_MS));
    }
  }
}

// ── Processar um job individual ──
async function processJob(job) {
  stats.processed++;
  console.log(`[JOB] id=${job.id} tipo=${job.job_type} phone=${job.contact_phone || '-'}`);

  let success = false;
  let errorMsg = null;
  let retry = true;

  try {
    if (job.job_type === 'flow_trigger') {
      const result = await processFlowTriggerJob(job);
      success = result.ok;
      errorMsg = result.error || null;
      retry = result.retry !== false;
    } else if (job.job_type === 'flow_timeout') {
      // Timeout de IA / menu: o Railway resolve as expirações vencidas na hora
      await checkTimeoutsNow(pgPool, callBase44Function);
      success = true;
    } else if (job.job_type === 'appointment_reminder') {
      success = await processAppointmentJob(job);
    } else {
      console.warn(`[JOB] tipo desconhecido: ${job.job_type}`);
      success = true; // marca como completed para não ficar preso
    }
  } catch (e) {
    console.error(`[JOB] exceção id=${job.id}:`, e.message);
    errorMsg = e.message;
    success = false;
    // Se for rate limit da plataforma, ativar pausa global para evitar
    // que os próximos jobs também batam o limite e falhem em cascata
    if (/rate limit/i.test(e.message)) {
      rateLimitedUntil = Date.now() + RATE_LIMIT_GLOBAL_PAUSE_MS;
      console.warn(`[JOB] rate limit detectado — pausa global de ${RATE_LIMIT_GLOBAL_PAUSE_MS / 1000}s ativada`);
    }
  }

  // ── Atualizar status do job ──
  await updateJobStatus(job, success, errorMsg, retry);

  // ── Criar próxima ocorrência para jobs recorrentes ──
  if (success && job.reference_type === 'recurring' && job.job_type === 'flow_trigger') {
    await createNextRecurringJob(job);
  }

  if (success) stats.sent++;
  else stats.failed++;
}

// ── Processar flow_trigger ──
// Agendados/por data: Railway envia os primeiros blocos direto pela Meta; o Base44 só registra e continua
async function fastJob(job, flowId, connectionId) {
  try {
    const { rows: [flow] } = await pgPool.query(
      `select base44_id, name, nodes, trigger_config, trigger_type from flows where base44_id = $1 and status = 'active' limit 1`, [flowId]);
    if (!flow || flow.trigger_config?.contact_filters?.length) return null; // filtros ficam com o Base44
    const { rows: [contact] } = await pgPool.query(
      `select id, company_id, connection_id, nome, email, empresa, telefone, subscriber_active, automation_paused_until, tags, custom_fields, ultima_inbound_em, ad_window_expires_at from crm_contacts
       where telefone = $1 and connection_id = $2 limit 1`, [job.contact_phone, connectionId]);
    if (!contact || contact.subscriber_active === false || (contact.automation_paused_until && new Date(contact.automation_paused_until) > new Date())) return null;
    const { rows: active } = await pgPool.query(
      `select 1 from crm_flow_executions where flow_id = $1 and contact_phone = $2 and status in ('running','waiting') limit 1`, [flowId, job.contact_phone]);
    if (active.length) return null;
    const loadFlow = async (id) => (await pgPool.query(
      `select base44_id, name, nodes from flows where base44_id = $1 and connection_id = $2 and status = 'active' limit 1`, [id, connectionId])).rows[0] || null;
    const t = Date.now();
    // Janela de 24h (ou 72h de anúncio) aberta: o bloco de voz pode seguir pelo Railway
    const now = Date.now();
    const windowOpen = (contact.ultima_inbound_em && now - new Date(contact.ultima_inbound_em).getTime() < 24 * 3600000) ||
      (contact.ad_window_expires_at && new Date(contact.ad_window_expires_at).getTime() > now);
    // Contexto do disparo (ex.: data e hora do agendamento) entra nas variáveis das mensagens
    const live = liveTimeline(pgPool, { companyId: job.company_id, connectionId, contactId: contact.id, phone: job.contact_phone });
    const fast = await runFast(flow, firstNodeId(flow), { companyId: job.company_id, connectionId, phone: job.contact_phone, contact, loadFlow, context: job.context || {}, fresh: true, windowOpen: !!windowOpen, live, started: true });
    if (fast) console.log(`[JOB] id=${job.id} RAILWAY ENVIOU ${(fast._railway_messages || []).length} msg(s) de "${flow.name}" em ${Date.now() - t}ms`);
    // Caminho todo do Railway: ele mesmo registra a execução no Supabase (sem chamar o Base44)
    const trigger = { ...(job.context || {}), _source: 'railway_engine', reference_id: job.reference_id, connection_id: connectionId };
    const owned = fast ? await ownStart(pgPool, { flow, contact, phone: job.contact_phone, fast, trigger }) : false;
    return { fast, owned: !!owned };
  } catch (e) {
    console.error(`[JOB] id=${job.id} envio direto falhou (Base44 assume):`, e.message);
    return null;
  }
}

async function processFlowTriggerJob(job) {
  const context = job.context || {};
  const flowBase44Id = job.flow_base44_id;

  // ── Delay resume: pular verificação de status/filtros ──
  // Jobs de retomada de atraso (delay) já têm uma execução em andamento
  // e devem ser retomados independentemente do status do fluxo ou filtros
  // de contato. Sem isso, um fluxo em rascunho ou contato que não passa
  // no filtro deixa a execução travada em "waiting" para sempre.
  const isDelayResume = !!(context._delay_resume_execution_id);

  // Para delay-resume, NÃO verificar o flow no Supabase — o flow pode não
  // estar sincronizado ou pode ter status diferente. A execução já existe
  // no Base44 e deve ser retomada via flowEngine (que lê do Base44, não do Supabase).
  let flowConnectionId = context.connection_id || null;
  if (!isDelayResume) {
    // Verificar se o flow ainda existe (via Supabase) — apenas para jobs normais
    const flowRes = await pgPool.query(
      `SELECT status, connection_id, name, trigger_type FROM flows WHERE base44_id = $1 LIMIT 1`,
      [flowBase44Id]
    );
    const flow = flowRes.rows[0];
    if (!flow) {
      console.warn(`[JOB] flow não encontrado: ${flowBase44Id}`);
      return { ok: true }; // não retentar — flow deletado
    }
    if (flow.status !== 'active') {
      console.log(`[JOB] flow não ativo (${flow.status}) — cancelando job`);
      return { ok: true }; // não retentar — flow pausado/arquivado
    }
    flowConnectionId = flow.connection_id || flowConnectionId;
  } else {
    console.log(`[JOB] delay-resume detectado — pulando verificação no Supabase (flow=${flowBase44Id})`);
  }

  const direct = isDelayResume ? null : await fastJob(job, flowBase44Id, flowConnectionId);
  if (direct?.owned) {
    await logAutomation(job, 'sent');
    return { ok: true };
  }
  const fast = direct?.fast || null;

  // Chamar Base44 workerTrigger (tem rate limit + contact filters)
  const result = await callBase44Function('workerTrigger', {
    action: 'startFlow',
    flow_id: flowBase44Id,
    contact_phone: job.contact_phone,
    company_id: job.company_id,
    context: {
      ...context,
      ...(fast || {}),
      ...(fast ? { _source: 'railway_engine' } : {}),
      reference_id: job.reference_id,
      connection_id: flowConnectionId,
    },
    reference_id: job.reference_id,
  });

  // Log condensado do resultado (1 linha em vez de múltiplas)
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
  if (reason === 'Already running') {
    console.log(`skipped: already running, execution_id=${result?.execution_id || 'unknown'}`);
    return { ok: true, retry: false };
  }

  const isSuccess = result?.ok === true;
  await logAutomation(job, isSuccess ? 'sent' : 'failed');
  return { ok: isSuccess, retry: result?.retry !== false, error: isSuccess ? null : (result?.error || result?.reason || 'Falha no envio') };
}

// ── Processar appointment_reminder ──
async function processAppointmentJob(job) {
  const context = job.context || {};
  const flowBase44Id = job.flow_base44_id;

  // Verificar flow
  const flowRes = await pgPool.query(
    `SELECT status, connection_id, name FROM flows WHERE base44_id = $1 LIMIT 1`,
    [flowBase44Id]
  );
  const flow = flowRes.rows[0];
  if (!flow) return true;
  if (flow.status !== 'active') return true;

  // Deduplicação: verificar se já disparou para este reference_id
  const existingLog = await pgPool.query(
    `SELECT id FROM automation_logs WHERE automation_id = $1 AND reference_id = $2 LIMIT 1`,
    [flowBase44Id, job.reference_id]
  );
  if (existingLog.rows.length > 0) {
    console.log(`[JOB] appointment já disparado para ref=${job.reference_id} — pulando`);
    return true;
  }

  // Railway envia as mensagens direto pela Meta; o flowEngine registra e segue o restante
  // Caminho todo do Railway: ele mesmo registra a execução (sem chamar o Base44)
  const direct = await fastJob(job, flowBase44Id, flow.connection_id || context.connection_id);
  if (direct?.owned) {
    await logAutomation(job, 'sent');
    return true;
  }
  const fast = direct?.fast || null;
  const result = await callBase44Function('flowEngine', {
    action: 'startFlow',
    flow_id: flowBase44Id,
    contact_phone: job.contact_phone,
    company_id: job.company_id,
    trigger_context: {
      ...context,
      ...(fast || {}),
      ...(fast ? { _source: 'railway_engine' } : {}),
      reference_id: job.reference_id,
      connection_id: flow.connection_id || context.connection_id || null,
    },
  });

  console.log(`[JOB] flowEngine resultado: ok=${result?.ok} exec=${result?.execution_id || '-'}`);

  // Registrar log
  await logAutomation(job, result?.ok ? 'sent' : 'failed');

  return !!result?.ok;
}

// ── Log de automação no Supabase ──
async function logAutomation(job, status) {
  try {
    const flowRes = await pgPool.query(
      `SELECT name FROM flows WHERE base44_id = $1 LIMIT 1`,
      [job.flow_base44_id]
    );
    const flowName = flowRes.rows[0]?.name || '';
    await pgPool.query(
      `INSERT INTO automation_logs (company_id, automation_type, automation_id, automation_name, contact_phone, status, triggered_at, reference_id)
       VALUES ($1, 'flow', $2, $3, $4, $5, NOW(), $6)`,
      [job.company_id, job.flow_base44_id, flowName, job.contact_phone, status, job.reference_id]
    );
  } catch (e) {
    console.warn('[LOG] erro ao registrar log:', e.message);
  }
}

// ── Atualizar status do job ──
async function updateJobStatus(job, success, errorMsg, retry = true) {
  try {
    if (success) {
      await pgPool.query(
        `UPDATE scheduled_jobs SET status = 'completed', completed_at = NOW(), error_message = NULL WHERE id = $1`,
        [job.id]
      );
    } else if (!retry || job.attempts >= MAX_ATTEMPTS) {
      await pgPool.query(
        `UPDATE scheduled_jobs SET status = 'failed', error_message = $2 WHERE id = $1`,
        [job.id, errorMsg || 'Falha no envio']
      );
      console.log(`[JOB] ❌ ${job.id} phone=${job.contact_phone} | ${errorMsg || 'Falha'}`);
    } else {
      await pgPool.query(
        // Reagenda com atraso crescente — sem isso o job é reclamado na hora e
        // queima as 3 tentativas no mesmo segundo enquanto o rate limit dura.
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

// ── Criar próxima ocorrência para jobs recorrentes ──
async function createNextRecurringJob(job) {
  try {
    const flowRes = await pgPool.query(
      `SELECT trigger_config, connection_id FROM flows WHERE base44_id = $1 LIMIT 1`,
      [job.flow_base44_id]
    );
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
      else if (cfg.recurrence_type === 'weekly') {
        const dia = diasSemana[candidate.getUTCDay()];
        match = (cfg.recurrence_days || []).includes(dia);
      } else if (cfg.recurrence_type === 'monthly') {
        match = candidate.getUTCDate() === (cfg.day_of_month || 1);
      }
      if (match) { nextOccurrence = candidate; break; }
    }

    if (!nextOccurrence) return;

    // Aplicar hora configurada (cfg.time é BRT = UTC-3, somar 3h para UTC)
    const [h, m] = (cfg.time || '08:00').split(':').map(Number);
    nextOccurrence.setUTCHours((h || 8) + 3, m || 0, 0, 0);

    const nextRefId = `${job.flow_base44_id}_${job.contact_phone}_${nextOccurrence.toISOString().slice(0, 10)}`;

    // Verificar se já existe
    const existing = await pgPool.query(
      `SELECT id FROM scheduled_jobs WHERE reference_id = $1 AND status IN ('pending', 'queued', 'running') LIMIT 1`,
      [nextRefId]
    );
    if (existing.rows.length > 0) return;

    await pgPool.query(
      `INSERT INTO scheduled_jobs (company_id, job_type, flow_base44_id, contact_phone, scheduled_for, reference_id, reference_type, context, status, attempts, max_attempts)
       VALUES ($1, 'flow_trigger', $2, $3, $4, $5, 'recurring', $6, 'pending', 0, 3)`,
      [job.company_id, job.flow_base44_id, job.contact_phone, nextOccurrence.toISOString(), nextRefId, JSON.stringify({ ...job.context, flow_name: flow.name, connection_id: flow.connection_id || null })]
    );
    console.log(`[RECUR] próxima ocorrência: ${nextOccurrence.toISOString()} para ${job.contact_phone}`);
  } catch (e) {
    console.warn('[RECUR] erro:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════
// TIMER PARA PRÓXIMO JOB FUTURO
// ═══════════════════════════════════════════════════════════

async function scheduleNextJob() {
  if (nextJobTimer) {
    clearTimeout(nextJobTimer);
    nextJobTimer = null;
  }

  try {
    const res = await pgPool.query(`
      SELECT scheduled_for FROM scheduled_jobs
      WHERE status = 'pending' AND scheduled_for > NOW()
      ORDER BY scheduled_for ASC LIMIT 1
    `);
    if (res.rows.length === 0) return;

    const nextAt = new Date(res.rows[0].scheduled_for).getTime();
    const delay = Math.max(1000, nextAt - Date.now() + 500); // +500ms de margem
    // Só logar timer se próximo job for > 60s (reduz volume de logs)
    if (delay > 60000) {
      console.log(`[TIMER] próximo job em ${Math.round(delay / 1000)}s`);
    }
    nextJobTimer = setTimeout(() => scheduleProcessing(), delay);
  } catch (e) {
    console.error('[TIMER] erro:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════
// RECONCILIAÇÃO PERIÓDICA (safety net)
// ═══════════════════════════════════════════════════════════

function startReconciliation() {
  setInterval(async () => {
    // Reconciliação passa pelo mesmo guard de scheduleProcessing —
    // previne queries concorrentes no Pool
    await scheduleProcessing();
  }, RECONCILE_INTERVAL_MS);
  console.log(`[RECONCILE] reconciliação a cada ${RECONCILE_INTERVAL_MS / 1000}s`);
}

// ═══════════════════════════════════════════════════════════
// TIMEOUT CHECKS — verificações de tempo preciso (30s)
// Substitui o cron de 5 min do Base44 por precisão de ±30s
// ═══════════════════════════════════════════════════════════

function startTimeoutChecks() {
  setInterval(async () => {
    // contact_field_date: NÃO é mais verificado aqui. Os jobs são criados no Supabase
    // quando o campo muda (contactFieldUpdater) e disparados via NOTIFY. A varredura
    // de segurança (repetir todo ano) roda 1x/dia no Base44.

    // checkFlowTimeouts (reserva do Base44) — só quando há execução travada ou espera que o
    // Railway não resolveu em 2 min (atrasos e tempos limite são resolvidos aqui em ~10s)
    try {
      if (pgPool) {
        const { rows } = await pgPool.query(
          `select 1 from crm_flow_executions
           where (status = 'running' and started_at < now() - interval '2 minutes')
              or (status = 'waiting' and (
                   delay_until <= now() - interval '2 minutes'
                or nullif(context->>'_wait_timeout_at', '')::timestamptz <= now() - interval '2 minutes'
                or (context->>'_menu_timeout_at')::timestamptz <= now()
                or not (context ? '_wait_type')))
           limit 1`
        );
        if (!rows.length) return;
      }
      await callBase44Function('checkFlowTimeouts', {});
    } catch (e) {
      console.warn('[TIMEOUT_CHECK] checkFlowTimeouts erro:', e.message);
    }
  }, TIMEOUT_CHECK_INTERVAL_MS);
  console.log(`[TIMEOUT_CHECK] verificações a cada ${TIMEOUT_CHECK_INTERVAL_MS / 1000}s`);
}

// ═══════════════════════════════════════════════════════════
// HEARTBEAT
// ═══════════════════════════════════════════════════════════

function startHeartbeat() {
  setInterval(async () => {
    try {
      await pgPool.query(
        `UPDATE worker_heartbeats
         SET last_heartbeat = NOW(), status = 'running',
             processed_count = $2, failed_count = $3, updated_at = NOW()
         WHERE worker_id = $1`,
        [WORKER_ID, stats.processed, stats.failed]
      );
    } catch (e) {
      console.warn('[HEARTBEAT] erro:', e.message);
    }
  }, HEARTBEAT_INTERVAL_MS);
  console.log(`[HEARTBEAT] heartbeat a cada ${HEARTBEAT_INTERVAL_MS / 1000}s`);
}

// ═══════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('══════════════════════════════════════════════════════');
  console.log('  GOcrm Railway Worker v2.0 — Contínuo');
  console.log(`  Worker ID: ${WORKER_ID}`);
  console.log(`  App URL:  ${APP_URL}`);
  console.log(`  Port:     ${PORT}`);
  console.log('══════════════════════════════════════════════════════');

  // Validar config
  if (!WORKER_SECRET) { console.error('WORKER_SECRET não definido'); process.exit(1); }
  if (!SUPABASE_DB_URL) { console.error('SUPABASE_DB_URL não definido'); process.exit(1); }

  // Iniciar HTTP server
  server.listen(PORT, () => {
    console.log(`[HTTP] servidor ouvindo na porta ${PORT}`);
  });

  // Conectar Postgres e iniciar LISTEN
  await connectPostgres();

  // Processar jobs pendentes imediatamente (startup)
  await scheduleProcessing();

  // Iniciar loops
  startReconciliation();
  startHeartbeat();
  startTimeoutChecks();
  startWebhookRetries(() => pgPool);
  startWaitWatcher(pgPool, callBase44Function);
  startTimeoutWatcher(pgPool, callBase44Function);
  startFieldDateSweep(pgPool);
  startStaleDealsSweep(pgPool, callBase44Function);
  startDealDueSweep(pgPool);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});