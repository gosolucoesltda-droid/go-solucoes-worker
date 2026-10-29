// ═══════════════════════════════════════════════════════════
// Fase 1 — Railway executa blocos de texto e botões direto na Meta.
// Percorre o fluxo a partir de um nó enquanto os blocos forem só texto
// (sem variáveis {{ }}). Para no primeiro bloco com botões de resposta
// (igual ao Base44). Devolve o que enviou para o Base44 só registrar e
// continuar o restante do fluxo.
// ═══════════════════════════════════════════════════════════
const { needsFacts, loadFacts, evalFact, applyFactAction } = require('./crmFacts');
const { loadDealVars, usesDealVars } = require('./dealVars');
const { loadCreds } = require('./botSettings');
const { generateVoice } = require('./voiceAudio');
const { runSheetsBlock } = require('./googleSheets');
const { fieldValue, delayResumeAt } = require('./flowDates');
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const WORKER_SECRET = process.env.WORKER_SECRET;
const CREDS_TTL_MS = 10 * 60 * 1000;
const credsCache = new Map();

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_]/g, '_');
const nextOf = (n) => n.next_node_id ?? n.data?.next_node_id ?? n.config?.next_node_id ?? null;

async function getCreds(companyId, connectionId) {
  const hit = credsCache.get(connectionId);
  if (hit && hit.exp > Date.now()) return hit.creds;
  // Supabase primeiro; o Base44 só responde se a conexão ainda não foi copiada
  const data = await loadCreds(companyId, connectionId) || await (await fetch(`${APP_URL}/functions/workerTrigger`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'getSendCreds', company_id: companyId, context: { connection_id: connectionId } }),
  })).json();
  if (!data.ok) throw new Error(data.error || 'sem credenciais');
  credsCache.set(connectionId, { creds: data, exp: Date.now() + CREDS_TTL_MS });
  return data;
}

// Mesmos IDs de botão que o Base44 gera (o clique depois é resolvido por eles)
function buildButtons(node, sub) {
  const prefix = sanitize(node.id || 'n').slice(-20);
  return (sub.buttons || []).map((b, i) => ({
    id: sanitize(b.id ? `${prefix}_${b.id}` : `${prefix}_btn${i}`).slice(0, 256),
    text: b.text || `Botao ${i + 1}`,
    type: b.type || 'reply',
    url: b.url,
  }));
}

// Variáveis do contato que o Railway sabe preencher; qualquer outra → Base44 assume
// Mesma normalização do Base44 (sem acento, minúsculo)
const nk = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const prim = (v) => v !== null && v !== undefined && typeof v !== 'object';
const brNow = () => new Date(Date.now() - 3 * 3600000);
function saudacao() { const h = brNow().getUTCHours(); return h >= 5 && h < 12 ? 'Bom dia' : h < 18 && h >= 12 ? 'Boa tarde' : 'Boa noite'; }
// ctx = contexto da execução (variáveis do fluxo, respostas coletadas, última resposta…)
function contactVars(c = {}, ctx = {}) {
  const nome = c.nome || '';
  const custom = Object.fromEntries(Object.entries(c.custom_fields || {}).filter(([, v]) => prim(v)).map(([k, v]) => [nk(k), v]));
  const pad = (n) => String(n).padStart(2, '0');
  const d = brNow();
  const sys = {
    saudacao: saudacao(), data_hoje: `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`, hora_atual: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    ultima_resposta: ctx.last_reply ?? ctx.ultima_resposta ?? '', last_reply: ctx.last_reply ?? '', resposta: ctx.last_reply ?? '',
    opcao_selecionada: ctx.list_selected_title ?? ctx.button_selected_title ?? '',
  };
  // Variáveis do fluxo (mesma prioridade do Base44: variables → collected → contexto)
  const flow = {};
  for (const [i, src] of [ctx.variables || {}, ctx.collected || {}, ctx].entries()) {
    for (const [k, v] of Object.entries(src)) {
      if (!prim(v) || (i === 2 && (['nome', 'primeiro_nome'].includes(k.toLowerCase()) || k.startsWith('_')))) continue;
      if (!(nk(k) in flow)) flow[nk(k)] = v;
    }
  }
  // Campos do contato têm prioridade (ex.: campo "Nome"); contact_name/contact_phone ficam só para uso interno
  return { ...sys, nome, primeiro_nome: nome.split(' ')[0], email: c.email || '', empresa: c.empresa || '', telefone: c.telefone || '', phone: c.telefone || '', bsuid: c.bsuid || '', ...custom, ...flow, contact_name: nome, contact_phone: c.telefone || '', contact_id: c.id || '' };
}
const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const fmtDate = (v) => { const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v); };
// Variáveis antigas removidas: não são resolvidas (o fluxo segue pelo Base44, que as mantém como texto)
const REMOVED_VARS = new Set(['contact_name', 'contact_phone', 'contact_bsuid', 'contact_email', 'contact_empresa']);
const isRemoved = (k) => REMOVED_VARS.has(k) || k.startsWith('custom.') || k.startsWith('var.');
const canRender = (s, vars) => [...String(s || '').matchAll(VAR_RE)].every((m) => !isRemoved(nk(m[1])) && nk(m[1]) in vars);
const render = (s, vars) => String(s || '').replace(VAR_RE, (m, k) => isRemoved(nk(k)) ? m : fmtDate(vars[nk(k)] ?? ''));

// Atrasos curtos o Railway espera ele mesmo (limite total por execução); longos ficam com o Base44
const MAX_WAIT_MS = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const subWaitMs = (s) => s.type === 'delay' ? Math.min(Number(s.seconds || s.duration || 3), 55) * 1000
  : s.type === 'typing' ? Math.min(Number(s.seconds || 3), 30) * 1000 : 0;
const UNIT_MS = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 };
function delayNodeMs(node) {
  const d = node.data || node.config || {};
  if (d.delay_type !== 'duration') return Infinity;
  return (Number(d.duration) || 1) * (UNIT_MS[d.unit] || 3600000);
}

