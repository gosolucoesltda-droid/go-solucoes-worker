// ═══════════════════════════════════════════════════════════
// API pública (Make, Zapier, integrações) servida direto pelo Railway com os dados do Supabase.
// Mesmas rotas e respostas de https://gocrm.pro/functions/<nome> — basta trocar o endereço.
// Gravar campos usa o Base44 (datas, agendamentos e gatilhos); fluxos de tag também.
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');

const newId = () => crypto.randomBytes(12).toString('hex');
const digits = (v) => String(v || '').replace(/\D/g, '');
const parseJson = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return undefined; } };
const SCOPE = `company_id = $1 and ($2::text is null or connection_id = $2)`;

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-API-Token, Authorization' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return parseJson(raw || '{}') || {};
}

function getToken(req, url, body) {
  const auth = String(req.headers.authorization || '').trim();
  if (auth.startsWith('Bearer ') && auth.slice(7).trim().startsWith('gs_live_')) return auth.slice(7).trim();
  return String(req.headers['x-api-token'] || url.searchParams.get('api_token') || body.api_token || '').trim();
}

// Token do bot primeiro, depois o token da empresa (legado)
async function resolveToken(pool, token) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const { rows: [bot] } = await pool.query(
    `select w.id, co.id as company_id, co.name, co.status from crm_whatsapp_connections w join companies co on co.id = w.company_id where w.api_token_hash = $1 limit 1`, [hash]);
  if (bot) return { company: { id: bot.company_id, name: bot.name, status: bot.status }, connId: bot.id };
  const { rows: [co] } = await pool.query(`select id, name, status from companies where api_token_hash = $1 limit 1`, [hash]);
  return { company: co || null, connId: null };
}

async function findContact(pool, company, connId, { contact_id, contact_phone }) {
  const cols = `id, connection_id, telefone, tags`;
  if (contact_id) return (await pool.query(`select ${cols} from crm_contacts where ${SCOPE} and id = $3 limit 1`, [company.id, connId, contact_id])).rows[0] || null;
  const raw = digits(contact_phone);
  const variants = [raw];
  if (raw.startsWith('55') && raw.length > 12) variants.push(raw.slice(2));
  if (!raw.startsWith('55')) variants.push('55' + raw);
  return (await pool.query(`select ${cols} from crm_contacts where ${SCOPE} and telefone = any($3) limit 1`, [company.id, connId, variants])).rows[0] || null;
}

async function getContactByPhone({ pool, body, company, connId }) {
  if (!body.contact_phone) return [400, { error: 'contact_phone é obrigatório' }];
  const { rows: [c] } = await pool.query(`select * from crm_contacts where ${SCOPE} and telefone = $3 limit 1`, [company.id, connId, digits(body.contact_phone)]);
  if (!c) return [200, { ok: true, found: false, message: 'Contato não encontrado', contact_phone: body.contact_phone }];
  return [200, {
    ok: true, found: true, contact_id: c.id, nome: c.nome, telefone: c.telefone, phone: c.telefone, email: c.email, empresa: c.empresa,
    tags: c.tags || [], custom_fields: c.custom_fields || {}, observacoes: c.observacoes, ultima_mensagem: c.ultima_mensagem,
    ultima_mensagem_em: c.ultima_mensagem_em, conversation_status: c.conversation_status, assigned_to: c.assigned_to, created_date: c.created_at,
  }];
}

