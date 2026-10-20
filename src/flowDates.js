// ═══════════════════════════════════════════════════════════
// Datas do motor de fluxos no Railway (mesmas regras do Base44):
// - convertDate: base44/shared/dateConverter.ts (convertUnixTimestamp)
// - delayResumeAt: base44/shared/flowDelayBlock.ts (calculateDelayResumeAt)
// - fieldType: tipo do campo personalizado (o cadastro dos campos fica no Base44; cache de 5 min)
// ═══════════════════════════════════════════════════════════
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const WORKER_SECRET = process.env.WORKER_SECRET;
const BRT = 3 * 3600000;
const pad = (n) => String(n).padStart(2, '0');

const typesCache = new Map();
async function fieldTypes(companyId) {
  const hit = typesCache.get(companyId);
  if (hit && hit.exp > Date.now()) return hit.types;
  const res = await fetch(`${APP_URL}/functions/workerTrigger`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'fieldTypes', company_id: companyId }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'tipos de campo indisponíveis');
  typesCache.set(companyId, { types: data.types || {}, exp: Date.now() + 5 * 60000 });
  return data.types || {};
}

// Só busca o tipo quando o valor pode virar data (a maioria dos valores nem chega aqui)
const mayBeDate = (v) => v !== null && v !== undefined && v !== '' && !isNaN(new Date(String(v).trim()).getTime()) ||
  /^\d{9,13}$/.test(String(v ?? '').trim()) || /^\d{2}\/\d{2}\/\d{4}/.test(String(v ?? '').trim());

function fmt(d, type) {
  const b = new Date(d.getTime() - BRT);
  const day = `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}`;
  return type === 'date' ? day : `${day}T${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}:00`;
}

function convertDate(value, type) {
  if ((type !== 'date' && type !== 'datetime') || value === null || value === undefined || value === '') return value;
  const str = String(value).trim();
  if (/^\d{9,13}$/.test(str)) {
    const d = new Date(str.length <= 10 ? Number(str) * 1000 : Number(str));
    const y = d.getUTCFullYear();
    return isNaN(d.getTime()) || y < 2000 || y > 2100 ? value : fmt(d, type);
  }
  const br = str.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (br) {
    const [, d, mo, y, h, mi] = br;
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return value;
    if (type === 'date') return `${y}-${mo}-${d}`;
    return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), (h ? Number(h) : 0) + 3, mi ? Number(mi) : 0)).toISOString();
  }
  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) return value;
  const y = parsed.getUTCFullYear();
  if (y < 2000 || y > 2100) return value;
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (type === 'datetime' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str)) return str;
  return fmt(parsed, type);
}

// Valor final do campo (com a conversão de data quando o campo é data/data e hora)
async function fieldValue(companyId, key, value) {
  if (!mayBeDate(value)) return value;
  const types = await fieldTypes(companyId);
  return convertDate(value, types[String(key || '').toLowerCase()] || 'text');
}

const DAYS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const dayName = (n) => Object.keys(DAYS).find((k) => DAYS[k] === n);
const hm = (t, def) => (t || def).split(':').map(Number);

function businessHours(targetUtc, d) {
  if (!d.business_hours_only) return targetUtc.toISOString();
  const t = new Date(targetUtc.getTime() - BRT);
  const [bsH, bsM] = hm(d.business_start, '08:00');
  const [beH, beM] = hm(d.business_end, '18:00');
  const days = d.business_days || ['MON', 'TUE', 'WED', 'THU', 'FRI'];
  if (!days.includes(dayName(t.getUTCDay()))) {
    for (let i = 1; i <= 7; i++) {
      const n = new Date(t); n.setUTCDate(n.getUTCDate() + i);
      if (days.includes(dayName(n.getUTCDay()))) { n.setUTCHours(bsH, bsM, 0, 0); return new Date(n.getTime() + BRT).toISOString(); }
    }
  }
  const h = t.getUTCHours();
  if (h < bsH || (h === bsH && t.getUTCMinutes() < bsM)) t.setUTCHours(bsH, bsM, 0, 0);
  else if (h > beH || (h === beH && t.getUTCMinutes() > beM)) { t.setUTCDate(t.getUTCDate() + 1); t.setUTCHours(bsH, bsM, 0, 0); }
  return new Date(t.getTime() + BRT).toISOString();
}

const UNIT_MS = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 };
function delayResumeAt(d) {
  const now = new Date();
  const nowBRT = new Date(now.getTime() - BRT);
  switch (d.delay_type) {
    case 'duration': return new Date(now.getTime() + (d.duration || 1) * (UNIT_MS[d.unit] || 3600000)).toISOString();
    case 'until_time': {
      const [h, m] = hm(d.time, '08:00');
      const t = new Date(nowBRT); t.setUTCHours(h, m, 0, 0);
      if (t.getTime() <= nowBRT.getTime()) t.setUTCDate(t.getUTCDate() + 1);
      return businessHours(new Date(t.getTime() + BRT), d);
    }
    case 'until_weekday': {
      const [h, m] = hm(d.time, '08:00');
      for (let i = 0; i <= 7; i++) {
        const c = new Date(nowBRT); c.setUTCDate(c.getUTCDate() + i);
        if (!(d.weekdays || []).includes(dayName(c.getUTCDay()))) continue;
        c.setUTCHours(h, m, 0, 0);
        if (c.getTime() > nowBRT.getTime()) return businessHours(new Date(c.getTime() + BRT), d);
      }
      return new Date(now.getTime() + 86400000).toISOString();
    }
    case 'until_date': return d.datetime || new Date(now.getTime() + 3600000).toISOString();
    default: return new Date(now.getTime() + 3600000).toISOString();
  }
}

module.exports = { fieldValue, convertDate, delayResumeAt };