// ═══════════════════════════════════════════════════════════
// WhatsApp Flows — "Formulário em etapas"
// - Cria/atualiza/publica formulários na Meta (Graph API v22.0) com o token e o WABA da conexão
// - Envia o formulário dentro do fluxo (mensagem interativa type=flow)
// - Recebe a resposta (webhook nfm_reply), grava em whatsapp_flow_responses e retoma a espera
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');
const { loadCreds } = require('./botSettings');

const GRAPH = 'https://graph.facebook.com/v22.0';
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const WORKER_SECRET = process.env.WORKER_SECRET;
const PILOT_IDS = (process.env.RAILWAY_ENGINE_PHONE_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const nextOf = (n) => n?.next_node_id ?? n?.data?.next_node_id ?? n?.config?.next_node_id ?? null;
const newId = () => crypto.randomBytes(12).toString('hex');
const SYSTEM_FIELDS = ['nome', 'email', 'empresa', 'telefone'];

// ── Pilotos do motor Railway (mesma lista usada pelo railwayEngine) ──
function pilotIds() {
  return { pilots: PILOT_IDS, all: PILOT_IDS.includes('*') };
}

function isPilot(phoneNumberId) {
  return !!phoneNumberId && (PILOT_IDS.includes('*') || PILOT_IDS.includes(phoneNumberId));
}

// ── Token do formulário: identifica conexão e contato na volta do webhook ──
function flowToken(connectionId, phone) {
  return `v1_${connectionId}_${String(phone).replace(/\D/g, '')}_${crypto.randomBytes(4).toString('hex')}`;
}

function parseFlowToken(token) {
  const m = /^v1_([0-9a-f]{24})_(\d{10,15})_[0-9a-f]{8}$/.exec(String(token || ''));
  return m ? { connectionId: m[1], phone: m[2] } : null;
}

// ── Chamadas à Graph API ──
async function graph(creds, path, { method = 'GET', body, form } = {}) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${creds.access_token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(form ? { body: form } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    const e = data.error;
    console.error(`[FLOW API] Meta recusou ${path}: code=${e.code} subcode=${e.error_subcode || '-'} type=${e.type} fbtrace_id=${e.fbtrace_id || '-'} msg=${e.error_user_msg || e.message}`);
    const err = new Error(`Meta: ${e.error_user_msg || e.message}`);
    err.meta = {
      code: e.code ?? null, subcode: e.error_subcode ?? null, type: e.type ?? null,
      message: e.error_user_msg || e.message, fbtrace_id: e.fbtrace_id ?? null,
    };
    throw err;
  }
  return data;
}

async function createFlow(creds, { name, categories = ['OTHER'], flow_json }) {
  if (!creds.waba_id) throw new Error('Conexão sem WABA ID');
  return graph(creds, `${creds.waba_id}/flows`, {
    method: 'POST',
    body: {
      name,
      categories,
      ...(flow_json ? { flow_json: typeof flow_json === 'string' ? flow_json : JSON.stringify(flow_json) } : {}),
    },
  });
}

async function uploadFlowJson(creds, metaFlowId, flowJson) {
  const json = typeof flowJson === 'string' ? flowJson : JSON.stringify(flowJson);
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', new Blob([json], { type: 'application/json' }), 'flow.json');
  return graph(creds, `${metaFlowId}/assets`, { method: 'POST', form });
}

const getFlow = (creds, metaFlowId) => graph(creds,
  `${metaFlowId}?fields=id,name,status,categories,validation_errors,preview,json_version,health_status`);
const publishFlow = (creds, metaFlowId) => graph(creds, `${metaFlowId}/publish`, { method: 'POST' });
const deprecateFlow = (creds, metaFlowId) => graph(creds, `${metaFlowId}/deprecate`, { method: 'POST' });
const deleteFlow = (creds, metaFlowId) => graph(creds, metaFlowId, { method: 'DELETE' });
const listMetaFlows = (creds) => graph(creds,
  `${creds.waba_id}/flows?fields=id,name,status,categories,validation_errors,json_version&limit=100`);

// ── Credenciais da conexão (Supabase; Base44 como reserva) ──
async function credsFor(pool, companyId, connectionId, poolSetter) {
  if (poolSetter) poolSetter(pool);
  const local = await loadCreds(companyId, connectionId);
  if (local?.ok) return local;
  const data = await (await fetch(`${APP_URL}/functions/workerTrigger`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'getSendCreds', company_id: companyId, context: { connection_id: connectionId } }),
  })).json();
  if (!data?.ok) throw new Error(data?.error || 'sem credenciais para esta conexão');
  return data;
}

