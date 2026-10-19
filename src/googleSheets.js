// Bloco de planilha executado no próprio Railway (mesma regra do Base44: googleSheetsApi → execute_block).
// O token do Google é renovado aqui com a chave lacrada copiada para o Supabase.
// null = falta configuração ou a renovação falhou: quem chama pede ao Base44 como antes.
const crypto = require('crypto');
const { unseal } = require('./seal');
const { settingsPool } = require('./botSettings');

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const tokens = new Map();

async function accessToken(pool, companyId, integrationId) {
  const hit = tokens.get(integrationId);
  if (hit && hit.exp > Date.now()) return hit.token;
  const { rows: [g] } = await pool.query(
    `select client_id, client_secret_sealed, refresh_token_sealed from crm_google_integrations
     where id = $1 and company_id = $2 and is_active and not needs_reconnect`, [integrationId, companyId]);
  if (!g?.client_id || !g.client_secret_sealed || !g.refresh_token_sealed) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: g.client_id, client_secret: await unseal(g.client_secret_sealed),
      refresh_token: await unseal(g.refresh_token_sealed), grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    // O Base44 tenta de novo e marca a conexão para reconectar no painel
    console.error('[SHEETS] renovação do token falhou:', data?.error);
    await pool.query(`update crm_google_integrations set needs_reconnect = true where id = $1`, [integrationId]);
    return null;
  }
  tokens.set(integrationId, { token: data.access_token, exp: Date.now() + (data.expires_in - 300) * 1000 });
  return data.access_token;
}

function col(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); }
  return s;
}

async function api(token, path, method = 'GET', body) {
  const res = await fetch(`${SHEETS}/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Sheets API error: ${res.status}`);
  return data;
}

const range = (sheet, r) => encodeURIComponent(`${sheet}!${r}`);
const headersOf = async (t, id, sheet) => (await api(t, `${id}/values/${range(sheet, '1:1')}`)).values?.[0] || [];
const append = (t, id, sheet, values) => api(t, `${id}/values/${range(sheet, 'A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, 'POST', { values: [values] });
const updateRow = (t, id, sheet, row, values) => api(t, `${id}/values/${range(sheet, `A${row}:${col(values.length)}${row}`)}?valueInputOption=USER_ENTERED`, 'PUT', { values: [values] });

async function findRows(t, id, sheet, column, value) {
  const headers = await headersOf(t, id, sheet);
  const idx = headers.indexOf(column);
  if (idx === -1) throw new Error(`Coluna "${column}" não encontrada`);
  const rows = (await api(t, `${id}/values/${range(sheet, `A:${col(Math.max(headers.length, 26))}`)}`)).values || [];
  const want = String(value ?? '').trim();
  const matches = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][idx] ?? '').trim() === want) matches.push({ rowNumber: i + 1, data: Object.fromEntries(headers.map((h, j) => [h, rows[i][j] || ''])) });
  }
  return { matches, headers };
}

async function operate(t, p) {
  const { operation: op, spreadsheet_id: id, sheet_name: sheet, mappings, columns_to_update: upd, on_not_found: notFound, multiple_matches: multi } = p;
  if (op === 'insert') {
    const headers = await headersOf(t, id, sheet);
    return { rows_affected: 1, data: await append(t, id, sheet, headers.map((c) => mappings?.[c] || '')) };
  }
  const { matches, headers } = await findRows(t, id, sheet, p.search_column, p.search_value || '');
  if (op === 'update') {
    if (!matches.length) {
      if (notFound === 'create') {
        await append(t, id, sheet, headers.map((c) => (upd && upd[c] !== undefined && upd[c] !== '' ? upd[c] : mappings?.[c] || '')));
        return { rows_affected: 1, data: { upserted: true } };
      }
      if (notFound === 'fail') throw new Error('Linha não encontrada');
      return { rows_affected: 0, data: null };
    }
    const rows = multi === 'all' ? matches : [matches[0]];
    for (const m of rows) await updateRow(t, id, sheet, m.rowNumber, headers.map((c) => (upd && upd[c] !== undefined ? upd[c] : m.data[c])));
    return { rows_affected: rows.length, data: rows };
  }
  if (op === 'read') {
    if (!matches.length) {
      if (notFound === 'fail') throw new Error('Dados não encontrados');
      return { rows_affected: 0, data: null, variable_values: {} };
    }
    const row = multi === 'last' ? matches[matches.length - 1] : multi === 'all' ? matches : matches[0];
    const values = {};
    for (const m of p.variable_mappings || []) {
      const v = row.data?.[m.spreadsheet_column];
      if (v !== undefined) values[m.crm_field] = v;
    }
    return { rows_affected: 1, data: row, variable_values: values };
  }
  throw new Error('Operação inválida');
}

async function runSheetsBlock(companyId, p) {
  const pool = settingsPool();
  if (!pool) return null;
  const t = await accessToken(pool, companyId, p.integration_id).catch((e) => { console.error('[SHEETS] token:', e.message); return null; });
  if (!t) return null;
  const t0 = Date.now();
  let result;
  try {
    result = { ok: true, ...(await operate(t, p)) };
    await pool.query(
      `update crm_google_integrations set last_used_at = now(),
         usage_count_month = case when usage_month = to_char(now(), 'YYYY-MM') then usage_count_month + 1 else 1 end,
         usage_month = to_char(now(), 'YYYY-MM') where id = $1`, [p.integration_id]);
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  await pool.query(
    `insert into crm_google_sheets_logs (id, integration_id, company_id, flow_id, flow_name, flow_block_id, contact_phone, operation, spreadsheet_id, spreadsheet_name, sheet_name, rows_affected, input_data, output_data, status, error, response_time_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [crypto.randomUUID(), p.integration_id, companyId, p.flow_id || null, p.flow_name || null, p.flow_block_id || null, p.contact_phone || null, p.operation,
      p.spreadsheet_id, p.spreadsheet_name || '', p.sheet_name, result.rows_affected || 0,
      JSON.stringify({ mappings: p.mappings, search_column: p.search_column, search_value: p.search_value, columns_to_update: p.columns_to_update }),
      JSON.stringify(result.data || {}), result.ok ? 'success' : 'error', result.error || null, Date.now() - t0]
  ).catch((e) => console.error('[SHEETS] registro falhou:', e.message));
  console.log(`[SHEETS] ${p.operation} pelo Railway ${result.ok ? 'ok' : 'falhou'} em ${Date.now() - t0}ms`);
  return result;
}

module.exports = { runSheetsBlock };