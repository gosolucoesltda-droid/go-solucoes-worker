const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

async function processJobs(manualJobs = null) {
  const supabase = getSupabase();
  const now = new Date();
  const results = { processed: 0, sent: 0, failed: 0 };

  let jobs = manualJobs;

  if (!jobs) {
    const { data, error } = await supabase
      .from('scheduled_jobs')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_for', now.toISOString())
      .lt('attempts', 3)
      .order('scheduled_for', { ascending: true })
      .limit(50);

    if (error) {
      console.error('[PROCESSOR] Erro ao buscar jobs:', error.message);
      return results;
    }
    jobs = data || [];
  }

  if (jobs.length === 0) return results;

  console.log(`[PROCESSOR] ${jobs.length} jobs para processar`);

  // Processar em paralelo (máximo 5 simultâneos)
  const chunks = chunkArray(jobs, 5);
  for (const chunk of chunks) {
    await Promise.allSettled(
      chunk.map(job => processJob(job, supabase, results))
    );
  }

  return results;
}

async function processJob(job, supabase, results) {
  results.processed++;

  // Marcar como running (evitar processamento duplo)
  const { data: updated } = await supabase
    .from('scheduled_jobs')
    .update({
      status: 'running',
      attempts: (job.attempts || 0) + 1,
      last_attempt_at: new Date().toISOString()
    })
    .eq('id', job.id)
    .eq('status', 'pending')
    .select();

  // Se não atualizou nada, outro processo já pegou este job
  if (!updated || updated.length === 0) {
    console.log(`[PROCESSOR] Job ${job.id} já sendo processado`);
    return;
  }

  try {
    const sucesso = await executarJob(job, supabase);

    await supabase
      .from('scheduled_jobs')
      .update({
        status: sucesso ? 'completed' : ((job.attempts || 0) >= 2 ? 'failed' : 'pending'),
        completed_at: sucesso ? new Date().toISOString() : null,
        error_message: sucesso ? null : 'Falha no envio — reprocessar'
      })
      .eq('id', job.id);

    if (sucesso) {
      results.sent++;

      await supabase.from('automation_logs').insert({
        company_id: job.company_id,
        automation_type: 'flow',
        automation_id: job.flow_base44_id,
        automation_name: job.context?.flow_name || 'Automação',
        contact_phone: job.contact_phone,
        status: 'sent',
        triggered_at: new Date().toISOString(),
        reference_id: job.reference_id
      });

      console.log(`[PROCESSOR] ✅ Job concluído: ${job.id} → ${job.contact_phone}`);
    } else {
      results.failed++;
      console.log(`[PROCESSOR] ❌ Job falhou: ${job.id}`);
    }

  } catch(e) {
    results.failed++;
    console.error(`[PROCESSOR] Exceção no job ${job.id}:`, e.message);

    await supabase
      .from('scheduled_jobs')
      .update({
        status: (job.attempts || 0) >= 2 ? 'failed' : 'pending',
        error_message: e.message
      })
      .eq('id', job.id);
  }
}