// ── Envio do formulário dentro do fluxo ──
async function sendFlowMessage(creds, to, sub, token) {
  const params = {
    flow_message_version: '3',
    flow_token: token,
    flow_id: String(sub.meta_flow_id),
    flow_cta: String(sub.cta || 'Abrir formulário').slice(0, 30),
  };
  if (sub.screen) {
    let data = {};
    if (sub.screen_data) {
      try { data = typeof sub.screen_data === 'string' ? JSON.parse(sub.screen_data) : sub.screen_data; } catch { data = {}; }
    }
    params.flow_action = 'navigate';
    params.flow_action_payload = { screen: sub.screen, ...(Object.keys(data || {}).length ? { data } : {}) };
  }
  const interactive = {
    type: 'flow',
    body: { text: String(sub.body || 'Toque no botão para preencher o formulário').slice(0, 1024) },
    action: { name: 'flow', parameters: params },
  };
  if (sub.header) interactive.header = { type: 'text', text: String(sub.header).slice(0, 60) };
  if (sub.footer) interactive.footer = { type: 'text', text: String(sub.footer).slice(0, 60) };

  const data = await graph(creds, `${creds.phone_number_id}/messages`, {
    method: 'POST',
    body: { messaging_product: 'whatsapp', to, type: 'interactive', interactive },
  });
  return {
    tipo: 'flow_form',
    body: interactive.body.text,
    flow: { meta_flow_id: params.flow_id, form_name: sub.form_name || '', screen: sub.screen || null, cta: params.flow_cta },
    wa_id: data.messages?.[0]?.id || null,
    at: new Date().toISOString(),
  };
}

// ── Salvamento de formulário no Supabase ──
async function saveForm(pool, f) {
  const id = f.id || newId();
  await pool.query(
    `insert into whatsapp_flow_forms (id, company_id, connection_id, phone_number_id, waba_id, base44_flow_id, meta_flow_id, name,
       categories, status, screens, flow_json, json_version, preview_url, validation_errors, last_error, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13,$14,$15::jsonb,$16,now())
     on conflict (id) do update set meta_flow_id = excluded.meta_flow_id, name = excluded.name, categories = excluded.categories,
       status = excluded.status, screens = coalesce(excluded.screens, whatsapp_flow_forms.screens),
       flow_json = coalesce(excluded.flow_json, whatsapp_flow_forms.flow_json), json_version = excluded.json_version,
       preview_url = coalesce(excluded.preview_url, whatsapp_flow_forms.preview_url),
       validation_errors = excluded.validation_errors, last_error = excluded.last_error, updated_at = now()`,
    [id, f.company_id, f.connection_id, f.phone_number_id || null, f.waba_id || null, f.base44_flow_id || null, f.meta_flow_id || null,
      f.name, JSON.stringify(f.categories || ['OTHER']), f.status || 'draft', f.screens ? JSON.stringify(f.screens) : null,
      f.flow_json ? JSON.stringify(f.flow_json) : null, f.json_version || null, f.preview_url || null,
      f.validation_errors ? JSON.stringify(f.validation_errors) : null, f.last_error || null]
  );
  return id;
}

