// ═══════════════════════════════════════════════════════════
// Fase 5 — Resposta de texto a uma pergunta do fluxo: o Railway valida, salva o campo
// e continua (mesmas regras do Base44: flowResume.ts / flowResumeReply.ts).
// Se o próximo bloco só o Base44 executa, ele continua dali (o que já foi enviado é pulado).
// ═══════════════════════════════════════════════════════════
const { ownResume, saveMessages, mergeFast } = require('./flowOwner');
const { getCreds, metaPost, payloadFor } = require('./fastPath');
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const WORKER_SECRET = process.env.WORKER_SECRET;

const nextOf = (n) => n?.next_node_id ?? n?.data?.next_node_id ?? n?.config?.next_node_id ?? null;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const SYSTEM_FIELDS = ['nome', 'email', 'empresa', 'observacoes']; // colunas do contato que o Railway grava

function validAnswer(text, type) {
  if (type === 'image' || !text) return false;
  switch (type) {
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    case 'phone': { const d = text.replace(/\D/g, ''); return d.length >= 10 && d.length <= 13; }
    case 'number': return !isNaN(Number(text.replace(',', '.')));
    case 'url': try { new URL(text.startsWith('http') ? text : `https://${text}`); return true; } catch { return false; }
    default: return text.length > 0;
  }
}

// Menu persistente: resposta que escolhe um item do menu fica com o Base44 (pode trocar de fluxo)
function hitsMenu(ctx, text) {
  const mc = ctx._menu_persistent === true && ctx._menu_node_id && ctx._menu_config;
  if (!mc) return false;
  const items = [...(mc.rows || []), ...(mc.sections || [])].flatMap((s) => (s.rows || s.items || []).map((i) => i.title))
    .concat((mc.buttons || []).map((b) => b.text));
  const r = norm(text);
  return items.some((t) => { const n = norm(t); return n && (n === r || n.includes(r) || r.includes(n)); });
}

