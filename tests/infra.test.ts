// Garante as decisões de segurança/arquitetura no template sintetizado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SelfieStack } from '../infra/selfie-stack.ts';

const t = Template.fromStack(new SelfieStack(new App(), 'Test', {
  zoneName: 'example.com', hostedZoneId: 'Z000TEST', domainName: 'selfie.example.com',
  cognitoDomainPrefix: 'test-prefix', eventEndsAt: '2026-11-15T02:59:59Z',
}));

test('buckets bloqueiam acesso público e exigem TLS', () => {
  const buckets = t.findResources('AWS::S3::Bucket');
  assert.equal(Object.keys(buckets).length, 3);
  for (const b of Object.values(buckets)) {
    assert.deepEqual(b.Properties.PublicAccessBlockConfiguration, {
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    });
  }
  t.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Condition: { Bool: { 'aws:SecureTransport': 'false' } }, Effect: 'Deny' })]) },
  });
});

test('só as rotas /api/admin/* exigem JWT do Cognito', () => {
  const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map((r) => r.Properties);
  assert.equal(routes.length, 11);
  for (const r of routes) {
    const isAdmin = String(r.RouteKey).includes('/api/admin/');
    assert.equal(r.AuthorizationType, isAdmin ? 'JWT' : 'NONE', r.RouteKey);
  }
});

test('evento só de uploads/ do bucket de entrada vai para o workflow, com DLQ', () => {
  t.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: { source: ['aws.s3'], 'detail-type': ['Object Created'], detail: { object: { key: [{ prefix: 'uploads/' }] } } },
    Targets: [Match.objectLike({ DeadLetterConfig: Match.anyValue(), RetryPolicy: Match.anyValue() })],
  });
  t.hasResourceProperties('AWS::StepFunctions::StateMachine', { StateMachineType: 'STANDARD' });
});

test('nenhum usuário pode se cadastrar sozinho no painel e MFA é obrigatório', () => {
  t.hasResourceProperties('AWS::Cognito::UserPool', {
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    MfaConfiguration: 'ON',
  });
});
