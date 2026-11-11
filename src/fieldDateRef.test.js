// Roda os casos únicos (fieldDateRef.cases.json) nas DUAS implementações:
//   railway-worker/fieldDateRef.js   (CommonJS, worker)
//   base44/shared/fieldDateRef.ts    (ESM/Deno, funções Base44)
// As duas precisam produzir exatamente o esperado em todos os casos.
//
//   node railway-worker/fieldDateRef.test.js
/* global module, require, __dirname */
const fs = require('fs');
const os = require('os');
const path = require('path');

const local = require('./fieldDateRef');

// O .ts é JS puro com "export" — basta remover a palavra para carregar em CommonJS.
function loadTsModule() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'base44', 'shared', 'fieldDateRef.ts'), 'utf8');
  const body = src.replace(/^export\s+/gm, '');
  const tmp = path.join(os.tmpdir(), `fieldDateRef.${process.pid}.cjs`);
  fs.writeFileSync(tmp, `${body}\nmodule.exports = { normalizeFieldDate, occurrenceKeyDate, fieldDateRef };\n`);
  const mod = require(tmp);
  fs.unlinkSync(tmp);
  return mod;
}

function run(name, mod, casos) {
  const falhas = [];
  for (const caso of casos) {
    const got = mod.fieldDateRef(caso.entrada);
    if (got !== caso.esperado) {
      falhas.push({ caso: caso.nome, esperado: caso.esperado, obtido: got });
    }
  }
  return { implementacao: name, casos: casos.length, falhas: falhas.length, detalhes: falhas };
}

function main() {
  const { casos } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fieldDateRef.cases.json'), 'utf8'));
  const resultados = [run('railway-worker/fieldDateRef.js', local, casos), run('base44/shared/fieldDateRef.ts', loadTsModule(), casos)];
  const ok = resultados.every((r) => r.falhas === 0);
  for (const r of resultados) {
    console.log(`${r.falhas === 0 ? 'OK  ' : 'FALHA'} ${r.implementacao}: ${r.casos - r.falhas}/${r.casos} casos`);
    for (const d of r.detalhes) console.log(`   - ${d.caso}: esperado ${JSON.stringify(d.esperado)}, obtido ${JSON.stringify(d.obtido)}`);
  }
  // Paridade: as duas implementações precisam concordar em tudo (inclusive nos nulls).
  const divergentes = casos.filter((c) => local.fieldDateRef(c.entrada) !== loadTsModule().fieldDateRef(c.entrada));
  console.log(`${divergentes.length === 0 ? 'OK  ' : 'FALHA'} paridade entre as duas implementações${divergentes.length ? `: ${divergentes.length} divergência(s)` : ''}`);
  if (!ok || divergentes.length) process.exit(1);
}

main();