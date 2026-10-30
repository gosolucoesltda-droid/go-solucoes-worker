// Requisição de API → variáveis do negócio (Funil): {{deal_nome}}, {{deal_value}}, {{deal_date}}, {{deal_datetime}}.
// Mesma regra do Base44: base44/shared/dealFieldMap.ts
/* global module */
const { logDealChanges } = require('./dealNotices');
const DEAL_FIELD_KEYS = ['deal_nome', 'deal_value', 'deal_date', 'deal_datetime'];

function parseMoney(v) {
  let s = String(v ?? '').replace(/[^\d.,-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Number(s) || 0;
}

const brt = (ms) => { const i = new Date(ms - 3 * 3600000).toISOString(); return { date: i.slice(0, 10), time: i.slice(11, 16) }; };

// dd/mm/aaaa [HH:MM], aaaa-mm-dd[ HH:MM], ISO com fuso (convertido para Brasília) ou timestamp Unix
function parseDue(v) {
  const s = String(v || '').trim();
  if (/^\d{10}$|^\d{13}$/.test(s)) return brt(s.length === 10 ? Number(s) * 1000 : Number(s));
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2}):(\d{2}))?/);
  if (m) return { date: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, time: m[4] ? `${m[4].padStart(2, '0')}:${m[5]}` : null };
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?/);
  if (!m) return null;
  if (m[6]) { const ms = Date.parse(s); if (!isNaN(ms)) return brt(ms); }
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] ? `${m[4]}:${m[5]}` : null };
}

function dealPatch(mapped) {
  const p = {};
  for (const [k, v] of Object.entries(mapped)) {
    const s = String(v ?? '').trim();
    if (k === 'deal_nome' && s) p.title = s;
    else if (k === 'deal_value') p.value = parseMoney(s);
    else if (k === 'deal_date' || k === 'deal_datetime') {
      const d = parseDue(s);
      if (!d) continue;
      p.due_date = d.date;
      if (k === 'deal_datetime' && d.time) p.due_time = d.time;
    }
  }
  return p;
}

function applyDealVars(t, p) {
  if ('title' in p) { t.deal_nome = p.title; t.deal_title = p.title; }
  if ('value' in p) t.deal_value = String(Number(p.value) || 0);
  if (p.due_date) {
    const [y, m, d] = p.due_date.split('-');
    const date = `${d}/${m}/${y}`;
    const time = p.due_time || (String(t.deal_datetime || '').match(/\d{2}:\d{2}$/) || [])[0] || '';
    t.deal_date = date;
    t.deal_datetime = time ? `${date} ${time}` : date;
  }
}

// Grava no negócio do disparo ou, sem ele, no negócio aberto mais recente do contato no bot
async function saveDealFields(pool, contact, phone, r) {
  const cols = Object.keys(r.patch || {}).filter((k) => ['title', 'value', 'due_date', 'due_time'].includes(k));
  if (!cols.length) return;
  const { rows: [deal] } = r.deal_id
    ? await pool.query('select id, title, value, due_date, due_time from crm_deals where id = $1', [r.deal_id])
    : await pool.query(
      `select id, title, value, due_date, due_time from crm_deals where company_id = $1 and contact_phone = $2 and coalesce(status, 'open') = 'open'
         and (connection_id is null or connection_id = $3::text)
       order by (connection_id = $3::text) desc nulls last, updated_at desc nulls last limit 1`,
      [contact.company_id, phone, contact.connection_id || null]);
  if (!deal) return;
  await pool.query(`update crm_deals set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [deal.id, ...cols.map((c) => r.patch[c])]);
  // Aviso no chat das variáveis do Funil que mudaram
  await logDealChanges(pool, { companyId: contact.company_id, connectionId: contact.connection_id, phone, at: r.at }, deal, { ...deal, ...r.patch })
    .catch((e) => console.error('[DEAL_FIELDS] aviso falhou:', e.message));
}

module.exports = { DEAL_FIELD_KEYS, dealPatch, applyDealVars, saveDealFields, parseMoney };