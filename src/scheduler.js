const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
}

async function scheduleRecurring() {
  const supabase = getSupabase();
  const now = new Date();
  console.log('[SCHEDULER] Verificando gatilhos diários...');

  await Promise.allSettled([
    processTaskOverdue(supabase, now),
    processDealStalled(supabase, now),
    processContactInactive(supabase, now),
    processBalanceLow(supabase, now),
    processRecurringFlows(supabase, now)
  ]);

  console.log('[SCHEDULER] Gatilhos diários processados');
}

async function processTaskOverdue(supabase, now) {
  const { data: flows } = await supabase
    .from('flows')
    .select('*')
    .eq('trigger_type', 'task_overdue')
    .eq('status', 'active');

  for (const flow of flows || []) {
    const { data: tasks } = await supabase
      .from('tasks')
      .select('*')
      .eq('company_id', flow.company_id)
      .neq('status', 'Finalizado')
      .not('contact_phone', 'is', null)
      .lt('due_date', now.toISOString());

    for (const task of tasks || []) {
      await createJobIfNotExists(supabase, {
        company_id: flow.company_id,
        job_type: 'flow_trigger',
        flow_base44_id: flow.base44_id || flow.id,
        contact_phone: task.contact_phone,
        scheduled_for: now.toISOString(),
        reference_id: `${task.id}_${now.toDateString()}`,
        reference_type: 'task',
        context: {
          contact_phone: task.contact_phone,
          task_title: task.title,
          task_due_date: new Date(task.due_date).toLocaleDateString('pt-BR', {
            timeZone: 'America/Sao_Paulo'
          })
        }
      });
    }
  }
}

async function processDealStalled(supabase, now) {
  const { data: flows } = await supabase
    .from('flows')
    .select('*')
    .eq('trigger_type', 'deal_stalled')
    .eq('status', 'active');

  for (const flow of flows || []) {
    const hours = Number(flow.trigger_config?.hours) || 48;
    const stallLimit = new Date(now.getTime() - hours * 3600000);

    const { data: deals } = await supabase
      .from('deals')
      .select('*')
      .eq('company_id', flow.company_id)
      .eq('stage_id', flow.trigger_config?.stage_id)
      .eq('status', 'open')
      .not('contact_phone', 'is', null)
      .lt('stage_entered_at', stallLimit.toISOString());

    for (const deal of deals || []) {
      const daysStalled = Math.floor(
        (now - new Date(deal.stage_entered_at)) / 86400000
      );

      await createJobIfNotExists(supabase, {
        company_id: flow.company_id,
        job_type: 'flow_trigger',
        flow_base44_id: flow.base44_id || flow.id,
        contact_phone: deal.contact_phone,
        scheduled_for: now.toISOString(),
        reference_id: `${deal.id}_stalled`,
        reference_type: 'deal',
        context: {
          contact_phone: deal.contact_phone,
          deal_title: deal.title,
          deal_value: `R$ ${(deal.value || 0).toFixed(2)}`,
          days_stalled: String(daysStalled)
        }
      });
    }
  }
}

async function processContactInactive(supabase, now) {
  const { data: flows } = await supabase
    .from('flows')
    .select('*')
    .eq('trigger_type', 'contact_inactive')
    .eq('status', 'active');

  for (const flow of flows || []) {
    const days = Number(flow.trigger_config?.days) || 30;
    const limit = new Date(now.getTime() - days * 86400000);

    const { data: contacts } = await supabase
      .from('chat_contacts')
      .select('*')
      .eq('customer_id', flow.company_id)
      .not('telefone', 'is', null)
      .lt('ultima_mensagem_em', limit.toISOString());

    for (const contact of contacts || []) {
      await createJobIfNotExists(supabase, {
        company_id: flow.company_id,
        job_type: 'flow_trigger',
        flow_base44_id: flow.base44_id || flow.id,
        contact_phone: contact.telefone,
        scheduled_for: now.toISOString(),
        reference_id: `${contact.id}_inactive_${now.toDateString()}`,
        reference_type: 'contact',
        context: {
          contact_phone: contact.telefone,
          contact_name: contact.nome || contact.telefone,
          days_inactive: String(days)
        }
      });
    }
  }
}

