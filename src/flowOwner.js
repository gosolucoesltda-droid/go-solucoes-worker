// ═══════════════════════════════════════════════════════════
// Fase 5 — O Railway inicia e retoma o fluxo sozinho quando todo o caminho é dele
// (mensagens, condições, atrasos curtos, sorteio, voz). Grava a execução, as mensagens
// e a linha do tempo direto no Supabase, no mesmo formato do Base44 — sem chamar o Base44
// no caminho da mensagem. O Base44 só recebe depois (sem esperar) as estatísticas do fluxo.
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const WORKER_SECRET = process.env.WORKER_SECRET;

const newId = () => crypto.randomBytes(12).toString('hex'); // mesmo formato dos ids do Base44
const nextOf = (n) => n?.next_node_id ?? n?.data?.next_node_id ?? n?.config?.next_node_id ?? null;
const UNIT_MS = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 };

// true = nada do caminho precisa do Base44 (ações, API, planilha e saltos ficam com ele)
function ownable(fast, flow) {
  const m = fast?._meta;
  if (!m || fast._railway_jump) return false;
  if ([fast._railway_api, fast._railway_sheets, fast._railway_action_at].some((o) => o && Object.keys(o).length)) return false;
  // Saldo da empresa só existe no Base44 (condições de saldo mais à frente precisam dele)
  if (/"(balance|has_balance)"/.test(JSON.stringify(flow.nodes || []))) return false;
  return m.ended || !!fast._railway_stop_node;
}

// Mesmo contexto inicial do Base44 (base44/shared/flowStart.ts)
async function startContext(pool, contact, phone, trigger) {
  const { rows: deals } = await pool.query(
    `select id, stage_id, pipeline_id from crm_deals where company_id = $1 and contact_phone = $2 and status = 'open'`, [contact.company_id, phone]
  );
  const nome = contact.nome || phone;
  const cf = contact.custom_fields || {};
  return {
    ...trigger, contact_id: contact.id, contact_name: nome, contact_phone: phone, contact_bsuid: contact.bsuid || '',
    nome, telefone: phone, email: contact.email || '', empresa: contact.empresa || '', primeiro_nome: nome.split(' ')[0],
    tags: contact.tags || [], has_open_deal: deals.length > 0, open_deals: deals,
    attendance_status: cf.attendance_status || null, assigned_to: cf.assigned_to || null,
    whatsapp_window_open: true, collected: { ...cf }, variables: {},
  };
}

// Estado final igual ao do Base44: pergunta → aguardando resposta; botões/lista/fim → concluído
function finalState(fast, flow, ctx) {
  const executed = fast._executed_nodes || [];
  const c = { ...ctx, _executed_nodes: [...new Set([...(ctx._executed_nodes || []), ...executed])] };
  if (fast.variables) c.variables = { ...(c.variables || {}), ...fast.variables };
  const stopId = fast._railway_stop_node;
  const sub = fast._meta.stopSub;
  if (fast._railway_question_node && sub) {
    const node = (flow.nodes || []).find((n) => n.id === stopId);
    const d = node.data || node.config || {};
    const nodeNext = nextOf(node);
    const timeoutNext = node.next_node_timeout_id ?? d.next_node_timeout_id ?? null;
    const ms = Number(sub.timeout_value ?? sub.timeout_minutes ?? 30) * (UNIT_MS[sub.timeout_unit ?? 'minutes'] ?? UNIT_MS.minutes);
    c._wait_type = 'reply';
    c._wait_node_id = stopId;
    c._wait_timeout_at = ms > 0 ? new Date(Date.now() + ms).toISOString() : null;
    c._wait_config = {
      type: 'question', question: sub.question_text ?? sub.question ?? '', response_type: sub.response_type ?? 'text',
      field_type: sub.field_type ?? 'custom', contact_field: sub.contact_field ?? null, save_to_field: sub.save_to_field ?? null,
      max_retries: sub.max_retries ?? 3, retries_used: 0,
      error_message: sub.error_message ?? sub.invalid_reply_message ?? 'Resposta inválida. Tente novamente.',
      next_node_id: sub.on_success_next ?? sub.next_node_id ?? nodeNext ?? null,
      next_node_timeout_id: sub.on_timeout_next ?? sub.next_node_timeout_id ?? timeoutNext ?? null,
    };
    return { status: 'waiting', current: stopId, ctx: c, steps: executed.length };
  }
  // Botões e listas enviados: o clique segue pelo botão (mesmo resultado do Base44 com o Railway)
  return { status: 'completed', current: stopId || executed[executed.length - 1] || null, ctx: c, steps: executed.length };
}