// Templates: definição aprovada lida da Meta (cache 10 min). Com botões de resposta → fica com o Base44 (ele pausa o fluxo)
const tplCache = new Map();
const tplParams = (s) => { const m = s.variables_mapping || s.variables || {}; return Object.keys(m).sort((a, b) => parseInt(a) - parseInt(b)).map((k) => m[k] || ''); };
async function loadTemplate(creds, name, lang) {
  const key = `${creds.waba_id}:${name}:${lang}`;
  const hit = tplCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.tpl;
  const res = await fetch(`https://graph.facebook.com/v22.0/${creds.waba_id}/message_templates?name=${encodeURIComponent(name)}&limit=50`, { headers: { Authorization: `Bearer ${creds.access_token}` } });
  const data = await res.json();
  const tpl = (data.data || []).find((t) => t.name === name && t.language === lang && t.status === 'APPROVED') || null;
  tplCache.set(key, { tpl, exp: Date.now() + CREDS_TTL_MS });
  return tpl;
}
async function prefetchTemplates(node, opts) {
  const subs = node?.type === 'message' ? ((node.data || node.config || {}).sub_blocks || []).filter((s) => s.type === 'template') : [];
  if (!subs.length) return;
  const creds = await getCreds(opts.companyId, opts.connectionId).catch(() => null);
  if (!creds?.waba_id) return;
  opts.vars.__waba = creds.waba_id;
  for (const s of subs) await loadTemplate(creds, s.template_name, s.template_language || 'pt_BR').catch(() => null);
}
function templateOk(s, vars) {
  const hit = tplCache.get(`${vars.__waba}:${s.template_name}:${s.template_language || 'pt_BR'}`);
  const tpl = hit && hit.exp > Date.now() ? hit.tpl : null;
  if (!tpl) return false;
  const btns = tpl.components?.find((c) => c.type === 'BUTTONS')?.buttons || [];
  return tplParams(s).every((p) => canRender(p, vars)) && canRender(s.header_image_url, vars);
}
async function sendTemplate(creds, to, s, vars) {
  const lang = s.template_language || 'pt_BR';
  const tpl = await loadTemplate(creds, s.template_name, lang);
  const params = tplParams(s).map((p) => render(p, vars));
  const components = [];
  if (s.header_image_url) components.push({ type: 'header', parameters: [{ type: 'image', image: { link: render(s.header_image_url, vars) } }] });
  if (params.length) components.push({ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) });
  const template = { name: s.template_name, language: { code: lang }, ...(components.length ? { components } : {}) };
  const data = await metaPost(creds, 'messages', { messaging_product: 'whatsapp', to, type: 'template', template });
  return { tipo: 'template', body: `[Template: ${s.template_name}]`, template_buttons: tpl?.components?.find((c) => c.type === 'BUTTONS')?.buttons || [], buttons: [], wa_id: data.messages?.[0]?.id || null, at: new Date().toISOString() };
}

function isSupported(node, vars, waitLeft = MAX_WAIT_MS) {
  if (!node || node.type !== 'message') return false;
  const subs = (node.data || node.config || {}).sub_blocks || [];
  if (!subs.length) return false;
  if (subs.some((s) => s.type === 'template' && !templateOk(s, vars))) return false;
  if (subs.reduce((t, s) => t + subWaitMs(s), 0) > waitLeft) return false;
  return subs.every((s) => s.type === 'delay' || s.type === 'typing' || s.type === 'template' ||
    ((s.type === 'image' || s.type === 'video') && s.url && canRender(s.url, vars) && canRender(s.caption, vars)) ||
    (s.type === 'file' && s.url && canRender(s.url, vars) && canRender(s.filename || s.display_name, vars)) ||
    (s.type === 'list' && listSections({ id: node.id }, s).length) ||
    (s.type === 'question' && String(s.question_text ?? s.question ?? '').trim() && canRender(s.question_text ?? s.question, vars)) ||
    (s.type === 'audio' && s.url && canRender(s.url, vars)) || (s.type === 'text' && canRender(s.content, vars) &&
    (s.buttons || []).every((b) => canRender(b.url, vars) && canRender(b.text, vars))));
}

// Menu de lista (mesmo formato e IDs do Base44); o clique segue pelo item escolhido
function listSections(node, sub) {
  const prefix = sanitize(node.id || 'n').slice(-20);
  const raw = sub.rows?.length ? sub.rows : (sub.sections || []);
  return raw.map((s, si) => ({
    title: ((s.title || '').trim() || `Seção ${si + 1}`).slice(0, 24),
    rows: (s.rows || s.items || []).filter((it) => it.title && it.id).map((it) => ({
      id: sanitize(`${prefix}_${it.id}`).slice(0, 200), title: it.title.slice(0, 24),
      ...(it.description ? { description: it.description.slice(0, 72) } : {}),
    })),
  })).filter((s) => s.rows.length);
}
async function sendList(creds, to, node, sub) {
  const sections = listSections(node, sub);
  const body = sub.body || 'Selecione uma opção';
  const button = sub.button_label || 'Ver opções';
  const interactive = { type: 'list', body: { text: body.slice(0, 4096) }, action: { button: button.slice(0, 20), sections } };
  if (sub.header) interactive.header = { type: 'text', text: sub.header.slice(0, 60) };
  if (sub.footer) interactive.footer = { text: sub.footer.slice(0, 60) };
  const data = await metaPost(creds, 'messages', { messaging_product: 'whatsapp', to, type: 'interactive', interactive });
  return { tipo: 'list', body, list: { header: sub.header || null, footer: sub.footer || null, button_label: button, sections }, buttons: [], wa_id: data.messages?.[0]?.id || null, at: new Date().toISOString() };
}

function payloadFor(to, text, buttons) {
  const reply = buttons.filter((b) => b.type !== 'url');
  const urls = buttons.filter((b) => b.type === 'url');
  if (urls.length && !reply.length) {
    return { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'cta_url', body: { text }, action: { name: 'cta_url', parameters: { display_text: urls[0].text.slice(0, 20), url: urls[0].url || '' } } } };
  }
  if (reply.length && reply.length <= 3) {
    return { messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text }, action: { buttons: reply.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.text.slice(0, 20) } })) } } };
  }
  return { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
}

