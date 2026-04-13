import * as crypto from 'crypto';

/**
 * Generate a fast hash from a PNG buffer by sampling pixels.
 * Samples every Nth byte to keep it fast while still detecting page changes.
 */
export function generatePageHash(pngBuffer: Buffer): string {
  const SAMPLE_STEP = 500;
  const sampled: number[] = [];

  for (let i = 0; i < pngBuffer.length; i += SAMPLE_STEP) {
    sampled.push(pngBuffer[i]);
  }

  const hash = crypto
    .createHash('md5')
    .update(Buffer.from(sampled))
    .digest('hex')
    .slice(0, 12);

  return hash;
}