async function processBalanceLow(supabase, now) {
  const { data: flows } = await supabase
    .from('flows')
    .select('*')
    .eq('trigger_type', 'balance_low')
    .eq('status', 'active');

  for (const flow of flows || []) {
    const threshold = Number(flow.trigger_config?.threshold) || 5;

    const { data: companies } = await supabase
      .from('companies')
      .select('*')
      .eq('id', flow.company_id)
      .lte('balance', threshold)
      .gt('balance', 0);

    for (const company of companies || []) {
      await createJobIfNotExists(supabase, {
        company_id: company.id,
        job_type: 'flow_trigger',
        flow_base44_id: flow.base44_id || flow.id,
        contact_phone: company.email,
        scheduled_for: now.toISOString(),
        reference_id: `${company.id}_balance_${now.toDateString()}`,
        reference_type: 'company',
        context: {
          balance: String(company.balance),
          company_name: company.name
        }
      });
    }
  }
}

async function processRecurringFlows(supabase, now) {
  const { data: flows } = await supabase
    .from('flows')
    .select('*')
    .eq('trigger_type', 'scheduled_recurring')
    .eq('status', 'active');

  const diasSemana = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const diaAtual = diasSemana[now.getDay()];

  for (const flow of flows || []) {
    const { recurrence_type, recurrence_days, time } = flow.trigger_config || {};
    if (!time) continue;

    let diaMatch = false;
    if (recurrence_type === 'daily') diaMatch = true;
    else if (recurrence_type === 'weekly') diaMatch = (recurrence_days || []).includes(diaAtual);
    else if (recurrence_type === 'monthly') diaMatch = now.getDate() === (flow.trigger_config?.day_of_month || 1);

    if (!diaMatch) continue;

    // Verificar se já disparou hoje
    const inicioDoDia = new Date(now);
    inicioDoDia.setUTCHours(0, 0, 0, 0);

    const { data: logs } = await supabase
      .from('automation_logs')
      .select('id')
      .eq('automation_id', flow.base44_id || flow.id)
      .gte('triggered_at', inicioDoDia.toISOString())
      .limit(1);

    if (logs && logs.length > 0) continue;

    // Calcular horário exato de disparo
    const [hora, minuto] = time.split(':').map(Number);
    const scheduledFor = new Date(now);
    scheduledFor.setUTCHours(hora + 3, minuto, 0, 0); // BRT → UTC

    // Buscar contatos
    const { data: contacts } = await supabase
      .from('chat_contacts')
      .select('telefone, nome')
      .eq('customer_id', flow.company_id)
      .not('telefone', 'is', null);

    for (const contact of contacts || []) {
      await createJobIfNotExists(supabase, {
        company_id: flow.company_id,
        job_type: 'flow_trigger',
        flow_base44_id: flow.base44_id || flow.id,
        contact_phone: contact.telefone,
        scheduled_for: scheduledFor.toISOString(),
        reference_id: `${flow.id}_${contact.telefone}_${inicioDoDia.toISOString()}`,
        reference_type: 'recurring',
        context: {
          contact_phone: contact.telefone,
          contact_name: contact.nome || contact.telefone
        }
      });
    }
  }
}

async function createJobIfNotExists(supabase, jobData) {
  // Verificar se já existe
  const { data: existing } = await supabase
    .from('scheduled_jobs')
    .select('id')
    .eq('flow_base44_id', jobData.flow_base44_id)
    .eq('reference_id', jobData.reference_id)
    .in('status', ['pending', 'running', 'completed'])
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

  console.log(`[SCHEDULER] ✅ Job: ${jobData.job_type} | ${jobData.contact_phone} | ${jobData.scheduled_for}`);
  return data;
}

module.exports = { scheduleRecurring, createJobIfNotExists };
