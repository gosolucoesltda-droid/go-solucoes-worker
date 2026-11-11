// Flow JSON 7.3 do Agendamento GOcrm (Data API 4.0 — endpoint).
// Um único Flow publicado por conexão atende os dois formatos de data:
// o formato é escolhido em runtime pelo endpoint, que devolve `mode_calendar`
// ou `mode_list` na tela DATA. Trocar a opção no bloco não exige republicar.
const FLOW_VERSION = '7.3';
const DATA_API_VERSION = '4.0';

const dayItem = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['id', 'title'],
};

const timeItem = {
  type: 'object',
  properties: { id: { type: 'string' }, title: { type: 'string' } },
  required: ['id', 'title'],
};

const errorFields = {
  has_error: { type: 'boolean', __example__: false },
  error: { type: 'string', __example__: 'Escolha uma data para continuar.' },
};

function dataScreen(logoUrl) {
  const children = [];
  if (logoUrl && /^https:\/\//i.test(String(logoUrl))) {
    children.push({
      type: 'Image', src: String(logoUrl), width: 96, height: 96,
      'scale-type': 'contain', 'alt-text': 'Logo',
    });
  }
  children.push(
    { type: 'TextHeading', text: 'Escolha uma data' },
    { type: 'TextBody', text: '${data.error}', visible: '${data.has_error}' },
    {
      type: 'CalendarPicker', name: 'date_cal', visible: '${data.mode_calendar}',
      'min-date': '${data.min_date}', 'max-date': '${data.max_date}',
      'unavailable-dates': '${data.unavailable}',
    },
    { type: 'RadioButtonsGroup', name: 'date_list', 'data-source': '${data.days}', visible: '${data.mode_list}' },
    {
      type: 'Footer', label: 'Continuar',
      'on-click-action': { name: 'data_exchange', payload: { date_cal: '${form.date_cal}', date_list: '${form.date_list}' } },
    },
  );
  return {
    id: 'DATA',
    title: 'Agendamento',
    data: {
      ...errorFields,
      mode_calendar: { type: 'boolean', __example__: true },
      mode_list: { type: 'boolean', __example__: false },
      min_date: { type: 'string', __example__: '2026-11-12' },
      max_date: { type: 'string', __example__: '2027-01-10' },
      unavailable: { type: 'array', items: { type: 'string' }, __example__: ['2026-11-15'] },
      days: {
        type: 'array', items: dayItem,
        __example__: [{ id: '2026-11-13', title: 'Qui, 13/11', description: '6 horários livres' }],
      },
    },
    layout: { type: 'SingleColumnLayout', children },
  };
}

const horarioScreen = {
  id: 'HORARIO',
  title: 'Horário',
  data: {
    ...errorFields,
    date: { type: 'string', __example__: '2026-11-12' },
    date_label: { type: 'string', __example__: '12 de novembro — escolha um horário' },
    times: { type: 'array', items: timeItem, __example__: [{ id: '09:00', title: '09:00' }] },
  },
  layout: {
    type: 'SingleColumnLayout',
    children: [
      { type: 'TextHeading', text: '${data.date_label}' },
      { type: 'TextBody', text: '${data.error}', visible: '${data.has_error}' },
      { type: 'RadioButtonsGroup', name: 'time', 'data-source': '${data.times}' },
      {
        type: 'Footer', label: 'Continuar',
        'on-click-action': {
          name: 'data_exchange',
          payload: { date: '${data.date}', time: '${form.time}' },
        },
      },
    ],
  },
};

const dadosScreen = {
  id: 'DADOS',
  title: 'Confirmação',
  data: {
    ...errorFields,
    date: { type: 'string', __example__: '2026-11-12' },
    time: { type: 'string', __example__: '09:00' },
    summary: { type: 'string', __example__: '12 de novembro, às 09:00' },
    who: { type: 'string', __example__: 'Agendando como Ana' },
    nome: { type: 'string', __example__: 'Ana' },
    note_enabled: { type: 'boolean', __example__: true },
    note_label: { type: 'string', __example__: 'Observação (opcional)' },
  },
  layout: {
    type: 'SingleColumnLayout',
    children: [
      { type: 'TextSubheading', text: '${data.summary}' },
      { type: 'TextCaption', text: '${data.who}' },
      { type: 'TextBody', text: '${data.error}', visible: '${data.has_error}' },
      { type: 'TextEntry', name: 'nome', label: 'Seu nome', 'init-value': '${data.nome}', required: true },
      { type: 'TextArea', name: 'note', label: '${data.note_label}', visible: '${data.note_enabled}' },
      {
        type: 'Footer', label: 'Confirmar agendamento',
        'on-click-action': {
          name: 'data_exchange',
          payload: {
            date: '${data.date}', time: '${data.time}',
            nome: '${form.nome}', note: '${form.note}',
          },
        },
      },
    ],
  },
};

const successScreen = {
  id: 'SUCCESS',
  title: 'Agendamento',
  terminal: true,
  success: true,
  data: { confirmacao: { type: 'string', __example__: 'Tudo certo! Seu horário está reservado.' } },
  layout: {
    type: 'SingleColumnLayout',
    children: [
      { type: 'TextHeading', text: 'Agendamento confirmado' },
      { type: 'TextBody', text: '${data.confirmacao}' },
      { type: 'Footer', label: 'Concluir', 'on-click-action': { name: 'complete', payload: {} } },
    ],
  },
};

function bookingFlowJson({ logoUrl } = {}) {
  return {
    version: FLOW_VERSION,
    data_api_version: DATA_API_VERSION,
    routing_model: { DATA: ['HORARIO'], HORARIO: ['DADOS'], DADOS: ['SUCCESS'] },
    screens: [dataScreen(logoUrl), horarioScreen, dadosScreen, successScreen],
  };
}

module.exports = { bookingFlowJson, FLOW_VERSION, DATA_API_VERSION };