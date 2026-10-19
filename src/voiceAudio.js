// Voz do ElevenLabs gerada no próprio Railway: chave e voz padrão vêm do Supabase,
// o áudio fica guardado no Supabase e é servido pelo Railway em /audio/<id>.
// null = falta configuração ou falhou: quem chama pede ao Base44 como antes.
const crypto = require('crypto');
const { loadAiBundle, settingsPool } = require('./botSettings');

const DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
const KEEP_DAYS = 7;

async function generateVoice({ companyId, text, cfg, flowId, nodeId, contactId, phone }) {
  const pool = settingsPool();
  if (!pool || !DOMAIN) return null;
  const el = (await loadAiBundle(companyId))?.el;
  const vId = cfg.voice_id || el?.default_voice_id;
  if (!el?.key || !vId) return null;
  const mId = cfg.model_id || el.default_model_id || 'eleven_multilingual_v2';
  const custom = cfg.use_default_settings === false;
  const pick = (k) => (custom ? cfg[k] : undefined) ?? el[`default_${k}`];
  const settings = {
    stability: pick('stability') ?? 0.5, similarity_boost: pick('similarity_boost') ?? 0.75,
    style: pick('style') ?? 0, use_speaker_boost: pick('use_speaker_boost') ?? true,
  };
  const fmt = cfg.output_format || 'opus_48000_64';
  const mime = fmt.startsWith('opus') ? 'audio/ogg' : 'audio/mpeg';
  const t0 = Date.now();
  const log = {
    company_id: companyId, flow_id: flowId || null, flow_block_id: nodeId || null, contact_id: contactId || null, contact_phone: phone || null,
    input_text: cfg.text || text, rendered_text: text, voice_id: vId, model_id: mId, characters_used: text.length,
  };
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vId}?output_format=${fmt}`, {
      method: 'POST',
      headers: { 'xi-api-key': el.key, 'Content-Type': 'application/json', Accept: mime },
      body: JSON.stringify({ text, model_id: mId, voice_settings: settings }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.detail?.message || `HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const id = crypto.randomUUID();
    const url = `https://${DOMAIN}/audio/${id}.${mime === 'audio/ogg' ? 'ogg' : 'mp3'}`;
    await pool.query(`insert into crm_tts_audio (id, company_id, mime_type, data) values ($1, $2, $3, $4)`, [id, companyId, mime, buf]);
    await saveLog(pool, { ...log, audio_file_size_bytes: buf.length, audio_url: url, response_time_ms: Date.now() - t0 });
    pool.query(`delete from crm_tts_audio where created_at < now() - interval '${KEEP_DAYS} days'`).catch(() => {});
    console.log(`[VOICE] áudio gerado no Railway (${text.length} chars) em ${Date.now() - t0}ms`);
    return url;
  } catch (e) {
    console.error('[VOICE] falhou (Base44 assume):', e.message);
    await saveLog(pool, { ...log, error: e.message, response_time_ms: Date.now() - t0 }).catch(() => {});
    return null;
  }
}

async function saveLog(pool, l) {
  await pool.query(
    `insert into crm_elevenlabs_logs (id, company_id, flow_id, flow_block_id, contact_id, contact_phone, input_text, rendered_text, voice_id, model_id, characters_used, audio_file_size_bytes, audio_url, error, response_time_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [crypto.randomUUID(), l.company_id, l.flow_id, l.flow_block_id, l.contact_id, l.contact_phone, l.input_text, l.rendered_text, l.voice_id, l.model_id,
      l.characters_used, l.audio_file_size_bytes || 0, l.audio_url || null, l.error || null, l.response_time_ms]
  );
}

// GET /audio/<id>.ogg — a Meta e o chat do painel baixam o áudio por aqui
async function serveAudio(res, pool, file) {
  const id = String(file).replace(/\.[a-z0-9]+$/i, '');
  const { rows: [a] } = pool ? await pool.query(`select mime_type, data from crm_tts_audio where id = $1`, [id]) : { rows: [] };
  if (!a) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': a.mime_type, 'Content-Length': a.data.length, 'Cache-Control': 'public, max-age=604800', 'Access-Control-Allow-Origin': '*' });
  res.end(a.data);
}

module.exports = { generateVoice, serveAudio };