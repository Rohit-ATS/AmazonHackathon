#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { CareFlowStack } from '../lib/careflow-stack.js';

const app = new App();

new CareFlowStack(app, 'CareFlow', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description:
    'CareFlow: voice-first care access with Ring. Lambda + API Gateway + DynamoDB + Bedrock + Polly.',
  // Passed through to the Lambda. Must be the Ring partner HMAC key in a real deployment —
  // see docs/aws-services.md for how it is stored.
  ringHmacSecretName: process.env.RING_HMAC_SECRET_NAME ?? 'careflow/ring-hmac-key',
  bedrockModelId: process.env.BEDROCK_MODEL_ID,
  allowedOrigin: process.env.CAREFLOW_WEB_ORIGIN,
});
