// Chaves de criptografia do endpoint do Flow de agendamento + preparo do Flow por conexão.
// - Um único par RSA 2048 atende todos os números; a pública é cadastrada em cada número.
// - A privada vem de FLOW_BOOKING_PRIVATE_KEY (Railway) e nunca vai para log.
const crypto = require('crypto');
const { createFlow, getFlow, publishFlow, setEncryptionKey, getEncryption } = require('./flowGraph');
const { bookingFlowJson } = require('./bookingFlowJson');
const { loadCreds } = require('./botSettings');
const { versionInfo } = require('./buildInfo');

let PRIVATE_KEY = null;
let PUBLIC_PEM = '';
let EPHEMERAL = false;

// Chave temporária só pode existir em desenvolvimento (NODE_ENV=development|dev).
// Em produção, sem FLOW_BOOKING_PRIVATE_KEY: nenhuma chave é gerada nem cadastrada.
const IS_DEV = ['development', 'dev'].includes(String(process.env.NODE_ENV || '').toLowerCase());
const NO_KEY_MESSAGE = 'Chave de criptografia não configurada no servidor';

function ensureKeys() {
  if (PRIVATE_KEY) return true;
  const raw = String(process.env.FLOW_BOOKING_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (raw) {
    PRIVATE_KEY = crypto.createPrivateKey(raw);
    PUBLIC_PEM = String(process.env.FLOW_BOOKING_PUBLIC_KEY || '').replace(/\\n/g, '\n').trim()
      || crypto.createPublicKey(PRIVATE_KEY).export({ type: 'spki', format: 'pem' });
    console.log('[FLOW-BOOKING] par RSA carregado do ambiente');
    return true;
  }
  if (!IS_DEV) {
    console.error('[FLOW-BOOKING] FLOW_BOOKING_PRIVATE_KEY ausente — agendamento no WhatsApp desativado (envio pelo link da Página)');
    return false;
  }
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  PRIVATE_KEY = crypto.createPrivateKey(pair.privateKey);
  PUBLIC_PEM = pair.publicKey;
  EPHEMERAL = true;
  console.warn('[FLOW-BOOKING] NODE_ENV de desenvolvimento sem FLOW_BOOKING_PRIVATE_KEY — chave temporária gerada neste boot');
  return true;
}

const hasKey = () => ensureKeys();
const privateKey = () => { if (!ensureKeys()) throw new Error(NO_KEY_MESSAGE); return PRIVATE_KEY; };
const publicKeyPem = () => { if (!ensureKeys()) throw new Error(NO_KEY_MESSAGE); return PUBLIC_PEM; };
const isEphemeral = () => (ensureKeys() ? EPHEMERAL : false);
const keyFingerprint = () => (ensureKeys()
  ? crypto.createHash('sha256').update(PUBLIC_PEM).digest('hex').slice(0, 16)
  : null);

// Erros da Meta em português para o painel do nó.
function friendly(message) {
  const m = String(message || '');
  if (/public.?key/i.test(m)) return 'A Meta recusou a chave de criptografia do número. Use "Recadastrar chave em todas as conexões".';
  if (/endpoint/i.test(m) && /health|ping|unreachable/i.test(m)) return 'A Meta não conseguiu falar com o servidor de agendamento. Verifique se o worker está no ar.';
  if (/json/i.test(m) && /invalid|validation/i.test(m)) return 'A Meta recusou a estrutura do formulário de agendamento.';
  return m || 'Não foi possível preparar o agendamento no WhatsApp.';
}

async function saveStatus(pool, { companyId, connectionId, creds, patch }) {
  if (!pool) return;
  try {
    await pool.query(
      `insert into whatsapp_flow_endpoint (connection_id, company_id, phone_number_id, waba_id, updated_at)
       values ($1,$2,$3,$4,now())
       on conflict (connection_id) do update set updated_at = now()`,
      [connectionId, companyId, creds?.phone_number_id || null, creds?.waba_id || null],
    );
    const keys = Object.keys(patch || {});
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await pool.query(
      `update whatsapp_flow_endpoint set ${sets}, updated_at = now() where connection_id = $1`,
      [connectionId, ...keys.map((k) => patch[k])],
    );
  } catch (e) {
    console.warn('[FLOW-BOOKING] status não salvo:', e.message);
  }
}

// Cadastra a chave pública no número da conexão (idempotente).
async function registerKey(pool, { companyId, connectionId, creds }) {
  if (!ensureKeys()) {
    await saveStatus(pool, {
      companyId, connectionId, creds,
      patch: { last_error: NO_KEY_MESSAGE, key_fingerprint: null, key_signature_status: null },
    });
    return { ok: false, code: 'no_key', error: NO_KEY_MESSAGE };
  }
  try {
    await setEncryptionKey(creds, publicKeyPem());
  } catch (e) {
    await saveStatus(pool, { companyId, connectionId, creds, patch: { last_error: friendly(e.message), key_fingerprint: keyFingerprint() } });
    return { ok: false, error: friendly(e.message) };
  }
  let status = 'VALID';
  try {
    const st = await getEncryption(creds);
    status = st?.business_public_key_signature_status || 'VALID';
  } catch (e) {
    console.warn('[FLOW-BOOKING] status da chave não lido:', e.message);
  }
  await saveStatus(pool, {
    companyId, connectionId, creds,
    patch: { key_fingerprint: keyFingerprint(), key_signature_status: status, key_set_at: new Date().toISOString(), last_error: null },
  });
  return { ok: status !== 'MISMATCH', status };
}

async function saveBookingForm(pool, { existingId, companyId, connectionId, creds, metaFlowId, flowJson, status, validationErrors, jsonVersion, previewUrl }) {
  if (existingId) {
    await pool.query(
      `update whatsapp_flow_forms set meta_flow_id = $2, status = $3, flow_json = $4::jsonb, json_version = $5,
         preview_url = coalesce($6, preview_url), validation_errors = $7::jsonb, updated_at = now()
       where id = $1`,
      [existingId, metaFlowId, status, JSON.stringify(flowJson), jsonVersion || null, previewUrl || null, JSON.stringify(validationErrors || [])],
    );
    return existingId;
  }
  const id = crypto.randomBytes(12).toString('hex');
  await pool.query(
    `insert into whatsapp_flow_forms (id, company_id, connection_id, phone_number_id, waba_id, meta_flow_id, name, categories,
       status, flow_json, json_version, preview_url, validation_errors, kind, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13::jsonb,'booking',now())`,
    [id, companyId, connectionId, creds.phone_number_id || null, creds.waba_id || null, metaFlowId, 'Agendamento GOcrm',
      JSON.stringify(['APPOINTMENT_BOOKING']), status, JSON.stringify(flowJson), jsonVersion || null, previewUrl || null,
      JSON.stringify(validationErrors || [])],
  );
  return id;
}

/**
 * Garante (cria e publica uma única vez) o Flow de agendamento da conexão,
 * com o endpoint configurado e a chave pública cadastrada no número.
 */
async function ensureBookingFlow(pool, { companyId, connectionId, creds, endpointBase, logoUrl }) {
  if (!pool) return { ok: false, error: 'Banco indisponível' };
  if (!creds?.phone_number_id || !creds?.waba_id) return { ok: false, error: 'WhatsApp não conectado para esta conexão' };
  // Sem chave configurada não cadastra nada na Meta nem publica o Flow.
  if (!ensureKeys()) return { ok: false, code: 'no_key', error: NO_KEY_MESSAGE };

  const key = await registerKey(pool, { companyId, connectionId, creds });
  if (!key.ok) return { ok: false, error: key.error };

  const { rows } = await pool.query(
    `select id, meta_flow_id from whatsapp_flow_forms where connection_id = $1 and kind = 'booking' order by updated_at desc limit 1`,
    [connectionId],
  );
  const current = rows[0];

  if (current?.meta_flow_id) {
    const details = await getFlow(creds, current.meta_flow_id).catch(() => null);
    if (details?.status === 'PUBLISHED' && !(details.validation_errors || []).length) {
      await saveStatus(pool, {
        companyId, connectionId, creds,
        patch: { meta_flow_id: current.meta_flow_id, flow_status: 'PUBLISHED', endpoint_uri: details.endpoint_uri || null, last_error: null },
      });
      return { ok: true, meta_flow_id: current.meta_flow_id, status: 'PUBLISHED' };
    }
  }

  const endpointUri = `${String(endpointBase).replace(/\/+$/, '')}/flows/booking?c=${encodeURIComponent(connectionId)}`;
  const flowJson = bookingFlowJson({ logoUrl });
  let created;
  try {
    created = await createFlow(creds, {
      name: 'Agendamento GOcrm',
      categories: ['APPOINTMENT_BOOKING'],
      flow_json: flowJson,
      endpoint_uri: endpointUri,
      publish: true,
    });
  } catch (e) {
    await saveStatus(pool, { companyId, connectionId, creds, patch: { last_error: friendly(e.message), endpoint_uri: endpointUri } });
    return { ok: false, error: friendly(e.message) };
  }

  const metaFlowId = created.id;
  let details = await getFlow(creds, metaFlowId).catch(() => null);
  if (details && details.status !== 'PUBLISHED') {
    await publishFlow(creds, metaFlowId).catch((e) => console.warn('[FLOW-BOOKING] publicar:', e.message));
    details = await getFlow(creds, metaFlowId).catch(() => details);
  }
  const errors = details?.validation_errors || [];
  if (errors.length) {
    const msg = errors[0]?.error_user_msg || errors[0]?.message || 'Estrutura recusada pela Meta';
    await saveStatus(pool, { companyId, connectionId, creds, patch: { meta_flow_id: metaFlowId, flow_status: details?.status || 'DRAFT', last_error: friendly(msg), endpoint_uri: endpointUri } });
    return { ok: false, error: friendly(msg) };
  }

  await saveBookingForm(pool, {
    existingId: current?.id, companyId, connectionId, creds, metaFlowId, flowJson,
    status: String(details?.status || 'published').toLowerCase(),
    validationErrors: errors, jsonVersion: details?.json_version || null,
    previewUrl: details?.preview?.preview_url || null,
  });
  await saveStatus(pool, {
    companyId, connectionId, creds,
    patch: { meta_flow_id: metaFlowId, flow_status: String(details?.status || 'PUBLISHED'), endpoint_uri: endpointUri, last_error: null },
  });
  console.log(`[FLOW-BOOKING] Flow de agendamento pronto conn=${connectionId.slice(0, 8)}… meta=${metaFlowId} chave=${keyFingerprint()}`);
  return { ok: true, meta_flow_id: metaFlowId, status: details?.status || 'PUBLISHED' };
}

/** Status do agendamento no WhatsApp para o painel do nó (não publica nada). */
async function bookingStatus(pool, { companyId, connectionId, creds }) {
  if (!pool) return { ok: false, error: 'Banco indisponível' };
  if (!ensureKeys()) {
    return {
      ok: false, code: 'no_key', key_configured: false, ready: false, error: NO_KEY_MESSAGE,
      meta_flow_id: null, flow_status: null, key_status: null, key_fingerprint: null,
      ephemeral_key: false, worker: versionInfo(),
    };
  }
  const { rows } = await pool.query(
    `select meta_flow_id, flow_status, endpoint_uri, key_signature_status, last_error
       from whatsapp_flow_endpoint where connection_id = $1 limit 1`, [connectionId],
  ).catch(() => ({ rows: [] }));
  const st = rows[0];
  // A chave é conferida ao vivo (a própria Meta diz se reconhece a pública).
  let keyStatus = st?.key_signature_status || null;
  if (creds?.phone_number_id) {
    const enc = await getEncryption(creds).catch(() => null);
    if (enc) keyStatus = enc.business_public_key_signature_status || keyStatus;
  }
  const ready = !!(st?.meta_flow_id && String(st?.flow_status || '').toUpperCase() === 'PUBLISHED' && keyStatus !== 'MISMATCH');
  return {
    ok: true,
    ready,
    key_configured: true,
    meta_flow_id: st?.meta_flow_id || null,
    flow_status: st?.flow_status || null,
    key_status: keyStatus,
    key_fingerprint: keyFingerprint(),
    ephemeral_key: isEphemeral(),
    worker: versionInfo(),
    error: st?.last_error || null,
  };
}

/** Recadastra a chave pública em todas as conexões (rotação ou vazamento). */
async function rotateAll(pool, { companyId } = {}) {
  if (!pool) return { ok: false, error: 'Banco indisponível' };
  if (!ensureKeys()) return { ok: false, code: 'no_key', error: NO_KEY_MESSAGE };
  const { rows } = await pool.query(
    `select id, company_id, phone_number_id from crm_whatsapp_connections
     where ($1::text is null or company_id = $1) and phone_number_id is not null`,
    [companyId || null],
  );
  const out = { ok: true, fingerprint: keyFingerprint(), total: rows.length, done: 0, failed: [] };
  for (const conn of rows) {
    const creds = await loadCreds(conn.company_id, conn.id).catch(() => null);
    if (!creds?.ok) { out.failed.push({ connection_id: conn.id, error: 'sem credenciais' }); continue; }
    const res = await registerKey(pool, { companyId: conn.company_id, connectionId: conn.id, creds });
    if (res.ok) out.done++;
    else out.failed.push({ connection_id: conn.id, error: res.error });
  }
  console.log(`[FLOW-BOOKING] chave recadastrada em ${out.done}/${out.total} conexões (${out.fingerprint})`);
  return out;
}

module.exports = {
  privateKey, publicKeyPem, keyFingerprint, isEphemeral, hasKey, NO_KEY_MESSAGE,
  ensureBookingFlow, bookingStatus, registerKey, rotateAll, friendly,
};