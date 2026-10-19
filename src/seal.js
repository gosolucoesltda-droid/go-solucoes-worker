// Abre os segredos que o Base44 copia lacrados para o Supabase (credenciais do WhatsApp, chaves da IA).
// Mesma chave do lado do Base44 (base44/shared/railwaySeal.ts): derivada do WORKER_SECRET.
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;
const enc = new TextEncoder();
let keyPromise = null;

function key() {
  if (!keyPromise) keyPromise = (async () => {
    const material = await subtle.importKey('raw', enc.encode(process.env.WORKER_SECRET || ''), 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('railway-seal-v1'), info: enc.encode('aes-256-gcm') },
      material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
  })();
  return keyPromise;
}

async function unseal(b64) {
  if (!b64) return null;
  const buf = Buffer.from(b64, 'base64');
  const out = await subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, await key(), buf.subarray(12));
  return Buffer.from(out).toString('utf8');
}

module.exports = { unseal };