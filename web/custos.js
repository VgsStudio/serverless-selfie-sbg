// Calculadora de custo por selfie. Tudo roda no navegador, sem API.

// Preços on-demand em us-east-1 (AWS Price List API, 10/11/2026), em US$ por unidade.
const PRICE = {
  lambdaGbSecond: 0.0000133334, // Lambda ARM, primeiro tier
  lambdaRequest: 0.0000002,
  apiRequest: 0.000001, // HTTP API, primeiros 300 milhões
  stateTransition: 0.000025, // Step Functions Standard
  dynamoWrite: 0.000000625, // por WRU, on-demand
  dynamoRead: 0.000000125, // por RRU, on-demand
  s3Tier1: 0.000005, // PUT, POST, LIST
  s3Tier2: 0.0000004, // GET
  s3OutGb: 0.09, // S3 → internet, primeiros 10 TB
  cloudfrontRequest: 0.0000022, // HTTPS, América do Sul
  cloudfrontOutGb: 0.11, // América do Sul, primeiros 10 TB
  logsGb: 0.5, // ingestão CloudWatch Logs
};

// Franquias mensais permanentes (por conta, valem todo mês, compartilhadas com o
// resto da conta). A calculadora oficial da AWS já desconta a do Step Functions.
const ALWAYS_FREE = { stateTransitions: 4000, lambdaRequests: 1_000_000, lambdaGbSeconds: 400_000 };

// Consumo medido no ensaio (CloudWatch, 26 execuções).
const MEASURED = {
  apiMs: 146, apiGb: 0.25,
  claimMs: 124, validateMs: 201, stepGb: 0.25,
  renderMs: 1860, renderGb: 2, renders: 2,
  transitions: 8,
  outputsMb: 0.32, // story + quadrado baixados pelo celular
  staticMbPerSession: 0.05, // html/css/js via CloudFront
  staticRequestsPerSession: 4,
  logKbPerInvocation: 0.5,
};

const $ = (s) => document.querySelector(s);
const MB_TO_GB = 1 / 1024;

