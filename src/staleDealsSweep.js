// ═══════════════════════════════════════════════════════════
// Negócios parados na etapa (automação do funil "após X horas na etapa") — mesmas regras do
// Base44 (processStaleDealsAutomations + triggerAutomation), lendo tudo do Supabase e enviando
// o modelo direto pela Meta. Uma vez por dia a partir das 9h (Brasília).
// O Base44 só registra depois: cria o histórico (AutomationLog) e desconta o saldo.
// ═══════════════════════════════════════════════════════════
/* global module, require */
const { startDaily } = require('./dailyClaim');
const { loadCreds } = require('./botSettings');
const SWEEP_ID = 'sweep_stale_deals';
const PRICES = { MARKETING: 0.40, UTILITY: 0.06, AUTHENTICATION: 0.06 };

function templateParams(auto, ctx) {
  const vars = auto.template_variables || {};
  return Object.keys(vars).sort((a, b) => parseInt(a) - parseInt(b)).map((k) => {
    const f = vars[k];
    const text = f === 'custom_text' ? (auto.custom_texts || {})[k] || '' : f && ctx[f] != null ? String(ctx[f]) : '';
    return { type: 'text', text };
  });
}

async function credsFor(pool, companyId, connectionId) {
  const own = connectionId && await loadCreds(companyId, connectionId);
  if (own) return own;
  const { rows: [c] } = await pool.query(
    `select id from crm_whatsapp_connections where company_id = $1 and status = 'active' and access_token_sealed is not null order by updated_at desc limit 1`, [companyId]);
  return c ? loadCreds(companyId, c.id) : null;
}

