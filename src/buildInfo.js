// Identificação do build do worker.
// Usada pelo GET /version (checklist de deploy) e pelo painel do bloco "Formulário em etapas".
// Ao publicar uma mudança no worker, atualize BUILD aqui e EXPECTED_WORKER_BUILD no app.
const BUILD = '2026-11-11-booking-2';
const BUILT_AT = '2026-11-11';
const FEATURES = ['flows', 'booking_setup', 'booking_endpoint', 'booking_metrics', 'field_date_ref'];

const COMMIT = String(process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || '').trim();
const BRANCH = String(process.env.RAILWAY_GIT_BRANCH || '').trim();
const STARTED_AT = new Date().toISOString();

function versionInfo() {
  return {
    ok: true,
    service: 'gocrm-worker',
    build: BUILD,
    built_at: BUILT_AT,
    features: FEATURES,
    commit: COMMIT ? COMMIT.slice(0, 7) : 'local',
    branch: BRANCH || null,
    started_at: STARTED_AT,
    node: process.version,
  };
}

module.exports = { BUILD, FEATURES, versionInfo };