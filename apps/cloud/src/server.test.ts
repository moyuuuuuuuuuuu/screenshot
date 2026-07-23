import { describe, expect, it, vi } from 'vitest';

import type { RecognitionResult } from './domain/result.js';
import {
  ProviderError,
  type OcrTranslationProvider,
  type RecognitionMode,
} from './providers/provider.js';
import type { QuotaStore } from './quota/quota-store.js';
import { createRequestSignature } from './security/request-signature.js';
import {
  buildServer,
  type AuditEvent,
  type AuditLogger,
  type ServerOptions,
} from './server.js';

const signingSecret = 'server-only-signing-secret';
const now = Date.parse('2026-07-23T02:00:00.000Z');
const deviceId = '01234567-89ab-cdef-0123-456789abcdef';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const jpeg = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z',
  'base64',
);

const recognitionResult: RecognitionResult = {
  sourceLanguage: 'zh',
  originalText: 'sensitive recognized text',
  translatedText: 'sensitive translated text',
  blocks: [],
};

function createHarness(overrides: Partial<ServerOptions> = {}) {
  let requestNumber = 0;
  const recognize = vi.fn(
    async (_mode: RecognitionMode, _image: Uint8Array, _requestId: string) =>
      recognitionResult,
  );
  const provider: OcrTranslationProvider = { recognize };
  const consume = vi.fn<QuotaStore['consume']>(async () => ({
    accepted: true,
    remaining: 19,
    resetsAt: '2026-07-23T16:00:00.000Z',
  }));
  const status = vi.fn<QuotaStore['status']>(async () => ({
    ocr: { limit: 20, remaining: 20 },
    translate: { limit: 10, remaining: 10 },
    resetsAt: '2026-07-23T16:00:00.000Z',
  }));
  const quotaStore: QuotaStore = { consume, status };
  const auditEvents: AuditEvent[] = [];
  const auditLogger: AuditLogger = {
    log(event) {
      auditEvents.push(event);
    },
  };
  const app = buildServer({
    provider,
    quotaStore,
    signingSecret,
    clock: () => now,
    auditLogger,
    requestIdFactory: () => `server-request-${(requestNumber += 1)}`,
    ...overrides,
  });
  return { app, recognize, consume, status, auditEvents };
}

function signedHeaders(
  mode: RecognitionMode,
  image: Uint8Array = png,
  timestamp = String(now),
  id = deviceId,
): Record<string, string> {
  return {
    'content-type': mode === 'ocr' ? 'image/png' : 'image/jpeg',
    'x-device-id': id,
    'x-request-timestamp': timestamp,
    'x-request-signature': createRequestSignature(
      { deviceId: id, timestamp, mode, image },
      signingSecret,
    ),
  };
}

function signedQuotaHeaders(
  timestamp = String(now),
  id = deviceId,
): Record<string, string> {
  return {
    'x-device-id': id,
    'x-request-timestamp': timestamp,
    'x-request-signature': createRequestSignature(
      { deviceId: id, timestamp, mode: 'quota', image: new Uint8Array() },
      signingSecret,
    ),
  };
}

describe('server configuration', () => {
  it.each(['', '   ', '\n\t'])('rejects an empty signing secret', (emptySecret) => {
    expect(() => buildServer({ signingSecret: emptySecret })).toThrow(
      'A non-empty signing secret is required.',
    );
  });
});

describe('cloud OCR and translation API', () => {
  it('returns an OCR result for a fresh signed PNG request', async () => {
    const { app, recognize, consume } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: { ...signedHeaders('ocr'), 'x-request-id': 'ocr-request' },
      payload: png,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(recognitionResult);
    expect(consume).toHaveBeenCalledWith(deviceId, 'ocr', now);
    expect(recognize).toHaveBeenCalledWith('ocr', png, 'server-request-1');

    await app.close();
  });

  it('accepts a fresh signed JPEG translation request', async () => {
    const { app, recognize } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: signedHeaders('translate', jpeg),
      payload: jpeg,
    });

    expect(response.statusCode).toBe(200);
    expect(recognize).toHaveBeenCalledOnce();

    await app.close();
  });

  it('preserves the unsupported content-type error before protected processing', async () => {
    const { app, recognize, consume } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: { 'content-type': 'text/plain', 'x-request-id': 'invalid-mime-request' },
      payload: 'not an image',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Only image uploads are supported.',
        requestId: 'server-request-1',
      },
    });
    expect(consume).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();

    await app.close();
  });

  it('preserves the unsupported media response for malformed JSON uploads', async () => {
    const { app, recognize, consume } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: { 'content-type': 'application/json', 'x-request-id': 'malformed-json-request' },
      payload: '{',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
    expect(consume).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();

    await app.close();
  });

  it('preserves the over-8-MiB error before protected processing', async () => {
    const { app, recognize, consume } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: { 'content-type': 'image/png', 'x-request-id': 'large-image-request' },
      payload: Buffer.alloc(8 * 1024 * 1024 + 1),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'IMAGE_TOO_LARGE' } });
    expect(consume).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();

    await app.close();
  });
});

