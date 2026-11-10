// Limpeza pós-evento: apaga TODAS as versões dos buckets de entrada e saída
// e todos os itens da tabela (inclusive contadores) da stack desta demo.
// Só mexe nos recursos listados nos outputs de ServerlessSelfie-App.
//
//   npm run event:cleanup            → dry-run (só conta)
//   npm run event:cleanup -- --yes   → apaga de verdade
//
// Usa as credenciais AWS do seu perfil local (SSO/IAM); nada fica no repo.
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { BatchWriteItemCommand, DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';

const STACK = process.env.STACK_NAME ?? 'ServerlessSelfie-App';
const apply = process.argv.includes('--yes');
const s3 = new S3Client({});
const ddb = new DynamoDBClient({});

const { Stacks } = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: STACK }));
const out = Object.fromEntries(Stacks[0].Outputs.map((o) => [o.OutputKey, o.OutputValue]));

for (const Bucket of [out.InputBucketName, out.OutputBucketName]) {
  let total = 0;
  let page = {};
  do {
    page = await s3.send(new ListObjectVersionsCommand({ Bucket, KeyMarker: page.NextKeyMarker, VersionIdMarker: page.NextVersionIdMarker }));
    const Objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
    total += Objects.length;
    if (apply && Objects.length) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects, Quiet: true } }));
  } while (page.IsTruncated);
  console.log(`${apply ? 'apagadas' : 'seriam apagadas'} ${total} versões em ${Bucket}`);
}

let items = 0;
let ExclusiveStartKey;
do {
  const page = await ddb.send(new ScanCommand({ TableName: out.TableName, ProjectionExpression: 'pk', ExclusiveStartKey }));
  items += page.Items.length;
  for (let i = 0; apply && i < page.Items.length; i += 25) {
    const RequestItems = { [out.TableName]: page.Items.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
    await ddb.send(new BatchWriteItemCommand({ RequestItems })); // ponytail: sem reenvio de UnprocessedItems; rode de novo se sobrar algo
  }
  ExclusiveStartKey = page.LastEvaluatedKey;
} while (ExclusiveStartKey);
console.log(`${apply ? 'apagados' : 'seriam apagados'} ${items} itens em ${out.TableName}`);
if (!apply) console.log('\nDry-run. Para executar: npm run event:cleanup -- --yes');
