// Normalização de texto usada pelos filtros/condições do fluxo.
// Ignora maiúsculas/minúsculas e espaços extras: "Mensal - 2 Telas" == "mensal - 2 telas".
// Mesma regra no Base44 (base44/shared/textNorm.ts) — mantenha as duas iguais.
const normText = (v) => String(v ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

module.exports = { normText };