describe('cloud quota API', () => {
  it('returns the exact full quota shape without consuming quota or calling the provider', async () => {
    const { app, recognize, consume, status } = createHarness();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/quota',
      headers: signedQuotaHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ocr: { limit: 20, remaining: 20 },
      translate: { limit: 10, remaining: 10 },
      resetsAt: '2026-07-23T16:00:00.000Z',
    });
    expect(status).toHaveBeenCalledWith(deviceId, now);
    expect(consume).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();

    await app.close();
  });

  it('returns current independent counts from the read-only store status', async () => {
    const status = vi.fn<QuotaStore['status']>(async () => ({
      ocr: { limit: 20, remaining: 7, internalCounterKey: 'ocr-private' },
      translate: { limit: 10, remaining: 3, internalCounterKey: 'translate-private' },
      resetsAt: '2026-07-23T16:00:00.000Z',
      internalDeviceKey: 'device-private',
    }));
    const consume = vi.fn<QuotaStore['consume']>();
    const { app, recognize } = createHarness({ quotaStore: { consume, status } });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/quota',
      headers: signedQuotaHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ocr: { limit: 20, remaining: 7 },
      translate: { limit: 10, remaining: 3 },
      resetsAt: '2026-07-23T16:00:00.000Z',
    });
    expect(consume).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects invalid signatures and replays before reading quota', async () => {
    const { app, recognize, consume, status } = createHarness();
    const headers = signedQuotaHeaders();

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/quota',
      headers: { ...headers, 'x-request-signature': '0'.repeat(64) },
    });
    const accepted = await app.inject({ method: 'GET', url: '/v1/quota', headers });
    const replay = await app.inject({ method: 'GET', url: '/v1/quota', headers });

    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
    expect(accepted.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
    expect(status).toHaveBeenCalledOnce();
    expect(consume).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();

    await app.close();
  });

  it('applies the per-IP rate limiter without consuming quota or calling the provider', async () => {
    const { app, recognize, consume, status } = createHarness();
    let response;

    for (let request = 0; request < 31; request += 1) {
      response = await app.inject({
        method: 'GET',
        url: '/v1/quota',
        headers: signedQuotaHeaders(String(now + request)),
        remoteAddress: '203.0.113.42',
      });
    }

    expect(response?.statusCode).toBe(429);
    expect(response?.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(status).toHaveBeenCalledTimes(30);
    expect(consume).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();

    await app.close();
  });
});

describe('request authentication', () => {
  it.each([
    ['stale', String(now - 300_001)],
    ['future', String(now + 300_001)],
  ])('rejects a %s timestamp before quota or provider calls', async (_label, timestamp) => {
    const { app, recognize, consume } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: signedHeaders('ocr', png, timestamp),
      payload: png,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
    expect(consume).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();

    await app.close();
  });

  it('accepts timestamps exactly at both freshness boundaries', async () => {
    const { app } = createHarness();
    const staleBoundary = String(now - 300_000);
    const futureBoundary = String(now + 300_000);

    const staleResponse = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: signedHeaders('ocr', png, staleBoundary),
      payload: png,
    });
    const futureResponse = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: signedHeaders('ocr', png, futureBoundary),
      payload: png,
    });

    expect(staleResponse.statusCode).toBe(200);
    expect(futureResponse.statusCode).toBe(200);

    await app.close();
  });

  it.each([
    ['missing device ID', { 'x-device-id': undefined }],
    ['uppercase device ID', { 'x-device-id': deviceId.toUpperCase() }],
    ['missing timestamp', { 'x-request-timestamp': undefined }],
    ['malformed timestamp', { 'x-request-timestamp': '12.5' }],
    ['missing signature', { 'x-request-signature': undefined }],
    ['uppercase signature', { 'x-request-signature': 'A'.repeat(64) }],
    ['invalid HMAC', { 'x-request-signature': '0'.repeat(64) }],
  ])('rejects %s with the stable signature envelope', async (_label, replacement) => {
    const { app, recognize, consume } = createHarness();
    const headers: Record<string, string> = signedHeaders('ocr');
    for (const [name, value] of Object.entries(replacement)) {
      if (value === undefined) {
        delete headers[name];
      } else {
        headers[name] = value;
      }
    }
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers,
      payload: png,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
    expect(consume).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects a replayed accepted tuple before a second quota or provider call', async () => {
    const { app, recognize, consume } = createHarness();
    const request = {
      method: 'POST' as const,
      url: '/v1/ocr',
      headers: signedHeaders('ocr'),
      payload: png,
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
    expect(consume).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledOnce();

    await app.close();
  });

  it('rejects an invalid HMAC before attempting expensive image decoding', async () => {
    const { app, recognize, consume } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: {
        ...signedHeaders('ocr', Buffer.from('not decodable')),
        'x-request-signature': '0'.repeat(64),
      },
      payload: Buffer.from('not decodable'),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_SIGNATURE' } });
    expect(consume).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();

    await app.close();
  });
});

