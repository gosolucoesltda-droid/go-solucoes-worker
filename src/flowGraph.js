// Chamadas à Graph API dos WhatsApp Flows (v22.0) — usado pelo formulário estático
// (whatsappFlows) e pelo Flow de agendamento (bookingFlowSetup).
const GRAPH = 'https://graph.facebook.com/v22.0';

async function graph(creds, path, { method = 'GET', body, form } = {}) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${creds.access_token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(form ? { body: form } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    const e = data.error;
    console.error(`[FLOW API] Meta recusou ${path}: code=${e.code} subcode=${e.error_subcode || '-'} type=${e.type} fbtrace_id=${e.fbtrace_id || '-'} msg=${e.error_user_msg || e.message}`);
    const err = new Error(`Meta: ${e.error_user_msg || e.message}`);
    err.meta = {
      code: e.code ?? null, subcode: e.error_subcode ?? null, type: e.type ?? null,
      message: e.error_user_msg || e.message, fbtrace_id: e.fbtrace_id ?? null,
    };
    throw err;
  }
  return data;
}

function createFlow(creds, { name, categories = ['OTHER'], flow_json, endpoint_uri, publish }) {
  if (!creds.waba_id) throw new Error('Conexão sem WABA ID');
  return graph(creds, `${creds.waba_id}/flows`, {
    method: 'POST',
    body: {
      name,
      categories,
      ...(flow_json ? { flow_json: typeof flow_json === 'string' ? flow_json : JSON.stringify(flow_json) } : {}),
      ...(endpoint_uri ? { endpoint_uri } : {}),
      ...(publish ? { publish: 'true' } : {}),
    },
  });
}

async function uploadFlowJson(creds, metaFlowId, flowJson) {
  const json = typeof flowJson === 'string' ? flowJson : JSON.stringify(flowJson);
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', new Blob([json], { type: 'application/json' }), 'flow.json');
  return graph(creds, `${metaFlowId}/assets`, { method: 'POST', form });
}

const getFlow = (creds, metaFlowId) => graph(creds,
  `${metaFlowId}?fields=id,name,status,categories,validation_errors,preview,json_version,health_status,endpoint_uri`);
const publishFlow = (creds, metaFlowId) => graph(creds, `${metaFlowId}/publish`, { method: 'POST' });
const deprecateFlow = (creds, metaFlowId) => graph(creds, `${metaFlowId}/deprecate`, { method: 'POST' });
const deleteFlow = (creds, metaFlowId) => graph(creds, metaFlowId, { method: 'DELETE' });
const listMetaFlows = (creds) => graph(creds,
  `${creds.waba_id}/flows?fields=id,name,status,categories,validation_errors,json_version&limit=100`);

// Chave pública de criptografia do endpoint (por número de telefone).
const setEncryptionKey = (creds, publicPem) => graph(creds, `${creds.phone_number_id}/whatsapp_business_encryption`, {
  method: 'POST',
  form: new URLSearchParams({ business_public_key: publicPem }),
});
const getEncryption = (creds) => graph(creds, `${creds.phone_number_id}/whatsapp_business_encryption`);

module.exports = {
  GRAPH, graph, createFlow, uploadFlowJson, getFlow, publishFlow, deprecateFlow, deleteFlow, listMetaFlows,
  setEncryptionKey, getEncryption,
};