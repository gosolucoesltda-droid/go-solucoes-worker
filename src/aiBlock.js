// ═══════════════════════════════════════════════════════════
// Bloco "Agente de IA" executado pelo Railway (mesmas regras do
// aiAgentBlock.ts / aiAgentResume.ts do Base44):
// - no fluxo: 'wait_input' só pausa; 'bot_first' chama a IA, envia pela Meta e
//   escolhe entre a saída condicional, o fim do fluxo ou uma nova espera;
// - na mensagem do contato: chama a IA, envia, salva as variáveis extraídas,
//   segue a saída condicional escolhida ou volta a esperar (mantendo o prazo).
// O Base44 só recebe o log do agente (sem esperar) para o painel.
// ═══════════════════════════════════════════════════════════
const { processAi } = require('./aiAgent');
const { saveMessages, mergeFast, ownResume } = require('./flowOwner');

const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const WORKER_SECRET = process.env.WORKER_SECRET;
const STANDARD = new Set(['nome', 'email', 'telefone', 'empresa', 'observacoes']);
const WAIT_KEYS = ['_wait_type', '_wait_config', '_wait_node_id', '_wait_timeout_at', '_ai_responded'];

let pool = null;
const setAiPool = (p) => { pool = p; };

const nextOf = (n) => n?.next_node_id ?? n?.data?.next_node_id ?? n?.config?.next_node_id ?? null;
const nk = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const timeoutHours = (h) => (Number(h) > 0 ? Math.min(24, Math.max(1, Number(h))) : 24);

// Estado de espera do agente, no mesmo formato que o Base44 grava
function waitState(cfg = {}, nodeId, next) {
  const timeoutAt = new Date(Date.now() + timeoutHours(cfg.default_timeout_hours) * 3600000).toISOString();
  const saved = {
    response_mode: cfg.response_mode, custom_prompt: cfg.custom_prompt, model: cfg.model,
    knowledge_documents: cfg.knowledge_documents, conditional_outputs: cfg.conditional_outputs,
    output_variables: cfg.output_variables, context_message_count: cfg.context_message_count ?? 10,
    default_timeout_hours: cfg.default_timeout_hours, entry_behavior: cfg.entry_behavior,
    voice_response_enabled: cfg.voice_response_enabled, el_voice_id: cfg.el_voice_id, el_model_id: cfg.el_model_id,
    el_stability: cfg.el_stability, el_similarity_boost: cfg.el_similarity_boost, el_style: cfg.el_style,
    el_use_speaker_boost: cfg.el_use_speaker_boost, node_id: nodeId, next_node_id: next ?? null,
  };
  return { cfg: saved, timeout_at: timeoutAt };
}

// Log do painel do agente: o Base44 grava (sem esperar, fora do caminho da mensagem)
function reportLog(companyId, connectionId, phone, contactId, r) {
  const rec = r?._record;
  if (!rec) return;
  fetch(`${APP_URL}/functions/workerTrigger`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'aiLog', company_id: companyId,
      context: { connection_id: connectionId, contact_phone: phone, contact_id: contactId || rec.contact_id || null, agent_id: rec.agent_id, log: rec.log || null, el_log: rec.el_log || null, disable_agent: !!rec.disable_agent },
    }),
  }).catch((e) => console.warn('[AIBLOCK] log do agente:', e.message));
}

// Chama a IA (ela mesma envia pela Meta). null = o Railway não conseguiu, o Base44 assume
async function callAi(opts, cfg, text, type) {
  if (!pool) return null;
  try {
    const r = await processAi(pool, {
      action: 'processMessage', from_flow: true, skip_branch: true, record: false, force_send: true,
      company_id: opts.companyId, connection_id: opts.connectionId || undefined, flow_id: opts.flowId || undefined,
      contact_phone: opts.phone, contact_id: opts.contact?.id || opts.context?.contact_id || undefined,
      message_text: text || '', message_type: type || 'text',
      custom_prompt: cfg.custom_prompt || undefined, model: cfg.model || undefined,
      knowledge_documents: cfg.knowledge_documents || undefined, response_mode: cfg.response_mode || 'single',
      conditional_outputs: cfg.conditional_outputs || undefined, output_variables: cfg.output_variables || undefined,
      context_message_count: cfg.context_message_count ?? 10, voice_response_enabled: cfg.voice_response_enabled || undefined,
      el_voice_id: cfg.el_voice_id || undefined, el_model_id: cfg.el_model_id || undefined,
      el_stability: cfg.el_stability ?? undefined, el_similarity_boost: cfg.el_similarity_boost ?? undefined,
      el_style: cfg.el_style ?? undefined, el_use_speaker_boost: cfg.el_use_speaker_boost ?? undefined,
    });
    return r && !r.fallback ? r : null;
  } catch (e) {
    console.error('[AIBLOCK] IA falhou (Base44 assume):', e.message);
    return null;
  }
}

