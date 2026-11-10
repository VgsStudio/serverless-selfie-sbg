// Site público. Sem build, sem dependências. A sessão é um cookie HttpOnly
// emitido pela API — este JS nunca vê o token.
const $ = (s) => document.querySelector(s);
const STEPS = ['pick', 'crop', 'progress', 'result'];
const STATUS_STEP = { AWAITING_UPLOAD: 'upload', RECEIVED: 'event', PROCESSING: 'process', COMPLETED: 'done' };
const ORDER = ['job', 'upload', 'event', 'process', 'done'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = { image: null, focus: { x: 0.5, y: 0.5 }, idem: null, jobId: null, outputs: {} };

function show(step) {
  for (const s of STEPS) $(`#step-${s}`).hidden = s !== step;
  $('#error').hidden = true;
}

function fail(err) {
  const el = $('#error');
  el.textContent = err?.message || 'Algo deu errado. Tente de novo.';
  el.hidden = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// 429/5xx = throttle ou falha temporária (ex.: Lambdas ocupadas no lote da demo):
// espera e tenta de novo até 3 vezes. É seguro: criar trabalho usa Idempotency-Key.
async function api(path, options = {}) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`/api${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    if (!(res.status === 429 || res.status >= 500) || attempt === 3) break;
    await sleep(800 * 2 ** attempt);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || `Erro ${res.status}`), { status: res.status, code: body.error });
  return body;
}

// ---------- 1. foto ----------
// Reencoda no navegador para JPEG ≤ 2048 px: reduz o upload, aplica a
// orientação e converte HEIC quando o navegador sabe abrir. O backend
// valida e processa de novo de qualquer jeito.
async function normalize(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Não consegui abrir esse formato neste navegador. Use JPEG/PNG ou a imagem de exemplo.');
  }
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
}

async function pick(blob) {
  try {
    state.image = await normalize(blob);
    state.focus = { x: 0.5, y: 0.5 };
    state.idem = crypto.randomUUID(); // mesma chave em novas tentativas = mesmo trabalho
    const img = $('#crop-img');
    URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(state.image);
    applyFocus();
    show('crop');
  } catch (e) {
    fail(e);
  }
}

for (const id of ['#camera', '#gallery']) {
  $(id).addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) pick(file);
  });
}
$('#use-sample').addEventListener('click', async () => pick(await (await fetch('sample.jpg')).blob()));
$('#change').addEventListener('click', () => show('pick'));

// ---------- 2. enquadramento (arrastar = object-position) ----------
function applyFocus() {
  $('#crop-img').style.objectPosition = `${state.focus.x * 100}% ${state.focus.y * 100}%`;
}
{
  const box = $('#crop');
  let last = null;
  box.addEventListener('pointerdown', (e) => { last = e; box.setPointerCapture(e.pointerId); });
  box.addEventListener('pointerup', () => { last = null; });
  box.addEventListener('pointermove', (e) => {
    if (!last) return;
    const img = $('#crop-img');
    const scale = Math.max(box.clientWidth / img.naturalWidth, box.clientHeight / img.naturalHeight);
    const overX = img.naturalWidth * scale - box.clientWidth;
    const overY = img.naturalHeight * scale - box.clientHeight;
    const clamp = (v) => Math.min(1, Math.max(0, v));
    if (overX > 0) state.focus.x = clamp(state.focus.x - (e.clientX - last.clientX) / overX);
    if (overY > 0) state.focus.y = clamp(state.focus.y - (e.clientY - last.clientY) / overY);
    last = e;
    applyFocus();
  });
}

// ---------- 3. criar trabalho, enviar e acompanhar ----------
function mark(step, pct) {
  const current = ORDER.indexOf(step);
  document.querySelectorAll('.timeline li').forEach((li) => {
    const i = ORDER.indexOf(li.dataset.step);
    li.className = i < current ? 'done' : i === current ? 'active' : '';
  });
  $('#upload-pct').textContent = pct === undefined ? '' : `${pct}%`;
}

function uploadOnce({ url, fields }, blob) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', blob); // o arquivo precisa ser o último campo do POST
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && mark('upload', Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error('O envio da imagem foi recusado. Tente de novo.')));
    xhr.onerror = () => reject(Object.assign(new Error('Não consegui enviar a imagem: a conexão caiu ou esta rede bloqueia o armazenamento da AWS. Tente de novo ou troque de rede (Wi-Fi ↔ 4G).'), { network: true }));
    xhr.send(form);
  });
}

// Oscilação de rede no celular é comum: tenta de novo uma vez, com a mesma
// autorização (vale 2 min). Recusa do S3 (4xx) não é repetida.
async function upload(target, blob) {
  try {
    await uploadOnce(target, blob);
  } catch (e) {
    if (!e.network) throw e;
    await sleep(1500);
    await uploadOnce(target, blob);
  }
}

async function generate() {
  const btn = $('#generate');
  btn.disabled = true;
  try {
    show('progress');
    mark('job');
    const job = await api('/jobs', {
      method: 'POST',
      headers: { 'idempotency-key': state.idem },
      body: JSON.stringify({ contentType: state.image.type, sizeBytes: state.image.size, focus: state.focus }),
    });
    state.jobId = job.jobId;
    $('#job-id').textContent = job.jobId;
    if (job.upload) {
      mark('upload', 0);
      await upload(job.upload, state.image);
    } else if (job.status === 'AWAITING_UPLOAD') {
      // Repetiu o pedido depois que a autorização de envio venceu.
      state.idem = crypto.randomUUID();
      throw new Error('A autorização de envio expirou. Toque em “Gerar minha moldura” de novo.');
    }
    mark('event');
    await poll(job.jobId);
  } catch (e) {
    show('crop');
    fail(e);
  } finally {
    btn.disabled = false;
  }
}
$('#generate').addEventListener('click', generate);

// Polling com recuo; para no estado final ou depois de 2 min (o trabalho
// continua na nuvem — dá para consultar de novo).
async function poll(jobId) {
  $('#poll-again').hidden = true;
  const started = Date.now();
  let delay = 2000;
  while (Date.now() - started < 120_000) {
    const job = await api(`/jobs/${jobId}`);
    if (job.status === 'COMPLETED') return showResult(jobId);
    if (job.status === 'FAILED') throw new Error('Não deu para processar essa imagem. Tente outra foto ou a imagem de exemplo.');
    if (job.status === 'EXPIRED') throw new Error('Esse trabalho expirou. Escolha a foto de novo.');
    mark(STATUS_STEP[job.status] === 'upload' ? 'event' : STATUS_STEP[job.status]);
    await sleep(delay);
    delay = Math.min(delay * 1.3, 6000);
  }
  $('#poll-again').hidden = false;
}
$('#poll-again').addEventListener('click', () => poll(state.jobId).catch(fail));

// ---------- 4. resultado ----------
async function showResult(jobId) {
  mark('done');
  const { outputs } = await api(`/jobs/${jobId}/result`);
  // Baixa já: a URL assinada vale poucos minutos e o compartilhamento
  // precisa do arquivo pronto antes do toque no botão.
  for (const o of outputs) {
    const blob = await (await fetch(o.url)).blob();
    state.outputs[o.format] = new File([blob], `serverless-selfie-sbg-${o.format}.jpg`, { type: 'image/jpeg' });
  }
  const img = $('#result-story');
  URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(state.outputs.story);
  $('#story-help').hidden = true;
  show('result');
}

function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// O site não consegue abrir o editor de Stories direto: usa o menu nativo
// (Web Share) e, sem suporte, salva a imagem e orienta o caminho manual.
$('#share-story').addEventListener('click', async () => {
  const data = { files: [state.outputs.story] };
  if (navigator.canShare?.(data)) {
    try {
      await navigator.share(data);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  download(state.outputs.story);
  $('#story-help').hidden = false;
});
$('#download-story').addEventListener('click', () => download(state.outputs.story));
$('#download-square').addEventListener('click', () => download(state.outputs.square));
$('#again').addEventListener('click', () => show('pick'));

$('#delete-job').addEventListener('click', async () => {
  try {
    await api(`/jobs/${state.jobId}`, { method: 'DELETE' });
    state.outputs = {};
    show('pick');
  } catch (e) {
    fail(e);
  }
});
$('#delete-all').addEventListener('click', async () => {
  if (!confirm('Excluir todas as suas fotos e encerrar esta sessão?')) return;
  try {
    await api('/sessions/current', { method: 'DELETE' });
    state.outputs = {};
    show('pick');
    await startSession();
  } catch (e) {
    fail(e);
  }
});

// ---------- início: cria (ou reaproveita) a sessão anônima ----------
async function startSession() {
  return api('/sessions', { method: 'POST' });
}

(async () => {
  try {
    const s = await startSession();
    const last = s.jobIds?.at(-1);
    if (!last) return;
    // Recarregou a página? Retoma o último trabalho desta sessão.
    const job = await api(`/jobs/${last}`).catch(() => null);
    if (!job || ['FAILED', 'EXPIRED'].includes(job.status)) return;
    state.jobId = last;
    $('#job-id').textContent = last;
    if (job.status === 'COMPLETED') return showResult(last);
    if (job.status !== 'AWAITING_UPLOAD') {
      show('progress');
      await poll(last);
    }
  } catch (e) {
    fail(e);
  }
})();
