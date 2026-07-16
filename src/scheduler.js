// ══════════════════════════════════════════════════════════
// scheduler.js — Gatilhos diários (contact_inactive, balance_low,
// scheduled_recurring). SÓ CRIA jobs no Supabase — não dispara.
// O poller pega esses jobs e enfileira; o consumer dispara.
//
// NÃO inclui task_overdue nem deal_stalled: esses são criados
// no momento do evento (saveTask/moveDeal no Base44).
// ══════════════════════════════════════════════════════════
const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

function getSupabase() {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);
}

// Cria job só se não existir um para a mesma referência
async function createJobIfNotExists(supabase, jobData) {
  const { data: existing } = await supabase
    .from('scheduled_jobs')
    .select('id')
    .eq('flow_base44_id', jobData.flow_base44_id)
    .eq('reference_id', jobData.reference_id)
    .in('status', ['pending', 'queued', 'running', 'completed'])
    .limit(1);

  if (existing && existing.length > 0) return null;

  const { data, error } = await supabase
    .from('scheduled_jobs')
    .insert({ ...jobData, status: 'pending', attempts: 0, max_attempts: 3 })
    .select()
    .single();

  if (error) {
    console.error('[SCHEDULER] Erro ao criar job:', error.message);
    return null;
  }
  console.log(`[SCHEDULER] ✅ Job: ${jobData.reference_type} | ${jobData.contact_phone}`);
  return data;
}

async function scheduleRecurring() {
  const supabase = getSupabase();
  const now = new Date();
  console.log('[SCHEDULER] Verificando gatilhos diários...');

  await Promise.allSettled([
    processContactInactive(supabase, now),
    processBalanceLow(supabase, now),
    processRecurringFlows(supabase, now),
  ]);

  console.log('[SCHEDULER] Concluído');
}

async function processContactInactive(supabase, now) {
  const { data: flows } = await supabase
    .from('flows').select('*')
    .eq('trigger_type', 'contact_inactive').eq('status', 'active');

  for (const flow of flows || []) {
    const days = Number(flow.trigger_config?.days) || 30;
    const limit = new Date(now.getTime() - days * 86400000);
    const flowBase44Id = flow.base44_id || flow.id;
    if (!flowBase44Id) continue;

    const { data: contacts } = await supabase
      .from('chat_contacts').select('*')
      .eq('customer_id', flow.company_id)
      .not('telefone', 'is', null)
      .lt('ultima_mensagem_em', limit.toISOString());

    for (const contact of contacts || []) {
      await createJobIfNotExists(supabase, {
        company_id: flow.company_id,
        job_type: 'flow_trigger',
        flow_base44_id: flowBase44Id,
        contact_phone: contact.telefone,
        scheduled_for: now.toISOString(),
        // reference_id SEM data: avisa 1x até o contato interagir
        reference_id: `${contact.id}_inactive`,
        reference_type: 'contact',
        context: {
          contact_phone: contact.telefone,
          contact_name: contact.nome || contact.telefone,
          days_inactive: String(days),
          flow_name: flow.name,
        },
      });
    }
  }
}

async function processBalanceLow(supabase, now) {
  const { data: flows } = await supabase
    .from('flows').select('*')
    .eq('trigger_type', 'balance_low').eq('status', 'active');

  for (const flow of flows || []) {
    const threshold = Number(flow.trigger_config?.threshold) || 5;
    const flowBase44Id = flow.base44_id || flow.id;
    if (!flowBase44Id) continue;

    const { data: companies } = await supabase
      .from('companies').select('*')
      .eq('id', flow.company_id)
      .lte('balance', threshold)
      .gt('balance', 0);

    for (const company of companies || []) {
      await createJobIfNotExists(supabase, {
        company_id: company.id,
        job_type: 'flow_trigger',
        flow_base44_id: flowBase44Id,
        contact_phone: company.email,
        scheduled_for: now.toISOString(),
        reference_id: `${company.id}_balance_${now.toISOString().slice(0, 10)}`,
        reference_type: 'company',
        context: {
          balance: String(company.balance),
          company_name: company.name,
          flow_name: flow.name,
        },
      });
    }
  }
}

async function processRecurringFlows(supabase, now) {
  const { data: flows } = await supabase
    .from('flows').select('*')
    .eq('trigger_type', 'scheduled_recurring').eq('status', 'active');

  const diasSemana = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const diaAtual = diasSemana[now.getUTCDay()];

  for (const flow of flows || []) {
    const { recurrence_type, recurrence_days, time, day_of_month } = flow.trigger_config || {};
    if (!time) continue;
    const flowBase44Id = flow.base44_id || flow.id;
    if (!flowBase44Id) continue;

    let diaMatch = false;
    if (recurrence_type === 'daily') diaMatch = true;
    else if (recurrence_type === 'weekly') diaMatch = (recurrence_days || []).includes(diaAtual);
    else if (recurrence_type === 'monthly') diaMatch = now.getUTCDate() === (day_of_month || 1);
    if (!diaMatch) continue;

    const [hora, minuto] = time.split(':').map(Number);
    const scheduledFor = new Date(now);
    scheduledFor.setUTCHours(hora + 3, minuto, 0, 0); // BRT → UTC

    if (scheduledFor < new Date(now.getTime() - 15 * 60000)) continue;

    const { data: contacts } = await supabase
      .from('chat_contacts').select('telefone, nome')
      .eq('customer_id', flow.company_id)
      .not('telefone', 'is', null);

    const hoje = now.toISOString().slice(0, 10);
    for (const contact of contacts || []) {
      await createJobIfNotExists(supabase, {
        company_id: flow.company_id,
        job_type: 'flow_trigger',
        flow_base44_id: flowBase44Id,
        contact_phone: contact.telefone,
        scheduled_for: scheduledFor.toISOString(),
        reference_id: `${flowBase44Id}_${contact.telefone}_${hoje}`,
        reference_type: 'recurring',
        context: {
          contact_phone: contact.telefone,
          contact_name: contact.nome || contact.telefone,
          flow_name: flow.name,
        },
      });
    }
  }
}

module.exports = { scheduleRecurring, createJobIfNotExists };