// Variáveis extraídas pela IA: campos padrão vão para a coluna, o resto para os campos personalizados
async function saveVars(contact, mapped) {
  if (!mapped || typeof mapped !== 'object' || !contact?.id || !pool) return;
  const custom = { ...(contact.custom_fields || {}) };
  const cols = {};
  for (const [k, v] of Object.entries(mapped)) {
    if (v === null || v === undefined) continue;
    const key = nk(k);
    if (STANDARD.has(key)) cols[key] = String(v);
    else if (v === '') delete custom[k];
    else custom[k] = String(v);
  }
  const entries = Object.entries(cols);
  const sql = `update crm_contacts set custom_fields = $2::jsonb, updated_at = now()${entries.map(([k], i) => `, ${k} = $${i + 3}`).join('')} where id = $1`;
  await pool.query(sql, [contact.id, JSON.stringify(custom), ...entries.map(([, v]) => v)])
    .catch((e) => console.error('[AIBLOCK] variáveis não salvas:', e.message));
  Object.assign(contact, cols, { custom_fields: custom });
}

// Bloco no fluxo. { pause: true } = aguardando a próxima mensagem; route = saída escolhida
async function runAiNode(node, vars, sim, opts, flowId) {
  const cfg = node.data || node.config || {};
  const next = nextOf(node);
  // 'wait_input': espera uma mensagem nova do contato antes de chamar a IA
  if ((cfg.entry_behavior || 'bot_first') === 'wait_input') {
    return { ...waitState(cfg, node.id, next), pause: true, responded: false, messages: [] };
  }
  const ctx = opts.context || {};
  const text = String(ctx.last_reply ?? ctx.ultima_resposta ?? '').trim() || 'Olá';
  const type = ctx.last_message_type || ctx.message_type || 'text';
  const r = await callAi({ ...opts, flowId }, cfg, text, type);
  if (!r) return null;
  const rec = r._record || {};
  const mapped = r.mapped_variables || {};
  const responded = r.ok && !r.skipped && !!r.response;
  if (responded) {
    await saveVars(sim, mapped);
    for (const [k, v] of Object.entries(mapped)) vars[nk(k)] = v;
    if (opts.collected) Object.assign(opts.collected, mapped, { IA_RESPONSE: r.response });
    vars.ia_response = r.response;
  }
  reportLog(opts.companyId, opts.connectionId, opts.phone, sim.id, r);
  const cond = (cfg.conditional_outputs || []).find((c) => c.id === r.matched_branch);
  const route = cond?.next_node_id || null;
  const complete = !!r.matched_branch && !cond?.next_node_id;
  return {
    ...waitState(cfg, node.id, next), messages: rec.messages || [], mapped, response: r.response || null,
    route, complete, responded, pause: !route && !complete,
  };
}

