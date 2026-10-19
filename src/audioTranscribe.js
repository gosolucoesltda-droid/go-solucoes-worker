// Transcrição de áudio recebido feita no Railway (Whisper com a chave OpenAI da empresa, a mesma da IA).
// null = sem chave ou falhou: o Base44 transcreve como antes.
const { loadCreds, loadAiBundle } = require('./botSettings');

async function transcribeAudio(companyId, connectionId, mediaId, mimeType) {
  if (!mediaId) return null;
  const [creds, ai] = await Promise.all([loadCreds(companyId, connectionId), loadAiBundle(companyId)]);
  if (!creds?.access_token || !ai?.openai_key) return null;
  const t0 = Date.now();
  try {
    const auth = { Authorization: `Bearer ${creds.access_token}` };
    const meta = await (await fetch(`https://graph.facebook.com/v22.0/${mediaId}`, { headers: auth })).json();
    if (!meta.url) throw new Error(meta.error?.message || 'Meta não retornou URL do áudio');
    const file = await fetch(meta.url, { headers: auth });
    if (!file.ok) throw new Error(`download HTTP ${file.status}`);
    const mime = mimeType || 'audio/ogg';
    const ext = mime.includes('mp4') ? 'm4a' : mime.includes('mpeg') ? 'mp3' : 'ogg';
    const form = new FormData();
    form.append('model', 'whisper-1');
    form.append('file', new Blob([await file.arrayBuffer()], { type: mime.split(';')[0] }), `audio.${ext}`);
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${ai.openai_key}` }, body: form, signal: AbortSignal.timeout(60000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `OpenAI HTTP ${res.status}`);
    const text = String(data.text || '').trim();
    console.log(`[TRANSCRIÇÃO] ${text ? 'ok' : 'vazia'} em ${Date.now() - t0}ms`);
    return text || null;
  } catch (e) {
    console.error('[TRANSCRIÇÃO] falhou (Base44 assume):', e.message);
    return null;
  }
}

module.exports = { transcribeAudio };