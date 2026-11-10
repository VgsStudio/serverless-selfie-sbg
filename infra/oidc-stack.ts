import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export interface OidcStackProps extends StackProps {
  /** Parte "repo:..." da claim `sub` do GitHub, ex.: `Owner@123/serverless-selfie-sbg@456`
   *  (formato imutável com IDs) ou `Owner/serverless-selfie-sbg`. */
  githubRepoClaim: string;
}

/** Deixa o GitHub Actions (só na branch main) rodar `cdk deploy` sem access key.
 *  Pressupõe o provedor OIDC do GitHub já criado na conta (mesmo dos outros projetos). */
export class OidcStack extends Stack {
  constructor(scope: Construct, id: string, props: OidcStackProps) {
    super(scope, id, props);
    const q = 'hnb659fds'; // qualificador padrão do cdk bootstrap
    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'github-actions-serverless-selfie-deploy',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(
        `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
        {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          StringLike: { 'token.actions.githubusercontent.com:sub': `repo:${props.githubRepoClaim}:ref:refs/heads/main` },
        },
      ),
    });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(
        (r) => `arn:aws:iam::${this.account}:role/cdk-${q}-${r}-role-${this.account}-${this.region}`,
      ),
    }));
  }
}