async function findForm(pool, companyId, connectionId, { formId, metaFlowId }) {
  const { rows } = await pool.query(
    `select * from whatsapp_flow_forms where company_id = $1 and connection_id = $2
       and (($3::text is not null and id = $3) or ($4::text is not null and meta_flow_id = $4)) limit 1`,
    [companyId, connectionId, formId || null, metaFlowId || null]
  );
  return rows[0] || null;
}

// ── Resposta do formulário (webhook nfm_reply) ──
async function saveContactFields(pool, contact, response, mapping) {
  const rows = (mapping || []).filter((m) => m?.from && response[m.from] !== undefined && response[m.from] !== '');
  const entries = rows.length
    ? rows.map((m) => ({ key: m.to, value: response[m.from] }))
    : Object.entries(response).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object');
  const custom = { ...(contact.custom_fields || {}) };
  for (const { key, value } of entries) {
    const text = String(value);
    if (SYSTEM_FIELDS.includes(key)) {
      await pool.query(`update crm_contacts set ${key} = $2, updated_at = now() where id = $1`, [contact.id, text]);
      contact[key] = text;
    } else {
      custom[key] = text;
      await pool.query(
        `update crm_contacts set custom_fields = coalesce(custom_fields, '{}'::jsonb) || jsonb_build_object($2::text, $3::text), updated_at = now() where id = $1`,
        [contact.id, key, text]
      );
    }
  }
  if (!rows.length) contact.custom_fields = custom;
  return entries;
}