describe('IP burst limiting', () => {
  it('accepts 30 requests in a rolling minute and rejects request 31 before quota', async () => {
    const { app, recognize, consume } = createHarness();
    let response;
    for (let request = 0; request < 31; request += 1) {
      const timestamp = String(now + request);
      response = await app.inject({
        method: 'POST',
        url: '/v1/ocr',
        headers: signedHeaders('ocr', png, timestamp),
        payload: png,
        remoteAddress: '203.0.113.10',
      });
    }

    expect(response?.statusCode).toBe(429);
    expect(response?.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(consume).toHaveBeenCalledTimes(30);
    expect(recognize).toHaveBeenCalledTimes(30);

    await app.close();
  });

  it('isolates rolling windows by IP address', async () => {
    const { app, recognize, consume } = createHarness();
    for (let request = 0; request < 30; request += 1) {
      const timestamp = String(now + request);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ocr',
        headers: signedHeaders('ocr', png, timestamp),
        payload: png,
        remoteAddress: '203.0.113.10',
      });
      expect(response.statusCode).toBe(200);
    }

    const isolated = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: signedHeaders('ocr', png, String(now + 30)),
      payload: png,
      remoteAddress: '203.0.113.11',
    });

    expect(isolated.statusCode).toBe(200);
    expect(consume).toHaveBeenCalledTimes(31);
    expect(recognize).toHaveBeenCalledTimes(31);

    await app.close();
  });

  it('expires the oldest request at exactly 60,000 ms', async () => {
    let clock = now;
    const { app } = createHarness({ clock: () => clock });
    for (let request = 0; request < 30; request += 1) {
      const timestamp = String(now + request);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ocr',
        headers: signedHeaders('ocr', png, timestamp),
        payload: png,
      });
      expect(response.statusCode).toBe(200);
    }

    clock = now + 60_000;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: signedHeaders('ocr', png, String(clock)),
      payload: png,
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });
});

describe('image validation and quota enforcement', () => {
  it.each([
    ['invalid bytes', Buffer.from('not an image')],
    ['unsupported encoded format', Buffer.from('GIF89a')],
    ['corrupt PNG data', corruptPng()],
    ['invalid PNG pixel stream with valid chunk CRC', invalidPngPixelStream()],
    ['fabricated JPEG entropy data', fabricatedJpeg()],
    ['truncated JPEG data', truncatedJpeg()],
    ['zero width', pngHeader(0, 1)],
    ['zero height', pngHeader(1, 0)],
    ['width over 4096', pngHeader(4097, 1)],
    ['height over 4096', pngHeader(1, 4097)],
  ])('rejects %s before quota or provider calls', async (_label, image) => {
    const { app, recognize, consume } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: { ...signedHeaders('ocr', image), 'content-type': 'image/png' },
      payload: image,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_IMAGE' } });
    expect(consume).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejects exhausted quota before provider invocation', async () => {
    const consume = vi.fn<QuotaStore['consume']>(async () => ({
      accepted: false,
      remaining: 0,
      resetsAt: '2026-07-23T16:00:00.000Z',
    }));
    const status = vi.fn<QuotaStore['status']>();
    const { app, recognize } = createHarness({ quotaStore: { consume, status } });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: signedHeaders('ocr'),
      payload: png,
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: 'QUOTA_EXCEEDED' } });
    expect(consume).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
    expect(recognize).not.toHaveBeenCalled();

    await app.close();
  });
});

