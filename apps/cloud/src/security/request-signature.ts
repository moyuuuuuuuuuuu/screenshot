import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { RecognitionMode } from '../providers/provider.js';

export type RequestOperation = RecognitionMode | 'quota';

export type RequestSignatureInput = Readonly<{
  deviceId: string;
  timestamp: string;
  mode: RequestOperation;
  image: Uint8Array;
}>;

const lowercaseSha256Pattern = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function createCanonicalRequestPayload(input: RequestSignatureInput): string {
  return [input.deviceId, input.timestamp, input.mode, sha256Hex(input.image)].join('\n');
}

export function createRequestSignature(input: RequestSignatureInput, signingSecret: string): string {
  return createHmac('sha256', signingSecret)
    .update(createCanonicalRequestPayload(input))
    .digest('hex');
}

export function verifyRequestSignature(
  input: RequestSignatureInput,
  signingSecret: string,
  signature: string,
): boolean {
  if (!lowercaseSha256Pattern.test(signature)) {
    return false;
  }

  const expected = Buffer.from(createRequestSignature(input, signingSecret), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return timingSafeEqual(expected, actual);
}
