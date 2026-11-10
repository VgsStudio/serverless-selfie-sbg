// API administrativa (painel do apresentador). Toda rota aqui passa pelo
// JWT authorizer do Cognito no API Gateway — a Lambda nem é invocada sem
// um token válido. Nada de foto, sessão ou token no que é devolvido.
import { BatchWriteCommand, GetCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudWatchClient, GetMetricDataCommand, type MetricDataResult } from '@aws-sdk/client-cloudwatch';
import { GetAccountSettingsCommand, LambdaClient } from '@aws-sdk/client-lambda';
import sample from '../web/sample.jpg';
import {
  INPUT_BUCKET, LIMITS, META_PK, TABLE, ddb, effectiveStatus, epoch, error, inputKey, json, jobPk, log,
  listJobs, newId, parseBody, removeJob, s3, type HttpEvent, type HttpResult, type Job,
} from './common.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cw = new CloudWatchClient({});
const lambdaClient = new LambdaClient({});
let accountLimit: number | undefined;

/** Concorrência de Lambda na conta, minuto a minuto, nos últimos 15 min.
 *  É a mesma métrica do dashboard (ConcurrentExecutions, Maximum), trazida
 *  para o painel. O CloudWatch publica com ~1–2 min de atraso. */
async function lambdaMetrics() {
  const end = new Date();
  const start = new Date(end.getTime() - 15 * 60_000);
  const q = (Id: string, MetricName: string, Stat: string) =>
    ({ Id, MetricStat: { Metric: { Namespace: 'AWS/Lambda', MetricName }, Period: 60, Stat } });
  const out = await cw.send(new GetMetricDataCommand({
    StartTime: start,
    EndTime: end,
    ScanBy: 'TimestampAscending',
    MetricDataQueries: [q('conc', 'ConcurrentExecutions', 'Maximum'), q('thr', 'Throttles', 'Sum'), q('inv', 'Invocations', 'Sum')],
  }));
  const r: Record<string, MetricDataResult> = Object.fromEntries((out.MetricDataResults ?? []).map((m) => [m.Id, m]));
  const total = (id: string) => (r[id]?.Values ?? []).reduce((a: number, b: number) => a + b, 0);
  accountLimit ??= (await lambdaClient.send(new GetAccountSettingsCommand({}))).AccountLimit?.ConcurrentExecutions;
  const conc: MetricDataResult = r.conc ?? {};
  return {
    windowMinutes: 15,
    limit: accountLimit,
    peak: Math.max(0, ...(conc.Values ?? [])),
    throttles: total('thr'),
    invocations: total('inv'),
    series: (conc.Timestamps ?? []).map((t: Date, i: number) => ({ t: t.toISOString(), v: conc.Values![i] })),
  };
}

async function getMeta() {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: META_PK } }));
  return Item ?? {};
}

const setMeta = (field: 'accepting' | 'loadStop', value: boolean) =>
  ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: META_PK },
    UpdateExpression: 'SET #f = :v',
    ExpressionAttributeNames: { '#f': field },
    ExpressionAttributeValues: { ':v': value },
  }));

/** Trabalho sintético: mesmo caminho da turma (upload no S3 → evento →
 *  workflow), marcado como isSynthetic e com teto próprio. */
async function createSynthetic(failOnce: boolean): Promise<string> {
  const jobId = newId();
  const now = Date.now();
  const job: Job = {
    pk: jobPk(jobId),
    jobId,
    sessionId: 'synthetic',
    status: 'AWAITING_UPLOAD',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LIMITS.retentionSeconds * 1000).toISOString(),
    uploadExpiresAt: new Date(now + LIMITS.uploadUrlSeconds * 1000).toISOString(),
    contentType: 'image/jpeg',
    sizeBytes: sample.byteLength,
    focusX: 0.5,
    focusY: 0.5,
    isSynthetic: true,
    failOnce,
    gsi1pk: 'JOB',
    ttl: epoch(now + LIMITS.retentionSeconds * 1000),
  };
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLE, Item: job, ConditionExpression: 'attribute_not_exists(pk)' } },
      {
        Update: {
          TableName: TABLE,
          Key: { pk: META_PK },
          UpdateExpression: 'ADD synthetic :one',
          ConditionExpression: 'attribute_not_exists(synthetic) OR synthetic < :max',
          ExpressionAttributeValues: { ':one': 1, ':max': LIMITS.maxSyntheticJobs },
        },
      },
    ],
  }));
  await s3.send(new PutObjectCommand({ Bucket: INPUT_BUCKET, Key: inputKey(jobId), Body: sample, ContentType: 'image/jpeg' }));
  return jobId;
}

