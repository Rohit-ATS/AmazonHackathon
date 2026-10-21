/**
 * Runtime configuration.
 *
 * Design rule: a clean clone with no AWS account and no Ring credentials must still run the
 * full demo. Teammates should not need to wait on IAM to build a UI. So every AWS dependency
 * degrades to a local equivalent, and `/healthz` reports which mode is live so nobody has to
 * guess why something looks different.
 */

export type StorageMode = 'dynamodb' | 'local';
export type TtsMode = 'polly' | 'browser';

export interface Config {
  port: number;
  /** Public base URL of this API, used when building the simulator's delivery target. */
  selfUrl: string;
  /**
   * Where a linked user is sent afterwards. Ring opens the account-link page in a plain
   * browser, so it has to be an absolute URL back to the CareFlow interface.
   */
  webAppUrl: string;
  storage: StorageMode;
  tableName: string;
  /** Where local mode keeps its JSON state. */
  localStatePath: string;
  tts: TtsMode;
  pollyVoiceId: string;
  awsRegion: string;
  bedrockModelId?: string;
  /**
   * HMAC key used to verify webhook signatures. In deployed mode this is Ring's partner
   * HMAC key from Secrets Manager; locally it is a dev key shared with the simulator.
   * Either way the verification code path is identical.
   */
  ringHmacKey: string;
  ringClientId?: string;
  ringClientSecret?: string;
  ringRedirectUri: string;
  /** Refuse to start if signature verification would be off in a deployed environment. */
  requireSignatureVerification: boolean;
  demoMode: boolean;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function loadConfig(): Config {
  const isLambda = Boolean(env('AWS_LAMBDA_FUNCTION_NAME'));
  const tableName = env('CAREFLOW_TABLE') ?? 'careflow';
  const storage: StorageMode = env('CAREFLOW_TABLE') || isLambda ? 'dynamodb' : 'local';

  const hmacKey =
    env('RING_HMAC_KEY') ??
    // Dev-only fallback. Not a secret, and not used anywhere a real Ring delivery lands:
    // the simulator uses the same value so local runs still verify signatures for real.
    'careflow-local-dev-hmac-key-do-not-use-in-production';

  const port = Number(env('PORT') ?? 8787);

  const config: Config = {
    port,
    selfUrl: env('CAREFLOW_SELF_URL') ?? `http://localhost:${port}`,
    webAppUrl: env('CAREFLOW_WEB_URL') ?? 'http://localhost:5173',
    storage,
    tableName,
    localStatePath: env('CAREFLOW_LOCAL_STATE') ?? '.careflow-state.json',
    tts: env('CAREFLOW_TTS') === 'browser' ? 'browser' : isLambda || env('AWS_REGION') ? 'polly' : 'browser',
    pollyVoiceId: env('POLLY_VOICE_ID') ?? 'Joanna',
    awsRegion: env('AWS_REGION') ?? 'us-east-1',
    ringHmacKey: hmacKey,
    ringRedirectUri: env('RING_REDIRECT_URI') ?? `http://localhost:${port}/ring/oauth/callback`,
    requireSignatureVerification: true,
    demoMode: env('CAREFLOW_DEMO_MODE') !== 'false',
  };

  const modelId = env('BEDROCK_MODEL_ID');
  if (modelId) config.bedrockModelId = modelId;
  const clientId = env('RING_CLIENT_ID');
  if (clientId) config.ringClientId = clientId;
  const clientSecret = env('RING_CLIENT_SECRET');
  if (clientSecret) config.ringClientSecret = clientSecret;

  if (isLambda && hmacKey.startsWith('careflow-local-dev') && !env('RING_HMAC_SECRET_NAME')) {
    // Fail loudly rather than quietly accepting unsigned webhooks in a deployed service.
    throw new Error(
      'Neither RING_HMAC_KEY nor RING_HMAC_SECRET_NAME is set in a deployed environment. ' +
        'Refusing to start with the dev key.',
    );
  }

  return config;
}

/**
 * Pull the Ring HMAC key out of Secrets Manager when the deployed stack points at one.
 *
 * The key stays out of the Lambda's environment variables, which are visible to anyone with
 * `lambda:GetFunctionConfiguration` — and a signing key in plaintext configuration is the
 * kind of thing that ends up in a screenshot during a demo.
 */
export async function resolveSecrets(config: Config): Promise<Config> {
  const secretName = process.env.RING_HMAC_SECRET_NAME;
  if (!secretName || process.env.RING_HMAC_KEY) return config;

  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import(
      '@aws-sdk/client-secrets-manager'
    );
    const client = new SecretsManagerClient({ region: config.awsRegion });
    const res = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
    if (!res.SecretString) throw new Error('secret has no string value');

    // Accept either a bare string or {"RING_HMAC_KEY": "..."}, since both are things a
    // teammate might reasonably have put in the console.
    let key = res.SecretString;
    try {
      const parsed = JSON.parse(res.SecretString) as Record<string, string>;
      key = parsed.RING_HMAC_KEY ?? parsed.ringHmacKey ?? parsed.key ?? key;
    } catch {
      // Not JSON; the raw string is the key.
    }
    return { ...config, ringHmacKey: key };
  } catch (err) {
    // Starting with the dev key in a deployed environment would mean accepting webhooks
    // that Ring did not sign. Refuse instead.
    throw new Error(
      `Could not read the Ring HMAC key from secret "${secretName}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