describe('privacy-safe audit logging', () => {
  it.each([
    deviceId,
    signingSecret,
    '198.51.100.19',
    createRequestSignature(
      { deviceId, timestamp: String(now), mode: 'ocr', image: png },
      signingSecret,
    ),
    recognitionResult.originalText,
  ])('does not trust a client request ID containing %s', async (clientRequestId) => {
    const { app, recognize, auditEvents } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: { ...signedHeaders('ocr'), 'x-request-id': clientRequestId },
      payload: png,
      remoteAddress: '198.51.100.19',
    });

    expect(response.statusCode).toBe(200);
    expect(auditEvents[0]?.requestId).not.toBe(clientRequestId);
    expect(recognize.mock.calls[0]?.[2]).not.toBe(clientRequestId);
    expect(JSON.stringify(auditEvents)).not.toContain(clientRequestId);

    await app.close();
  });

  it('emits only whitelisted metadata for accepted and rejected requests', async () => {
    const rawIp = '198.51.100.19';
    const { app, auditEvents } = createHarness();
    const headers: Record<string, string> = {
      ...signedHeaders('ocr'),
      'x-request-id': 'safe-request-id',
    };

    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers,
      payload: png,
      remoteAddress: rawIp,
    });
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers,
      payload: png,
      remoteAddress: rawIp,
    });

    expect(accepted.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(401);
    expect(auditEvents).toEqual([
      { requestId: 'server-request-1', operation: 'ocr', durationMs: 0, statusCode: 200 },
      {
        requestId: 'server-request-2',
        operation: 'ocr',
        durationMs: 0,
        statusCode: 401,
        errorCode: 'INVALID_SIGNATURE',
      },
    ]);

    const serialized = JSON.stringify(auditEvents);
    const signature = headers['x-request-signature'];
    for (const forbidden of [
      png.toString('base64'),
      recognitionResult.originalText,
      recognitionResult.translatedText ?? '',
      signingSecret,
      deviceId,
      rawIp,
      signature,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    await app.close();
  });

  it.each([
    ['UNSUPPORTED_LANGUAGE', 422, 'The detected language is not supported.'],
    ['PROVIDER_INVALID_RESPONSE', 502, 'The OCR provider returned an invalid response.'],
    ['PROVIDER_TIMEOUT', 504, 'The OCR provider timed out.'],
    ['PROVIDER_UNAVAILABLE', 503, 'The OCR provider is unavailable.'],
  ] as const)(
    'maps typed provider error %s to a stable privacy-safe envelope',
    async (code, statusCode, message) => {
      const provider: OcrTranslationProvider = {
        recognize: vi.fn(async () => {
          throw new ProviderError(code);
        }),
      };
      const { app, auditEvents } = createHarness({ provider });
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ocr',
        headers: signedHeaders('ocr'),
        payload: png,
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({
        error: {
          code,
          message,
          requestId: 'server-request-1',
        },
      });
      expect(auditEvents).toEqual([
        {
          requestId: 'server-request-1',
          operation: 'ocr',
          durationMs: 0,
          statusCode,
          errorCode: code,
        },
      ]);
      const serialized = JSON.stringify({ body: response.json(), auditEvents });
      for (const forbidden of [
        'server-only-coze-token',
        'private OCR text',
        'private translation',
        'https://debug.example/private',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }

      await app.close();
    },
  );
});

function pngHeader(width: number, height: number): Buffer {
  const image = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.writeUInt32BE(13, 8);
  image.write('IHDR', 12, 'ascii');
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return image;
}

function corruptPng(): Buffer {
  const image = Buffer.from(png);
  image[41] = (image[41] ?? 0) ^ 0xff;
  return image;
}

function invalidPngPixelStream(): Buffer {
  const image = Buffer.from(png);
  const idatOffset = 33;
  const dataLength = image.readUInt32BE(idatOffset);
  image.fill(0, idatOffset + 8, idatOffset + 8 + dataLength);
  image.writeUInt32BE(
    crc32ForTest(image.subarray(idatOffset + 4, idatOffset + 8 + dataLength)),
    idatOffset + 8 + dataLength,
  );
  return image;
}

function fabricatedJpeg(): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00,
    0xff, 0xd9,
  ]);
}

function truncatedJpeg(): Buffer {
  return Buffer.concat([jpeg.subarray(0, -20), Buffer.from([0xff, 0xd9])]);
}

function crc32ForTest(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum & 1) === 1 ? 0xedb88320 ^ (checksum >>> 1) : checksum >>> 1;
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}
