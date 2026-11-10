// Código compartilhado pelas Lambdas: clientes AWS, limites e helpers HTTP.
// Tudo que é configurável chega por variável de ambiente definida no CDK.
import { createHash, randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
export const s3 = new S3Client({});

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`variável de ambiente ausente: ${name}`);
  return v;
};

export const TABLE = env('TABLE_NAME', 'test-table');
export const INPUT_BUCKET = env('INPUT_BUCKET', 'test-input');
export const OUTPUT_BUCKET = env('OUTPUT_BUCKET', 'test-output');

export const LIMITS = {
  maxUploadBytes: Number(env('MAX_UPLOAD_BYTES', String(8 * 1024 * 1024))),
  maxPixels: Number(env('MAX_PIXELS', String(20_000_000))),
  jobsPerSession: Number(env('JOBS_PER_SESSION', '3')),
  maxJobs: Number(env('MAX_JOBS', '100')),
  maxSessions: Number(env('MAX_SESSIONS', '100')),
  maxSyntheticJobs: Number(env('MAX_SYNTHETIC_JOBS', '100')),
  sessionSeconds: Number(env('SESSION_SECONDS', String(2 * 3600))),
  // 45 min + varredura a cada 10 min (sweep) = nada fica mais de ~1 h.
  retentionSeconds: Number(env('RETENTION_SECONDS', String(45 * 60))),
  // Registro anônimo (horários, status; sem foto nem token) para as estatísticas do painel.
  statsSeconds: Number(env('STATS_SECONDS', String(30 * 24 * 3600))),
  uploadUrlSeconds: Number(env('UPLOAD_URL_SECONDS', '120')),
  resultUrlSeconds: Number(env('RESULT_URL_SECONDS', '120')),
  eventEndsAt: env('EVENT_ENDS_AT', '2026-11-15T02:59:59Z'),
};

export const ALLOWED_ORIGIN = env('ALLOWED_ORIGIN', 'https://localhost');

// Chaves do DynamoDB (tabela única, atributo `pk`).
export const META_PK = 'META#event';
export const jobPk = (jobId: string) => `JOB#${jobId}`;
export const sessionPk = (tokenHash: string) => `SESSION#${tokenHash}`;

export const inputKey = (jobId: string) => `uploads/${jobId}/original`;
export const outputKey = (jobId: string, format: string) => `outputs/${jobId}/${format}.jpg`;
export const JOB_KEY_RE = /^uploads\/([a-f0-9]{32})\/original$/;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const newId = () => randomBytes(16).toString('hex');
export const nowIso = () => new Date().toISOString();
export const epoch = (ms = Date.now()) => Math.floor(ms / 1000);

export type JobStatus =
  | 'AWAITING_UPLOAD' | 'RECEIVED' | 'PROCESSING' | 'COMPLETED'
  | 'FAILED' | 'EXPIRED' | 'DELETION_PENDING';

export interface Job {
  pk: string;
  jobId: string;
  sessionId: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  uploadExpiresAt: string;
  contentType: string;
  sizeBytes: number;
  focusX: number;
  focusY: number;
  isSynthetic: boolean;
  failOnce?: boolean;
  failedOnce?: boolean;
  inputVersionId?: string;
  executionArn?: string;
  receivedAt?: string;
  completedAt?: string;
  errorCode?: string;
  leaseUntil?: number;
  purgedAt?: string;
  gsi1pk: 'JOB';
  ttl: number;
}

/** TTL do registro anônimo (estatística), não da foto. */
export const statsTtl = (ms = Date.now()) => epoch(ms + LIMITS.statsSeconds * 1000);

/** Estado visto pelo cliente: prazos vencidos viram EXPIRED na leitura,
 *  sem depender de quando o TTL/Lifecycle apagam fisicamente. */
export function effectiveStatus(job: Pick<Job, 'status' | 'expiresAt' | 'uploadExpiresAt'>, now = Date.now()): JobStatus {
  if (job.status === 'DELETION_PENDING') return job.status;
  if (now > Date.parse(job.expiresAt)) return 'EXPIRED';
  // Trabalho criado e nunca enviado: vence 5 min depois da autorização de upload.
  if (job.status === 'AWAITING_UPLOAD' && now > Date.parse(job.uploadExpiresAt) + 5 * 60_000) return 'EXPIRED';
  return job.status;
}

export interface HttpEvent {
  rawPath: string;
  routeKey: string;
  headers: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  pathParameters?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  requestContext: { requestId: string; http: { method: string } };
}

export interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  cookies?: string[];
}

export function json(statusCode: number, body: unknown, cookies?: string[]): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
    ...(cookies ? { cookies } : {}),
  };
}

export const error = (statusCode: number, code: string, message: string, requestId: string) =>
  json(statusCode, { error: code, message, requestId });

export function parseBody(event: HttpEvent): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Log estruturado. Nunca passar token, cookie, URL assinada ou imagem aqui. */
export const log = (msg: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ msg, ...fields }));

/** Todos os trabalhos do evento, mais novos primeiro (GSI byType).
 *  ponytail: lê tudo numa partição (≤ ~200 itens); com volume real, agregados no META. */
export async function listJobs(sinceIso?: string): Promise<Job[]> {
  return listByType<Job>('JOB', sinceIso);
}

/** Itens do GSI byType (JOB ou SESSION), opcionalmente só os criados desde `sinceIso`. */
export async function listByType<T>(type: 'JOB' | 'SESSION', sinceIso?: string): Promise<T[]> {
  const jobs: T[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'byType',
      KeyConditionExpression: sinceIso ? 'gsi1pk = :j AND createdAt >= :since' : 'gsi1pk = :j',
      ExpressionAttributeValues: sinceIso ? { ':j': type, ':since': sinceIso } : { ':j': type },
      ScanIndexForward: false,
      ExclusiveStartKey,
    }));
    jobs.push(...((out.Items ?? []) as T[]));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return jobs;
}

/** Apaga todas as versões de entrada e saída de um trabalho. */
export async function deleteJobObjects(jobId: string) {
  for (const [Bucket, Prefix] of [[INPUT_BUCKET, `uploads/${jobId}/`], [OUTPUT_BUCKET, `outputs/${jobId}/`]]) {
    const out = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix }));
    const Objects = [...(out.Versions ?? []), ...(out.DeleteMarkers ?? [])].map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
    if (Objects.length) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }));
  }
}

/** Remove o trabalho por completo: arquivos (todas as versões) e registro. */
export async function removeJob(job: Pick<Job, 'jobId' | 'pk'>) {
  await deleteJobObjects(job.jobId);
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: job.pk } }));
}

/** Vencido: apaga foto e molduras (todas as versões) e mantém só o registro
 *  anônimo do trabalho para as estatísticas, até o TTL de 30 dias. */
export async function purgeJob(job: Pick<Job, 'jobId' | 'pk'>) {
  await deleteJobObjects(job.jobId);
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: job.pk },
    UpdateExpression: 'SET purgedAt = :now',
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':now': nowIso() },
  })).catch((e) => { if ((e as Error).name !== 'ConditionalCheckFailedException') throw e; });
}
