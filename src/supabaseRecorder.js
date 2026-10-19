// ═══════════════════════════════════════════════════════════
// Fase 2 — O Railway grava direto no Supabase o que acabou de enviar pela Meta
// (mensagens de saída) e a execução do fluxo. O Base44 continua gravando a
// cópia dele; a sincronização troca as linhas provisórias ("wa_..." / "rw_...").
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');

function sentMessages(fast) {
  const out = [];
  for (let r = fast; r; r = r._railway_jump) out.push(...(r._railway_messages || []));
  return out.filter((m) => m.wa_id);
}

function interactiveOf(m) {
  if (m.list) return m.list;
  if (m.template_buttons) return { template_buttons: m.template_buttons };
  if (m.buttons?.length) return { buttons: m.buttons };
  return null;
}

// flow = fluxo iniciado agora (cria execução provisória); executionId = execução existente (retomada)
async function recordFast(pool, p) {
  const { companyId, connectionId, contactId, phone, flow, fast, executionId, startNodeId } = p;
  if (!fast || !pool) return;
  const t0 = Date.now();
  try {
    const msgs = sentMessages(fast);
    for (const m of msgs) {
      const json = interactiveOf(m);
      await pool.query(
        `insert into crm_messages (id, company_id, contact_id, connection_id, direction, body, status, tipo, whatsapp_message_id, media_url, media_id, file_name, mime_type, interactive_data, sent_at, created_at, is_ai_generated)
         values ($1, $2, $3, $4, 'outbound', $5, 'sent', $6, $7, $8, $9, $10, $11, $12, $13, now(), false) on conflict (id) do nothing`,
        [`wa_${m.wa_id}`, companyId, contactId, connectionId, m.body || '', m.tipo || (m.buttons?.length ? 'interactive_buttons' : 'text'), m.wa_id,
          m.media_url || null, m.audio_media_id || null, m.file_name || null, m.audio_media_id ? 'audio/ogg' : null, json ? JSON.stringify(json) : null, m.at || new Date().toISOString()]
      );
    }
    if (msgs.length && contactId) {
      await pool.query(`update crm_contacts set ultima_mensagem = $2, ultima_mensagem_em = now(), updated_at = now() where id = $1`,
        [contactId, String(msgs[msgs.length - 1].body || '').slice(0, 100)]);
    }

    const steps = (fast._executed_nodes || []).length;
    const node = fast._railway_stop_node || (fast._executed_nodes || [])[steps - 1] || startNodeId || null;
    const status = fast._railway_stop_node ? 'waiting' : 'running';
    const waitingSince = status === 'waiting' ? new Date().toISOString() : null;
    if (executionId) {
      await pool.query(
        `update crm_flow_executions set status = $2, current_node_id = $3, delay_until = null, waiting_since = $4, steps_executed = steps_executed + $5, updated_at = now() where id = $1`,
        [executionId, status, node, waitingSince, steps]
      );
    } else if (flow) {
      // Provisórias que o Base44 nunca substituiu não podem travar novos disparos
      await pool.query(`delete from crm_flow_executions where id like 'rw\\_%' and created_at < now() - interval '10 minutes'`);
      await pool.query(
        `insert into crm_flow_executions (id, company_id, connection_id, flow_id, flow_name, contact_phone, status, current_node_id, started_at, waiting_since, steps_executed)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10)`,
        [`rw_${crypto.randomUUID()}`, companyId, connectionId, flow.base44_id, flow.name || null, phone, status, node, waitingSince, steps]
      );
    }
    console.log(`[SUPABASE] gravou ${msgs.length} msg(s)${executionId || flow ? ' + execução' : ''} em ${Date.now() - t0}ms`);
  } catch (e) {
    console.error('[SUPABASE] gravação direta falhou (Base44 sincroniza):', e.message);
  }
}

module.exports = { recordFast };