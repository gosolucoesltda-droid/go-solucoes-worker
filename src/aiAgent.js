// ═══════════════════════════════════════════════════════════
// Agente de IA no Railway (mesma lógica do aiAgent/processMessage do Base44, modo fluxo).
// Faz transcrição, visão, OpenAI, voz (ElevenLabs), botão e envio direto pela Meta.
// O Base44 só registra (mensagens e logs) com o que vem em _record.
// ═══════════════════════════════════════════════════════════
const { buildSystemPrompt, matchByLabel } = require('./aiPrompt');
const { getCreds, metaPost, payloadFor, runFast } = require('./fastPath');
const { recordFast } = require('./supabaseRecorder');
const { loadAiBundle } = require('./botSettings');

const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const WORKER_SECRET = process.env.WORKER_SECRET;
const BUNDLE_TTL_MS = 5 * 60 * 1000;
const bundles = new Map();

async function getBundle(companyId) {
  const hit = bundles.get(companyId);
  if (hit && hit.exp > Date.now()) return hit.data;
  // Supabase primeiro; o Base44 só responde se a configuração ainda não foi copiada
  const data = await loadAiBundle(companyId) || await (await fetch(`${APP_URL}/functions/workerTrigger`, {
    method: 'POST', headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'getAiBundle', company_id: companyId }),
  })).json();
  if (!data.ok) throw new Error(data.error || 'sem agente');
  bundles.set(companyId, { data, exp: Date.now() + BUNDLE_TTL_MS });
  return data;
}

const supportsVision = (m) => /4o|4-turbo|vision|gpt-5|o1|o3|o4/.test((m || '').toLowerCase());
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const textOf = (c) => Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : String(c);

async function downloadMedia(creds, mediaId) {
  const meta = await (await fetch(`https://graph.facebook.com/v22.0/${mediaId}`, { headers: { Authorization: `Bearer ${creds.access_token}` } })).json();
  if (!meta.url) throw new Error('Meta não retornou URL da mídia');
  const file = await fetch(meta.url, { headers: { Authorization: `Bearer ${creds.access_token}` } });
  if (!file.ok) throw new Error(`mídia HTTP ${file.status}`);
  return { buf: Buffer.from(await file.arrayBuffer()), mime: meta.mime_type || file.headers.get('content-type') || '' };
}

async function transcribe(pool, creds, key, contactId) {
  const { rows: [m] } = await pool.query(
    `select media_id, mime_type from crm_messages where contact_id = $1 and direction = 'inbound' and tipo = 'audio' and media_id is not null order by sent_at desc limit 1`, [contactId]);
  if (!m) throw new Error('Nenhuma mensagem de áudio encontrada');
  const { buf, mime } = await downloadMedia(creds, m.media_id);
  const type = m.mime_type || mime || 'audio/ogg';
  const ext = type.includes('mp4') ? 'm4a' : type.includes('mpeg') ? 'mp3' : 'ogg';
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('file', new Blob([buf], { type }), `audio.${ext}`);
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  const data = await res.json();
  if (!res.ok || !data.text?.trim()) throw new Error(data.error?.message || 'transcrição vazia');
  return data.text.trim();
}

async function history(pool, contactId, count) {
  if (count <= 0) return [];
  const { rows } = await pool.query(
    `select direction, body, tipo, media_id, connection_id from crm_messages where contact_id = $1 order by sent_at desc limit $2`,
    [contactId, Math.min(Math.max(count * 5, 30), 150)]);
  return rows.reverse()
    .filter((m) => m.tipo !== 'template' && !(m.direction === 'inbound' && (m.tipo === 'interactive_buttons' || m.tipo === 'list')))
    .map((m) => {
      const role = m.direction === 'inbound' ? 'user' : 'assistant';
      const img = m.direction === 'inbound' && m.tipo === 'image' ? m.media_id : undefined;
      if (m.body && m.body.trim()) return { role, content: m.body, _img: img };
      if (!m.media_id) return null;
      const label = { audio: '[mensagem de áudio]', image: '[mensagem de imagem]', video: '[mensagem de vídeo]' }[m.tipo] || '[mensagem de arquivo]';
      return { role, content: label, _img: img };
    })
    .filter(Boolean).slice(-count);
}