// true = resposta tratada (o Base44 não dispara gatilhos com ela)
async function handleFlowReply(ev, pool, contact, msg, { tryFast, claim }) {
  const nfm = msg.nfm;
  if (!nfm) return false;
  const phone = msg.from;
  const parsed = parseFlowToken(nfm.flow_token);
  if (!parsed) { console.warn(`[FLOW] id=${ev.id} flow_token desconhecido: ${nfm.flow_token}`); return true; }
  if (parsed.connectionId !== contact.connection_id || parsed.phone !== String(contact.telefone)) {
    console.warn(`[FLOW] id=${ev.id} token não confere com contato/conexão (${parsed.connectionId}/${parsed.phone})`);
    return true;
  }
  let response = {};
  try { response = JSON.parse(nfm.response_json || '{}') || {}; } catch { response = {}; }

  const { rows } = await pool.query(
    `select e.id, e.current_node_id, e.context, f.base44_id, f.name, f.trigger_type, f.nodes from crm_flow_executions e
     join flows f on f.base44_id = e.flow_id and f.connection_id = e.connection_id
     where e.company_id = $1 and e.connection_id = $2 and e.contact_phone = $3 and e.status = 'waiting'
       and coalesce(e.context->>'_wait_type', '') = 'flow_reply'
     order by e.started_at desc nulls last limit 1`,
    [contact.company_id, contact.connection_id, phone]
  );
  const ex = rows[0];
  const ctx = { ...(ex?.context || {}) };
  const wc = ctx._wait_config || {};

  // Idempotência: o wamid é único na tabela (reentrega da Meta não grava nem retoma de novo)
  const { rows: ins } = await pool.query(
    `insert into whatsapp_flow_responses (id, company_id, connection_id, form_id, meta_flow_id, flow_token, contact_id, contact_phone,
       execution_id, wamid, screen, response_json, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
     on conflict (wamid) do nothing returning id`,
    [newId(), contact.company_id, contact.connection_id, wc.form_id || null, wc.meta_flow_id || null, nfm.flow_token,
      contact.id, phone, ex?.id || null, msg.raw.id, response.screen || wc.screen || null, JSON.stringify(response),
      ex ? 'received' : 'late']
  );
  if (!ins[0]) { console.log(`[FLOW] id=${ev.id} resposta repetida (wamid ${msg.raw.id}) — ignorada`); return true; }
  console.log(`[FLOW] id=${ev.id} formulário respondido (${Object.keys(response).length} campos) exec=${ex?.id || '-'}`);

  if (!ex) return true; // formulário já vencido/encerrado: a resposta fica registrada

  const { rowCount } = await pool.query(
    `update crm_flow_executions set status = 'running', waiting_since = null, delay_until = null, started_at = now(), updated_at = now()
     where id = $1 and status = 'waiting'`, [ex.id]
  );
  if (!rowCount) return true;
  await claim(pool, { base44_id: `resume:${msg.raw.id}` }, phone, 86400);

  const node = (ex.nodes || []).find((n) => n.id === ex.current_node_id);
  try {
    const saved = await saveContactFields(pool, contact, response, wc.fields);
    const collected = { ...(ctx.collected || {}) };
    for (const { key, value } of saved) collected[key] = String(value);
    Object.assign(ctx, {
      last_reply: 'formulário respondido', ultima_resposta: 'formulário respondido', last_message_type: 'flow_reply',
      whatsapp_window_open: true, collected, _form_response: response, _form_token: nfm.flow_token,
    });
    const next = wc.next_node_id || nextOf(node);
    for (const k of ['_wait_type', '_wait_config', '_wait_node_id', '_wait_timeout_at', '_ai_responded']) delete ctx[k];
    await pool.query(`update whatsapp_flow_responses set status = 'resumed' where wamid = $1`, [msg.raw.id]);

    if (!next) {
      await pool.query(`update crm_flow_executions set status = 'completed', completed_at = now(), context = $2, updated_at = now() where id = $1`,
        [ex.id, JSON.stringify(ctx)]);
      return true;
    }
    const flow = { base44_id: ex.base44_id, name: ex.name, trigger_type: ex.trigger_type, nodes: ex.nodes };
    const fast = await tryFast(ev, pool, flow, next, contact, msg, { force: true, context: ctx, fresh: true, record: false });
    const { ownResume, saveMessages, mergeFast } = require('./flowOwner');
    if (fast && await ownResume(pool, { exec: ex, flow, contact, phone, fast, ctx })) return true;
    if (fast) await saveMessages(pool, contact, phone, fast, null);
    await pool.query(`update crm_flow_executions set context = $2, updated_at = now() where id = $1`, [ex.id, JSON.stringify(mergeFast(ctx, fast))]);
    const res = await fetch(`${APP_URL}/functions/workerTrigger`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resumeExecution', company_id: contact.company_id, context: { execution_id: ex.id, node_id: next } }),
    });
    console.log(`[FLOW] Base44 continua exec=${ex.id} a partir de ${next} status=${res.status}`);
  } catch (e) {
    console.error(`[FLOW] retomada falhou exec=${ex.id} (Base44 assume):`, e.message);
    await pool.query(`update crm_flow_executions set status = 'waiting', waiting_since = now(), updated_at = now() where id = $1 and status = 'running'`, [ex.id]).catch(() => {});
  }
  return true;
}

