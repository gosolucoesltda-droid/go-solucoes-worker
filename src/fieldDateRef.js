// ═══════════════════════════════════════════════════════════
// Chave única dos jobs "disparo por data do campo" (contact_field_date).
//
//   {flowId}_{contactId}_{fieldKey}_{AAAA-MM-DD}
//
// A data é SEMPRE a do valor do campo (nunca a data do disparo, nunca ISO completo),
// lida no próprio calendário do texto para não deslocar por fuso.
//
// Recorrência: a chave usa a data base projetada para o período da ocorrência.
//   none     → a própria data do campo
//   yearly   → ano da ocorrência + mês/dia do campo   (repeat_yearly do gatilho)
//   monthly  → ano/mês da ocorrência + dia do campo (limitado ao fim do mês)
//
// Espelho exato de base44/shared/fieldDateRef.ts — os dois rodam os mesmos casos
// de railway-worker/fieldDateRef.cases.json (ver fieldDateRef.test.js).
/* global module */
const TZ = 'America/Sao_Paulo';

const pad = (n) => String(n).padStart(2, '0');

function isRealDate(y, m, d) {
  if (!(y > 1900 && y < 2200) || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function brtParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Valor do campo → 'AAAA-MM-DD' (o dia escrito, sem deslocar por fuso) ou null. */
function normalizeFieldDate(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // DD/MM/AAAA (opcionalmente com hora)
  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) {
    const [, dd, mm, yyyy] = br;
    const y = Number(yyyy), m = Number(mm), d = Number(dd);
    return isRealDate(y, m, d) ? `${yyyy}-${mm}-${dd}` : null;
  }
  // AAAA-MM-DD (inclusive ISO: usa a data escrita, não converte fuso)
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return isRealDate(Number(y), Number(m), Number(d)) ? `${y}-${m}-${d}` : null;
  }
  // epoch (segundos ou milissegundos) → calendário de Brasília
  if (/^\d{10}$/.test(raw)) {
    const dt = new Date(Number(raw) * 1000);
    if (isNaN(dt.getTime())) return null;
    const p = brtParts(dt);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }
  if (/^\d{13}$/.test(raw)) {
    const dt = new Date(Number(raw));
    if (isNaN(dt.getTime())) return null;
    const p = brtParts(dt);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }
  return null;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Data que entra na chave: a do campo, projetada no período da ocorrência
 * quando o gatilho é recorrente.
 */
function occurrenceKeyDate({ fieldValue, repeat, occurrenceAt }) {
  const base = normalizeFieldDate(fieldValue);
  if (!base) return null;
  const mode = repeat === true ? 'yearly' : String(repeat || 'none');
  if (mode === 'none') return base;

  const occ = occurrenceAt ? (occurrenceAt instanceof Date ? occurrenceAt : new Date(occurrenceAt)) : null;
  if (!occ || isNaN(occ.getTime())) return base;

  const p = brtParts(occ);
  const monthDay = base.slice(5); // MM-DD
  if (mode === 'yearly') return `${p.year}-${monthDay}`;
  if (mode === 'monthly') {
    const day = Math.min(Number(base.slice(8, 10)), daysInMonth(p.year, p.month));
    return `${p.year}-${pad(p.month)}-${pad(day)}`;
  }
  return base;
}

/**
 * Chave do job. Retorna null quando não há data válida no valor do campo
 * (mesma regra de sempre: sem data válida, não cria job).
 */
function fieldDateRef({ flowId, contactId, fieldKey, fieldValue, repeat, occurrenceAt }) {
  if (!flowId || !contactId || !fieldKey) return null;
  const date = occurrenceKeyDate({ fieldValue, repeat, occurrenceAt });
  if (!date) return null;
  return `${flowId}_${contactId}_${fieldKey}_${date}`;
}

module.exports = { normalizeFieldDate, occurrenceKeyDate, fieldDateRef };