const toBase44 = (body) => fetch(`${APP_URL}/functions/workerTrigger`, {
  method: 'POST', headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function saveAnswer(pool, contact, ctx, wc, sysField, text) {
  ctx.collected = ctx.collected || {};
  if (sysField) {
    await pool.query(`update crm_contacts set ${sysField} = $2, updated_at = now() where id = $1`, [contact.id, text]);
    contact[sysField] = text; ctx.collected[sysField] = text; ctx[sysField] = text;
    if (sysField === 'nome') Object.assign(ctx, { contact_name: text, primeiro_nome: text.split(' ')[0] });
  } else if (wc.save_to_field) {
    const k = wc.save_to_field;
    await pool.query(`update crm_contacts set custom_fields = coalesce(custom_fields, '{}'::jsonb) || jsonb_build_object($2::text, $3::text), updated_at = now() where id = $1`, [contact.id, k, text]);
    contact.custom_fields = { ...(contact.custom_fields || {}), [k]: text };
    ctx.collected[k] = text; ctx[k] = text;
  }
}

// Resposta inválida: avisa e continua esperando
async function retry(pool, ex, ctx, wc, used, contact, phone) {
  let fast = null;
  if (wc.error_message) {
    const data = await metaPost(await getCreds(contact.company_id, contact.connection_id), 'messages', payloadFor(phone, wc.error_message, []));
    fast = { _railway_messages: [{ body: wc.error_message, buttons: [], wa_id: data.messages?.[0]?.id || null, at: new Date().toISOString() }] };
  }
  await pool.query(`update crm_flow_executions set status = 'waiting', waiting_since = now(), context = $2, updated_at = now() where id = $1`,
    [ex.id, JSON.stringify({ ...ctx, _wait_config: { ...wc, retries_used: used } })]);
  if (fast) await saveMessages(pool, contact, phone, fast, null);
  console.log(`[QUESTION] resposta inválida (${used}/${wc.max_retries ?? 3}) exec=${ex.id}`);
}

// true = resposta tratada aqui (o Base44 e os gatilhos não processam esta mensagem)
async function resumeQuestion(ev, pool, contact, msg, { tryFast, claim }) {
  const phone = msg.from;
  const { rows } = await pool.query(
    `select e.id, e.current_node_id, e.context, f.base44_id, f.name, f.trigger_type, f.nodes from crm_flow_executions e
     join flows f on f.base44_id = e.flow_id and f.connection_id = e.connection_id
     where e.company_id = $1 and e.connection_id = $2 and e.contact_phone = $3 and e.status = 'waiting' and e.id not like 'rw\\_%'
     order by e.started_at desc nulls last limit 1`,
    [contact.company_id, contact.connection_id, phone]
  );
  const ex = rows[0];
  const ctx = { ...(ex?.context || {}) };
  const wc = ctx._wait_config;
  const node = (ex?.nodes || []).find((n) => n.id === ex.current_node_id);
  if (!ex || node?.type !== 'message' || ctx._wait_type !== 'reply' || wc?.type !== 'question' || ctx._pending_route_next || hitsMenu(ctx, msg.text)) return false;
  const text = msg.text.trim();
  const valid = validAnswer(text, wc.response_type ?? 'text');
  const sysField = wc.field_type === 'system' ? wc.contact_field : null;
  if (valid && sysField && !SYSTEM_FIELDS.includes(sysField)) return false;
  if (valid && !sysField && wc.save_to_field && /^\d{10,13}$/.test(text)) return false; // pode virar data no Base44

  // Trava atômica (a mesma do Base44): só um processo retoma
  const { rowCount } = await pool.query(
    `update crm_flow_executions set status = 'running', waiting_since = null, delay_until = null, started_at = now(), updated_at = now() where id = $1 and status = 'waiting'`, [ex.id]
  );
  if (!rowCount) return true;
  await claim(pool, { base44_id: `resume:${msg.raw.id}` }, phone, 86400);
  const flow = { base44_id: ex.base44_id, name: ex.name, trigger_type: ex.trigger_type, nodes: ex.nodes };
  console.log(`[QUESTION] id=${ev.id} resposta "${text.slice(0, 40)}" para exec=${ex.id} válida=${valid}`);
  try {
    // Mesmos dados que o Base44 atualiza na retomada
    const ai = ctx._ai_mapped_vars || {};
    const nome = ai.nome || contact.nome || ctx.nome || '';
    Object.assign(ctx, {
      last_reply: msg.text, ultima_resposta: msg.text, last_message_type: 'text', whatsapp_window_open: true,
      nome, email: ai.email || contact.email || ctx.email || '', empresa: ai.empresa || contact.empresa || ctx.empresa || '',
      contact_name: ai.nome || contact.nome || ctx.contact_name || '', telefone: phone, contact_phone: phone, primeiro_nome: nome.split(' ')[0],
      tags: Array.isArray(contact.tags) ? contact.tags : (ctx.tags || []), collected: { ...(ctx.collected || {}), ...(contact.custom_fields || {}) },
    });
    let next;
    if (!valid) {
      const used = (wc.retries_used ?? 0) + 1;
      if (used < (wc.max_retries ?? 3)) { await retry(pool, ex, ctx, wc, used, contact, phone); return true; }
      next = wc.next_node_timeout_id || nextOf(node);
    } else {
      await saveAnswer(pool, contact, ctx, wc, sysField, text);
      next = wc.next_node_id || nextOf(node);
    }
    for (const k of ['_wait_type', '_wait_config', '_wait_node_id', '_wait_timeout_at', '_ai_responded']) delete ctx[k];
    if (!next) {
      await pool.query(`update crm_flow_executions set status = 'completed', completed_at = now(), context = $2, updated_at = now() where id = $1`, [ex.id, JSON.stringify(ctx)]);
      return true;
    }
    const fast = await tryFast(ev, pool, flow, next, contact, msg, { force: true, context: ctx, fresh: true, record: false });
    if (fast && await ownResume(pool, { exec: ex, flow, contact, phone, fast, ctx })) return true;
    // Bloco que só o Base44 executa: ele continua daqui
    if (fast) await saveMessages(pool, contact, phone, fast, null);
    await pool.query(`update crm_flow_executions set context = $2, updated_at = now() where id = $1`, [ex.id, JSON.stringify(mergeFast(ctx, fast))]);
    const res = await toBase44({ action: 'resumeExecution', company_id: contact.company_id, context: { execution_id: ex.id, node_id: next } });
    console.log(`[QUESTION] Base44 continua exec=${ex.id} a partir de ${next} status=${res.status}`);
  } catch (e) {
    // Falhou antes de terminar: devolve a espera e o Base44 processa a resposta como antes
    console.error(`[QUESTION] retomada falhou exec=${ex.id} (Base44 assume):`, e.message);
    await pool.query(`update crm_flow_executions set status = 'waiting', waiting_since = now(), updated_at = now() where id = $1 and status = 'running'`, [ex.id]).catch(() => {});
    await toBase44({ action: 'resumeFlow', contact_phone: phone, company_id: contact.company_id, context: { connection_id: contact.connection_id, reply_text: msg.text, message_type: 'text' } }).catch(() => {});
  }
  return true;
}

module.exports = { resumeQuestion };