// ── API usada pela função Base44 (editor): criar / validar / publicar / listar ──
async function handleFlowApi(req, res, pool, { setBotSettingsPool }) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if ((req.headers.authorization || '') !== `Bearer ${WORKER_SECRET}`) return send(401, { ok: false, error: 'Unauthorized' });

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return send(400, { ok: false, error: 'JSON inválido' }); }

  const { action, company_id: companyId, connection_id: connectionId } = body;
  try {
    if (action === 'pilotIds') return send(200, { ok: true, ...pilotIds() });

    if (!companyId || !connectionId) return send(400, { ok: false, error: 'company_id e connection_id obrigatórios' });
    const creds = await credsFor(pool, companyId, connectionId, setBotSettingsPool);
    const base = { company_id: companyId, connection_id: connectionId, phone_number_id: creds.phone_number_id, waba_id: creds.waba_id };

    if (action === 'list') {
      const meta = await listMetaFlows(creds).catch((e) => ({ data: [], error: e.message }));
      const { rows } = await pool.query(
        `select id, meta_flow_id, name, status, screens, flow_json, preview_url, validation_errors, json_version, updated_at
         from whatsapp_flow_forms where company_id = $1 and connection_id = $2 order by updated_at desc limit 100`,
        [companyId, connectionId]
      );
      return send(200, { ok: true, forms: rows, meta_flows: meta.data || [], meta_error: meta.error || null });
    }

    if (action === 'create' || action === 'validate') {
      const existing = await findForm(pool, companyId, connectionId, { formId: body.form_id, metaFlowId: body.meta_flow_id });
      const flowJson = typeof body.flow_json === 'string' ? body.flow_json : body.flow_json;
      let metaFlowId = body.meta_flow_id || existing?.meta_flow_id || null;
      if (!metaFlowId) {
        const created = await createFlow(creds, { name: body.name || 'Formulário', categories: body.categories || ['OTHER'], flow_json: flowJson });
        metaFlowId = created.id;
      } else if (flowJson) {
        await uploadFlowJson(creds, metaFlowId, flowJson);
      }
      const details = await getFlow(creds, metaFlowId);
      const id = await saveForm(pool, {
        id: existing?.id, ...base, base44_flow_id: body.base44_flow_id || existing?.base44_flow_id || null,
        meta_flow_id: metaFlowId, name: body.name || details.name || existing?.name || 'Formulário',
        categories: body.categories || details.categories || ['OTHER'], status: (details.status || 'DRAFT').toLowerCase(),
        screens: body.screens || existing?.screens || null, flow_json: body.screens && flowJson ? flowJson : (existing?.flow_json || null),
        json_version: details.json_version || null, preview_url: details.preview?.preview_url || null,
        validation_errors: details.validation_errors || [],
      });
      return send(200, {
        ok: true, form_id: id, meta_flow_id: metaFlowId, name: details.name, status: details.status,
        validation_errors: details.validation_errors || [], preview_url: details.preview?.preview_url || null,
        json_version: details.json_version || null,
      });
    }

    if (action === 'publish') {
      const existing = await findForm(pool, companyId, connectionId, { formId: body.form_id, metaFlowId: body.meta_flow_id });
      const metaFlowId = body.meta_flow_id || existing?.meta_flow_id;
      if (!metaFlowId) return send(400, { ok: false, error: 'Formulário ainda não existe na Meta — valide antes de publicar' });
      await publishFlow(creds, metaFlowId);
      const details = await getFlow(creds, metaFlowId);
      if (existing) await saveForm(pool, { ...existing, status: (details.status || 'published').toLowerCase(), validation_errors: [] });
      return send(200, { ok: true, meta_flow_id: metaFlowId, status: details.status || 'PUBLISHED' });
    }

    if (action === 'deprecate') {
      const existing = await findForm(pool, companyId, connectionId, { formId: body.form_id, metaFlowId: body.meta_flow_id });
      const metaFlowId = body.meta_flow_id || existing?.meta_flow_id;
      if (!metaFlowId) return send(400, { ok: false, error: 'Formulário não encontrado' });
      await deprecateFlow(creds, metaFlowId);
      if (existing) await saveForm(pool, { ...existing, status: 'deprecated' });
      return send(200, { ok: true, meta_flow_id: metaFlowId, status: 'DEPRECATED' });
    }

    if (action === 'delete') {
      const existing = await findForm(pool, companyId, connectionId, { formId: body.form_id, metaFlowId: body.meta_flow_id });
      const metaFlowId = body.meta_flow_id || existing?.meta_flow_id;
      if (metaFlowId) await deleteFlow(creds, metaFlowId).catch((e) => console.warn('[FLOW] excluir na Meta:', e.message));
      if (existing) await pool.query(`delete from whatsapp_flow_forms where id = $1`, [existing.id]);
      return send(200, { ok: true });
    }

    return send(400, { ok: false, error: `Ação desconhecida: ${action}` });
  } catch (e) {
    console.error('[FLOW API] erro:', e.message);
    return send(200, { ok: false, error: e.message, meta_error: e.meta || null });
  }
}

module.exports = {
  pilotIds, isPilot, flowToken, parseFlowToken, sendFlowMessage, handleFlowReply, handleFlowApi,
};