async function speak(creds, to, el, p, text) {
  const vId = p.el_voice_id || el.default_voice_id;
  if (!el.key || !vId) throw new Error('ElevenLabs sem chave ou voz');
  const mId = p.el_model_id || el.default_model_id || 'eleven_multilingual_v2';
  const settings = {
    stability: p.el_stability ?? el.default_stability ?? 0.5, similarity_boost: p.el_similarity_boost ?? el.default_similarity_boost ?? 0.75,
    style: p.el_style ?? el.default_style ?? 0, use_speaker_boost: p.el_use_speaker_boost ?? el.default_use_speaker_boost ?? true,
  };
  const t = Date.now();
  const tts = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vId}?output_format=opus_48000_64`, {
    method: 'POST', headers: { 'xi-api-key': el.key, 'Content-Type': 'application/json', Accept: 'audio/ogg' },
    body: JSON.stringify({ text, model_id: mId, voice_settings: settings }),
  });
  const log = { voice_id: vId, model_id: mId, characters_used: text.length, input_text: text, rendered_text: text };
  if (!tts.ok) { const e = await tts.json().catch(() => ({})); return { log: { ...log, error: e?.detail?.message || `HTTP ${tts.status}`, response_time_ms: Date.now() - t } }; }
  const buf = Buffer.from(await tts.arrayBuffer());
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'audio.ogg');
  const up = await metaPost(creds, 'media', form, false);
  const data = await metaPost(creds, 'messages', { messaging_product: 'whatsapp', to, type: 'audio', audio: { id: up.id, voice: true } });
  return {
    msg: { tipo: 'audio', body: 'Áudio', audio_media_id: up.id, buttons: [], wa_id: data.messages?.[0]?.id || null, at: new Date().toISOString() },
    log: { ...log, audio_file_size_bytes: buf.length, response_time_ms: Date.now() - t },
  };
}

async function sendText(creds, to, text, buttons = []) {
  const data = await metaPost(creds, 'messages', payloadFor(to, text, buttons));
  return { body: text, buttons, wa_id: data.messages?.[0]?.id || null, at: new Date().toISOString() };
}

// Resposta: { fallback: true } = nada foi enviado, o Base44 processa como antes
async function processAi(pool, p) {
  const phone = String(p.contact_phone || '').replace(/\D/g, '');
  const company = p.company_id;
  if (!phone || !company) return { ok: false, error: 'Missing phone or company_id' };
  const type = p.message_type || 'text';
  let text = p.message_text || '';
  if (!text.trim()) { if (type !== 'image') return { ok: true, skipped: true, reason: 'Mensagem vazia' }; text = '[imagem]'; }
  if (!['text', 'interactive', 'audio', 'image'].includes(type)) return { ok: true, skipped: true, reason: 'Tipo de mensagem não suportado pelo agente' };
  if (text.length > 4000) return { ok: true, skipped: true, reason: 'Mensagem muito longa (>4000 chars)' };

  const bundle = await getBundle(company);
  const agent = bundle.agent;
  if (!agent) return { ok: true, skipped: true, reason: 'Nenhum agente ativo' };
  const { rows: [contact] } = await pool.query(
    p.contact_id ? `select * from crm_contacts where id = $1 limit 1` : `select * from crm_contacts where company_id = $1 and telefone = $2 limit 1`,
    p.contact_id ? [p.contact_id] : [company, phone]);
  if (!contact) return { fallback: true };
  const creds = await getCreds(company, p.connection_id || contact.connection_id);
  const key = bundle.openai_key;
  const record = { contact_id: contact.id, agent_id: agent.id, messages: [], log: null, el_log: null };
  const rMode = p.response_mode || 'single';
  const suppress = rMode === 'single';
  if (!key) return { ok: false, error: 'API key OpenAI não configurada' };

  if (type === 'audio' && ['', '[áudio]', '[audio]'].includes(text.trim().toLowerCase())) {
    if (agent.whisper_enabled === false) return { ok: true, skipped: true, reason: 'Transcrição de áudio desativada (Whisper off)' };
    try { text = await transcribe(pool, creds, key, contact.id); } catch (e) {
      console.warn('[AI] transcrição falhou:', e.message);
      const msg = 'Desculpe, não consegui entender o seu áudio 😅 Você pode digitar a mensagem?';
      if (!suppress) record.messages.push(await sendText(creds, phone, msg));
      return { ok: true, response: msg, matched_branch: null, mapped_variables: {}, response_mode: rMode, _record: record };
    }
  }

  const count = p.context_message_count != null ? Math.min(50, Math.max(0, Number(p.context_message_count) || 0)) : (agent.context_message_count || 10);
  let ctx = await history(pool, contact.id, count);
  const last = ctx[ctx.length - 1];
  if (!last || last.role !== 'user' || textOf(last.content) !== text) {
    if (!ctx.slice(-3).some((m) => m.role === 'user' && textOf(m.content) === text)) ctx.push({ role: 'user', content: text });
  }
  const model = p.model || agent.openai_model || 'gpt-4o-mini';
  if (supportsVision(model)) {
    for (const m of ctx.filter((x) => x._img).slice(-3)) {
      try {
        const { buf, mime } = await downloadMedia(creds, m._img);
        m.content = [{ type: 'text', text: m.content === '[mensagem de imagem]' ? 'O cliente enviou esta imagem:' : m.content },
          { type: 'image_url', image_url: { url: `data:${mime || 'image/jpeg'};base64,${buf.toString('base64')}` } }];
      } catch (e) { console.warn('[AI] imagem não baixada:', e.message); }
    }
  }
  ctx = ctx.map(({ _img, ...rest }) => rest);

  const conds = p.conditional_outputs || [];
  const outVars = p.output_variables || [];
  const isCond = rMode === 'conditional';
  const useJson = isCond || (rMode === 'single' && outVars.length > 0);
  const contactObj = { ...contact, created_date: contact.created_at || contact.created_date };
  const system = buildSystemPrompt({
    customPrompt: p.custom_prompt || agent.system_prompt || '', responseMode: rMode, conditionalOutputs: conds, outputVariables: outVars,
    maxTokens: agent.max_tokens_response ?? 500, contact: contactObj, agent, knowledgeDocuments: p.knowledge_documents || agent.knowledge_documents || [],
    contextMessages: ctx, voiceResponseEnabled: p.voice_response_enabled === true,
  });
  const ml = model.toLowerCase();
  const noTemp = /^(gpt-5|o1|o3|o4)/.test(ml);
  const call = { model, messages: [{ role: 'system', content: system }, ...ctx], max_completion_tokens: agent.max_tokens_response ?? 500 };
  if (noTemp && call.max_completion_tokens < 8000) call.max_completion_tokens = 8000;
  if (!noTemp) call.temperature = agent.temperature ?? 0.7;
  if (useJson) call.response_format = { type: 'json_object' };
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(call) });
  const data = await res.json();
  if (!res.ok) {
    const error = data.error?.message || `OpenAI API error: ${res.status}`;
    record.log = { input_message: text, output_message: '', tokens_used_input: 0, tokens_used_output: 0, model_used: model, response_time_ms: 0, error };
    if (/Invalid API key|Incorrect API key/.test(error)) record.disable_agent = true;
    return { ok: false, error, _record: record };
  }
  const raw = data.choices?.[0]?.message?.content || '';

  let send = '';
  let branch = null;
  const mapped = {};
  const saveVars = (c, json) => { for (const sv of c.save_variables || []) if (sv.ai_field && sv.variable_name) { const v = json?.[sv.variable_name]; mapped[sv.variable_name] = v != null && v !== '' ? v : sv.ai_field; } };
  if (useJson) {
    let json = null;
    try { json = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); if (m) try { json = JSON.parse(m[0]); } catch {} }
    if (json) {
      send = json.message || raw;
      if (isCond) {
        const nullGoal = json.matched_goal == null;
        const goal = String(json.matched_goal || '').trim();
        if (goal && goal !== 'default' && goal !== 'null') {
          const g = norm(goal);
          const c = conds.find((c, i) => {
            if (c.id === goal || (c.label && norm(c.label) === g) || String.fromCharCode(65 + i) === goal.toUpperCase()) return true;
            if (!c.label) return false;
            const l = norm(c.label);
            if (g.includes(l) || l.includes(g)) return true;
            const w = l.split(/\s+/).filter((x) => x.length >= 3);
            return w.length > 0 && w.every((x) => g.includes(x));
          });
          if (c) { branch = c.id; saveVars(c, json); }
        }
        if (!branch) {
          const r = matchByLabel(conds, text, send);
          if (r && r.score >= (nullGoal ? 5 : 2)) { branch = r.matched.id; saveVars(r.matched, json); }
        }
      }
      for (const v of outVars) if (v.ai_field && v.variable_name && json[v.ai_field] !== undefined) mapped[v.variable_name] = json[v.ai_field];
    } else {
      send = raw;
      if (isCond) { const r = matchByLabel(conds, text, send); if (r) { branch = r.matched.id; saveVars(r.matched, null); } }
    }
  } else send = raw;

  let asAudio = false;
  const audioMark = p.voice_response_enabled && send && send.match(/^\[AUDIO\]\s*/i);
  if (audioMark) {
    const audioText = send.slice(audioMark[0].length).trim();
    if (audioText) {
      send = audioText;
      try {
        const v = await speak(creds, phone, bundle.el || {}, p, audioText);
        record.el_log = v.log;
        if (v.msg) { record.messages.push(v.msg); asAudio = true; }
      } catch (e) { console.error('[AI] voz falhou:', e.message); }
      if (!asAudio && !suppress) { record.messages.push(await sendText(creds, phone, audioText)); asAudio = true; }
    }
  }

  let asButton = false;
  const btn = send && send.match(/\[BOTAO:\s*([^\]|]+)\s*\|\s*(https?:\/\/[^\]]+)\s*\]/i);
  if (btn) {
    const label = btn[1].trim();
    const vars = { contact_id: contact.id, contact_name: contact.nome, nome: contact.nome, telefone: contact.telefone, email: contact.email, empresa: contact.empresa, ...(contact.custom_fields || {}), ...mapped };
    const url = btn[2].trim().replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => String(vars[k] ?? vars[k.replace(/^(custom_fields|collected|variables)\./, '')] ?? ''));
    send = send.replace(btn[0], '').trim();
    if (label && url) {
      try { record.messages.push(await sendText(creds, phone, send, [{ type: 'url', text: label, url }])); asButton = true; } catch (e) {
        console.error('[AI] botão falhou:', e.message);
        if (!suppress) { record.messages.push(await sendText(creds, phone, `${send}\n${url}`)); asButton = true; }
      }
    }
  }
  if (!asAudio && !asButton && send && !suppress) record.messages.push(await sendText(creds, phone, send));

  record.log = { input_message: text, output_message: send, tokens_used_input: data.usage?.prompt_tokens || 0, tokens_used_output: data.usage?.completion_tokens || 0, model_used: model, response_time_ms: Date.now() - t0, error: null };
  console.log(`[AI] ${phone} respondeu em ${Date.now() - t0}ms branch=${branch || '-'} audio=${asAudio}`);

  // Saída escolhida pela IA (ex.: transferir para atendente): o Railway já envia os blocos seguintes;
  // o Base44 só registra, executa as ações (atribuir atendente, etiquetas) e segue o restante
  const connId = p.connection_id || contact.connection_id;
  const next = branch && conds.find((c) => c.id === branch)?.next_node_id;
  let fast = null;
  if (next && p.flow_id) {
    try {
      const { rows: [flow] } = await pool.query(`select base44_id, name, nodes from flows where base44_id = $1 limit 1`, [p.flow_id]);
      const loadFlow = async (id) => (await pool.query(
        `select base44_id, name, nodes from flows where base44_id = $1 and connection_id = $2 and status = 'active' limit 1`, [id, connId])).rows[0] || null;
      if (flow) fast = await runFast(flow, next, { companyId: company, connectionId: connId, phone, contact, loadFlow, context: mapped });
      if (fast) console.log(`[AI] ${phone} RAILWAY ENVIOU ${(fast._railway_messages || []).length} msg(s) da saída "${branch}"`);
    } catch (e) {
      console.error('[AI] saída no Railway falhou (Base44 segue):', e.message);
      fast = null;
    }
  }
  await recordFast(pool, { companyId: company, connectionId: connId, contactId: contact.id, phone, fast: { _railway_messages: [...record.messages, ...(fast?._railway_messages || [])] } });
  return { ok: true, response: send, matched_branch: branch, mapped_variables: mapped, response_mode: rMode, sent_as_audio: asAudio, sent_as_button: asButton, _railway_fast: fast || undefined, _record: record };
}

async function handleAi(req, res, pool) {
  if ((req.headers.authorization || '') !== `Bearer ${WORKER_SECRET}`) { res.writeHead(401); return res.end('{}'); }
  let body = '';
  for await (const chunk of req) body += chunk;
  let out;
  try {
    const p = JSON.parse(body);
    out = p.action === 'processMessage' && p.from_flow ? await processAi(pool, p) : { fallback: true };
  } catch (e) {
    // Falha antes de enviar qualquer coisa: o Base44 processa como antes
    console.error('[AI] erro:', e.message);
    out = { fallback: true, error: e.message };
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(out));
}

module.exports = { handleAi };