const ms = (a?: string, b?: string) => (a && b ? Date.parse(b) - Date.parse(a) : undefined);

function stats(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    avgMs: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

async function dashboard(): Promise<HttpResult> {
  const jobs = await listJobs();

  const counts: Record<'participants' | 'synthetic', Record<string, number>> = { participants: {}, synthetic: {} };
  // Processadas = chegaram a COMPLETED, mesmo que a pessoa tenha excluído depois.
  const processed = { participants: 0, synthetic: 0 };
  const endToEnd: number[] = [];
  const processing: number[] = [];
  for (const j of jobs) {
    const group = counts[j.isSynthetic ? 'synthetic' : 'participants'];
    const s = effectiveStatus(j);
    group[s] = (group[s] ?? 0) + 1;
    if (j.completedAt) processed[j.isSynthetic ? 'synthetic' : 'participants']++;
    if (j.completedAt) {
      endToEnd.push(ms(j.createdAt, j.completedAt)!);
      processing.push(ms(j.receivedAt, j.completedAt)!);
    }
  }

  const [meta, lambda] = await Promise.all([
    getMeta(),
    lambdaMetrics().catch((e) => { console.error(e); return null; }), // painel funciona mesmo sem métricas
  ]);
  return json(200, {
    meta: {
      sessions: meta.sessions ?? 0,
      jobs: meta.jobs ?? 0,
      synthetic: meta.synthetic ?? 0,
      accepting: meta.accepting !== false,
      loadStop: meta.loadStop === true,
    },
    limits: LIMITS,
    counts,
    processed,
    lambda,
    durations: { endToEnd: stats(endToEnd), processing: stats(processing) },
    recent: jobs.slice(0, 30).map((j) => ({
      jobId: j.jobId,
      isSynthetic: j.isSynthetic,
      failOnce: j.failOnce === true,
      status: effectiveStatus(j),
      createdAt: j.createdAt,
      endToEndMs: ms(j.createdAt, j.completedAt),
      processingMs: ms(j.receivedAt, j.completedAt),
      errorCode: j.errorCode,
      executionArn: j.executionArn,
    })),
  });
}

async function load(event: HttpEvent, rid: string): Promise<HttpResult> {
  const body = parseBody(event);
  const count = Number(body.count ?? 10);
  const intervalMs = Number(body.intervalMs ?? 500);
  if (!Number.isInteger(count) || count < 1 || count > 20) return error(400, 'COUNT', 'count deve ser de 1 a 20.', rid);
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 2000) return error(400, 'INTERVAL', 'intervalMs de 0 a 2000.', rid);
  // A integração HTTP do API Gateway corta em 30 s: o lote inteiro cabe nisso.
  if (count * intervalMs > 25_000) return error(400, 'DURATION', 'count × intervalMs precisa ficar abaixo de 25 s.', rid);

  await setMeta('loadStop', false);
  const created: string[] = [];
  let stopped = false;
  for (let i = 0; i < count; i++) {
    if ((await getMeta()).loadStop === true) { stopped = true; break; }
    try {
      created.push(await createSynthetic(false));
    } catch (e) {
      if ((e as Error).name === 'TransactionCanceledException') { stopped = true; break; } // teto sintético
      throw e;
    }
    if (i < count - 1) await sleep(intervalMs);
  }
  log('admin.load', { requested: count, created: created.length, stopped, requestId: rid });
  return json(200, { created: created.length, stopped, jobIds: created });
}

