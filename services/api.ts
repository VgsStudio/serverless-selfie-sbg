// API pública: sessão anônima, criação de trabalho, status, resultado e exclusão.
// Sem login para participantes: a autorização é o cookie de sessão (token
// aleatório, só o hash fica no banco) + o vínculo job.sessionId === sessão.
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import frames from './assets/frames.json' with { type: 'json' };
import {
  ALLOWED_ORIGIN, INPUT_BUCKET, LIMITS, META_PK, OUTPUT_BUCKET, TABLE, ddb, effectiveStatus, epoch, error,
  inputKey, json, jobPk, log, newId, newToken, nowIso, outputKey, parseBody, s3, sessionPk, sha256,
  type HttpEvent, type HttpResult, type Job,
} from './common.ts';

const COOKIE = 'sbg_session';
const JOB_ID_RE = /^[a-f0-9]{32}$/;
const IDEM_RE = /^[A-Za-z0-9-]{8,64}$/;
const CONTENT_TYPES = new Set(['image/jpeg', 'image/png']);

interface Session {
  pk: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  jobIds: string[];
  jobCount: number;
  ttl: number;
}

const cookie = (value: string, maxAge: number) =>
  `${COOKIE}=${value}; Path=/api; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

function readToken(event: HttpEvent): string | null {
  for (const c of event.cookies ?? []) {
    const [k, ...v] = c.split('=');
    if (k.trim() === COOKIE) return v.join('=').trim() || null;
  }
  return null;
}

async function getSession(event: HttpEvent): Promise<Session | null> {
  const token = readToken(event);
  if (!token) return null;
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: sessionPk(sha256(token)) } }));
  const s = Item as Session | undefined;
  if (!s || s.revokedAt || Date.parse(s.expiresAt) <= Date.now()) return null;
  return s;
}

async function getMeta() {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: META_PK } }));
  return Item ?? {};
}

async function eventClosed() {
  return Date.now() > Date.parse(LIMITS.eventEndsAt) || (await getMeta()).accepting === false;
}

/** 404 tanto para "não existe" quanto para "não é seu": evita enumeração. */
async function ownedJob(session: Session, jobId: string | undefined): Promise<Job | null> {
  if (!jobId || !JOB_ID_RE.test(jobId)) return null;
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: jobPk(jobId) } }));
  const job = Item as Job | undefined;
  if (!job || job.sessionId !== session.sessionId || job.status === 'DELETION_PENDING') return null;
  return job;
}

const publicJob = (job: Job) => ({
  jobId: job.jobId,
  status: effectiveStatus(job),
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  expiresAt: job.expiresAt,
  errorCode: job.errorCode,
});

const publicConfig = () => ({
  title: 'O que é arquitetura Serverless?',
  group: 'Student Builder Group IMT',
  date: '14/11/2026',
  maxUploadBytes: LIMITS.maxUploadBytes,
  jobsPerSession: LIMITS.jobsPerSession,
  retentionMinutes: Math.round(LIMITS.retentionSeconds / 60),
});

async function presignUpload(job: Job) {
  const seconds = Math.max(1, Math.floor((Date.parse(job.uploadExpiresAt) - Date.now()) / 1000));
  const post = await createPresignedPost(s3, {
    Bucket: INPUT_BUCKET,
    Key: inputKey(job.jobId),
    Conditions: [
      ['content-length-range', 1, LIMITS.maxUploadBytes],
      ['eq', '$Content-Type', job.contentType],
    ],
    Fields: { 'Content-Type': job.contentType },
    Expires: seconds,
  });
  return { url: post.url, fields: post.fields, expiresAt: job.uploadExpiresAt };
}

/** Apaga todas as versões de entrada e saída de um trabalho. */
async function deleteJobObjects(jobId: string) {
  for (const [Bucket, Prefix] of [[INPUT_BUCKET, `uploads/${jobId}/`], [OUTPUT_BUCKET, `outputs/${jobId}/`]]) {
    const out = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix }));
    const Objects = [...(out.Versions ?? []), ...(out.DeleteMarkers ?? [])].map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
    if (Objects.length) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }));
  }
}

async function markDeleted(jobId: string, sessionId: string) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: jobPk(jobId) },
      UpdateExpression: 'SET #s = :d, updatedAt = :now',
      ConditionExpression: 'sessionId = :sid',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':d': 'DELETION_PENDING', ':now': nowIso(), ':sid': sessionId },
    }));
  } catch (e) {
    if ((e as Error).name !== 'ConditionalCheckFailedException') throw e;
    return;
  }
  // O workflow só conclui trabalhos em PROCESSING, então um job excluído não
  // "ressuscita". Uma saída escrita durante a corrida é apagada pelo Lifecycle.
  await deleteJobObjects(jobId);
}

async function createSession(event: HttpEvent, rid: string): Promise<HttpResult> {
  const existing = await getSession(event);
  if (existing) return json(200, { expiresAt: existing.expiresAt, jobIds: existing.jobIds, config: publicConfig() });
  if (await eventClosed()) return error(403, 'EVENT_CLOSED', 'A geração de selfies está encerrada.', rid);

  const token = newToken();
  const now = Date.now();
  const expiresMs = Math.min(now + LIMITS.sessionSeconds * 1000, Date.parse(LIMITS.eventEndsAt));
  const session: Session = {
    pk: sessionPk(sha256(token)),
    sessionId: newId(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    jobIds: [],
    jobCount: 0,
    ttl: epoch(now + LIMITS.retentionSeconds * 1000),
  };
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { pk: META_PK },
            UpdateExpression: 'ADD sessions :one',
            ConditionExpression: '(attribute_not_exists(sessions) OR sessions < :max) AND (attribute_not_exists(accepting) OR accepting = :t)',
            ExpressionAttributeValues: { ':one': 1, ':max': LIMITS.maxSessions, ':t': true },
          },
        },
        { Put: { TableName: TABLE, Item: session, ConditionExpression: 'attribute_not_exists(pk)' } },
      ],
    }));
  } catch (e) {
    if ((e as Error).name === 'TransactionCanceledException') {
      return error(429, 'SESSION_LIMIT', 'Limite de sessões do evento atingido.', rid);
    }
    throw e;
  }
  log('session.created', { sessionId: session.sessionId, requestId: rid });
  const maxAge = Math.floor((expiresMs - now) / 1000);
  return json(201, { expiresAt: session.expiresAt, jobIds: [], config: publicConfig() }, [cookie(token, maxAge)]);
}

async function createJob(event: HttpEvent, session: Session, rid: string): Promise<HttpResult> {
  const idem = event.headers['idempotency-key'];
  if (!idem || !IDEM_RE.test(idem)) return error(400, 'IDEMPOTENCY_KEY', 'Cabeçalho Idempotency-Key ausente ou inválido.', rid);

  const body = parseBody(event);
  const contentType = String(body.contentType ?? '');
  const sizeBytes = Number(body.sizeBytes);
  const focus = (body.focus ?? {}) as { x?: unknown; y?: unknown };
  const fx = Number(focus.x ?? 0.5);
  const fy = Number(focus.y ?? 0.5);
  if (!CONTENT_TYPES.has(contentType)) return error(400, 'CONTENT_TYPE', 'Envie JPEG ou PNG.', rid);
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1) return error(400, 'SIZE', 'Tamanho inválido.', rid);
  if (sizeBytes > LIMITS.maxUploadBytes) return error(413, 'TOO_LARGE', 'Arquivo acima do limite.', rid);
  if (![fx, fy].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return error(400, 'FOCUS', 'Enquadramento inválido.', rid);

  // jobId derivado de sessão + chave: repetir o mesmo pedido cai no mesmo
  // trabalho e não consome outra cota.
  const jobId = sha256(`${session.sessionId}:${idem}`).slice(0, 32);
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: jobPk(jobId) } }));
  if (Item) {
    const job = Item as Job;
    if (job.sessionId !== session.sessionId || job.contentType !== contentType || job.sizeBytes !== sizeBytes) {
      return error(409, 'IDEMPOTENCY_MISMATCH', 'Mesma chave com conteúdo diferente.', rid);
    }
    const status = effectiveStatus(job);
    const uploadOpen = status === 'AWAITING_UPLOAD' && Date.now() < Date.parse(job.uploadExpiresAt);
    return json(200, { ...publicJob(job), ...(uploadOpen ? { upload: await presignUpload(job) } : {}) });
  }

  const now = Date.now();
  const job: Job = {
    pk: jobPk(jobId),
    jobId,
    sessionId: session.sessionId,
    status: 'AWAITING_UPLOAD',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LIMITS.retentionSeconds * 1000).toISOString(),
    uploadExpiresAt: new Date(now + LIMITS.uploadUrlSeconds * 1000).toISOString(),
    contentType,
    sizeBytes,
    focusX: fx,
    focusY: fy,
    isSynthetic: false,
    gsi1pk: 'JOB',
    ttl: epoch(now + LIMITS.retentionSeconds * 1000),
  };
  try {
    // Reserva de cota por sessão e global na mesma transação: requisições
    // simultâneas não conseguem passar do teto.
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: job, ConditionExpression: 'attribute_not_exists(pk)' } },
        {
          Update: {
            TableName: TABLE,
            Key: { pk: session.pk },
            UpdateExpression: 'SET jobCount = jobCount + :one, jobIds = list_append(jobIds, :ids)',
            ConditionExpression: 'jobCount < :per AND attribute_not_exists(revokedAt) AND expiresAt > :now',
            ExpressionAttributeValues: { ':one': 1, ':ids': [jobId], ':per': LIMITS.jobsPerSession, ':now': job.createdAt },
          },
        },
        {
          Update: {
            TableName: TABLE,
            Key: { pk: META_PK },
            UpdateExpression: 'ADD jobs :one',
            ConditionExpression: '(attribute_not_exists(jobs) OR jobs < :max) AND (attribute_not_exists(accepting) OR accepting = :t)',
            ExpressionAttributeValues: { ':one': 1, ':max': LIMITS.maxJobs, ':t': true },
          },
        },
      ],
    }));
  } catch (e) {
    if ((e as Error).name !== 'TransactionCanceledException') throw e;
    const reasons = (e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
    if (reasons[1]?.Code === 'ConditionalCheckFailed') {
      return error(429, 'SESSION_LIMIT', `Limite de ${LIMITS.jobsPerSession} selfies por sessão atingido.`, rid);
    }
    if (reasons[2]?.Code === 'ConditionalCheckFailed') {
      return error(429, 'EVENT_LIMIT', 'Limite de selfies do evento atingido ou entrada encerrada.', rid);
    }
    return error(409, 'CONFLICT', 'Pedido simultâneo com a mesma chave; tente de novo.', rid);
  }
  log('job.created', { jobId, sessionId: session.sessionId, requestId: rid });
  return json(201, { ...publicJob(job), upload: await presignUpload(job) });
}

async function jobResult(job: Job, rid: string): Promise<HttpResult> {
  if (effectiveStatus(job) !== 'COMPLETED') return error(409, 'NOT_READY', 'O trabalho ainda não foi concluído.', rid);
  const expiresAt = new Date(Date.now() + LIMITS.resultUrlSeconds * 1000).toISOString();
  const outputs = await Promise.all(
    (Object.keys(frames) as (keyof typeof frames)[]).map(async (format) => ({
      format,
      width: frames[format].width,
      height: frames[format].height,
      contentType: 'image/jpeg',
      expiresAt,
      url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: OUTPUT_BUCKET, Key: outputKey(job.jobId, format) }), {
        expiresIn: LIMITS.resultUrlSeconds,
      }),
    })),
  );
  return json(200, { jobId: job.jobId, outputs });
}

export async function handler(event: HttpEvent): Promise<HttpResult> {
  const rid = event.requestContext.requestId;
  const method = event.requestContext.http.method;
  try {
    // CSRF: escrita só a partir do próprio site. CORS não substitui isso.
    if (method !== 'GET' && event.headers.origin !== ALLOWED_ORIGIN) {
      return error(403, 'ORIGIN', 'Origem não permitida.', rid);
    }
    if (event.routeKey === 'POST /api/sessions') return await createSession(event, rid);

    const session = await getSession(event);
    if (!session) return error(401, 'NO_SESSION', 'Sessão ausente ou expirada. Recarregue a página.', rid);

    switch (event.routeKey) {
      case 'DELETE /api/sessions/current': {
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { pk: session.pk },
          UpdateExpression: 'SET revokedAt = :now',
          ExpressionAttributeValues: { ':now': nowIso() },
        }));
        for (const jobId of session.jobIds) await markDeleted(jobId, session.sessionId);
        log('session.deleted', { sessionId: session.sessionId, requestId: rid });
        return json(202, { ok: true }, [cookie('', 0)]);
      }
      case 'POST /api/jobs':
        return await createJob(event, session, rid);
    }

    const job = await ownedJob(session, event.pathParameters?.jobId);
    if (!job) return error(404, 'NOT_FOUND', 'Trabalho não encontrado.', rid);
    switch (event.routeKey) {
      case 'GET /api/jobs/{jobId}':
        return json(200, publicJob(job));
      case 'GET /api/jobs/{jobId}/result':
        return await jobResult(job, rid);
      case 'DELETE /api/jobs/{jobId}':
        await markDeleted(job.jobId, session.sessionId);
        log('job.deleted', { jobId: job.jobId, requestId: rid });
        return json(202, { ok: true });
    }
    return error(404, 'ROUTE', 'Rota desconhecida.', rid);
  } catch (e) {
    log('api.error', { requestId: rid, route: event.routeKey, error: (e as Error).name });
    console.error(e);
    return error(500, 'INTERNAL', 'Erro interno.', rid);
  }
}

/** Varredura agendada (EventBridge, a cada 10 min): apaga fotos, molduras e o
 *  registro dos trabalhos vencidos. Com retenção de 45 min, nada passa de ~1 h.
 *  TTL do DynamoDB e Lifecycle do S3 ficam só como rede de segurança. */
export async function sweep() {
  const now = nowIso();
  let removed = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'byType',
      KeyConditionExpression: 'gsi1pk = :j',
      FilterExpression: 'expiresAt < :now',
      ExpressionAttributeValues: { ':j': 'JOB', ':now': now },
      ExclusiveStartKey,
    }));
    for (const j of (out.Items ?? []) as Job[]) {
      await deleteJobObjects(j.jobId);
      await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: j.pk } }));
      removed++;
    }
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  log('sweep', { removed });
  return { removed };
}
