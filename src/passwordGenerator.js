// Gerador de senhas público (sem token) — mesma regra e respostas da função generatePassword do Base44.
const crypto = require('crypto');

const SETS = { maiusculas: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', minusculas: 'abcdefghijklmnopqrstuvwxyz', numeros: '0123456789', especiais: '!@#$%&*()-_=+[]{}' };
const randomInt = (max) => crypto.randomInt(max);

function gerarSenha(tamanho, ativos, extras, excluidos) {
  const excl = new Set(excluidos || '');
  const sets = ativos.map((k) => [...SETS[k]].filter((c) => !excl.has(c)).join('')).filter(Boolean);
  const pool = sets.join('');
  if (!pool) throw new Error('Todos os caracteres disponíveis foram excluídos.');
  // Um caractere de cada conjunto garantido, o resto do pool inteiro, depois embaralha
  const arr = sets.map((s) => s[randomInt(s.length)]);
  while (arr.length < tamanho) arr.push(pool[randomInt(pool.length)]);
  for (let i = arr.length - 1; i > 0; i--) { const j = randomInt(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return formatarExtras(extras, ativos, excl) + arr.join('');
}

// Prefixo segue as mesmas regras (maiúsculas/minúsculas/números/especiais/excluídos), sem embaralhar
function formatarExtras(extras, ativos, excl) {
  const on = (k) => ativos.includes(k);
  let s = extras ? String(extras) : '';
  if (on('maiusculas') && !on('minusculas')) s = s.toUpperCase();
  if (on('minusculas') && !on('maiusculas')) s = s.toLowerCase();
  return [...s].filter((c) => {
    if (excl.has(c)) return false;
    if (/\p{L}/u.test(c)) return on('maiusculas') || on('minusculas');
    if (/\p{N}/u.test(c)) return on('numeros');
    return on('especiais');
  }).join('');
}

function generatePassword(raw) {
  let body;
  try { body = JSON.parse(raw || '{}'); } catch {
    return [400, { ok: false, error: 'Body JSON inválido. Separe os campos com vírgulas, escreva true/false sem aspas e coloque textos entre aspas duplas.' }];
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [400, { ok: false, error: 'O body deve ser um objeto JSON com os parâmetros da senha.' }];
  for (const campo of Object.keys(SETS)) {
    if (body[campo] !== undefined && typeof body[campo] !== 'boolean') return [400, { ok: false, error: `O campo ${campo} deve ser true ou false, sem aspas.` }];
  }
  const tamanho = Math.min(Math.max(Number(body.tamanho) || 16, 1), 128);
  const quantidade = Math.min(Math.max(Number(body.quantidade) || 1, 1), 100);
  const ativos = Object.keys(SETS).filter((k) => body[k] !== false);
  if (!ativos.length) return [400, { ok: false, error: 'Habilite pelo menos um conjunto de caracteres.' }];
  if (tamanho < ativos.length) return [400, { ok: false, error: `O tamanho deve ser no mínimo ${ativos.length} para incluir todos os conjuntos habilitados.` }];
  const resultado = {};
  try {
    for (let i = 0; i < quantidade; i++) resultado[`password${i + 1}`] = gerarSenha(tamanho, ativos, body.caracteres_extras, body.caracteres_excluidos);
  } catch (e) {
    return [400, { ok: false, error: e.message }];
  }
  return [200, resultado];
}

module.exports = { generatePassword };