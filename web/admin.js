// Painel do apresentador. Login no Cognito (Authorization Code + PKCE): a
// senha é digitada na página do Cognito, nunca aqui. Os IDs vêm de
// /admin-config.json, gerado no deploy — nada disso fica no repositório.
const $ = (s) => document.querySelector(s);
const TOKENS = 'selfie-admin:tokens';
const VERIFIER = 'selfie-admin:verifier';
let cfg;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fail(err) {
  $('#error').textContent = err?.message || String(err);
  $('#error').hidden = false;
}

// ---------- autenticação ----------
const loadTokens = () => { try { return JSON.parse(sessionStorage.getItem(TOKENS)); } catch { return null; } };
const saveTokens = (t) => sessionStorage.setItem(TOKENS, JSON.stringify({ ...t, obtainedAt: Date.now() }));

async function login() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(VERIFIER, verifier);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = new URL(`${cfg.cognitoDomain}/oauth2/authorize`);
  Object.entries({
    response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri,
    scope: 'openid email', code_challenge_method: 'S256', code_challenge: challenge,
  }).forEach(([k, v]) => url.searchParams.set(k, v));
  location.assign(url);
}

function logout() {
  sessionStorage.removeItem(TOKENS);
  const url = new URL(`${cfg.cognitoDomain}/logout`);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('logout_uri', cfg.redirectUri);
  location.assign(url);
}

async function token(body) {
  const res = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, ...body }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function idToken() {
  const code = new URLSearchParams(location.search).get('code');
  if (code) {
    history.replaceState({}, '', location.pathname);
    const t = await token({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri, code_verifier: sessionStorage.getItem(VERIFIER) || '' });
    sessionStorage.removeItem(VERIFIER);
    if (t) saveTokens(t);
  }
  let t = loadTokens();
  if (t && Date.now() - t.obtainedAt > (t.expires_in - 60) * 1000) {
    const fresh = t.refresh_token && (await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token }));
    if (fresh) saveTokens((t = { ...fresh, refresh_token: t.refresh_token }));
    else { sessionStorage.removeItem(TOKENS); t = null; }
  }
  return t?.id_token ?? null;
}

async function api(path, body) {
  const jwt = await idToken();
  if (!jwt) { showLogin(); throw new Error('Sessão expirada, entre de novo.'); }
  const res = await fetch(`/api/admin${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Erro ${res.status}`);
  return data;
}

function showLogin() {
  $('#login').hidden = false;
  $('#panel').hidden = true;
}

// ---------- painel ----------
const fmt = (ms) => (ms === undefined || ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const consoleUrl = (service, hash) => `https://${cfg.region}.console.aws.amazon.com/${service}/home?region=${cfg.region}#${hash}`;

function el(tag, text, attrs = {}) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  Object.assign(e, attrs);
  return e;
}

function render(d) {
  const p = d.counts.participants;
  const s = d.counts.synthetic;
  const stats = [
    [d.meta.sessions, 'sessões anônimas'],
    [sum(p), 'selfies da turma'],
    [p.COMPLETED ?? 0, 'da turma concluídas'],
    [(p.PROCESSING ?? 0) + (p.RECEIVED ?? 0), 'da turma processando'],
    [sum(s), 'sintéticos'],
    [s.COMPLETED ?? 0, 'sintéticos concluídos'],
    [(p.FAILED ?? 0) + (s.FAILED ?? 0), 'falhas definitivas'],
    [fmt(d.durations.endToEnd?.avgMs), 'ponta a ponta (média)'],
    [fmt(d.durations.processing?.p95Ms), 'processamento (p95)'],
  ];
  $('#stats').replaceChildren(...stats.map(([v, label]) => {
    const box = el('div', undefined, { className: 'stat' });
    box.append(el('b', String(v)), el('span', label));
    return box;
  }));

  $('#accepting').textContent = d.meta.accepting ? '⏸ Encerrar entrada de novas selfies' : '▶ Reabrir entrada';
  $('#accepting').dataset.accepting = String(d.meta.accepting);

  $('#jobs').replaceChildren(...d.recent.map((j) => {
    const tr = document.createElement('tr');
    const id = el('td', j.jobId.slice(0, 12) + '…', { className: 'mono', title: 'Clique para copiar o jobId' });
    id.addEventListener('click', () => navigator.clipboard.writeText(j.jobId));
    const exec = el('td');
    if (j.executionArn) exec.append(el('a', 'abrir', { href: consoleUrl('states', `/v2/executions/details/${j.executionArn}`), target: '_blank', rel: 'noopener' }));
    const status = el('td');
    status.append(el('span', j.status + (j.errorCode ? ` (${j.errorCode})` : ''), { className: `tag ${j.status}` }));
    tr.append(id, el('td', j.isSynthetic ? (j.failOnce ? 'sintético · retry' : 'sintético') : 'turma'), status, el('td', fmt(j.endToEndMs)), el('td', fmt(j.processingMs)), exec);
    return tr;
  }));
}

async function refresh() {
  try {
    render(await api('/dashboard'));
    $('#error').hidden = true;
  } catch (e) {
    fail(e);
  }
}

async function action(label, fn) {
  $('#action-status').textContent = `${label}…`;
  try {
    $('#action-status').textContent = `${label}: ${JSON.stringify(await fn())}`;
  } catch (e) {
    $('#action-status').textContent = '';
    fail(e);
  }
  refresh();
}

(async () => {
  try {
    cfg = await (await fetch('admin-config.json', { cache: 'no-store' })).json();
  } catch {
    return fail('admin-config.json ausente — ele é gerado no deploy.');
  }
  $('#login-btn').addEventListener('click', login);
  if (!(await idToken())) return showLogin();

  $('#panel').hidden = false;
  const links = [
    ['Dashboard CloudWatch', consoleUrl('cloudwatch', `dashboards/dashboard/${cfg.dashboardName}`)],
    ['Step Functions', consoleUrl('states', `/statemachines/view/${cfg.stateMachineArn}`)],
    ['S3 entrada', `https://s3.console.aws.amazon.com/s3/buckets/${cfg.inputBucket}?region=${cfg.region}&prefix=uploads/`],
    ['S3 saída', `https://s3.console.aws.amazon.com/s3/buckets/${cfg.outputBucket}?region=${cfg.region}&prefix=outputs/`],
    ['DynamoDB', consoleUrl('dynamodbv2', `item-explorer?table=${cfg.tableName}`)],
  ];
  $('#links').replaceChildren(...links.map(([t, href]) => el('a', t, { href, target: '_blank', rel: 'noopener', className: 'btn ghost' })));

  $('#load').addEventListener('click', () => action('Lote', () => api('/load', { count: Number($('#count').value), intervalMs: Number($('#interval').value) })));
  $('#stop').addEventListener('click', () => action('Parar', () => api('/stop', {})));
  $('#retry').addEventListener('click', () => action('Falha controlada', () => api('/retry-demo', {})));
  $('#accepting').addEventListener('click', (e) =>
    action('Entrada', () => api('/accepting', { accepting: e.target.dataset.accepting !== 'true' })));
  $('#logout').addEventListener('click', logout);

  await refresh();
  setInterval(refresh, 3000);
})();