// Imagem por link; áudio baixado e reenviado à Meta como mensagem de voz (igual ao Base44)
async function metaPost(creds, path, body, json = true) {
  const res = await fetch(`https://graph.facebook.com/v22.0/${creds.phone_number_id}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.access_token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(body) : body,
  });
  const data = await res.json();
  if (data.error) throw new Error(`Meta: ${data.error.message}`);
  return data;
}
async function sendMedia(creds, to, sub, vars) {
  const url = render(sub.url, vars);
  const at = () => new Date().toISOString();
  if (sub.type === 'image' || sub.type === 'video') {
    const caption = render(sub.caption, vars);
    const t = sub.type;
    const data = await metaPost(creds, 'messages', { messaging_product: 'whatsapp', to, type: t, [t]: caption ? { link: url, caption } : { link: url } });
    return { tipo: t, body: caption || (t === 'image' ? 'Imagem' : 'Video'), media_url: url, buttons: [], wa_id: data.messages?.[0]?.id || null, at: at() };
  }
  if (sub.type === 'file') {
    const filename = render(sub.filename || sub.display_name, vars);
    const data = await metaPost(creds, 'messages', { messaging_product: 'whatsapp', to, type: 'document', document: filename ? { link: url, filename } : { link: url } });
    return { tipo: 'document', body: 'Arquivo', media_url: url, file_name: filename || null, buttons: [], wa_id: data.messages?.[0]?.id || null, at: at() };
  }
  const file = await fetch(url);
  if (!file.ok) throw new Error(`áudio HTTP ${file.status}`);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([await file.arrayBuffer()], { type: 'audio/ogg' }), 'audio.ogg');
  const up = await metaPost(creds, 'media', form, false);
  const data = await metaPost(creds, 'messages', { messaging_product: 'whatsapp', to, type: 'audio', audio: { id: up.id, voice: true } });
  return { tipo: 'audio', body: 'Áudio', audio_media_id: up.id, buttons: [], wa_id: data.messages?.[0]?.id || null, at: at() };
}

// Salto (mesma leitura do Base44), nos dois modos: o Railway envia o começo do fluxo destino.
// "transferir" encerra este fluxo; "chamar" o Base44 continua este fluxo depois do salto.
function jumpTarget(node) {
  if (node?.type !== 'flow_jump') return null;
  const d = node.data || node.config || {};
  const c = node.config || node.data || {};
  return d.target_flow_id || c.target_flow_id || null;
}

// Condição (mesma regra do Base44): devolve o próximo nó, ou undefined se o Railway não sabe avaliar
function compareText(actual, op, value) {
  const a = String(actual || '').toLowerCase();
  const v = String(value || '').toLowerCase();
  switch (op) {
    case 'equals': return a === v;
    case 'not_equals': return a !== v;
    case 'contains': return a.includes(v);
    case 'not_contains': return !a.includes(v);
    case 'starts_with': return a.startsWith(v);
    case 'ends_with': return a.endsWith(v);
    case 'empty': case 'is_empty': return !actual;
    case 'not_empty': case 'is_not_empty': return !!actual;
    default: return undefined;
  }
}
function evalFilter(f, c) {
  let field = f.field || '';
  if (!field && f.field_type === 'tag') field = 'tag';
  if (!field && f.field_type === 'custom') field = 'custom_field';
  const { operator: op, value } = f;
  switch (field) {
    case 'current_time': {
      // Horário de Brasília (UTC-3), mesma regra do Base44
      const now = new Date();
      const nowMins = ((now.getUTCHours() - 3 + 24) % 24) * 60 + now.getUTCMinutes();
      const toMins = (t) => { const [h, m] = (t || '00:00').split(':').map(Number); return h * 60 + m; };
      if (op === 'between') return nowMins >= toMins(f.value_from) && nowMins <= toMins(f.value_to);
      return op === 'before' ? nowMins < toMins(value) : nowMins > toMins(value);
    }
    case 'current_weekday': {
      const DAYS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
      const today = new Date(Date.now() - 3 * 3600000).getUTCDay();
      const matches = (Array.isArray(value) ? value : [value]).some((v) => DAYS[v] === today);
      return op === 'is' ? matches : !matches;
    }
    case 'tag': { const tags = c.tags || []; return op === 'has_tag' || op === 'is' ? tags.includes(value) : !tags.includes(value); }
    case 'nome': case 'contact_name': return compareText(c.nome, op, value);
    case 'email': case 'contact_email': return compareText(c.email, op, value);
    case 'telefone': case 'contact_phone': return compareText(c.telefone, op, value);
    case 'empresa': case 'contact_empresa': return compareText(c.empresa, op, value);
    case 'custom_field': {
      const v = (c.custom_fields || {})[f.field_key || f.key || f.field];
      if (['empty', 'is_empty', 'not_empty', 'is_not_empty'].includes(op)) {
        const isEmpty = !v || String(v).trim() === '';
        return op === 'empty' || op === 'is_empty' ? isEmpty : !isEmpty;
      }
      if (['gt', 'lt', 'gte', 'lte'].includes(op)) {
        const a = Number(v), b = Number(value);
        return op === 'gt' ? a > b : op === 'lt' ? a < b : op === 'gte' ? a >= b : a <= b;
      }
      return compareText(v, op, value);
    }
    default: return evalFact(field, f, c._facts);
  }
}
function evalAll(filters, combine, c) {
  if (!filters?.length) return false;
  const rs = filters.map((f) => evalFilter(f, c));
  if (rs.includes(undefined)) return undefined;
  return combine === 'OR' ? rs.some(Boolean) : rs.every(Boolean);
}
function conditionNext(node, c) {
  const d = node.data || node.config || {};
  const noMatch = d.no_match_next || node.next_node_false_id || d.next_node_false_id || null;
  if ((d.groups || []).length) {
    for (const g of d.groups) {
      const r = evalAll(g.conditions || g.filters || [], g.combine || 'AND', c);
      if (r === undefined) return undefined;
      if (r) return g.next_node_id ?? null;
    }
    return noMatch;
  }
  const r = evalAll(d.filters || [], d.combine || 'AND', c);
  if (r === undefined) return undefined;
  return r ? nextOf(node) : noMatch;
}

// Ação: o Base44 grava (tags, campos, tarefas, funil); o Railway só passa por ela e segue enviando.
// false = ação que interrompe o fluxo (fica com o Base44); 'dirty' = efeito que o Railway não prevê
const PASS_TYPES = ['condition', 'delay', 'random', 'action', 'api_request', 'elevenlabs_audio', 'google_sheets'];
const PASS_ACTIONS = ['add_tag', 'remove_tag', 'set_variable', 'clear_variable', 'set_status', 'move_funnel', 'create_task', 'add_note', 'create_appointment', 'assign_attendant', 'appointment_status'];
// notices: avisos do histórico (mesmos que o Base44 registra), gravados na hora pelo Railway
function applyActions(node, sim, vars, notices = []) {
  const actions = (node.data || node.config || {}).actions || [];
  let dirty = false;
  for (const a of actions) {
    if (!PASS_ACTIONS.includes(a.type)) return false;
    // Ação que muda funil/tarefas: aplica nos dados lidos (agendamentos: as condições seguintes ficam com o Base44)
    applyFactAction(sim._facts, a);
    if (a.type === 'add_tag') {
      const added = (a.tags || []).filter((t, i, all) => !sim.tags.includes(t) && all.indexOf(t) === i);
      sim.tags.push(...added);
      if (added.length) notices.push(['tag_added', added.join(', '), { tags: added }]);
    }
    if (a.type === 'remove_tag') {
      const removed = sim.tags.filter((t) => (a.tags || []).includes(t));
      sim.tags = sim.tags.filter((t) => !(a.tags || []).includes(t));
      if (removed.length) notices.push(['tag_removed', removed.join(', '), { tags: removed }]);
    }
    if (a.type === 'set_variable' && a.field_key) {
      const old = sim.custom_fields[a.field_key] ?? null;
      const known = (a.operation === 'set' && canRender(a.value, vars)) || a.operation === 'clear';
      if (!known) dirty = true;
      else {
        sim.custom_fields[a.field_key] = a.operation === 'set' ? render(a.value, vars) : '';
        notices.push(['field_updated', a.field_key, { field: a.field_key, old_value: old, new_value: sim.custom_fields[a.field_key] }]);
      }
    }
    if (a.type === 'clear_variable') dirty = true;
  }
  return dirty ? 'dirty' : true;
}

// Retomada de atraso: o Railway calcula tudo que a ação faz (mesma regra do flowNodeAction.ts do Base44)
// e guarda em opts.records / sim; o flowOwner grava quando assume. false = fica com o Base44 (nada muda)
async function applyActionsOwn(node, sim, vars, notices, opts) {
  const actions = (node.data || node.config || {}).actions || [];
  const ctx = opts.context || {};
  const texts = (a) => a.type === 'set_variable' && a.operation === 'set' ? [a.value] : a.type === 'add_note' ? [a.content]
    : a.type === 'create_task' || a.type === 'create_appointment' ? [a.title, a.description] : a.type === 'move_funnel' ? [a.deal_title_template, String(a.value ?? '')] : [];
  if (!actions.every((a) => PASS_ACTIONS.includes(a.type) && texts(a).every((t) => canRender(t, vars)))) return false;
  // Valores dos campos antes de mexer em qualquer coisa (se o tipo do campo não puder ser lido, o Base44 assume)
  const col = { ...(ctx.collected || {}), ...opts.collected };
  const vals = [];
  try {
    for (const a of actions) {
      if (a.type !== 'set_variable' || !a.field_key) { vals.push(null); continue; }
      const op = a.operation;
      const raw = op === 'set' ? render(a.value || '', vars) : op === 'last_reply' ? (ctx.last_reply || '') : op === 'variable' ? (ctx.variables?.[a.source_var] || '')
        : op === 'increment' ? String(Number(col[a.field_key] || 0) + Number(a.value || 1)) : '';
      const v = await fieldValue(opts.companyId, a.field_key, raw);
      vals.push({ v, old: col[a.field_key] ?? null });
      col[a.field_key] = v;
    }
  } catch (e) {
    console.error('[FAST] tipo do campo indisponível (Base44 assume):', e.message);
    return false;
  }
  const at = new Date().toISOString();
  actions.forEach((a, i) => {
    applyFactAction(sim._facts, a);
    if (a.type === 'add_tag') {
      const added = (a.tags || []).filter((t, j, all) => !sim.tags.includes(t) && all.indexOf(t) === j);
      sim.tags.push(...added);
      if (added.length) notices.push(['tag_added', added.join(', '), { tags: added }]);
    } else if (a.type === 'remove_tag') {
      const removed = sim.tags.filter((t) => (a.tags || []).includes(t));
      sim.tags = sim.tags.filter((t) => !(a.tags || []).includes(t));
      if (removed.length) notices.push(['tag_removed', removed.join(', '), { tags: removed }]);
    } else if (a.type === 'set_variable' && vals[i]) {
      const { v, old } = vals[i];
      sim.custom_fields[a.field_key] = v; opts.collected[a.field_key] = v; opts.sources[a.field_key] = 'flow';
      vars[nk(a.field_key)] = v; vars[`custom.${nk(a.field_key)}`] = v;
      notices.push(['field_updated', a.field_key, { field: a.field_key, old_value: old, new_value: v }]);
    } else if (a.type === 'clear_variable' && a.field_key) {
      delete sim.custom_fields[a.field_key]; delete opts.collected[a.field_key];
      delete vars[nk(a.field_key)]; delete vars[`custom.${nk(a.field_key)}`];
    } else if (a.type === 'set_status') {
      sim.custom_fields.attendance_status = a.status;
    } else if (a.type === 'assign_attendant') {
      if ((a.mode || 'specific') === 'remove') { sim.assigned_to = null; sim.observacoes = ''; } else sim.assigned_to = a.user_id || a.assigned_to || '';
    } else if (a.type === 'move_funnel') {
      const title = render(a.deal_title_template || 'Negocio - {{nome}}', { ...vars, nome: sim.nome || vars.contact_phone });
      opts.records.push({ type: 'move_funnel', stage_id: a.stage_id, pipeline_id: a.pipeline_id, create_if_missing: !!a.create_if_missing, value: render(String(a.value ?? ''), vars), title });
    } else if (a.type === 'create_task') {
      let due = a.due_date || null;
      if (a.due_date_type === 'relative' || (!a.due_date_type && a.due_date_days != null)) due = new Date(Date.now() + Number(a.due_date_days ?? 1) * 86400000).toISOString().slice(0, 10);
      opts.records.push({ type: 'create_task', title: render(a.title || 'Nova tarefa', vars), description: render(a.description || '', vars), responsible: a.responsible || '', due_date: due, priority: a.priority || 'Baixa' });
    } else if (a.type === 'add_note') {
      opts.records.push({ type: 'add_note', content: render(a.content || '', vars), at });
    } else if (a.type === 'create_appointment') {
      const [h, m] = (a.time || '09:00').split(':').map(Number);
      const start = a.date_type === 'fixed' && a.date ? new Date(`${a.date}T00:00:00Z`) : new Date(Date.now() + Number(a.date_days ?? 1) * 86400000);
      start.setUTCHours(h || 9, m || 0, 0, 0);
      const end = new Date(start.getTime() + Number(a.duration_minutes || 60) * 60000);
      opts.records.push({ type: 'create_appointment', title: render(a.title || 'Agendamento', vars), description: render(a.description || '', vars), start: start.toISOString(), end: end.toISOString(), assigned_to: a.assigned_to || '' });
    }
  });
  return true;
}

const jumpMode = (n) => (n.data || {}).mode === 'transfer' || (n.config || {}).mode === 'transfer' ? 'transfer' : 'call';

// Requisição de API (mesma montagem do Base44). O Base44 reaproveita a resposta para mapear e salvar campos.
// false = usa variável que o Railway não conhece (fica com o Base44)
async function runApi(node, vars) {
  const cfg = { ...(node.config || {}), ...(node.data || {}) };
  if (!cfg.url) return false;
  const method = cfg.method || 'POST';
  const bodyType = cfg.body_type || 'json';
  const parts = [cfg.url, ...(cfg.headers || []).map((h) => h.value), ...(cfg.params || []).map((p) => p.value),
    ...(method === 'GET' || method === 'DELETE' ? [] : bodyType === 'json' ? [cfg.body_json] : bodyType === 'form' ? (cfg.body_form || []).map((f) => f.value) : [cfg.body_raw])];
  if (!parts.every((p) => canRender(p, vars))) return false;
  let url = render(cfg.url, vars);
  const headers = {};
  for (const h of cfg.headers || []) { const k = (h.key || '').trim(); if (/^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/.test(k)) headers[k] = render(h.value, vars); }
  const hasCT = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  const opts = { method, headers, signal: AbortSignal.timeout(20000) };
  if (method === 'GET' || method === 'DELETE') {
    const qp = new URLSearchParams();
    for (const p of cfg.params || []) if (p.key) qp.set(p.key, render(p.value, vars));
    const qs = qp.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  } else if (bodyType === 'json') { if (!hasCT) headers['Content-Type'] = 'application/json'; opts.body = render(cfg.body_json || '{}', vars); }
  else if (bodyType === 'form') {
    const fd = new URLSearchParams();
    for (const f of cfg.body_form || []) if (f.key) fd.set(f.key, render(f.value, vars));
    opts.body = fd.toString(); if (!hasCT) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else opts.body = render(cfg.body_raw || '', vars);
  const nextErr = node.next_node_error_id ?? node.data?.next_node_error_id ?? null;
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    let stable = true; const mapped = {};
    for (const m of cfg.response_mapping || []) {
      if (!m.response_path || !m.field_key) continue;
      let v = json;
      for (const k of m.response_path.split('.')) v = v && typeof v === 'object' ? v[k] : undefined;
      if (v === undefined) continue;
      if (/^\d{10,13}$/.test(String(v))) stable = false; // pode virar data no Base44
      vars[nk(m.field_key)] = String(v); mapped[m.field_key] = String(v);
    }
    if (cfg.save_status_to) vars[nk(cfg.save_status_to)] = String(res.status);
    // "at": horário da requisição, para o aviso de campo atualizado ficar na posição certa da conversa
    return { mapped, saved: { ok: res.ok, status: res.status, text, at: new Date().toISOString() }, next: res.ok ? nextOf(node) : nextErr, stable: stable && (res.ok || !!nextErr) };
  } catch (e) {
    return { saved: { error: e.message }, next: nextErr, stable: false };
  }
}

// Voz do ElevenLabs (bloco fora do agente): o Railway gera, guarda o áudio e registra o uso
// (reserva: o Base44); o link vai em {{audio_response}} e segue enviando. null = fica com o Base44
async function runVoice(node, vars, opts, flowId) {
  const cfg = node.data || node.config || {};
  if (!opts.fresh || !opts.windowOpen || !canRender(cfg.text || '', vars)) return null;
  const text = render(cfg.text || '', vars);
  if (!text.trim() || text.length > 5000) return null;
  const custom = cfg.use_default_settings === false;
  // Railway gera sozinho (chave no Supabase); o Base44 só entra se faltar configuração ou falhar
  const own = await generateVoice({ companyId: opts.companyId, text, cfg, flowId, nodeId: node.id, contactId: opts.contact?.id, phone: opts.phone });
  if (own) return own;
  try {
    const res = await fetch(`${APP_URL}/functions/workerTrigger`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'elevenLabsAudio', company_id: opts.companyId, context: {
        text, voice_id: cfg.voice_id || undefined, model_id: cfg.model_id || undefined, output_format: cfg.output_format || 'opus_48000_64',
        stability: custom ? cfg.stability : undefined, similarity_boost: custom ? cfg.similarity_boost : undefined,
        style: custom ? cfg.style : undefined, use_speaker_boost: custom ? cfg.use_speaker_boost : undefined,
        flow_id: flowId, flow_block_id: node.id, contact_id: opts.contact?.id, contact_phone: opts.phone, input_text: cfg.text || '',
      } }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    return data.ok && data.audio_url ? data.audio_url : null;
  } catch (e) {
    console.error('[FAST] voz falhou (Base44 assume):', e.message);
    return null;
  }
}

// Google Planilhas: o Base44 faz a operação (as chaves do Google ficam com ele) e o Railway segue
// com o resultado. null = fica com o Base44
async function runSheets(node, vars, opts, flow) {
  const cfg = { ...(node.config || {}), ...(node.data || {}) };
  if (!opts.fresh || !cfg.integration_id || !cfg.spreadsheet_id || !cfg.sheet_name) return null;
  const cols = (list) => (list || []).filter((c) => c.key);
  // Só os campos que a operação escolhida usa (as outras abas podem ter sobras)
  const op = cfg.operation || 'insert';
  const used = op === 'insert' ? [...cols(cfg.columns), ...(cfg.contact_mappings || [])]
    : op === 'update' ? [...cols(cfg.columns), ...cols(cfg.update_columns), ...(cfg.contact_mappings || [])] : [];
  const parts = used.map((c) => c.value).concat(op === 'insert' ? [] : [cfg.search_column, cfg.search_value]);
  if (!parts.every((p) => canRender(p, vars))) return null;
  const map = (list) => Object.fromEntries(cols(list).map((c) => [c.key, render(c.value, vars)]));
  const context = {
    integration_id: cfg.integration_id, spreadsheet_id: cfg.spreadsheet_id, spreadsheet_name: cfg.spreadsheet_name || '',
    sheet_name: cfg.sheet_name, operation: cfg.operation || 'insert', mappings: map(cfg.columns), columns_to_update: map(cfg.update_columns),
    search_column: render(cfg.search_column, vars), search_value: render(cfg.search_value, vars),
    variable_mappings: (cfg.read_mappings || []).filter((m) => m.column && m.var_name).map((m) => ({ spreadsheet_column: m.column, crm_field: m.var_name })),
    on_not_found: cfg.create_if_not_found ? 'create' : undefined,
    flow_id: flow.base44_id, flow_name: flow.name, flow_block_id: node.id, contact_phone: opts.phone,
  };
  // Railway executa sozinho (chave do Google no Supabase); o Base44 só entra se faltar configuração
  const own = await runSheetsBlock(opts.companyId, context);
  if (own) return own;
  try {
    const res = await fetch(`${APP_URL}/functions/workerTrigger`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'googleSheets', company_id: opts.companyId, context }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.ok === 'boolean' ? data : null;
  } catch (e) {
    console.error('[FAST] planilha falhou (Base44 assume):', e.message);
    return null;
  }
}
// Mesmo efeito que o Base44 aplica depois da planilha (para as mensagens seguintes)
// opts.collected / opts.sources: o que o Base44 guarda no contexto (usados quando o Railway assume a execução)
function applySheets(node, r, vars, sim, opts = {}) {
  const cfg = { ...(node.config || {}), ...(node.data || {}) };
  const col = opts.collected || {};
  const src = opts.sources || {};
  const set = (k, v) => {
    vars[nk(k)] = v;
    if (['nome', 'email', 'empresa', 'telefone'].includes(k)) sim[k] = v; else { sim.custom_fields[k] = v; col[k] = v; src[k] = 'sheets'; }
    if (k === 'nome') { vars.contact_name = v; vars.primeiro_nome = String(v).split(' ')[0]; }
  };
  if (cfg.operation === 'insert' || cfg.operation === 'update') {
    for (const m of cfg.contact_mappings || []) if (m.field) set(m.field, render(m.value, vars));
  }
  if (cfg.operation === 'read') {
    const found = (r.rows_affected || 0) > 0;
    if (cfg.save_results_to) { vars[nk(cfg.save_results_to)] = found ? 'found' : 'not_found'; col[cfg.save_results_to] = found ? 'found' : 'not_found'; }
    const row = r.data?.data || r.data || {};
    for (const m of cfg.read_mappings || []) {
      if (!m.var_name) continue;
      const v = row[m.column] ?? '';
      col[m.var_name] = v;
      if (found) set(m.var_name, v); else vars[nk(m.var_name)] = v;
    }
  }
}

// Aleatório (mesma regra do Base44): sorteio por porcentagem
function pickRandom(vs) {
  if (!vs.length) return null;
  const total = vs.reduce((s, v) => s + (v.percentage || 0), 0);
  if (!total) return vs[Math.floor(Math.random() * vs.length)];
  let r = Math.random() * total;
  for (const v of vs) { r -= v.percentage || 0; if (r <= 0) return v; }
  return vs[vs.length - 1];
}

// Retorna null quando nada foi enviado (o Base44 faz tudo como antes)
async function runFast(flow, startNodeId, opts, depth = 0) {
  const { companyId, connectionId, phone, contact, loadFlow } = opts;
  const nodes = flow.nodes || [];
  const vars = contactVars({ telefone: phone, ...(contact || {}) }, opts.context || {});
  // Variáveis do negócio ({{deal_nome}}, {{deal_stage}}…) em qualquer gatilho, inclusive manual
  if (opts.dealVars === undefined && usesDealVars(flow)) {
    opts.dealVars = await loadDealVars(null, { dealId: opts.context?.deal_id, companyId, connectionId, phone });
  }
  if (opts.dealVars) Object.assign(vars, opts.dealVars);
  opts.vars = vars;
  let node = nodes.find((n) => n.id === startNodeId);
  opts.wait = opts.wait || { left: MAX_WAIT_MS };
  // Horário em que este fluxo começou (avisos "Fluxo iniciado"/"Fluxo transferido" ficam antes de tudo dele)
  const startedAt = new Date().toISOString();
  // Histórico em tempo real: aviso de início (fluxo novo ou destino de salto) antes de tudo dele
  const live = opts.live || null;
  const notice = async (type, content, metadata) => { if (live) await live.notice(type, content, metadata); };
  if (depth > 0 || opts.started) {
    await notice('flow_started', flow.name || '', { flow_id: flow.base44_id, source: opts.manual ? 'manual' : 'automation', trigger_type: flow.trigger_type || null });
  }
  const executed = [];
  const messages = [];
  const push = async (m) => { messages.push(m); if (live) await live.message(m); };
  const delays = [];
  // Passa direto pelas condições e atrasos curtos (o Base44 reavalia as condições e pula o que já foi feito)
  opts.random = opts.random || {};
  // Cópia do contato com os efeitos das ações já percorridas (para as condições seguintes)
  const sim = { ...(contact || {}), tags: [...((contact || {}).tags || [])], custom_fields: { ...((contact || {}).custom_fields || {}) } };
  // Funil, tarefas e agendamentos: só lê quando o fluxo tem condição sobre eles
  if (!opts.facts && needsFacts(nodes)) opts.facts = await loadFacts(companyId, phone);
  sim._facts = opts.facts || null;
  let dirty = false;
  // Retomada de atraso (opts.apply): o Railway também passa por ações, API, planilha, salto e atraso longo.
  // Ele só simula aqui; o flowOwner grava os efeitos quando assume a execução (senão o Base44 faz tudo como antes)
  opts.records = opts.records || [];
  opts.sources = opts.sources || {};
  opts.collected = opts.collected || {};
  opts.sim = sim;
  let longDelay = null;  // atraso longo alcançado: a execução volta a esperar
  let handoff = false;   // resposta que o Base44 trata (erro de API/planilha): ele segue daqui
  const passed = [];     // ações, API e planilhas percorridas (registro de blocos no painel)
  const meta = (extra) => ({ applied: !!opts.apply, handoff, delay: longDelay, sim: opts.sim, records: opts.records, sources: opts.sources, collected: opts.collected, passed, ...extra });
  // Não enumerável: não vai junto no contexto enviado ao Base44
  const withMeta = (r, extra) => { if (r) Object.defineProperty(r, '_meta', { value: meta(extra), enumerable: false }); return r; };
  const skipConditions = async () => {
    for (let i = 0; PASS_TYPES.includes(node?.type) && i < 15; i++) {
      if (node.type === 'elevenlabs_audio') {
        const url = depth === 0 ? await runVoice(node, vars, opts, flow.base44_id) : null;
        if (!url) return false;
        vars[nk('audio_response')] = url; opts.audio = url;
        executed.push(node.id);
        node = nodes.find((n) => n.id === nextOf(node));
        continue;
      }
      if (node.type === 'google_sheets') {
        const r = depth === 0 ? await runSheets(node, vars, opts, flow) : null;
        if (!r) return false;
        opts.sheets[node.id] = r;
        // Falha na planilha: o Base44 segue daqui com o resultado salvo
        if (!r.ok) { handoff = true; node = null; return true; }
        applySheets(node, r, vars, sim, opts);
        // Leitura muda campos que as condições seguintes usam: elas ficam com o Base44 (na retomada o Railway já sabe os valores)
        if ((node.data || node.config || {}).operation === 'read' && !opts.apply) dirty = true;
        passed.push(node.id);
        node = nodes.find((n) => n.id === nextOf(node));
        continue;
      }
      if (node.type === 'api_request') {
        const r = await runApi(node, vars);
        if (!r) return false;
        opts.api[node.id] = r.saved;
        if (opts.apply) {
          // Mesma conversão de datas do Base44 (o Railway grava os campos depois)
          const cfg = { ...(node.config || {}), ...(node.data || {}) };
          try {
            for (const [k, v] of Object.entries(r.mapped || {})) {
              const cv = String(await fieldValue(companyId, k, v));
              r.mapped[k] = cv; vars[nk(k)] = cv; vars[`custom.${nk(k)}`] = cv; opts.collected[k] = cv; opts.sources[k] = 'api';
            }
          } catch (e) {
            console.error('[FAST] tipo do campo indisponível (Base44 assume):', e.message);
            handoff = true; node = null; return true;
          }
          if (cfg.save_status_to && r.saved.status) opts.collected[cfg.save_status_to] = String(r.saved.status);
        }
        // Campos que mudaram (valores que podem virar data ficam para o Base44 registrar)
        for (const [k, v] of Object.entries(r.mapped || {})) {
          const old = sim.custom_fields[k];
          if ((!opts.apply && /^\d{10,13}$/.test(v)) || String(old ?? '') === v) continue;
          await notice('field_updated', k, { field: k, old_value: old ?? null, new_value: v });
        }
        Object.assign(sim.custom_fields, r.mapped || {});
        if (opts.apply) {
          // Falha de conexão ou erro sem saída de erro: o Base44 segue daqui com a resposta salva
          if (r.saved.error || (!r.saved.ok && !r.next)) { handoff = true; node = null; return true; }
          passed.push(node.id);
          node = r.next ? nodes.find((n) => n.id === r.next) : null;
          continue;
        }
        // Resposta que o Base44 pode tratar diferente: ele segue daqui com a resposta salva
        if (!r.stable || !r.next) { handoff = true; node = null; return true; }
        node = nodes.find((n) => n.id === r.next);
        continue;
      }
      if (node.type === 'action') {
        const notices = [];
        const r = opts.apply ? await applyActionsOwn(node, sim, vars, notices, opts) : applyActions(node, sim, vars, notices);
        if (r === false) return false;
        if (r === 'dirty') dirty = true;
        for (const n of notices) await notice(...n);
        opts.actionAt[node.id] = new Date().toISOString();
        passed.push(node.id);
        node = nodes.find((n) => n.id === nextOf(node));
        continue;
      }
      if (node.type === 'random') {
        const v = pickRandom((node.data || node.config || {}).variations || []);
        if (!v?.next_node_id) return false;
        opts.random[node.id] = v.next_node_id;
        node = nodes.find((n) => n.id === v.next_node_id);
        continue;
      }
      if (node.type === 'delay') {
        const ms = delayNodeMs(node);
        if (ms > opts.wait.left) {
          if (!opts.apply) return false;
          // Atraso longo: a execução volta a esperar (o Railway retoma de novo na hora certa)
          longDelay = { node_id: node.id, resume_at: delayResumeAt(node.data || node.config || {}), next: nextOf(node) };
          node = null; return true;
        }
        opts.wait.left -= ms;
        await sleep(ms);
        delays.push(node.id); executed.push(node.id);
        node = nodes.find((n) => n.id === nextOf(node));
        continue;
      }
      if (dirty) return false;
      const nx = conditionNext(node, sim);
      if (nx === undefined) return false;
      node = nodes.find((n) => n.id === nx);
    }
    return !PASS_TYPES.includes(node?.type);
  };
  opts.api = opts.api || {};
  opts.sheets = opts.sheets || {};
  opts.actionAt = opts.actionAt || {};
  // Áudio gerado: o Base44 recebe o link em {{audio_response}}
  const voiceVars = () => opts.audio ? { variables: { ...((opts.context || {}).variables || {}), audio_response: opts.audio } } : {};
  const partial = () => (executed.length || Object.keys(opts.api).length || Object.keys(opts.sheets).length || opts.apply)
    ? withMeta({ _executed_nodes: executed, _railway_messages: [], _railway_stop_node: null, _railway_delays: delays, _railway_random: opts.random, _railway_api: opts.api, _railway_sheets: opts.sheets, _railway_action_at: opts.actionAt, _railway_started_at: startedAt, ...voiceVars() }, { ended: false, stopSub: null }) : null;
  // Resultado completo (fim do fluxo, parada num botão/lista/pergunta ou atraso longo)
  const finish = (stop) => withMeta({ _executed_nodes: executed, _railway_messages: messages, _railway_stop_node: stop, _railway_delays: delays, _railway_random: opts.random, _railway_api: opts.api, _railway_sheets: opts.sheets, _railway_action_at: opts.actionAt, _railway_started_at: startedAt, ...(opts.question ? { _railway_question_node: opts.question } : {}), ...voiceVars() },
    { ended: !stop && !node && !longDelay, stopSub: stop ? opts.stopSub || null : null });
  if (!(await skipConditions())) return partial();
  await prefetchTemplates(node, opts);
  // Salto logo no início: segue direto para o fluxo destino
  const target = jumpTarget(node);
  if (target && loadFlow && depth < 3) {
    const jumpNode = node;
    const dest = await loadFlow(target);
    const sub = dest && await runFast(dest, firstNodeId(dest), Object.assign(opts, { contact: sim }), depth + 1);
    if (!sub) return partial();
    // Mantém o que já passou antes do salto (atrasos, áudio, API) para o Base44 não repetir
    // Ações percorridas antes do salto não entram em "executed": o horário delas vai junto
    // para o Base44 registrar o aviso na posição certa da conversa (antes das mensagens do destino)
    const base = { ...(partial() || { _executed_nodes: [], _railway_messages: [], _railway_stop_node: null }), _railway_action_at: opts.actionAt, _railway_started_at: startedAt };
    return withMeta({ ...base, _railway_jump: { flow_id: target, ...sub } }, { ended: false, stopSub: null, jump: { node_id: jumpNode.id, mode: jumpMode(jumpNode), flow: dest, fast: sub } });
  }
  if (!isSupported(node, vars, opts.wait.left)) {
    // Retomada: nada mais a enviar (fim do fluxo depois de ações/API, ou atraso longo) — o Railway conclui
    return !node && !handoff && opts.apply ? finish(null) : partial();
  }
  const creds = await getCreds(companyId, connectionId);
  let stop = null;
  while (node && isSupported(node, vars, opts.wait.left) && executed.length < 15 && !stop) {
    for (const raw of (node.data || node.config).sub_blocks) {
      const wait = subWaitMs(raw);
      if (wait) { opts.wait.left -= wait; await sleep(wait); continue; }
      if (raw.type === 'template') {
        const m = await sendTemplate(creds, phone, raw, vars);
        await push(m);
        // Botões de resposta: para aqui; o clique segue pelo botão do template
        // ("Próximo Passo" conectado: segue já, os botões continuam clicáveis — mesma regra do Base44)
        const goOn = !!nextOf(node) && (raw.template_buttons || []).length > 0;
        if (!goOn && m.template_buttons.some((b) => b.type === 'QUICK_REPLY')) { stop = node.id; opts.stopSub = raw; break; }
        continue;
      }
      if (raw.type === 'list') { await push(await sendList(creds, phone, node, raw)); stop = node.id; opts.stopSub = raw; break; }
      if (raw.type === 'question') {
        // Pergunta: envia o texto e para; o Base44 registra a espera pela resposta
        const text = render(raw.question_text ?? raw.question, vars);
        const data = await metaPost(creds, 'messages', payloadFor(phone, text, []));
        await push({ body: text, buttons: [], wa_id: data.messages?.[0]?.id || null, at: new Date().toISOString() });
        stop = node.id; opts.question = node.id; opts.stopSub = raw; break;
      }
      if (['image', 'audio', 'video', 'file'].includes(raw.type)) { await push(await sendMedia(creds, phone, raw, vars)); continue; }
      const sub = { ...raw, content: render(raw.content, vars), buttons: (raw.buttons || []).map((b) => ({ ...b, text: render(b.text, vars), url: b.url && render(b.url, vars) })) };
      const buttons = buildButtons(node, sub);
      const res = await fetch(`https://graph.facebook.com/v22.0/${creds.phone_number_id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.access_token}` },
        body: JSON.stringify(payloadFor(phone, sub.content || '', buttons)),
      });
      const data = await res.json();
      if (data.error) throw new Error(`Meta: ${data.error.message}`);
      await push({ body: sub.content || '', buttons, wa_id: data.messages?.[0]?.id || null, at: new Date().toISOString() });
      if (buttons.some((b) => b.type !== 'url')) { stop = node.id; opts.stopSub = raw; break; }
    }
    executed.push(node.id);
    if (!stop) { node = nodes.find((n) => n.id === nextOf(node)); await skipConditions(); await prefetchTemplates(node, opts); }
  }
  // _meta diz ao Railway se terminou o caminho sozinho (fim do fluxo, parada num botão/lista/pergunta, atraso longo)
  const result = finish(stop);
  // Texto seguido de salto: já envia o começo do fluxo destino; o Base44 executa o salto e registra
  const target2 = !stop && jumpTarget(node);
  if (target2 && loadFlow && depth < 3) {
    const jumpNode = node;
    const dest = await loadFlow(target2).catch(() => null);
    const sub = dest && await runFast(dest, firstNodeId(dest), Object.assign(opts, { contact: sim }), depth + 1).catch((e) => { console.error('[FAST] salto falhou:', e.message); return null; });
    if (sub) {
      result._railway_jump = { flow_id: target2, ...sub };
      Object.assign(result._meta, { jump: { node_id: jumpNode.id, mode: jumpMode(jumpNode), flow: dest, fast: sub }, sim: opts.sim });
    }
  }
  return result;
}