// Chave comparada sem maiúsculas, acentos e separadores (- _ espaço); valor exato sem maiúsculas
async function getContactByField({ pool, body, company, connId }) {
  const { field_key, field_value } = body;
  if (!field_key) return [400, { error: 'field_key é obrigatório (chave do campo personalizado)' }];
  if (field_value === undefined || field_value === null) return [400, { error: 'field_value é obrigatório (valor a buscar)' }];
  const norm = (k) => String(k).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-_\s]/g, '');
  const { rows } = await pool.query(
    `select c.*, k.key as matched_key from crm_contacts c
     cross join lateral (
       select kv.key from jsonb_each_text(case when jsonb_typeof(c.custom_fields) = 'object' then c.custom_fields else '{}'::jsonb end) kv
       where regexp_replace(translate(lower(kv.key), 'áàâãäåéèêëíìîïóòôõöúùûüçñ', 'aaaaaaeeeeiiiiooooouuuucn'), '[-_\\s]', '', 'g') = $3
         and lower(btrim(kv.value)) = $4 limit 1) k
     where c.${SCOPE.replace('connection_id', 'c.connection_id')}
     order by c.ultima_mensagem_em desc nulls last limit 200`,
    [company.id, connId, norm(field_key), String(field_value).trim().toLowerCase()]);
  const f = rows[0];
  return [200, {
    ok: true, bot_id: connId || f?.connection_id || null, field_key: f?.matched_key || field_key, field_value, total: rows.length,
    contact_id: f?.id || null, nome: f?.nome || null, telefone: f?.telefone || null, phone: f?.telefone || null,
    email: f?.email || null, empresa: f?.empresa || null, tags: f?.tags || [], custom_fields: f?.custom_fields || {},
  }];
}

async function listContactsByTag({ pool, body, company, connId }) {
  if (!body.tag) return [400, { error: 'tag é obrigatória' }];
  const conn = connId || (body.connection_id && body.connection_id !== 'all' ? body.connection_id : null);
  const { rows } = await pool.query(
    `select id, nome, telefone, email, empresa, tags, custom_fields, ultima_mensagem_em from crm_contacts
     where ${SCOPE} and exists (select 1 from unnest(tags) t where lower(btrim(t)) = $3)
     order by ultima_mensagem_em desc nulls last`, [company.id, conn, String(body.tag).toLowerCase().trim()]);
  const contacts = rows.map((c) => ({ ...c, phone: c.telefone, tags: c.tags || [], custom_fields: c.custom_fields || {} }));
  return [200, { ok: true, tag: body.tag, total: contacts.length, contacts }];
}

async function setContactTags({ pool, body, company, connId, callBase44Function }) {
  const tags = parseJson(body.tags);
  if (!Array.isArray(tags)) return [400, { error: 'tags deve ser um array' }];
  if (!body.contact_id && !body.contact_phone) return [400, { error: 'contact_id ou contact_phone é obrigatório' }];
  const c = await findContact(pool, company, connId, body);
  if (!c) return [404, { error: 'Contato não encontrado' }];
  const phone = digits(c.telefone);
  const old = c.tags || [];
  await pool.query(`update crm_contacts set tags = $2, updated_at = now() where id = $1`, [c.id, tags]);
  if (tags.length) {
    await pool.query(
      `insert into crm_activities (id, company_id, connection_id, contact_phone, type, content, metadata, created_by, created_at) values ($1,$2,$3,$4,'tag_added',$5,$6,'API',now())`,
      [newId(), company.id, c.connection_id, phone, tags.join(', '), JSON.stringify({ tags })]).catch((e) => console.error('[API] atividade de tag:', e.message));
  }
  const added = tags.filter((t) => !old.includes(t));
  const removed = old.filter((t) => !tags.includes(t));
  if (added.length || removed.length) {
    callBase44Function('workerTrigger', { action: 'apiTagsChanged', company_id: company.id, contact_phone: phone, context: { added, removed } })
      .catch((e) => console.error('[API] fluxos de tag:', e.message));
  }
  return [200, { ok: true, contact_id: c.id, tags }];
}

async function setContactFields({ pool, body, company, connId, callBase44Function }) {
  const fields = parseJson(body.custom_fields || body.fields);
  if (!fields || typeof fields !== 'object') return [400, { error: 'custom_fields é obrigatório (objeto chave/valor)' }];
  if (!body.contact_id && !body.contact_phone) return [400, { error: 'contact_id ou contact_phone é obrigatório' }];
  const c = await findContact(pool, company, connId, body);
  if (!c) return [404, { error: body.contact_id ? 'Contato não encontrado ou não pertence a este bot' : `Contato não encontrado com o telefone ${body.contact_phone} na empresa ${company.name}` }];
  const r = await callBase44Function('workerTrigger', { action: 'apiSetFields', company_id: company.id, context: { contact_id: c.id, custom_fields: fields } });
  if (!r?.ok) return [500, { error: r?.error || 'Falha ao salvar os campos' }];
  return [200, { ok: true, contact_id: c.id, custom_fields: r.custom_fields }];
}

