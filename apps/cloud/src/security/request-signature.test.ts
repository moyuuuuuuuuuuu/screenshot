import { describe, expect, it } from 'vitest';

import {
  createCanonicalRequestPayload,
  createRequestSignature,
  sha256Hex,
  verifyRequestSignature,
} from './request-signature.js';

const input = {
  deviceId: '01234567-89ab-cdef-0123-456789abcdef',
  timestamp: '1784736000000',
  mode: 'ocr' as const,
  image: Buffer.from('image-bytes'),
};

describe('request signature helpers', () => {
  it('builds the exact canonical request payload', () => {
    expect(sha256Hex(input.image)).toBe(
      '2c8648d103e3dd7ad87660da0f126a1443b6d21ac1bd3ec000c5e24e2373a90c',
    );
    expect(createCanonicalRequestPayload(input)).toBe(
      [input.deviceId, input.timestamp, input.mode, sha256Hex(input.image)].join('\n'),
    );
  });

  it('creates a stable lowercase HMAC-SHA256 signature', () => {
    expect(createRequestSignature(input, 'test-secret')).toBe(
      '601b48271ced068ee0ecad89c758003f055bd0147921cbc0daf265b22ea3fb5d',
    );
  });

  it('verifies the expected signature and rejects invalid values', () => {
    const signature = createRequestSignature(input, 'test-secret');

    expect(verifyRequestSignature(input, 'test-secret', signature)).toBe(true);
    expect(verifyRequestSignature(input, 'wrong-secret', signature)).toBe(false);
    expect(verifyRequestSignature(input, 'test-secret', `${signature.slice(0, -1)}0`)).toBe(false);
    expect(verifyRequestSignature(input, 'test-secret', signature.toUpperCase())).toBe(false);
    expect(verifyRequestSignature(input, 'test-secret', 'not-hex')).toBe(false);
  });
});