/** Consumo e custo de N selfies, por serviço. */
function compute({ selfies, polls, perSession, freeTier = false }) {
  const sessions = selfies / perSession;
  const apiCalls = selfies * (1 + polls + 1) + sessions; // criar + consultas + resultado; sessão
  const apiGbS = apiCalls * (MEASURED.apiMs / 1000) * MEASURED.apiGb;
  const stepGbS = selfies * ((MEASURED.claimMs + MEASURED.validateMs) / 1000) * MEASURED.stepGb;
  const renderGbS = selfies * MEASURED.renders * (MEASURED.renderMs / 1000) * MEASURED.renderGb;
  const invocations = apiCalls + selfies * (2 + MEASURED.renders);
  // Escritas: trabalho (transação de 3 itens = 6 WRU), claim, validação, conclusão; sessão (2 itens = 4 WRU).
  const writes = selfies * (6 + 3) + sessions * 4;
  // Leituras eventualmente consistentes (0,5 RRU): sessão + trabalho em cada chamada.
  const reads = apiCalls * 1;
  const s3Tier1 = selfies * (1 + MEASURED.renders + 2); // upload + saídas + listagem na exclusão
  const s3Tier2 = selfies * (1 + MEASURED.renders + MEASURED.renders); // validação + leitura + download
  const outGb = selfies * MEASURED.outputsMb * MB_TO_GB;
  const cfRequests = apiCalls + sessions * MEASURED.staticRequestsPerSession;
  const cfGb = sessions * MEASURED.staticMbPerSession * MB_TO_GB;
  const logsGb = (invocations * MEASURED.logKbPerInvocation) / 1024 / 1024;

  const n = (v, unit) => `${Math.round(v).toLocaleString('pt-BR')} ${unit}`;
  const transitions = selfies * MEASURED.transitions;
  // Com franquia: só paga o que passa dela. GB-s grátis divididos na proporção de cada linha.
  const free = (used, allowance) => (freeTier ? Math.min(used, allowance) : 0);
  const gbS = renderGbS + apiGbS + stepGbS;
  const paidGbShare = gbS ? (gbS - free(gbS, ALWAYS_FREE.lambdaGbSeconds)) / gbS : 0;
  return [
    ['Step Functions', 'transições de estado', n(transitions, 'transições'), (transitions - free(transitions, ALWAYS_FREE.stateTransitions)) * PRICE.stateTransition],
    ['Lambda (render)', 'GB-segundo das molduras', n(renderGbS, 'GB-s'), renderGbS * paidGbShare * PRICE.lambdaGbSecond],
    ['Lambda (api e etapas)', 'GB-segundo', n(apiGbS + stepGbS, 'GB-s'), (apiGbS + stepGbS) * paidGbShare * PRICE.lambdaGbSecond],
    ['Lambda', 'requisições', n(invocations, 'invocações'), (invocations - free(invocations, ALWAYS_FREE.lambdaRequests)) * PRICE.lambdaRequest],
    ['API Gateway', 'requisições HTTP API', n(apiCalls, 'requisições'), apiCalls * PRICE.apiRequest],
    ['S3', 'PUT/POST/LIST e GET', n(s3Tier1 + s3Tier2, 'requisições'), s3Tier1 * PRICE.s3Tier1 + s3Tier2 * PRICE.s3Tier2],
    ['S3 → internet', 'download das molduras', `${(outGb * 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`, outGb * PRICE.s3OutGb],
    ['CloudFront', 'requisições HTTPS e dados', n(cfRequests, 'requisições'), cfRequests * PRICE.cloudfrontRequest + cfGb * PRICE.cloudfrontOutGb],
    ['DynamoDB', 'escritas e leituras', n(writes + reads, 'unidades'), writes * PRICE.dynamoWrite + reads * PRICE.dynamoRead],
    ['CloudWatch Logs', 'ingestão', `${(logsGb * 1024).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} MB`, logsGb * PRICE.logsGb],
  ].sort((a, b) => b[3] - a[3]);
}

const usd = (v) => `US$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: v < 0.01 ? 6 : 4 })}`;
const brl = (v) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: v < 0.01 ? 5 : 2 })}`;

function el(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}

function update() {
  const num = (id, min) => Math.max(min, Number($(id).value) || 0);
  const selfies = num('#selfies', 1);
  const fx = num('#fx', 0);
  const rows = compute({ selfies, polls: num('#polls', 0), perSession: num('#per-session', 1), freeTier: $('#free-tier').checked });
  const total = rows.reduce((s, r) => s + r[3], 0);
  const perSelfie = total / selfies;

  const stats = [
    [usd(total), `total para ${selfies.toLocaleString('pt-BR')} selfies`],
    [brl(total * fx), 'total em reais'],
    [usd(perSelfie), 'média por selfie'],
    [brl(perSelfie * fx), 'média por selfie em reais'],
    [perSelfie ? Math.floor(1 / perSelfie).toLocaleString('pt-BR') : '∞', 'selfies por US$ 1'],
  ];
  $('#totals').replaceChildren(...stats.map(([v, label], i) => {
    const box = el('div', undefined, i === 2 ? 'stat highlight' : 'stat');
    box.append(el('b', v), el('span', label));
    return box;
  }));
  $('#rows').replaceChildren(...rows.map(([service, what, qty, cost]) => {
    const pct = total ? `${((cost / total) * 100).toFixed(0)}%` : '—';
    const tr = document.createElement('tr');
    tr.append(el('td', service), el('td', what, 'muted'), el('td', qty), el('td', usd(cost)), el('td', pct));
    return tr;
  }));
}

for (const id of ['#selfies', '#polls', '#per-session', '#fx', '#free-tier']) $(id).addEventListener('input', update);
update();
