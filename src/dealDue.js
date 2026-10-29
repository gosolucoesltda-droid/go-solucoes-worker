// Vencimento do card criado pela ação "Mover no funil" (mesma regra do Base44: base44/shared/dealDue.ts).
// Origem: X dias após a criação (data de Brasília) ou uma variável em dd/mm/aaaa [HH:MM] ou aaaa-mm-dd [HH:MM].
/* global module */
function dealDue(a, render) {
  if (a.due_mode !== 'date' && a.due_mode !== 'datetime') return { due_date: null, due_time: null };
  let date = null;
  let time = null;
  if (a.due_source === 'variable') {
    const v = String(render(a.due_value || '')).trim();
    let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2}):(\d{2}))?/);
    if (m) date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    else if ((m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:\D+(\d{1,2}):(\d{2}))?/))) date = `${m[1]}-${m[2]}-${m[3]}`;
    if (m && m[4]) time = `${m[4].padStart(2, '0')}:${m[5]}`;
  } else {
    date = new Date(Date.now() - 3 * 3600000 + Number(a.due_days ?? 1) * 86400000).toISOString().slice(0, 10);
  }
  return { due_date: date, due_time: a.due_mode === 'datetime' && date ? (time || a.due_time || '09:00') : null };
}

module.exports = { dealDue };