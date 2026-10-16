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
  return { nome, primeiro_nome: nome.split(' ')[0], email: c.email || '', empresa: c.empresa || '', telefone: c.telefone || '', ...custom, contact_name: nome, contact_phone: c.telefone || '' };
}
const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const canRender = (s, vars) => [...String(s || '').matchAll(VAR_RE)].every((m) => m[1].toLowerCase() in vars);
const render = (s, vars) => String(s || '').replace(VAR_RE, (_, k) => String(vars[k.toLowerCase()] ?? ''));

function isSupported(node, vars) {
  if (!node || node.type !== 'message') return false;
  const subs = (node.data || node.config || {}).sub_blocks || [];
  if (!subs.length) return false;
  return subs.every((s) => s.type === 'text' && canRender(s.content, vars) &&
    (s.buttons || []).every((b) => canRender(b.url, vars) && canRender(b.text, vars)));
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

// Retorna null quando o primeiro nó não é suportado (o Base44 faz tudo como antes)
async function runFast(flow, startNodeId, { companyId, connectionId, phone, contact }) {
  const nodes = flow.nodes || [];
  const vars = contactVars({ telefone: phone, ...(contact || {}) });
  let node = nodes.find((n) => n.id === startNodeId);
  if (!isSupported(node, vars)) return null;
  const creds = await getCreds(companyId, connectionId);
  const executed = [];
  const messages = [];
  let stop = null;
  while (node && isSupported(node, vars) && executed.length < 10 && !stop) {
    for (const raw of (node.data || node.config).sub_blocks) {
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
    if (!stop) node = nodes.find((n) => n.id === nextOf(node));
  }
  return { _executed_nodes: executed, _railway_messages: messages, _railway_stop_node: stop };
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