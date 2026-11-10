import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, type NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as r53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface SelfieStackProps extends StackProps {
  zoneName: string;
  hostedZoneId: string;
  domainName: string;
  cognitoDomainPrefix: string;
  eventEndsAt: string;
}

/**
 * Tudo da demo numa stack: site (CloudFront + S3), API (API Gateway + Lambda),
 * estado (DynamoDB), upload → evento (S3 → EventBridge) → workflow (Step Functions),
 * login do painel (Cognito) e observabilidade (CloudWatch).
 * Não toca em nada do site principal: subdomínio, distribuição e buckets próprios.
 */
export class SelfieStack extends Stack {
  constructor(scope: Construct, id: string, props: SelfieStackProps) {
    super(scope, id, props);
    const origin = `https://${props.domainName}`;

    // ---------- Dados ----------
    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
      globalSecondaryIndexes: [{
        indexName: 'byType',
        partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      }],
    });

    const privateBucket: s3.BucketProps = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    };

    // Entrada: versionada (a versão aceita fica fixada no 1º evento) e com
    // eventos para o EventBridge. Saída: bucket separado, não dispara nada.
    const inputBucket = new s3.Bucket(this, 'InputBucket', {
      ...privateBucket,
      versioned: true,
      eventBridgeEnabled: true,
      cors: [{ allowedOrigins: [origin], allowedMethods: [s3.HttpMethods.POST], allowedHeaders: ['*'], maxAge: 600 }],
      lifecycleRules: [
        { expiration: Duration.days(1), noncurrentVersionExpiration: Duration.days(1), abortIncompleteMultipartUploadAfter: Duration.days(1) },
        { expiredObjectDeleteMarker: true },
      ],
    });
    const outputBucket = new s3.Bucket(this, 'OutputBucket', {
      ...privateBucket,
      cors: [{ allowedOrigins: [origin], allowedMethods: [s3.HttpMethods.GET], allowedHeaders: ['*'], maxAge: 600 }],
      lifecycleRules: [{ expiration: Duration.days(1) }],
    });
    const webBucket = new s3.Bucket(this, 'WebBucket', privateBucket);

    // ---------- Lambdas ----------
    const environment = {
      TABLE_NAME: table.tableName,
      INPUT_BUCKET: inputBucket.bucketName,
      OUTPUT_BUCKET: outputBucket.bucketName,
      ALLOWED_ORIGIN: origin,
      EVENT_ENDS_AT: props.eventEndsAt,
    };
    const fn = (name: string, file: string, handler: string, extra: Partial<NodejsFunctionProps> = {}) =>
      new NodejsFunction(this, name, {
        entry: path.join(ROOT, 'services', file),
        handler,
        projectRoot: ROOT,
        depsLockFilePath: path.join(ROOT, 'package-lock.json'),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: Duration.seconds(10),
        environment,
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
        bundling: {
          minify: true,
          externalModules: [], // empacota o SDK junto: versão fixa pelo lockfile
          loader: { '.png': 'binary', '.jpg': 'binary' },
        },
        ...extra,
      });

    const apiFn = fn('ApiFn', 'api.ts', 'handler');
    const adminFn = fn('AdminFn', 'admin.ts', 'handler', { timeout: Duration.seconds(29) });
    const claimFn = fn('ClaimFn', 'pipeline.ts', 'claim');
    const validateFn = fn('ValidateFn', 'pipeline.ts', 'validate');
    const renderFn = fn('RenderFn', 'pipeline.ts', 'render', { memorySize: 2048, timeout: Duration.seconds(60) });
    const sweepFn = fn('SweepFn', 'api.ts', 'sweep', { timeout: Duration.seconds(60) });

    for (const f of [apiFn, adminFn, claimFn, validateFn, renderFn, sweepFn]) table.grantReadWriteData(f);
    inputBucket.grantPut(adminFn, 'uploads/*');
    inputBucket.grantRead(validateFn, 'uploads/*');
    inputBucket.grantRead(renderFn, 'uploads/*');
    outputBucket.grantPut(renderFn, 'outputs/*');
    // API: assina upload (Put), assina download (Get) e apaga dados a pedido.
    for (const f of [apiFn, sweepFn]) f.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [inputBucket.arnForObjects('uploads/*')],
    }));
    for (const f of [apiFn, sweepFn]) f.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [outputBucket.arnForObjects('outputs/*')],
    }));
    for (const f of [apiFn, sweepFn]) f.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucketVersions', 's3:ListBucket'],
      resources: [inputBucket.bucketArn, outputBucket.bucketArn],
    }));

    // Painel: lê a concorrência de Lambda da conta (métrica e limite).
    adminFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricData', 'lambda:GetAccountSettings'],
      resources: ['*'], // essas duas ações não aceitam recurso específico
    }));

    // Retenção: a cada 10 min apaga trabalhos vencidos (45 min) → nada passa de ~1 h.
    new events.Rule(this, 'SweepSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(10)),
      targets: [new eventTargets.LambdaFunction(sweepFn)],
    });

    // ---------- Workflow ----------
    const retryTransient = (t: tasks.LambdaInvoke) => {
      t.addRetry({ errors: ['InvalidImage'], maxAttempts: 0 }); // entrada inválida não se repete
      // Concorrência esgotada (conta com cota baixa, lote da demo): espera e tenta de novo.
      t.addRetry({
        errors: ['Lambda.TooManyRequestsException'],
        interval: Duration.seconds(2), backoffRate: 2, maxAttempts: 6, maxDelay: Duration.seconds(20), jitterStrategy: sfn.JitterType.FULL,
      });
      t.addRetry({ errors: [sfn.Errors.ALL], interval: Duration.seconds(2), backoffRate: 2, maxAttempts: 2, jitterStrategy: sfn.JitterType.FULL });
      return t;
    };
    const jobKey = { pk: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.format('JOB#{}', sfn.JsonPath.stringAt('$.jobId'))) };
    const str = (v: string) => tasks.DynamoAttributeValue.fromString(v);
    const enteredTime = str(sfn.JsonPath.stringAt('$$.State.EnteredTime'));

    const claim = retryTransient(new tasks.LambdaInvoke(this, 'Reivindicar trabalho', {
      lambdaFunction: claimFn,
      payloadResponseOnly: true,
      payload: sfn.TaskInput.fromObject({
        key: sfn.JsonPath.stringAt('$.detail.object.key'),
        versionId: sfn.JsonPath.stringAt('$.detail.object.version-id'),
        executionArn: sfn.JsonPath.stringAt('$$.Execution.Id'),
      }),
    }));
    const validate = retryTransient(new tasks.LambdaInvoke(this, 'Validar e normalizar', { lambdaFunction: validateFn, payloadResponseOnly: true }));
    const renderTask = (format: 'story' | 'square', label: string) =>
      retryTransient(new tasks.LambdaInvoke(this, label, {
        lambdaFunction: renderFn,
        payloadResponseOnly: true,
        payload: sfn.TaskInput.fromObject({
          jobId: sfn.JsonPath.stringAt('$.jobId'),
          versionId: sfn.JsonPath.stringAt('$.versionId'),
          focus: sfn.JsonPath.objectAt('$.focus'),
          failOnce: sfn.JsonPath.objectAt('$.failOnce'),
          format,
        }),
      }));
    const outputs = new sfn.Parallel(this, 'Gerar saidas', { resultPath: '$.outputs' })
      .branch(renderTask('story', 'Gerar Story 1080x1920'))
      .branch(renderTask('square', 'Gerar quadrado 1080x1080'));

    // Concluir/falhar: integração direta com o DynamoDB. A condição impede que
    // um trabalho excluído ou expirado "ressuscite" no fim do workflow.
    const complete = new tasks.DynamoUpdateItem(this, 'Registrar conclusao', {
      table,
      key: jobKey,
      updateExpression: 'SET #s = :c, completedAt = :t, updatedAt = :t',
      conditionExpression: '#s = :p',
      expressionAttributeNames: { '#s': 'status' },
      expressionAttributeValues: { ':c': str('COMPLETED'), ':p': str('PROCESSING'), ':t': enteredTime },
      resultPath: sfn.JsonPath.DISCARD,
    });
    complete.addCatch(new sfn.Succeed(this, 'Excluido durante o processamento'), { errors: ['DynamoDB.ConditionalCheckFailedException'] });

    const markFailed = new tasks.DynamoUpdateItem(this, 'Registrar falha', {
      table,
      key: jobKey,
      updateExpression: 'SET #s = :f, errorCode = :e, updatedAt = :t',
      conditionExpression: '#s IN (:r, :p)',
      expressionAttributeNames: { '#s': 'status' },
      expressionAttributeValues: {
        ':f': str('FAILED'), ':r': str('RECEIVED'), ':p': str('PROCESSING'),
        ':e': str(sfn.JsonPath.stringAt('$.error.Error')), ':t': enteredTime,
      },
      resultPath: sfn.JsonPath.DISCARD,
    });
    markFailed.addCatch(new sfn.Succeed(this, 'Trabalho ja finalizado'), { errors: ['DynamoDB.ConditionalCheckFailedException'] });
    markFailed.next(new sfn.Fail(this, 'Trabalho falhou', { causePath: '$.error.Cause', errorPath: '$.error.Error' }));
    validate.addCatch(markFailed, { resultPath: '$.error' });
    outputs.addCatch(markFailed, { resultPath: '$.error' });

    const definition = claim.next(
      new sfn.Choice(this, 'Novo trabalho?')
        .when(sfn.Condition.stringEquals('$.action', 'process'),
          validate.next(outputs).next(complete).next(new sfn.Succeed(this, 'Concluido')))
        .otherwise(new sfn.Succeed(this, 'Evento duplicado ignorado')),
    );
    const stateMachine = new sfn.StateMachine(this, 'Workflow', {
      stateMachineName: 'serverless-selfie-sbg',
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.minutes(5),
    });

    // ---------- Evento: upload → workflow ----------
    const dlq = new sqs.Queue(this, 'EventsDlq', { retentionPeriod: Duration.days(4), enforceSSL: true });
    new events.Rule(this, 'UploadCreated', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: { bucket: { name: [inputBucket.bucketName] }, object: { key: events.Match.prefix('uploads/') } },
      },
      targets: [new eventTargets.SfnStateMachine(stateMachine, { deadLetterQueue: dlq, retryAttempts: 4, maxEventAge: Duration.hours(1) })],
    });
    new cloudwatch.Alarm(this, 'EventsDlqAlarm', {
      alarmDescription: 'Evento de upload não chegou ao workflow (ver fila DLQ).',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ---------- Login do painel (Cognito, só o apresentador) ----------
    const userPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: 'serverless-selfie-admin',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      passwordPolicy: { minLength: 14, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    userPool.addDomain('AdminDomain', {
      cognitoDomain: { domainPrefix: props.cognitoDomainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const adminRedirect = `${origin}/admin.html`;
    const userPoolClient = userPool.addClient('AdminSpa', {
      generateSecret: false,
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [adminRedirect],
        logoutUrls: [adminRedirect],
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.hours(12),
    });
    new cognito.CfnManagedLoginBranding(this, 'AdminLoginBranding', {
      userPoolId: userPool.userPoolId,
      clientId: userPoolClient.userPoolClientId,
      settings: {
        categories: { global: { colorSchemeMode: 'DARK' } },
        components: {
          pageBackground: { image: { enabled: false }, darkMode: { color: '1a0f3dff' } },
          form: { borderRadius: 16, darkMode: { backgroundColor: '251a52ff', borderColor: '3d3175ff' } },
          primaryButton: {
            darkMode: {
              defaults: { backgroundColor: '655cc6ff', textColor: 'ffffffff' },
              hover: { backgroundColor: '7a72d6ff', textColor: 'ffffffff' },
              active: { backgroundColor: '5249a8ff', textColor: 'ffffffff' },
            },
          },
        },
      },
    });

    // ---------- API ----------
    // Sem CORS: o navegador fala com a API pela mesma origem (CloudFront /api/*).
    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', { createDefaultStage: false });
    new apigwv2.HttpStage(this, 'Stage', { httpApi, stageName: '$default', autoDeploy: true, throttle: { rateLimit: 25, burstLimit: 50 } });
    const apiInt = new HttpLambdaIntegration('ApiInt', apiFn);
    const adminInt = new HttpLambdaIntegration('AdminInt', adminFn);
    const authorizer = new HttpUserPoolAuthorizer('AdminAuthorizer', userPool, { userPoolClients: [userPoolClient] });
    const M = apigwv2.HttpMethod;
    const routes: [string, apigwv2.HttpMethod, boolean][] = [
      ['/api/sessions', M.POST, false],
      ['/api/sessions/current', M.DELETE, false],
      ['/api/jobs', M.POST, false],
      ['/api/jobs/{jobId}', M.GET, false],
      ['/api/jobs/{jobId}', M.DELETE, false],
      ['/api/jobs/{jobId}/result', M.GET, false],
      ['/api/admin/dashboard', M.GET, true],
      ['/api/admin/load', M.POST, true],
      ['/api/admin/stop', M.POST, true],
      ['/api/admin/retry-demo', M.POST, true],
      ['/api/admin/accepting', M.POST, true],
    ];
    for (const [p, method, admin] of routes) {
      httpApi.addRoutes({ path: p, methods: [method], integration: admin ? adminInt : apiInt, ...(admin ? { authorizer } : {}) });
    }

    // ---------- Site: CloudFront com S3 (estático) e API na mesma origem ----------
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: props.zoneName });
    const certificate = new acm.Certificate(this, 'Cert', { domainName: props.domainName, validation: acm.CertificateValidation.fromDns(zone) });
    const cognitoDomain = `https://${props.cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com`;
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      `img-src 'self' blob: data:`,
      `connect-src 'self' https://*.s3.amazonaws.com https://*.s3.${this.region}.amazonaws.com ${cognitoDomain}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; ');
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
      },
    });
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      domainNames: [props.domainName],
      certificate,
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
      },
      additionalBehaviors: {
        // Respostas privadas: nada de cache compartilhado; cookies e Authorization vão para a origem.
        '/api/*': {
          origin: new origins.HttpOrigin(Fn.select(2, Fn.split('/', httpApi.apiEndpoint))),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
      },
    });
    const alias = route53.RecordTarget.fromAlias(new r53targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, 'AliasA', { zone, recordName: props.domainName, target: alias });
    new route53.AaaaRecord(this, 'AliasAAAA', { zone, recordName: props.domainName, target: alias });

    // ---------- Observabilidade ----------
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', { dashboardName: 'serverless-selfie-sbg' });
    const fns: Record<string, lambda.IFunction> = { api: apiFn, admin: adminFn, claim: claimFn, validate: validateFn, render: renderFn, sweep: sweepFn };
    const per = (metric: string, statistic: string) =>
      Object.entries(fns).map(([label, f]) => f.metric(metric, { statistic, period: Duration.minutes(1), label }));
    const graph = (title: string, metrics: cloudwatch.IMetric[]) => new cloudwatch.GraphWidget({ title, left: metrics, width: 8, height: 6 });
    dashboard.addWidgets(
      graph('Invocations (Sum) — volume', per('Invocations', 'Sum')),
      graph('ConcurrentExecutions (Maximum) — simultaneidade', per('ConcurrentExecutions', 'Maximum')),
      graph('Duration (Average)', per('Duration', 'Average')),
    );
    dashboard.addWidgets(
      graph('Duration (p95)', per('Duration', 'p95')),
      graph('Errors (Sum) — tentativas que falharam', per('Errors', 'Sum')),
      graph('Throttles (Sum)', per('Throttles', 'Sum')),
    );
    dashboard.addWidgets(
      graph('Workflow: execuções', [
        stateMachine.metricStarted({ period: Duration.minutes(1), label: 'iniciadas' }),
        stateMachine.metricSucceeded({ period: Duration.minutes(1), label: 'concluídas' }),
        stateMachine.metricFailed({ period: Duration.minutes(1), label: 'falharam' }),
      ]),
      graph('Eventos na DLQ', [dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) })]),
    );

    // ---------- Publicação do site ----------
    // admin-config.json é gerado no deploy: os IDs nunca ficam no repositório.
    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [
        s3deploy.Source.asset(path.join(ROOT, 'web')),
        s3deploy.Source.jsonData('admin-config.json', {
          region: this.region,
          cognitoDomain,
          clientId: userPoolClient.userPoolClientId,
          redirectUri: adminRedirect,
          dashboardName: 'serverless-selfie-sbg',
          stateMachineArn: stateMachine.stateMachineArn,
          inputBucket: inputBucket.bucketName,
          outputBucket: outputBucket.bucketName,
          tableName: table.tableName,
        }),
      ],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    new CfnOutput(this, 'Url', { value: origin });
    new CfnOutput(this, 'AdminUrl', { value: adminRedirect });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'StateMachineArn', { value: stateMachine.stateMachineArn });
    new CfnOutput(this, 'InputBucketName', { value: inputBucket.bucketName });
    new CfnOutput(this, 'OutputBucketName', { value: outputBucket.bucketName });
    new CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
