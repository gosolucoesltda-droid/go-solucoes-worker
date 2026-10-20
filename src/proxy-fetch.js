// ═══════════════════════════════════════════════════════════
// ENDPOINT /proxy-fetch — Railway Worker
// Intermediário IPv4 para chamadas de API do flowEngine.
//
// COMO INSTALAR:
// 1. Cole este trecho no arquivo do worker onde /trigger já é tratado
//    (geralmente server.js, index.js ou app.js no serviço Railway).
// 2. Certifique-se de que WORKER_SECRET está nas variáveis de ambiente
//    do Railway (já deve estar, pois /trigger o usa).
// 3. Reinicie o worker. Nenhuma outra mudança é necessária.
// ═══════════════════════════════════════════════════════════

// ── Exemplo em Express (ajuste se usar outro framework) ──
//
// app.post('/proxy-fetch', async (req, res) => {
//   try {
//     const auth = req.headers.authorization || '';
//     if (auth !== `Bearer ${process.env.WORKER_SECRET}`) {
//       return res.status(401).json({ ok: false, error: 'Unauthorized' });
//     }
//
//     const { method = 'GET', url, headers = {}, body = null } = req.body || {};
//     if (!url || typeof url !== 'string') {
//       return res.status(400).json({ ok: false, error: 'url obrigatória' });
//     }
//
//     const fetchOpts = { method, headers };
//     if (body !== null && body !== undefined && method !== 'GET' && method !== 'HEAD') {
//       fetchOpts.body = body;
//     }
//
//     const upstream = await fetch(url, fetchOpts);
//     const text = await upstream.text();
//
//     const respHeaders = {};
//     upstream.headers.forEach((v, k) => { respHeaders[k] = v; });
//
//     return res.json({
//       status: upstream.status,
//       ok: upstream.ok,
//       headers: respHeaders,
//       body: text,
//     });
//   } catch (e) {
//     console.error('[proxy-fetch] erro:', e.message);
//     return res.status(502).json({ ok: false, error: e.message });
//   }
// });

// ── Versão framework-agnostic (Node http) — use se não tiver Express ──
// Adicione dentro do seu handler de requisição, quando req.url === '/proxy-fetch'
// e req.method === 'POST':

async function handleProxyFetch(req, res, bodyBuffer) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${process.env.WORKER_SECRET}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyBuffer.toString('utf8') || '{}');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'JSON inválido' }));
  }

  const { method = 'GET', url, headers = {}, body = null } = parsed;
  if (!url || typeof url !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'url obrigatória' }));
  }

  try {
    const fetchOpts = { method, headers };
    if (body !== null && body !== undefined && method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = body;
    }

    const upstream = await fetch(url, fetchOpts);
    const text = await upstream.text();

    const respHeaders = {};
    upstream.headers.forEach((v, k) => { respHeaders[k] = v; });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: upstream.status,
      ok: upstream.ok,
      headers: respHeaders,
      body: text,
    }));
  } catch (e) {
    console.error('[proxy-fetch] erro:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

module.exports = { handleProxyFetch };