async function executarJob(job, supabase) {
  const context = job.context || {};
  const contactPhone = job.contact_phone;

  // Buscar empresa
  const { data: companies } = await supabase
    .from('companies')
    .select('phone_number_id, whatsapp_access_token, name')
    .eq('id', job.company_id)
    .limit(1);

  const company = companies?.[0];
  if (!company) {
    console.error(`[EXEC] Company não encontrada: ${job.company_id}`);
    return false;
  }

  const accessToken = process.env.META_SYSTEM_TOKEN || company.whatsapp_access_token;
  const phoneNumberId = company.phone_number_id;

  if (!accessToken || !phoneNumberId) {
    console.error(`[EXEC] Token ou phoneNumberId ausente para: ${company.name}`);
    return false;
  }

  // Buscar flow
  // Tentar buscar pelo base44_id direto
let { data: flows } = await supabase
  .from('flows')
  .select('*')
  .eq('base44_id', job.flow_base44_id)
  .limit(1);

// Se não achou, tentar converter UUID de volta para base44_id
if (!flows || flows.length === 0) {
  // Remover zeros do padding e hífens para obter o hex original
  const hexId = job.flow_base44_id.replace(/-/g, '').replace(/^0+/, '');
  console.log(`[EXEC] Tentando base44_id convertido: ${hexId}`);
  
  const result = await supabase
    .from('flows')
    .select('*')
    .eq('base44_id', hexId)
    .limit(1);
  
  flows = result.data;
}

// Se ainda não achou, buscar pelo UUID direto
if (!flows || flows.length === 0) {
  const result = await supabase
    .from('flows')
    .select('*')
    .eq('id', job.flow_base44_id)
    .limit(1);
  
  flows = result.data;
}

console.log(`[EXEC] Flow encontrado: ${flows?.length > 0 ? flows[0].name : 'NÃO'}`);

  const flow = flows?.[0];
  if (!flow) {
    console.error(`[EXEC] Flow não encontrado: ${job.flow_base44_id}`);
    return false;
  }

  // Buscar primeiro nó
  const nodes = flow.nodes || [];
  const firstNode = nodes.find(n =>
    !nodes.some(o =>
      o.next_node_id === n.id ||
      (o.branches || []).some(b => b.next_node_id === n.id)
    )
  ) || nodes[0];

  if (!firstNode) {
    console.error(`[EXEC] Flow sem nós: ${flow.name}`);
    return false;
  }

  console.log(`[EXEC] "${flow.name}" | ${firstNode.type} → ${contactPhone}`);

  return await enviarViaWhatsApp(
    firstNode, contactPhone, phoneNumberId, accessToken, context
  );
}

async function enviarViaWhatsApp(node, to, phoneNumberId, token, context) {
  let payload;

  if (node.type === 'send_template') {
    const tplName = node.config?.template_name;
    const tplLang = node.config?.template_language || 'pt_BR';
    const mapping = node.config?.variables_mapping || {};

    const params = Object.values(mapping)
      .map(src => {
        if (typeof src === 'string' && src.startsWith('custom:')) {
          return src.replace('custom:', '');
        }
        return context[String(src)] || '';
      })
      .filter(Boolean);

    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: tplName,
        language: { code: tplLang },
        ...(params.length > 0 && {
          components: [{
            type: 'body',
            parameters: params.map(p => ({ type: 'text', text: String(p) }))
          }]
        })
      }
    };

  } else if (node.type === 'send_message') {
    let msg = node.config?.message || '';
    Object.entries(context).forEach(([k, v]) => {
      msg = msg.replace(new RegExp(`{{${k}}}`, 'g'), String(v || ''));
    });
    payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: msg }
    };

  } else if (node.type === 'message') {
  // Alias para send_message
  let msg = node.config?.message || node.config?.text || '';
  Object.entries(context).forEach(([k, v]) => {
    msg = msg.replace(new RegExp(`{{${k}}}`, 'g'), String(v || ''));
  });

  if (!msg) {
    console.log(`[EXEC] Mensagem vazia no nó tipo message`);
    return true;
  }

  console.log(`[EXEC] Enviando mensagem (type=message): "${msg}"`);

  const res = await axios.post(
    `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: msg }
    },
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  const msgId = res.data?.messages?.[0]?.id;
  console.log(`[EXEC] ✅ Meta OK: ${res.status} | id: ${msgId}`);
  return res.status >= 200 && res.status < 300;

} else {
  console.log(`[EXEC] Tipo não suportado: ${node.type} — marcando como sucesso`);
  return true;
}

  try {
    const res = await axios.post(
      `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const msgId = res.data?.messages?.[0]?.id;
    console.log(`[EXEC] ✅ Meta OK: ${res.status} | id: ${msgId}`);
    return true;

  } catch(e) {
    const err = e.response?.data?.error;
    console.error(`[EXEC] ❌ Meta erro: ${err?.message || e.message}`);
    return false;
  }
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

module.exports = { processJobs };