function firstNodeId(flow) {
  const nodes = flow.nodes || [];
  const trig = nodes.find((n) => n.type === 'trigger');
  const t = trig && nextOf(trig);
  if (t && nodes.some((n) => n.id === t)) return t;
  return (nodes.find((n) => n.type !== 'trigger') || nodes[0])?.id || null;
}

function findClickedItem(flows, itemId) {
  if (!itemId) return null;
  for (const flow of flows) {
    for (const node of flow.nodes || []) {
      if (node.type !== 'message') continue;
      const prefix = sanitize(node.id || 'n').slice(-20);
      for (const sub of (node.data || node.config || {}).sub_blocks || []) {
        const bs = sub.buttons || [];
        for (let i = 0; i < bs.length; i++) {
          const raw = bs[i].id ? `${prefix}_${bs[i].id}` : `${prefix}_btn${i}`;
          if (sanitize(raw).slice(0, 256) === itemId && bs[i].next_node_id) return { flow, next_node_id: bs[i].next_node_id };
        }
        for (const s of [...(sub.rows || []), ...(sub.sections || [])]) {
          for (const item of s.rows || s.items || []) {
            if (item?.id && sanitize(`${prefix}_${item.id}`).slice(0, 200) === itemId && item.next_node_id) return { flow, next_node_id: item.next_node_id };
          }
        }
      }
    }
  }
  return null;
}

module.exports = { runFast, firstNodeId, findClickedItem, getCreds, metaPost, payloadFor };