// Coloca o fluxo na fila do próprio Railway (responde na hora, sem esperar o fluxo rodar)
async function triggerFlow({ pool, body, company, connId }) {
  const { flow_id, contact_phone, contact_id } = body;
  if (!flow_id) return [400, { error: 'flow_id é obrigatório' }];
  if (!contact_phone && !contact_id) return [400, { error: 'contact_phone ou contact_id é obrigatório' }];
  const { rows: [flow] } = await pool.query(`select status, connection_id from flows where base44_id = $1 and company_id = $2 limit 1`, [flow_id, company.id]);
  if (!flow) return [404, { error: 'Fluxo não encontrado ou não pertence à sua empresa' }];
  if (flow.status !== 'active') return [400, { error: 'Fluxo não está ativo. Publique o fluxo antes de dispará-lo.' }];
  let phone = digits(contact_phone);
  let contactConn = null;
  if (contact_id) {
    const { rows: [c] } = await pool.query(`select telefone, connection_id from crm_contacts where id = $1 and company_id = $2 limit 1`, [contact_id, company.id]);
    if (!c) return [404, { error: 'Contato não encontrado' }];
    phone = digits(c.telefone);
    contactConn = c.connection_id || null;
    if (!phone) return [400, { error: 'Contato sem telefone cadastrado' }];
  }
  if (connId && flow.connection_id && connId !== flow.connection_id) return [403, { error: 'O fluxo não pertence ao bot vinculado a este token.' }];
  const conn = flow.connection_id || connId || contactConn;
  if (!conn) return [400, { error: 'Fluxo sem bot vinculado (connection_id). Vincule o fluxo a um bot antes de dispará-lo.' }];
  const context = { source: 'external_api', variables: parseJson(body.variables) || {}, connection_id: conn, whatsapp_window_open: true, _skip_filters: true };
  const { rows: [job] } = await pool.query(
    `insert into scheduled_jobs (company_id, job_type, flow_base44_id, contact_phone, scheduled_for, reference_id, reference_type, context, status, attempts, max_attempts)
     values ($1, 'flow_trigger', $2, $3, now(), $4, 'api', $5, 'pending', 0, 3) returning id`,
    [company.id, flow_id, phone, `api_${flow_id}_${phone}_${Date.now()}`, JSON.stringify(context)]);
  return [200, { ok: true, queued: true, job_id: job.id, flow_id, contact_phone: phone }];
}

const ROUTES = { getContactByPhone, getContactByField, listContactsByTag, setContactTags, setContactFields, triggerFlow };

async function handlePublicApi(req, res, url, pool, callBase44Function) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const name = url.pathname.split('/').pop();
  const route = ROUTES[name];
  if (!route) return send(res, 404, { error: 'Rota não encontrada' });
  try {
    if (!pool) return send(res, 503, { error: 'Serviço indisponível, tente novamente em instantes' });
    const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
    const token = getToken(req, url, body);
    if (!token) return send(res, 401, { error: 'Token não fornecido. Use X-API-Token, Authorization: Bearer ou api_token no body/query.' });
    const { company, connId } = await resolveToken(pool, token);
    if (!company) return send(res, 401, { error: 'Token inválido. Gere um novo token na página de API do painel.' });
    if (company.status !== 'active') return send(res, 403, { error: 'Empresa inativa ou suspensa' });
    if (body.company_id && body.company_id !== company.id) return send(res, 403, { error: 'company_id não corresponde ao token' });
    const [status, data] = await route({ pool, body, company, connId, callBase44Function });
    return send(res, status, data);
  } catch (e) {
    console.error(`[API] ${name} erro:`, e.message);
    return send(res, 500, { error: e.message });
  }
}

module.exports = { handlePublicApi };