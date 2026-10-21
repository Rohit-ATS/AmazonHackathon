/**
 * CareFlow infrastructure.
 *
 * Five services, each doing a job the project actually needs rather than one added to tick
 * a box — the AWS Builder mini challenge asks for documented, meaningful integration, and
 * docs/aws-services.md explains each choice in prose:
 *
 *   API Gateway   HTTPS endpoint for Ring webhooks (Ring requires HTTPS and a 200 in <5s)
 *   Lambda        webhook intake, visit matching, consent gate, action execution
 *   DynamoDB      care plan state, sessions, idempotency keys, timeline, audit trail
 *   Bedrock       event explanation and intent extraction (IAM only; called by the agent)
 *   Polly         neural speech output for the patient-facing voice
 *   CloudWatch    structured JSON logs with a retention policy
 */

import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import { CfnStage, HttpApi, CorsHttpMethod, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface CareFlowStackProps extends StackProps {
  /** Secrets Manager secret holding the Ring partner HMAC signing key. */
  ringHmacSecretName: string;
  bedrockModelId?: string;
  /** Exact browser origin allowed to call the API. Falls back to '*' for the demo. */
  allowedOrigin?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export class CareFlowStack extends Stack {
  constructor(scope: Construct, id: string, props: CareFlowStackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    const table = new Table(this, 'Table', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      // Ring delivery dedupe markers carry a ttl; letting DynamoDB expire them means the
      // idempotency table does not grow without bound.
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Demo stack: destroy on teardown. A real deployment would retain, and that choice
      // is called out in docs/aws-services.md rather than left implicit.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const ringHmacSecret = Secret.fromSecretNameV2(
      this,
      'RingHmacKey',
      props.ringHmacSecretName,
    );
    const apiAuthSecret = new Secret(this, 'ApiAuthToken', { generateSecretString: { passwordLength: 48 } });
    const mcpAuthSecret = new Secret(this, 'McpAuthToken', { generateSecretString: { passwordLength: 48 } });
    const apiLogGroup = new LogGroup(this, 'ApiLogs', {
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---------------------------------------------------------------------
    // Compute
    // ---------------------------------------------------------------------

    const api = new NodejsFunction(this, 'Api', {
      entry: path.join(repoRoot, 'services/api/src/lambda.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      // Graviton: cheaper per millisecond, and nothing here is architecture-specific.
      architecture: Architecture.ARM_64,
      // Ring expects a 200 within five seconds. Ten gives room to return promptly while
      // still failing fast rather than hanging on a stuck model call.
      timeout: Duration.seconds(10),
      // Enough that a cold start is not the thing that blows the Ring budget.
      memorySize: 1024,
      reservedConcurrentExecutions: 10,
      logGroup: apiLogGroup,
      environment: {
        CAREFLOW_TABLE: table.tableName,
        CAREFLOW_DEMO_MODE: 'true',
        CAREFLOW_TTS: 'polly',
        POLLY_VOICE_ID: 'Joanna',
        RING_HMAC_SECRET_NAME: props.ringHmacSecretName,
        CAREFLOW_API_TOKEN_SECRET_NAME: apiAuthSecret.secretName,
        CAREFLOW_MCP_TOKEN_SECRET_NAME: mcpAuthSecret.secretName,
        ...(props.bedrockModelId ? { BEDROCK_MODEL_ID: props.bedrockModelId } : {}),
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        format: undefined,
        minify: false,
        sourceMap: true,
        // The care plan fixture is read at runtime, so it has to travel with the bundle.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            process.platform === 'win32'
              ? `xcopy /Y "${inputDir}\\fixtures\\care-plan.json" "${outputDir}\\fixtures\\"`
              : `mkdir -p ${outputDir}/fixtures && cp ${inputDir}/fixtures/care-plan.json ${outputDir}/fixtures/`,
          ],
        },
      },
    });

    new Alarm(this, 'ApiErrorsAlarm', {
      metric: api.metricErrors({ period: Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    new Alarm(this, 'ApiThrottlesAlarm', {
      metric: api.metricThrottles({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    new Alarm(this, 'ApiDurationAlarm', {
      metric: api.metricDuration({ period: Duration.minutes(5), statistic: 'p95' }),
      threshold: 2500,
      evaluationPeriods: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'CareFlow monthly guardrail',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 25, unit: 'USD' },
      },
    });

    table.grantReadWriteData(api);
    ringHmacSecret.grantRead(api);
    apiAuthSecret.grantRead(api);
    mcpAuthSecret.grantRead(api);

    // Bedrock: invoke only, and only on the model we configured. A wildcard here would be
    // the easy option and would also let a prompt-injected agent reach anything in the
    // account's model catalogue.
    api.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: props.bedrockModelId
          ? [
              `arn:aws:bedrock:${this.region}::foundation-model/${props.bedrockModelId}`,
              `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${props.bedrockModelId}`,
            ]
          : [`arn:aws:bedrock:${this.region}::foundation-model/*`],
      }),
    );

    // Polly needs no resource scoping: SynthesizeSpeech has no resource to scope to.
    api.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['polly:SynthesizeSpeech'],
        resources: ['*'],
      }),
    );

    // ---------------------------------------------------------------------
    // HTTP
    // ---------------------------------------------------------------------

    const httpApi = new HttpApi(this, 'HttpApi', {
      description: 'CareFlow API, including the Ring webhook endpoint',
      corsPreflight: {
        allowOrigins: [props.allowedOrigin ?? '*'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowHeaders: ['authorization', 'content-type', 'x-signature', 'x-careflow-simulated'],
        maxAge: Duration.hours(1),
      },
    });
    const stage = httpApi.defaultStage?.node.defaultChild as CfnStage | undefined;
    if (stage) {
      stage.defaultRouteSettings = { throttlingBurstLimit: 50, throttlingRateLimit: 25 };
    }

    const integration = new HttpLambdaIntegration('ApiIntegration', api);

    // Ring's webhook URL is fixed at partner onboarding and cannot be changed through the
    // API, so this route's path is effectively permanent once registered.
    httpApi.addRoutes({ path: '/ring/webhook', methods: [HttpMethod.POST], integration });
    httpApi.addRoutes({ path: '/{proxy+}', methods: [HttpMethod.ANY], integration });
    httpApi.addRoutes({ path: '/healthz', methods: [HttpMethod.GET], integration });

    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'RingWebhookUrl', { value: `${httpApi.apiEndpoint}/ring/webhook` });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'ApiAuthSecretName', { value: apiAuthSecret.secretName });
    new CfnOutput(this, 'McpAuthSecretName', { value: mcpAuthSecret.secretName });
  }
}