// Mensagens definitivas no chat (uma a uma, para o tempo real) + linha do tempo
async function saveMessages(pool, contact, phone, fast, started) {
  const msgs = [];
  for (let r = fast; r; r = r._railway_jump) msgs.push(...(r._railway_messages || []));
  const act = (type, content, metadata, by, at) => pool.query(
    `insert into crm_activities (id, company_id, connection_id, contact_phone, type, content, metadata, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newId(), contact.company_id, contact.connection_id, phone, type, content, metadata ? JSON.stringify(metadata) : null, by, at]
  );
  if (started) {
    const first = msgs[0]?.at ? new Date(new Date(msgs[0].at).getTime() - 1) : new Date();
    await act('flow_started', started.flow.name || '', { flow_id: started.flow.base44_id, execution_id: started.executionId, source: 'automation', trigger_type: started.flow.trigger_type || null }, 'sistema', first.toISOString());
  }
  for (const m of msgs) {
    const json = m.list || (m.template_buttons ? { template_buttons: m.template_buttons } : m.buttons?.length ? { buttons: m.buttons } : null);
    const at = m.at || new Date().toISOString();
    await pool.query(
      `insert into crm_messages (id, company_id, contact_id, connection_id, direction, body, status, tipo, whatsapp_message_id, media_url, media_id, file_name, mime_type, interactive_data, sent_at, created_at, is_ai_generated)
       values ($1,$2,$3,$4,'outbound',$5,'sent',$6,$7,$8,$9,$10,$11,$12,$13,now(),false)`,
      [newId(), contact.company_id, contact.id, contact.connection_id, m.body || '', m.tipo || (m.buttons?.length ? 'interactive_buttons' : 'text'), m.wa_id || null,
        m.media_url || null, m.audio_media_id || null, m.file_name || null, m.audio_media_id ? 'audio/ogg' : null, json ? JSON.stringify(json) : null, at]
    );
    await act('message_out', String(m.body || '').slice(0, 50), null, 'Fluxo', at);
  }
  if (msgs.length) {
    await pool.query(`update crm_contacts set ultima_mensagem = $2, ultima_mensagem_em = now(), updated_at = now() where id = $1`,
      [contact.id, String(msgs[msgs.length - 1].body || '').slice(0, 100)]);
  }
}

// Clique assume a conversa: encerra quem aguardava resposta (não atrasos) e cancela os jobs delas
async function endWaiting(pool, contact, phone) {
  const { rows } = await pool.query(
    `update crm_flow_executions set status = 'completed', completed_at = now(), updated_at = now()
     where company_id = $1 and connection_id = $2 and contact_phone = $3 and status = 'waiting' and coalesce(context->>'_wait_type', '') <> 'delay' returning id`,
    [contact.company_id, contact.connection_id, phone]
  );
  for (const { id } of rows) {
    const cancel = (status) => pool.query(
      `update scheduled_jobs set status = $1, completed_at = now() where status in ('pending','queued')
       and (reference_id = any($2) or reference_id like $3 or context->>'_delay_resume_execution_id' = $4 or context->>'execution_id' = $4)`,
      [status, [`ai_timeout_${id}`, `menu_timeout_${id}`], `delay_${id}%`, id]
    );
    await cancel('cancelled').catch(() => cancel('completed')).catch((e) => console.warn('[OWNER] cancelar jobs:', e.message));
  }
}

// Estatísticas e registro de blocos no painel (sem esperar — fora do caminho da mensagem)
function reportStats(flow, companyId, executionId, fast, started) {
  fetch(`${APP_URL}/functions/workerTrigger`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'flowStats', flow_id: flow.base44_id, company_id: companyId, context: { execution_id: executionId, node_ids: fast._executed_nodes || [], started } }),
  }).catch((e) => console.warn('[OWNER] estatísticas:', e.message));
}

const values = (st) => [st.status, st.current, JSON.stringify(st.ctx), st.status === 'waiting' ? new Date() : null, st.status === 'completed' ? new Date() : null, st.steps];

// Início (gatilho ou clique). Retorna o id da execução, ou false (o Base44 assume como antes)
async function ownStart(pool, { flow, contact, phone, fast, trigger, endWaiting: end }) {
  if (!ownable(fast, flow)) return false;
  const id = newId();
  try {
    const st = finalState(fast, flow, await startContext(pool, contact, phone, trigger));
    if (end) await endWaiting(pool, contact, phone);
    await pool.query(
      `insert into crm_flow_executions (id, company_id, connection_id, flow_id, flow_name, contact_phone, status, current_node_id, context, waiting_since, completed_at, steps_executed, started_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())`,
      [id, contact.company_id, contact.connection_id, flow.base44_id, flow.name || null, phone, ...values(st)]
    );
    console.log(`[OWNER] "${flow.name}" iniciado e registrado pelo Railway exec=${id} status=${st.status}`);
  } catch (e) {
    console.error('[OWNER] registro da execução falhou (Base44 assume):', e.message);
    return false;
  }
  await saveMessages(pool, contact, phone, fast, { flow, executionId: id }).catch((e) => console.error('[OWNER] mensagens:', e.message));
  reportStats(flow, contact.company_id, id, fast, true);
  return id;
}

// Retomada: continua a execução existente. false = o Base44 continua
async function ownResume(pool, { exec, flow, contact, phone, fast, ctx }) {
  if (!ownable(fast, flow)) return false;
  const st = finalState(fast, flow, ctx);
  await pool.query(
    `update crm_flow_executions set status = $2, current_node_id = $3, context = $4, waiting_since = $5, completed_at = $6,
     steps_executed = steps_executed + $7, delay_until = null, updated_at = now() where id = $1`,
    [exec.id, ...values(st)]
  );
  console.log(`[OWNER] "${flow.name}" retomado pelo Railway exec=${exec.id} status=${st.status}`);
  await saveMessages(pool, contact, phone, fast, null).catch((e) => console.error('[OWNER] mensagens:', e.message));
  reportStats(flow, contact.company_id, exec.id, fast, false);
  return true;
}

// Contexto para o Base44 continuar de onde o Railway parou (mensagens já registradas aqui)
function mergeFast(ctx, fast) {
  if (!fast) return ctx;
  const strip = (r) => { if (!r) return r; const { _railway_messages, ...rest } = r; return rest._railway_jump ? { ...rest, _railway_jump: strip(rest._railway_jump) } : rest; };
  const rest = strip(fast);
  return { ...ctx, ...rest, _executed_nodes: [...new Set([...(ctx._executed_nodes || []), ...(fast._executed_nodes || [])])], variables: { ...(ctx.variables || {}), ...(fast.variables || {}) } };
}

module.exports = { ownable, startContext, ownStart, ownResume, saveMessages, mergeFast };