async function sendOne(pool, auto, deal, company) {
  const cost = PRICES[String(auto.template_category || 'UTILITY').toUpperCase()] ?? PRICES.UTILITY;
  const creds = await credsFor(pool, auto.company_id, deal.connection_id);
  if (!creds) return { status: 'skipped', error: 'WhatsApp não conectado', cost };
  const balance = Number(company.balance) || 0;
  if (balance < cost) return { status: 'skipped', error: `Saldo insuficiente (R$ ${balance.toFixed(2)} disponível, R$ ${cost.toFixed(2)} necessário)`, cost };
  const digits = String(deal.contact_phone).replace(/\D/g, '');
  const { rows: [contact] } = await pool.query(
    `select nome from crm_contacts where company_id = $1 and telefone in ($2, $3) order by (connection_id = $4) desc nulls last limit 1`,
    [auto.company_id, deal.contact_phone, digits, deal.connection_id || '']);
  const ctx = {
    contact_name: contact?.nome || deal.contact_phone, contact_phone: deal.contact_phone, company_name: company.name || '',
    deal_title: deal.title || '', deal_value: String(Number(deal.value) || 0), responsible: deal.responsible || '',
    stage_name: auto.stage_name || '', pipeline_name: auto.pipeline_name || '',
  };
  const params = templateParams(auto, ctx);
  const template = { name: auto.template_name, language: { code: 'pt_BR' }, ...(params.length ? { components: [{ type: 'body', parameters: params }] } : {}) };
  try {
    const res = await fetch(`https://graph.facebook.com/v22.0/${creds.phone_number_id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.access_token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: digits, type: 'template', template }),
    });
    const data = await res.json();
    if (data.error) return { status: 'failed', error: data.error.message || JSON.stringify(data.error), cost };
    company.balance = balance - cost;
    return { status: 'sent', wa_id: data.messages?.[0]?.id || null, cost };
  } catch (e) {
    return { status: 'failed', error: e.message, cost };
  }
}

async function runStaleDeals(pool) {
  const res = { automations: 0, deals: 0, sent: 0, failed: 0, skipped: 0 };
  const { rows: autos } = await pool.query(
    `select * from crm_funnel_automations where trigger = 'after_hours_in_stage' and is_active and template_name is not null`);
  res.automations = autos.length;
  const companies = new Map();
  for (const auto of autos) {
    const { rows: deals } = await pool.query(
      `select d.* from crm_deals d where d.company_id = $1 and d.stage_id = $2 and d.status = 'open'
         and d.stage_entered_at <= now() - $3 * interval '1 hour' and coalesce(d.contact_phone, '') <> ''
         and not exists (select 1 from crm_funnel_automation_sends s where s.automation_id = $4 and s.deal_id = d.id and s.status in ('sent', 'sending'))`,
      [auto.company_id, auto.stage_id, Number(auto.trigger_hours) || 48, auto.id]);
    if (!companies.has(auto.company_id)) {
      companies.set(auto.company_id, (await pool.query(`select name, balance from companies where id = $1`, [auto.company_id])).rows[0] || {});
    }
    for (const deal of deals) {
      // Trava por automação + negócio (falha ou pulado de outro dia pode tentar de novo)
      const { rowCount } = await pool.query(
        `insert into crm_funnel_automation_sends (automation_id, deal_id, status, updated_at) values ($1, $2, 'sending', now())
         on conflict (automation_id, deal_id) do update set status = 'sending', updated_at = now()
         where crm_funnel_automation_sends.status in ('failed', 'skipped')
         returning deal_id`, [auto.id, deal.id]);
      if (!rowCount) continue;
      res.deals++;
      const r = await sendOne(pool, auto, deal, companies.get(auto.company_id));
      res[r.status]++;
      await pool.query(
        `update crm_funnel_automation_sends set status = $3, error_message = $4, wa_id = $5, company_id = $6, contact_phone = $7,
           automation_name = $8, template_name = $9, cost = $10, reported = false, updated_at = now()
         where automation_id = $1 and deal_id = $2`,
        [auto.id, deal.id, r.status, r.error || null, r.wa_id || null, auto.company_id, deal.contact_phone, auto.name, auto.template_name, r.status === 'sent' ? r.cost : 0]);
      if (r.status === 'sent') await pool.query(`update companies set balance = balance - $2 where id = $1`, [auto.company_id, r.cost]);
    }
  }
  return res;
}

// Base44 registra o histórico e desconta o saldo (envios ainda não informados)
async function reportPending(pool, callBase44Function) {
  const { rows } = await pool.query(
    `select * from crm_funnel_automation_sends where reported = false and status in ('sent', 'failed', 'skipped') and company_id is not null order by updated_at limit 200`);
  if (!rows.length) return;
  const r = await callBase44Function('workerTrigger', { action: 'funnelAutomationResults', context: { results: rows.map((s) => ({
    automation_id: s.automation_id, automation_name: s.automation_name, template_name: s.template_name, deal_id: s.deal_id,
    company_id: s.company_id, contact_phone: s.contact_phone, status: s.status, error_message: s.error_message, cost: Number(s.cost) || 0,
    triggered_at: new Date(s.updated_at).toISOString(),
  })) } }).catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) { console.error('[STALE_DEALS] Base44 não registrou (tenta de novo):', r?.error); return; }
  await pool.query(`update crm_funnel_automation_sends set reported = true where (automation_id, deal_id) in (select unnest($1::text[]), unnest($2::text[]))`,
    [rows.map((s) => s.automation_id), rows.map((s) => s.deal_id)]);
  console.log(`[STALE_DEALS] ${rows.length} envio(s) registrados no Base44`);
}

function startStaleDealsSweep(pool, callBase44Function) {
  if (!pool) return;
  startDaily(pool, SWEEP_ID, 9, async (p) => {
    const res = await runStaleDeals(p);
    await reportPending(p, callBase44Function).catch((e) => console.error('[STALE_DEALS] registro:', e.message));
    return res;
  }, 'STALE_DEALS');
  setInterval(() => reportPending(pool, callBase44Function).catch((e) => console.error('[STALE_DEALS] registro:', e.message)), 10 * 60 * 1000);
  console.log('[STALE_DEALS] negócios parados pelo Railway');
}

module.exports = { startStaleDealsSweep, runStaleDeals };