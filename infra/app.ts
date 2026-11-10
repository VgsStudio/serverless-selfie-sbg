// Entrada do CDK. Nenhum ID de conta, zona ou ARN fica no código:
// tudo vem de variáveis de ambiente (local: shell; CI: GitHub "variables").
import { App } from 'aws-cdk-lib';
import { SelfieStack } from './selfie-stack.ts';
import { OidcStack } from './oidc-stack.ts';

const required = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Defina ${name} (ver .env.example e README).`);
  return v;
};

const app = new App();
// us-east-1 fixo: o certificado do CloudFront precisa estar nessa região.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' };

new SelfieStack(app, 'ServerlessSelfie-App', {
  env,
  zoneName: process.env.ZONE_NAME ?? 'vsoller.com.br',
  hostedZoneId: required('HOSTED_ZONE_ID'),
  domainName: process.env.APP_DOMAIN ?? 'serverless-selfie.vsoller.com.br',
  cognitoDomainPrefix: process.env.COGNITO_DOMAIN_PREFIX ?? 'vgs-serverless-selfie',
  eventEndsAt: process.env.EVENT_ENDS_AT ?? '2026-11-15T02:59:59Z', // fim do dia 14/11 em Brasília
});

// Só cria o papel do GitHub Actions quando a claim do repositório é informada.
if (process.env.GITHUB_REPO_CLAIM) {
  new OidcStack(app, 'ServerlessSelfie-Oidc', { env, githubRepoClaim: process.env.GITHUB_REPO_CLAIM });
}
