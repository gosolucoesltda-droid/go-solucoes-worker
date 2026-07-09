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
  const results = { processed: 0, triggered: 0, failed: 0 };

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

  if (!updated || updated.length === 0) {
    console.log(`[PROCESSOR] Job ${job.id} já sendo processado`);
    return;
  }

  try {
    // Chamar o Base44 para executar o fluxo
    const sucesso = await dispararFluxoNoBase44(job);

    await supabase
      .from('scheduled_jobs')
      .update({
        status: sucesso ? 'completed' : ((job.attempts || 0) >= 2 ? 'failed' : 'pending'),
        completed_at: sucesso ? new Date().toISOString() : null,
        error_message: sucesso ? null : 'Falha ao disparar fluxo no Base44'
      })
      .eq('id', job.id);

    if (sucesso) {
      results.triggered++;

      // Registrar AutomationLog no Supabase
      await supabase.from('automation_logs').insert({
        company_id: job.company_id,
        automation_type: 'flow',
        automation_id: job.flow_base44_id,
        automation_name: job.context?.flow_name || 'Automação',
        contact_phone: job.contact_phone,
        status: 'triggered',
        triggered_at: new Date().toISOString(),
        reference_id: job.reference_id
      });

      console.log(`[PROCESSOR] ✅ Fluxo disparado: ${job.contact_phone}`);
    } else {
      results.failed++;
      console.log(`[PROCESSOR] ❌ Falhou: ${job.id}`);
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

async function dispararFluxoNoBase44(job) {
  const base44Url = process.env.BASE44_WORKER_ENDPOINT;
  const workerSecret = process.env.WORKER_SECRET;

  if (!base44Url) {
    console.error('[TRIGGER] BASE44_WORKER_ENDPOINT não configurado');
    return false;
  }

  try {
    console.log(`[TRIGGER] Disparando fluxo: ${job.flow_base44_id} → ${job.contact_phone}`);

    const res = await axios.post(
      base44Url,
      {
        action: 'startFlow',
        flow_id: job.flow_base44_id,
        contact_phone: job.contact_phone,
        company_id: job.company_id,
        context: job.context || {},
        reference_id: job.reference_id,
        reference_type: job.reference_type
      },
      {
        headers: {
          'Authorization': `Bearer ${workerSecret}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000
      }
    );

    console.log(`[TRIGGER] Base44 respondeu: ${res.status} | ${JSON.stringify(res.data)}`);
    return res.status >= 200 && res.status < 300 && res.data?.ok !== false;

  } catch(e) {
    const err = e.response?.data;
    console.error(`[TRIGGER] Erro ao chamar Base44: ${JSON.stringify(err || e.message)}`);
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
