// Tarefas do workflow (Step Functions). Cada export é o handler de uma Lambda:
//   claim    → reivindica o trabalho (idempotência + lease), fixa a versão do upload
//   validate → confere tipo real, dimensões e tamanho lendo só o cabeçalho
//   render   → gera uma saída (story ou square); roda em paralelo, um por formato
// Concluir e marcar falha são integrações diretas do Step Functions com o
// DynamoDB (ver infra), sem Lambda só para repassar chamada.
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import storyFrame from './assets/frame-story.png';
import squareFrame from './assets/frame-square.png';
import { InvalidImage, render as compose, validate as checkImage, type Format } from './image.ts';
import {
  INPUT_BUCKET, JOB_KEY_RE, LIMITS, OUTPUT_BUCKET, TABLE, ddb, epoch, inputKey, jobPk, log, nowIso, outputKey, s3,
} from './common.ts';

const LEASE_SECONDS = 5 * 60;
const FRAMES: Record<Format, Buffer> = { story: Buffer.from(storyFrame), square: Buffer.from(squareFrame) };

export interface Work {
  action: 'process' | 'skip';
  jobId?: string;
  versionId?: string;
  focus?: { x: number; y: number };
  failOnce?: boolean;
  reason?: string;
}

/** Falha transitória provocada de propósito na demo de Retry. */
class DemoTransientError extends Error {
  override name = 'DemoTransientError';
}

const isConditionFail = (e: unknown) => (e as Error).name === 'ConditionalCheckFailedException';

export async function claim(input: { key: string; versionId: string; executionArn: string }): Promise<Work> {
  const m = JOB_KEY_RE.exec(input.key);
  if (!m) return { action: 'skip', reason: 'UNKNOWN_KEY' };
  const jobId = m[1];
  const now = nowIso();
  try {
    // Aceita: (a) primeiro evento de um upload esperado; (b) retomada de um
    // processamento abandonado (lease vencida) da MESMA versão. Evento
    // repetido, reenvio de outro arquivo ou job concluído/excluído caem fora.
    const out = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: jobPk(jobId) },
      UpdateExpression:
        'SET #s = :received, inputVersionId = :v, receivedAt = if_not_exists(receivedAt, :now), leaseUntil = :lease, executionArn = :exec, updatedAt = :now',
      ConditionExpression:
        '(#s = :awaiting AND expiresAt > :now) OR (#s IN (:received, :processing) AND inputVersionId = :v AND leaseUntil < :epoch)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':received': 'RECEIVED', ':processing': 'PROCESSING', ':awaiting': 'AWAITING_UPLOAD',
        ':v': input.versionId, ':now': now, ':epoch': epoch(), ':lease': epoch() + LEASE_SECONDS, ':exec': input.executionArn,
      },
      ReturnValues: 'ALL_NEW',
    }));
    const job = out.Attributes!;
    log('job.claimed', { jobId, executionArn: input.executionArn });
    return { action: 'process', jobId, versionId: input.versionId, focus: { x: job.focusX, y: job.focusY }, failOnce: job.failOnce === true };
  } catch (e) {
    if (!isConditionFail(e)) throw e;
    // Duplicata não é falha: o trabalho original segue intacto.
    log('job.duplicateIgnored', { jobId, executionArn: input.executionArn });
    return { action: 'skip', jobId, reason: 'DUPLICATE_OR_STALE' };
  }
}

export async function validate(work: Work): Promise<Work> {
  const out = await s3.send(new GetObjectCommand({
    Bucket: INPUT_BUCKET, Key: inputKey(work.jobId!), VersionId: work.versionId, Range: 'bytes=0-524287', // folga para EXIF/ICC grandes antes do SOF
  }));
  const total = Number(/\/(\d+)$/.exec(out.ContentRange ?? '')?.[1] ?? out.ContentLength);
  if (total > LIMITS.maxUploadBytes) throw new InvalidImage('arquivo acima do limite');
  const head = await out.Body!.transformToByteArray();
  const info = checkImage(head, LIMITS.maxPixels);

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: jobPk(work.jobId!) },
    UpdateExpression: 'SET #s = :p, updatedAt = :now',
    ConditionExpression: '#s IN (:r, :p) AND inputVersionId = :v',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':p': 'PROCESSING', ':r': 'RECEIVED', ':v': work.versionId, ':now': nowIso() },
  }));
  log('job.validated', { jobId: work.jobId, ...info });
  return work;
}

export async function render(input: Work & { format: Format }): Promise<{ format: Format; key: string }> {
  const { jobId, format } = input;

  if (input.failOnce && format === 'story') {
    // Contador persistente (não variável em memória): falha só na 1ª tentativa,
    // mesmo que a nova tentativa caia em outro ambiente de execução.
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk: jobPk(jobId!) },
        UpdateExpression: 'SET failedOnce = :t',
        ConditionExpression: 'attribute_not_exists(failedOnce)',
        ExpressionAttributeValues: { ':t': true },
      }));
      log('job.demoFailure', { jobId });
      throw new DemoTransientError('falha controlada para demonstrar Retry');
    } catch (e) {
      if (!isConditionFail(e)) throw e;
    }
  }

  const obj = await s3.send(new GetObjectCommand({ Bucket: INPUT_BUCKET, Key: inputKey(jobId!), VersionId: input.versionId }));
  const bytes = Buffer.from(await obj.Body!.transformToByteArray());
  const started = Date.now();
  const jpeg = await compose(bytes, format, FRAMES[format], input.focus);
  const key = outputKey(jobId!, format); // chave determinística: repetir sobrescreve, não duplica
  await s3.send(new PutObjectCommand({ Bucket: OUTPUT_BUCKET, Key: key, Body: jpeg, ContentType: 'image/jpeg' }));
  log('job.rendered', { jobId, format, ms: Date.now() - started, bytes: jpeg.length });
  return { format, key };
}