// Escopos da limpeza: tudo (zera o painel), só sintéticos, ou criados antes de X minutos.
const CLEANUP_MINUTES: Record<string, number> = { '15m': 15, '1h': 60, '3h': 180 };

async function sessionKeys(): Promise<{ pk: string }[]> {
  const keys: { pk: string }[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: 'pk',
      FilterExpression: 'begins_with(pk, :s)',
      ExpressionAttributeValues: { ':s': 'SESSION#' },
      ExclusiveStartKey,
    }));
    keys.push(...((out.Items ?? []) as { pk: string }[]));
    ExclusiveStartKey = out.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return keys;
}

/** Limpeza pelo painel. Com dryRun só conta; sem ele apaga arquivos (todas as
 *  versões) e registros. "all" também apaga sessões e zera os contadores. */
async function cleanup(event: HttpEvent, rid: string): Promise<HttpResult> {
  const body = parseBody(event);
  const scope = String(body.scope ?? '');
  if (!(scope === 'all' || scope === 'synthetic' || scope in CLEANUP_MINUTES)) {
    return error(400, 'SCOPE', 'scope deve ser all, synthetic, 15m, 1h ou 3h.', rid);
  }
  const cutoff = scope in CLEANUP_MINUTES ? new Date(Date.now() - CLEANUP_MINUTES[scope] * 60_000).toISOString() : '';
  const jobs = (await listJobs()).filter((j) =>
    scope === 'all' || (scope === 'synthetic' ? j.isSynthetic : j.createdAt < cutoff));
  const sessions = scope === 'all' ? await sessionKeys() : [];

  if (body.dryRun === true) return json(200, { scope, jobs: jobs.length, sessions: sessions.length, resetsCounters: scope === 'all' });

  // Em lotes de 10 para caber nos 30 s da integração do API Gateway.
  for (let i = 0; i < jobs.length; i += 10) await Promise.all(jobs.slice(i, i + 10).map(removeJob));
  for (let i = 0; i < sessions.length; i += 25) {
    await ddb.send(new BatchWriteCommand({
      RequestItems: { [TABLE]: sessions.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) },
    }));
  }
  if (scope === 'all' || scope === 'synthetic') {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: META_PK },
      UpdateExpression: scope === 'all' ? 'SET sessions = :z, jobs = :z, synthetic = :z' : 'SET synthetic = :z',
      ExpressionAttributeValues: { ':z': 0 },
    }));
  }
  log('admin.cleanup', { scope, jobs: jobs.length, sessions: sessions.length, requestId: rid });
  return json(200, { scope, jobs: jobs.length, sessions: sessions.length, resetsCounters: scope === 'all' });
}

export async function handler(event: HttpEvent): Promise<HttpResult> {
  const rid = event.requestContext.requestId;
  try {
    switch (event.routeKey) {
      case 'GET /api/admin/dashboard':
        return await dashboard();
      case 'POST /api/admin/load':
        return await load(event, rid);
      case 'POST /api/admin/stop':
        await setMeta('loadStop', true);
        return json(200, { ok: true });
      case 'POST /api/admin/retry-demo': {
        const jobId = await createSynthetic(true);
        log('admin.retryDemo', { jobId, requestId: rid });
        return json(201, { jobId });
      }
      case 'POST /api/admin/cleanup':
        return await cleanup(event, rid);
      case 'POST /api/admin/accepting': {
        const accepting = parseBody(event).accepting;
        if (typeof accepting !== 'boolean') return error(400, 'ACCEPTING', 'accepting deve ser booleano.', rid);
        await setMeta('accepting', accepting);
        log('admin.accepting', { accepting, requestId: rid });
        return json(200, { accepting });
      }
    }
    return error(404, 'ROUTE', 'Rota desconhecida.', rid);
  } catch (e) {
    console.error(e);
    return error(500, 'INTERNAL', 'Erro interno.', rid);
  }
}
