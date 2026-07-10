async function dispararFluxoNoBase44(job) {
  const base44Url = process.env.BASE44_WORKER_ENDPOINT;
  const workerSecret = process.env.WORKER_SECRET;

  // LOGS DE DEBUG
  console.log(`[TRIGGER] URL: ${base44Url}`);
  console.log(`[TRIGGER] WORKER_SECRET existe: ${!!workerSecret}`);
  console.log(`[TRIGGER] WORKER_SECRET primeiros 10 chars: ${workerSecret?.substring(0, 10)}`);
  console.log(`[TRIGGER] Header que será enviado: Bearer ${workerSecret?.substring(0, 5)}...`);

  if (!base44Url) {
    console.error('[TRIGGER] BASE44_WORKER_ENDPOINT não configurado');
    return false;
  }

  try {
    console.log(`[TRIGGER] Disparando fluxo: ${job.flow_base44_id} → ${job.contact_phone}`);

    const res = await axios.post(
      base44Url,
      {
        action: 'startFlow',
        flow_id: job.flow_base44_id,
        contact_phone: job.contact_phone,
        company_id: job.company_id,
        context: job.context || {},
        reference_id: job.reference_id,
        reference_type: job.reference_type
      },
      {
        headers: {
          'Authorization': `Bearer ${workerSecret}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000
      }
    );

    console.log(`[TRIGGER] Base44 respondeu: ${res.status} | ${JSON.stringify(res.data)}`);
    return res.status >= 200 && res.status < 300 && res.data?.ok !== false;

  } catch(e) {
    // Log detalhado do erro
    console.error(`[TRIGGER] Status do erro: ${e.response?.status}`);
    console.error(`[TRIGGER] Body do erro: ${JSON.stringify(e.response?.data)}`);
    console.error(`[TRIGGER] Mensagem: ${e.message}`);
    return false;
  }
}
