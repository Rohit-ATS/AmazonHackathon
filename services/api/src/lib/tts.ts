/**
 * Text to speech via Amazon Polly.
 *
 * Returns undefined when Polly is unavailable or not configured, and the frontend falls
 * back to the browser's speech synthesis. The fallback exists because the demo has to work
 * on a laptop with no AWS credentials — and because a care assistant that goes mute when a
 * cloud call fails is not one worth shipping.
 *
 * Neural voices are worth the extra cost here: the difference between a warm voice and a
 * robotic one is the difference between a product somebody will let into their home and one
 * they will switch off.
 */

export interface SynthesisResult {
  audio: Buffer;
  contentType: 'audio/mpeg';
  voiceId: string;
}

export async function synthesize(
  text: string,
  opts: { voiceId: string; region: string },
): Promise<SynthesisResult | undefined> {
  try {
    const { PollyClient, SynthesizeSpeechCommand } = await import('@aws-sdk/client-polly');
    const client = new PollyClient({ region: opts.region });

    const res = await client.send(
      new SynthesizeSpeechCommand({
        Text: wrapSsml(text),
        TextType: 'ssml',
        OutputFormat: 'mp3',
        VoiceId: opts.voiceId as never,
        Engine: 'neural',
      }),
    );

    if (!res.AudioStream) return undefined;
    const audio = Buffer.from(await res.AudioStream.transformToByteArray());
    return { audio, contentType: 'audio/mpeg', voiceId: opts.voiceId };
  } catch {
    // Missing credentials, no SDK installed, region without the neural engine: all of these
    // mean "use the browser voice", not "fail the turn".
    return undefined;
  }
}

/**
 * Slow the delivery slightly and pause between sentences.
 *
 * This is an accessibility decision, not a stylistic one: the people CareFlow is for may be
 * older, may be hard of hearing, and may be hearing this while walking to the door.
 */
function wrapSsml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const paced = escaped.replace(/([.?!])\s+/g, '$1<break time="400ms"/> ');
  return `<speak><prosody rate="92%">${paced}</prosody></speak>`;
}
