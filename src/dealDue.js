// Vencimento do card criado pela ação "Mover no funil" (mesma regra do Base44: base44/shared/dealDue.ts).
// Data/hora mapeada de uma variável (dd/mm/aaaa [HH:MM] ou aaaa-mm-dd [HH:MM]) — ou a data de criação
// (Brasília) se vazia — somada à correção em dias.
/* global module */
function dealDue(a, render) {
  if (a.due_mode !== 'date' && a.due_mode !== 'datetime') return { due_date: null, due_time: null };
  const v = String(render(a.due_value || '')).trim();
  let base = null;
  let time = null;
  let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2}):(\d{2}))?/);
  if (m) base = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  else if ((m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:\D+(\d{1,2}):(\d{2}))?/))) base = `${m[1]}-${m[2]}-${m[3]}`;
  if (m && m[4]) time = `${m[4].padStart(2, '0')}:${m[5]}`;
  if (v && !base) return { due_date: null, due_time: null }; // variável sem data válida
  if (!base) base = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const date = new Date(new Date(`${base}T12:00:00Z`).getTime() + (Number(a.due_days) || 0) * 86400000).toISOString().slice(0, 10);
  return { due_date: date, due_time: a.due_mode === 'datetime' ? (time || a.due_time || '09:00') : null };
}

module.exports = { dealDue };