// ═══════════════════════════════════════════════════════════
// Fase 1 — Railway executa blocos de texto e botões direto na Meta.
// Percorre o fluxo a partir de um nó enquanto os blocos forem só texto
// (sem variáveis {{ }}). Para no primeiro bloco com botões de resposta
// (igual ao Base44). Devolve o que enviou para o Base44 só registrar e
// continuar o restante do fluxo.
// ═══════════════════════════════════════════════════════════
const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const WORKER_SECRET = process.env.WORKER_SECRET;
const CREDS_TTL_MS = 10 * 60 * 1000;
const credsCache = new Map();

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_]/g, '_');
const nextOf = (n) => n.next_node_id ?? n.data?.next_node_id ?? n.config?.next_node_id ?? null;

async function getCreds(companyId, connectionId) {
  const hit = credsCache.get(connectionId);
  if (hit && hit.exp > Date.now()) return hit.creds;
  const res = await fetch(`${APP_URL}/functions/workerTrigger`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'getSendCreds', company_id: companyId, context: { connection_id: connectionId } }),
  });
  const data = await res.json();
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
function contactVars(c = {}) {
  const nome = c.nome || '';
  const custom = Object.fromEntries(Object.entries(c.custom_fields || {}).map(([k, v]) => [k.toLowerCase(), v]));
  // Campos do contato têm prioridade (ex.: campo "Nome"); contact_name é sempre o nome principal
  return { nome, primeiro_nome: nome.split(' ')[0], email: c.email || '', empresa: c.empresa || '', telefone: c.telefone || '', ...custom, contact_name: nome, contact_phone: c.telefone || '', contact_id: c.id || '' };
}
const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const canRender = (s, vars) => [...String(s || '').matchAll(VAR_RE)].every((m) => m[1].toLowerCase() in vars);
const render = (s, vars) => String(s || '').replace(VAR_RE, (_, k) => String(vars[k.toLowerCase()] ?? ''));

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
  return !btns.some((b) => b.type === 'QUICK_REPLY') && tplParams(s).every((p) => canRender(p, vars)) && canRender(s.header_image_url, vars);
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
    (s.type === 'audio' && s.url && canRender(s.url, vars)) || (s.type === 'text' && canRender(s.content, vars) &&
    (s.buttons || []).every((b) => canRender(b.url, vars) && canRender(b.text, vars))));
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

// Salto "transferir" (mesma leitura do Base44): devolve o fluxo destino ou null
function jumpTarget(node) {
  if (node?.type !== 'flow_jump') return null;
  const d = node.data || node.config || {};
  const c = node.config || node.data || {};
  const target = d.target_flow_id || c.target_flow_id;
  return target && (d.mode === 'transfer' || c.mode === 'transfer') ? target : null;
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
    default: return undefined;
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

// Retorna null quando nada foi enviado (o Base44 faz tudo como antes)
async function runFast(flow, startNodeId, opts, depth = 0) {
  const { companyId, connectionId, phone, contact, loadFlow } = opts;
  const nodes = flow.nodes || [];
  const vars = contactVars({ telefone: phone, ...(contact || {}) });
  opts.vars = vars;
  let node = nodes.find((n) => n.id === startNodeId);
  opts.wait = opts.wait || { left: MAX_WAIT_MS };
  const executed = [];
  const messages = [];
  const delays = [];
  // Passa direto pelas condições e atrasos curtos (o Base44 reavalia as condições e pula o que já foi feito)
  const skipConditions = async () => {
    for (let i = 0; (node?.type === 'condition' || node?.type === 'delay') && i < 10; i++) {
      if (node.type === 'delay') {
        const ms = delayNodeMs(node);
        if (ms > opts.wait.left) return false;
        opts.wait.left -= ms;
        await sleep(ms);
        delays.push(node.id); executed.push(node.id);
        node = nodes.find((n) => n.id === nextOf(node));
        continue;
      }
      const nx = conditionNext(node, contact || {});
      if (nx === undefined) return false;
      node = nodes.find((n) => n.id === nx);
    }
    return node?.type !== 'condition' && node?.type !== 'delay';
  };
  if (!(await skipConditions())) return null;
  await prefetchTemplates(node, opts);
  // Salto logo no início: segue direto para o fluxo destino
  const target = jumpTarget(node);
  if (target && loadFlow && depth < 3) {
    const dest = await loadFlow(target);
    const sub = dest && await runFast(dest, firstNodeId(dest), opts, depth + 1);
    return sub ? { _executed_nodes: [], _railway_messages: [], _railway_stop_node: null, _railway_jump: { flow_id: target, ...sub } } : null;
  }
  if (!isSupported(node, vars, opts.wait.left)) {
    return delays.length ? { _executed_nodes: executed, _railway_messages: [], _railway_stop_node: null, _railway_delays: delays } : null;
  }
  const creds = await getCreds(companyId, connectionId);
  let stop = null;
  while (node && isSupported(node, vars, opts.wait.left) && executed.length < 15 && !stop) {
    for (const raw of (node.data || node.config).sub_blocks) {
      const wait = subWaitMs(raw);
      if (wait) { opts.wait.left -= wait; await sleep(wait); continue; }
      if (raw.type === 'template') { messages.push(await sendTemplate(creds, phone, raw, vars)); continue; }
      if (['image', 'audio', 'video', 'file'].includes(raw.type)) { messages.push(await sendMedia(creds, phone, raw, vars)); continue; }
      const sub = { ...raw, content: render(raw.content, vars), buttons: (raw.buttons || []).map((b) => ({ ...b, text: render(b.text, vars), url: b.url && render(b.url, vars) })) };
      const buttons = buildButtons(node, sub);
      const res = await fetch(`https://graph.facebook.com/v22.0/${creds.phone_number_id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.access_token}` },
        body: JSON.stringify(payloadFor(phone, sub.content || '', buttons)),
      });
      const data = await res.json();
      if (data.error) throw new Error(`Meta: ${data.error.message}`);
      messages.push({ body: sub.content || '', buttons, wa_id: data.messages?.[0]?.id || null, at: new Date().toISOString() });
      if (buttons.some((b) => b.type !== 'url')) { stop = node.id; break; }
    }
    executed.push(node.id);
    if (!stop) { node = nodes.find((n) => n.id === nextOf(node)); await skipConditions(); await prefetchTemplates(node, opts); }
  }
  const result = { _executed_nodes: executed, _railway_messages: messages, _railway_stop_node: stop, _railway_delays: delays };
  // Texto seguido de salto: já envia o começo do fluxo destino; o Base44 executa o salto e registra
  const target2 = !stop && jumpTarget(node);
  if (target2 && loadFlow && depth < 3) {
    const dest = await loadFlow(target2).catch(() => null);
    const sub = dest && await runFast(dest, firstNodeId(dest), opts, depth + 1).catch((e) => { console.error('[FAST] salto falhou:', e.message); return null; });
    if (sub) result._railway_jump = { flow_id: target2, ...sub };
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

module.exports = { runFast, firstNodeId, findClickedItem };