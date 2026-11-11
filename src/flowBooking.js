// ═══════════════════════════════════════════════════════════
// Endpoint do Flow de agendamento (POST /flows/booking)
// Meta → Railway (aqui) → publicBooking / formPageApi (Base44) → Supabase
//
// - Descriptografa (RSA-OAEP-SHA256 + AES-128-GCM) e responde cifrado (IV invertido)
// - Responde ao ping de saúde da Meta
// - Ações: INIT, data_exchange e BACK
// - Disponibilidade SEMPRE pelas mesmas funções da página pública (publicBooking);
//   cache curto por token (60s) só das respostas de availability/get_slots.
//   A conferência final (slotStillFree) e a criação são sempre ao vivo.
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');
const { privateKey } = require('./bookingFlowSetup');
const { DATA_API_VERSION } = require('./bookingFlowJson');

const APP_URL = process.env.APP_URL || 'https://gocrm.base44.app';
const CACHE_TTL_MS = 60 * 1000;
const CACHE_KEEP_MS = 10 * 60 * 1000;
const MSG_ERRO = 'Não consegui carregar os horários. Tente novamente em instantes.';
const SCREENS = ['DATA', 'HORARIO', 'DADOS'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// ── criptografia ──
function decryptRequest(body) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body || {};
  if (!encrypted_aes_key || !encrypted_flow_data || !initial_vector) throw new Error('payload incompleto');
  const aesKey = crypto.privateDecrypt(
    { key: privateKey(), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(encrypted_aes_key, 'base64'),
  );
  const buf = Buffer.from(encrypted_flow_data, 'base64');
  const iv = Buffer.from(initial_vector, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(buf.subarray(-16));
  const json = Buffer.concat([decipher.update(buf.subarray(0, -16)), decipher.final()]).toString('utf8');
  return { body: JSON.parse(json), aesKey, iv };
}

function encryptResponse(obj, aesKey, iv) {
  const flipped = Buffer.from(Array.from(iv).map((b) => ~b & 0xff));
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flipped);
  return Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

// ── métricas por tela (p50/p90 ao vivo vs cache) ──
const timings = { DATA: { live: [], cache: [] }, HORARIO: { live: [], cache: [] }, DADOS: { live: [], cache: [] } };
const cap = (list) => { while (list.length > 500) list.shift(); };

function record(screen, source, ms, meta = {}) {
  const bucket = timings[screen]?.[source];
  if (bucket) { bucket.push(ms); cap(bucket); }
  if (meta.pool) {
    meta.pool.query(
      `insert into whatsapp_flow_timings (connection_id, screen, action, source, ms) values ($1,$2,$3,$4,$5)`,
      [(meta.connectionId || '').slice(0, 40), screen, String(meta.action || '').slice(0, 24), source, ms],
    ).catch(() => {});
  }
}

function percentile(list, p) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

function bookingMetrics() {
  const out = { ok: true, since_boot_ms: Date.now() - bootedAt, screens: {} };
  for (const screen of SCREENS) {
    out.screens[screen] = {};
    for (const source of ['live', 'cache']) {
      const list = timings[screen][source];
      out.screens[screen][source] = { n: list.length, p50: percentile(list, 50), p90: percentile(list, 90) };
    }
  }
  return out;
}
const bootedAt = Date.now();

// ── cache curto por token (nunca usado para confirmar/criar) ──
const linkCache = new Map(); // token -> { at, availability, slots: { 'YYYY-MM-DD': { at, slots } } }
function cacheOf(token) {
  const now = Date.now();
  for (const [key, entry] of linkCache) if (now - entry.at > CACHE_KEEP_MS) linkCache.delete(key);
  let entry = linkCache.get(token);
  if (!entry) { entry = { at: now, availability: null, slots: {} }; linkCache.set(token, entry); }
  entry.at = now;
  return entry;
}
function readAvailability(token) {
  const hit = linkCache.get(token)?.availability;
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.days : null;
}
function writeAvailability(token, days) {
  cacheOf(token).availability = { at: Date.now(), days };
}
function readSlots(token, date) {
  const hit = linkCache.get(token)?.slots?.[date];
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.slots : null;
}
function writeSlots(token, date, slots) {
  cacheOf(token).slots[date] = { at: Date.now(), slots };
}

// ── chamadas ao Base44 (mesmas funções da página pública) ──
async function bookingApi(body, timeout = 4500) {
  const res = await fetch(`${APP_URL}/functions/publicBooking`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok) throw new Error(data?.error || `publicBooking HTTP ${res.status}`);
  return data;
}

async function submitAnswers(link, blockId, { date, time, note }) {
  const res = await fetch(`${APP_URL}/functions/formPageApi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'submit', token: link.token,
      answers: { [blockId]: { date, time, note: note || '', confirmed: true } },
    }),
    signal: AbortSignal.timeout(9000),
  });
  return (await res.json().catch(() => null)) || { ok: false, error: 'submit_failed' };
}

// ── dados do link ──
async function getLink(pool, token) {
  const { rows } = await pool.query(`select * from form_links where token = $1 limit 1`, [token]);
  return rows[0] || null;
}

const mask = (token) => `${String(token || '').slice(0, 6)}…`;
const brtToday = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const longLabel = (date) => {
  const [, m, d] = String(date).split('-').map(Number);
  return `${d} de ${MONTHS[m - 1] || ''}`;
};
const shortLabel = (date) => {
  const dt = new Date(`${date}T12:00:00-03:00`);
  return `${WEEKDAYS[dt.getUTCDay()]}, ${String(date).slice(8, 10)}/${String(date).slice(5, 7)}`;
};
const slotsLabel = (n) => `${n} ${n === 1 ? 'horário livre' : 'horários livres'}`;

function bookingBlockOf(link) {
  for (const screen of link?.form_snapshot?.screens || []) {
    for (const block of screen.blocks || []) if (block.kind === 'agendamento') return block;
  }
  return null;
}

function errorScreen(message, screen = 'DATA') {
  if (screen === 'HORARIO') {
    return { screen: 'HORARIO', data: { date: brtToday(), date_label: 'Escolha um horário', times: [], has_error: true, error: message } };
  }
  return {
    screen: 'DATA',
    data: {
      mode_calendar: false, mode_list: false, min_date: brtToday(), max_date: brtToday(),
      unavailable: [], days: [], has_error: true, error: message,
    },
  };
}

function dataScreenData(link, days, error) {
  const block = bookingBlockOf(link) || {};
  const listMode = block?.booking?.date_format === 'list';
  const open = (days || []).filter((d) => (d.slots || []).length);
  let msg = error || '';
  if (!open.length && !msg) msg = 'Sem horários livres nos próximos dias.';

  if (listMode) {
    return {
      mode_calendar: false, mode_list: true,
      min_date: brtToday(), max_date: (days || []).length ? days[days.length - 1].date : brtToday(),
      unavailable: [],
      days: open.slice(0, 10).map((d) => ({ id: d.date, title: shortLabel(d.date), description: slotsLabel(d.slots.length) })),
      has_error: !!msg, error: msg,
    };
  }
  return {
    mode_calendar: true, mode_list: false,
    min_date: brtToday(),
    max_date: (days || []).length ? days[days.length - 1].date : brtToday(),
    unavailable: (days || []).filter((d) => !(d.slots || []).length).map((d) => d.date),
    days: [],
    has_error: !!msg, error: msg,
  };
}

async function availabilityFor(link, ctx) {
  const cached = readAvailability(link.token);
  if (cached) {
    record('DATA', 'cache', Date.now() - ctx.t0, ctx.meta);
    return cached;
  }
  const started = Date.now();
  const res = await bookingApi({ action: 'availability', slug: bookingBlockOf(link)?.booking?.slug || '', days: 60 });
  const days = res.days || [];
  writeAvailability(link.token, days);
  record('DATA', 'live', Date.now() - started, ctx.meta);
  return days;
}

async function slotsFor(link, date, ctx) {
  const fromAvailability = (readAvailability(link.token) || []).find((d) => d.date === date);
  if (fromAvailability) {
    record('HORARIO', 'cache', Date.now() - ctx.t0, ctx.meta);
    return fromAvailability.slots || [];
  }
  const cached = readSlots(link.token, date);
  if (cached) {
    record('HORARIO', 'cache', Date.now() - ctx.t0, ctx.meta);
    return cached;
  }
  const started = Date.now();
  const res = await bookingApi({ action: 'get_slots', slug: bookingBlockOf(link)?.booking?.slug || '', date });
  const slots = res.slots || [];
  writeSlots(link.token, date, slots);
  record('HORARIO', 'live', Date.now() - started, ctx.meta);
  return slots;
}

function horarioData(link, date, slots, error) {
  return {
    date,
    date_label: `${longLabel(date)} — escolha um horário`,
    times: (slots || []).map((t) => ({ id: t, title: t })),
    has_error: !!error,
    error: error || '',
  };
}

function dadosData(link, { date, time, nome }, error) {
  const block = bookingBlockOf(link) || {};
  const who = nome || link?.form_snapshot?.contact?.nome || 'seu contato';
  return {
    date,
    time,
    summary: `${longLabel(date)}, às ${time}`,
    who: `Agendando como ${who}`,
    nome: who,
    note_enabled: block?.booking?.note_enabled !== false,
    note_label: block?.booking?.note_label || 'Observação (opcional)',
    has_error: !!error,
    error: error || '',
  };
}

// ── rota ──
async function handleBookingFlow(req, res, url, pool) {
  const connectionId = url.searchParams.get('c') || '';
  let raw = '';
  for await (const chunk of req) raw += chunk;

  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('bad json');
  }

  let dec;
  try { dec = decryptRequest(payload); } catch (e) {
    console.warn('[FLOW-BOOKING] falha ao descriptografar:', e.message);
    res.writeHead(421, { 'Content-Type': 'text/plain' });
    return res.end();
  }

  const reply = (obj) => {
    const out = encryptResponse(obj, dec.aesKey, dec.iv);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(out);
  };

  const incoming = dec.body || {};
  const action = String(incoming.action || '').toLowerCase();
  if (action === 'ping') return reply({ version: DATA_API_VERSION, data: { status: 'active' } });

  const token = String(incoming.flow_token || '');
  const screen = String(incoming.screen || '').toUpperCase();
  const data = incoming.data || {};
  const t0 = Date.now();
  const ctx = { t0, meta: { pool, connectionId, action: incoming.action } };

  try {
    if (!pool) throw new Error('banco indisponível');
    const link = await getLink(pool, token);
    if (!link) {
      console.warn(`[FLOW-BOOKING] token ${mask(token)} não encontrado`);
      return reply(errorScreen(MSG_ERRO));
    }
    if (link.status === 'submitted') {
      console.warn(`[FLOW-BOOKING] token ${mask(token)} já respondido`);
      return reply(errorScreen('Este agendamento já foi concluído.'));
    }
    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
      console.warn(`[FLOW-BOOKING] token ${mask(token)} expirado`);
      return reply(errorScreen('Este link expirou. Peça um novo agendamento no WhatsApp.'));
    }
    if (!connectionId) {
      console.warn(`[FLOW-BOOKING] requisição sem conexão na URL (token ${mask(token)})`);
      return reply(errorScreen(MSG_ERRO));
    }
    if (link.connection_id !== connectionId) {
      console.warn(`[FLOW-BOOKING] token ${mask(token)} não pertence à conexão ${String(connectionId).slice(0, 8)}…`);
      return reply(errorScreen(MSG_ERRO));
    }

    const block = bookingBlockOf(link);
    if (!block?.booking?.slug) {
      console.warn(`[FLOW-BOOKING] token ${mask(token)} sem link de agendamento`);
      return reply(errorScreen('Este agendamento não está configurado. Fale com a empresa pelo WhatsApp.'));
    }

    // ── INIT: uma chamada de disponibilidade para o período inteiro ──
    if (action === 'init') {
      const days = await availabilityFor(link, ctx);
      console.log(`[FLOW-BOOKING] INIT token=${mask(token)} conn=${connectionId.slice(0, 8)}… ${Date.now() - t0}ms`);
      return reply({ screen: 'DATA', data: dataScreenData(link, days) });
    }

    // ── Voltar: devolve a tela anterior ──
    if (action === 'back') {
      if (screen === 'HORARIO' || screen === 'DADOS') {
        const date = String(data.date || '');
        if (screen === 'DADOS' && date) {
          const slots = await slotsFor(link, date, ctx);
          return reply({ screen: 'HORARIO', data: horarioData(link, date, slots) });
        }
        const days = await availabilityFor(link, ctx);
        return reply({ screen: 'DATA', data: dataScreenData(link, days) });
      }
      const days = await availabilityFor(link, ctx);
      return reply({ screen: 'DATA', data: dataScreenData(link, days) });
    }

    // ── DATA → HORARIO ──
    if (screen === 'DATA') {
      const date = String(data.date_list || data.date_cal || '');
      if (!date) {
        const days = await availabilityFor(link, ctx);
        return reply({ screen: 'DATA', data: dataScreenData(link, days, 'Escolha uma data para continuar.') });
      }
      const slots = await slotsFor(link, date, ctx);
      if (!slots.length) {
        const days = await availabilityFor(link, ctx);
        return reply({ screen: 'DATA', data: dataScreenData(link, days, 'Esse dia não tem mais horário livre. Escolha outro.') });
      }
      console.log(`[FLOW-BOOKING] DATA→HORARIO token=${mask(token)} date=${date} slots=${slots.length} ${Date.now() - t0}ms`);
      return reply({ screen: 'HORARIO', data: horarioData(link, date, slots) });
    }

    // ── HORARIO → DADOS ──
    if (screen === 'HORARIO') {
      const date = String(data.date || '');
      const time = String(data.time || '');
      const slots = await slotsFor(link, date, ctx);
      if (!time || !slots.includes(time)) {
        return reply({ screen: 'HORARIO', data: horarioData(link, date, slots, 'Escolha um horário para continuar.') });
      }
      return reply({ screen: 'DADOS', data: dadosData(link, { date, time, nome: link?.form_snapshot?.contact?.nome || '' }) });
    }

    // ── DADOS → confirma (formSubmitted) ──
    if (screen === 'DADOS') {
      const date = String(data.date || '');
      const time = String(data.time || '');
      const nome = String(data.nome || '').trim();
      const note = String(data.note || '').trim();
      if (!nome) {
        return reply({ screen: 'DADOS', data: dadosData(link, { date, time, nome }, 'Informe seu nome para confirmar.') });
      }
      const submitted = await submitAnswers(link, block.id, { date, time, note });
      const took = Date.now() - t0;
      record('DADOS', 'live', took, { ...ctx.meta, pool });

      if (!submitted.ok) {
        const reason = String(submitted.error || '');
        console.warn(`[FLOW-BOOKING] confirmação recusada token=${mask(token)} motivo=${reason}`);
        if (reason === 'no_slot' || reason === 'unavailable') {
          const slots = await slotsFor(link, date, ctx);
          return reply({
            screen: 'HORARIO',
            data: horarioData(link, date, slots, 'Esse horário acabou de ser reservado, escolha outro.'),
          });
        }
        if (reason === 'used') {
          return reply(errorScreen('Este agendamento já foi concluído.'));
        }
        return reply({ screen: 'DADOS', data: dadosData(link, { date, time, nome }, MSG_ERRO) });
      }

      console.log(`[FLOW-BOOKING] agendamento confirmado token=${mask(token)} ${date} ${time} ${took}ms`);
      return reply({
        screen: 'SUCCESS',
        data: {
          confirmacao: `${longLabel(date)}, às ${time}. Enviamos os detalhes aqui no WhatsApp.`,
        },
      });
    }

    return reply(errorScreen(MSG_ERRO));
  } catch (e) {
    console.error(`[FLOW-BOOKING] erro token=${mask(token)} action=${incoming.action || '-'} screen=${screen || '-'}:`, e.message);
    return reply(errorScreen(MSG_ERRO));
  }
}

module.exports = { handleBookingFlow, bookingMetrics };