// Mensagem do contato para uma execução aguardando o agente.
// true = tratada aqui (o Base44 e os gatilhos não processam esta mensagem)
async function resumeAi(ev, db, contact, msg, { tryFast, claim }) {
  const phone = msg.from;
  const { rows } = await db.query(
    `select e.id, e.current_node_id, e.context, f.base44_id, f.name, f.trigger_type, f.nodes
     from crm_flow_executions e
     join flows f on f.base44_id = e.flow_id and f.connection_id = e.connection_id
     where e.company_id = $1 and e.connection_id = $2 and e.contact_phone = $3 and e.status = 'waiting'
       and e.context->>'_wait_type' = 'ai_agent' and e.id not like 'rw\\_%'
     order by e.started_at desc nulls last limit 1`,
    [contact.company_id, contact.connection_id, phone]
  );
  const ex = rows[0];
  if (!ex) return false;
  const node = (ex.nodes || []).find((n) => n.id === ex.current_node_id);
  if (node?.type && node.type !== 'ai_agent') return false;
  const ctx = { ...(ex.context || {}) };
  if (ctx._pending_route_next) return false;
  const cfg = ctx._wait_config || (node ? (node.data || node.config || {}) : {});
  const keepTimeout = ctx._wait_timeout_at || null;

  // Trava atômica: só um processo retoma esta execução
  const { rowCount } = await db.query(
    `update crm_flow_executions set status = 'running', waiting_since = null, delay_until = null, updated_at = now() where id = $1 and status = 'waiting'`,
    [ex.id]
  );
  if (!rowCount) return true;
  await claim(db, { base44_id: `resume:${msg.raw.id}` }, phone, 86400);
  const flow = { base44_id: ex.base44_id, name: ex.name, trigger_type: ex.trigger_type, nodes: ex.nodes };
  const aiText = msg.type === 'audio' ? '[audio]' : msg.type === 'image' ? '[imagem]' : msg.text;
  console.log(`[AI] id=${ev.id} resposta "${String(msg.text || msg.type).slice(0, 40)}" para exec=${ex.id}`);

  try {
    const ai = ctx._ai_mapped_vars || {};
    const nome = ai.nome || contact.nome || ctx.nome || '';
    Object.assign(ctx, {
      last_reply: msg.text, ultima_resposta: msg.text, last_message_type: msg.type, whatsapp_window_open: true,
      nome, email: ai.email || contact.email || ctx.email || '', empresa: ai.empresa || contact.empresa || ctx.empresa || '',
      contact_name: ai.nome || contact.nome || ctx.contact_name || '', telefone: phone, contact_phone: phone,
      primeiro_nome: nome.split(' ')[0], tags: Array.isArray(contact.tags) ? contact.tags : (ctx.tags || []),
      collected: { ...(ctx.collected || {}), ...(contact.custom_fields || {}) },
    });
    const r = await callAi({ companyId: contact.company_id, connectionId: contact.connection_id, phone, contact, context: ctx, flowId: ex.flow_id }, cfg, aiText, msg.type);
    if (!r) {
      // Devolve a espera e o Base44 processa a resposta como antes
      await db.query(`update crm_flow_executions set status = 'waiting', waiting_since = now(), updated_at = now() where id = $1 and status = 'running'`, [ex.id]).catch(() => {});
      return false;
    }
    const rec = r._record || {};
    const mapped = r.mapped_variables || {};
    const responded = r.ok && !r.skipped && !!r.response;
    if (mapped && Object.keys(mapped).length) {
      await saveVars(contact, mapped);
      Object.assign(ctx, mapped);
      ctx.collected = { ...(ctx.collected || {}), ...mapped };
      ctx._ai_mapped_vars = { ...(ctx._ai_mapped_vars || {}), ...mapped };
    }
    if (responded) {
      ctx.IA_RESPONSE = r.response;
      ctx.collected = { ...(ctx.collected || {}), IA_RESPONSE: r.response };
    }
    if (rec.messages?.length) await saveMessages(db, contact, phone, { _railway_messages: rec.messages }, null).catch((e) => console.error('[AI] mensagens:', e.message));
    reportLog(contact.company_id, contact.connection_id, phone, contact.id, r);
    console.log(`[AI] exec=${ex.id} respondeu em ${rec.log?.response_time_ms || 0}ms saída=${r.matched_branch || '-'}`);

    const cond = (cfg.conditional_outputs || []).find((c) => c.id === r.matched_branch);
    for (const k of WAIT_KEYS) delete ctx[k];

    // Saída escolhida sem destino: o fluxo termina (a resposta já foi enviada)
    if (r.matched_branch && !cond?.next_node_id) {
      await db.query(`update crm_flow_executions set status = 'completed', completed_at = now(), context = $2, updated_at = now() where id = $1`,
        [ex.id, JSON.stringify(ctx)]);
      console.log(`[AI] exec=${ex.id} saída "${r.matched_branch}" sem destino — fluxo concluído`);
      return true;
    }

    // Saída escolhida com destino: o Railway segue o caminho; o que não for dele fica com o Base44
    if (cond?.next_node_id) {
      const fast = await tryFast(ev, db, flow, cond.next_node_id, contact, msg, { force: true, context: ctx, fresh: true, record: false });
      if (fast && await ownResume(db, { exec: ex, flow, contact, phone, fast, ctx })) return true;
      if (fast) await saveMessages(db, contact, phone, fast, null);
      await db.query(`update crm_flow_executions set context = $2, updated_at = now() where id = $1`, [ex.id, JSON.stringify(mergeFast(ctx, fast))]);
      await fetch(`${APP_URL}/functions/workerTrigger`, {
        method: 'POST', headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resumeExecution', company_id: contact.company_id, context: { execution_id: ex.id, node_id: cond.next_node_id } }),
      }).catch((e) => console.warn('[AI] Base44 continua:', e.message));
      return true;
    }

    // Sem saída escolhida: volta a esperar a próxima mensagem (mantém o prazo original)
    const w = waitState(cfg, ex.current_node_id, cfg.next_node_id ?? nextOf(node));
    const timeoutAt = keepTimeout || w.timeout_at;
    await db.query(
      `update crm_flow_executions set status = 'waiting', waiting_since = now(), current_node_id = $2, delay_until = $3, context = $4, updated_at = now() where id = $1`,
      [ex.id, ex.current_node_id, timeoutAt, JSON.stringify({ ...ctx, _wait_type: 'ai_agent', _wait_config: w.cfg, _wait_node_id: ex.current_node_id, _wait_timeout_at: timeoutAt, _ai_responded: responded })]
    );
    console.log(`[AI] exec=${ex.id} aguardando nova mensagem até ${timeoutAt}`);
    return true;
  } catch (e) {
    // Falhou no meio: devolve a espera e o Base44 retoma como antes
    console.error(`[AI] retomada falhou exec=${ex.id} (Base44 assume):`, e.message);
    await db.query(`update crm_flow_executions set status = 'waiting', waiting_since = now(), updated_at = now() where id = $1 and status = 'running'`, [ex.id]).catch(() => {});
    await fetch(`${APP_URL}/functions/workerTrigger`, {
      method: 'POST', headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resumeFlow', contact_phone: phone, company_id: contact.company_id, context: { connection_id: contact.connection_id, reply_text: msg.text, message_type: msg.type } }),
    }).catch(() => {});
    return true;
  }
}

module.exports = { setAiPool, runAiNode, resumeAi };