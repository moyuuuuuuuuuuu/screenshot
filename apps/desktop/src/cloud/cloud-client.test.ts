import { webcrypto } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CloudClientError,
  createCloudClient,
  createCloudRequestSignature,
  type RecognitionResult,
} from './cloud-client';

const deviceId = '01234567-89ab-cdef-0123-456789abcdef';
const timestamp = 1_784_736_000_000;
const recognitionResult: RecognitionResult = {
  sourceLanguage: 'zh',
  originalText: '原文',
  translatedText: null,
  blocks: [{ text: '原文', x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
};
const quotaResult = {
  ocr: { limit: 20 as const, remaining: 19 },
  translate: { limit: 10 as const, remaining: 8 },
  resetsAt: '2026-07-23T16:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createHarness(fetchImpl: typeof fetch) {
  return createCloudClient({
    apiUrl: 'https://cloud.example.test/',
    requestKey: 'test-secret',
    getDeviceId: async () => deviceId,
    fetch: fetchImpl,
    subtleCrypto: webcrypto.subtle as SubtleCrypto,
    clock: () => timestamp,
  });
}

describe('cloud request signing', () => {
  it('matches the server fixed HMAC-SHA256 vector', async () => {
    await expect(
      createCloudRequestSignature(
        {
          deviceId,
          timestamp: String(timestamp),
          operation: 'ocr',
          body: new TextEncoder().encode('image-bytes'),
          requestKey: 'test-secret',
        },
        webcrypto.subtle as SubtleCrypto,
      ),
    ).resolves.toBe(
      '601b48271ced068ee0ecad89c758003f055bd0147921cbc0daf265b22ea3fb5d',
    );
  });

  it('signs quota with the server fixed empty-body vector', async () => {
    await expect(
      createCloudRequestSignature(
        {
          deviceId,
          timestamp: String(timestamp),
          operation: 'quota',
          body: new Uint8Array(),
          requestKey: 'test-secret',
        },
        webcrypto.subtle as SubtleCrypto,
      ),
    ).resolves.toBe(
      'a68ed41fd3f57c6fdbdbd2da66fd65795b6fabfb7293f61f936e9c888620c87e',
    );
  });
});

describe('CloudClient requests and parsing', () => {
  it('sends exact raw OCR and translation requests and an empty-body quota request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(recognitionResult))
      .mockResolvedValueOnce(jsonResponse({
        ...recognitionResult,
        translatedText: 'translation',
      }))
      .mockResolvedValueOnce(jsonResponse(quotaResult));
    const client = createHarness(fetchImpl);
    const image = new Blob(['image-bytes'], { type: 'image/png' });

    await expect(client.recognize('ocr', image, new AbortController().signal))
      .resolves.toEqual(recognitionResult);
    await expect(client.recognize('translate', image, new AbortController().signal))
      .resolves.toMatchObject({ translatedText: 'translation' });
    await expect(client.quota()).resolves.toEqual(quotaResult);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://cloud.example.test/v1/ocr');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: image,
      headers: {
        'content-type': 'image/png',
        'x-device-id': deviceId,
        'x-request-timestamp': String(timestamp),
        'x-request-signature':
          '601b48271ced068ee0ecad89c758003f055bd0147921cbc0daf265b22ea3fb5d',
      },
    });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://cloud.example.test/v1/translate');
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: image,
      headers: {
        'content-type': 'image/png',
        'x-device-id': deviceId,
        'x-request-timestamp': String(timestamp),
        'x-request-signature':
          '1e8cedadd8e5e8c3b001d62861d4a8b46345ab0217e59d3b22d2a1dd09c09226',
      },
    });
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('https://cloud.example.test/v1/quota');
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({
      method: 'GET',
      headers: {
        'x-device-id': deviceId,
        'x-request-timestamp': String(timestamp),
        'x-request-signature':
          'a68ed41fd3f57c6fdbdbd2da66fd65795b6fabfb7293f61f936e9c888620c87e',
      },
    });
    expect(fetchImpl.mock.calls[2]?.[1]).not.toHaveProperty('body');
    expect(fetchImpl.mock.calls[2]?.[1]?.headers).not.toHaveProperty('content-type');
  });

  it('parses a stable server error without exposing raw response text', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'QUOTA_EXCEEDED',
            message: 'The anonymous daily quota has been exceeded.',
            requestId: 'server-request-7',
          },
        },
        429,
      ),
    );

    await expect(
      createHarness(fetchImpl).recognize(
        'ocr',
        new Blob(['image-bytes'], { type: 'image/png' }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: 'CloudClientError',
      code: 'QUOTA_EXCEEDED',
      status: 429,
      requestId: 'server-request-7',
    });
  });

  it.each([
    ['recognition extra property', { ...recognitionResult, unexpected: true }],
    ['recognition invalid block bounds', {
      ...recognitionResult,
      blocks: [{ text: 'bad', x: 0.9, y: 0, width: 0.2, height: 1 }],
    }],
    ['recognition wrong translation type', { ...recognitionResult, translatedText: 7 }],
  ])('maps malformed %s success data to INVALID_RESPONSE', async (_label, body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));

    await expect(
      createHarness(fetchImpl).recognize(
        'ocr',
        new Blob(['image-bytes'], { type: 'image/png' }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    ['quota wrong literal limit', { ...quotaResult, ocr: { limit: 21, remaining: 20 } }],
    ['quota invalid reset', { ...quotaResult, resetsAt: 'tomorrow' }],
    ['quota extra property', { ...quotaResult, raw: 'unsafe' }],
  ])('maps malformed %s data to INVALID_RESPONSE', async (_label, body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));
    await expect(createHarness(fetchImpl).quota()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it.each([
    ['unknown error code', {
      error: { code: 'RAW_PROVIDER_FAILURE', message: 'raw provider stack', requestId: 'request-1' },
    }],
    ['extra error field', {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests.',
        requestId: 'request-1',
        raw: 'secret',
      },
    }],
    ['non-JSON error', 'not-json'],
  ])('maps malformed %s envelopes to INVALID_RESPONSE', async (_label, body) => {
    const response = typeof body === 'string'
      ? new Response(body, { status: 500 })
      : jsonResponse(body, 500);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(createHarness(fetchImpl).quota()).rejects.toEqual(
      expect.objectContaining({
        code: 'INVALID_RESPONSE',
        message: expect.not.stringContaining('raw provider stack'),
      }),
    );
  });

  it('requires cloud URL and request key only when an action is invoked', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createCloudClient({
      apiUrl: ' ',
      requestKey: '',
      getDeviceId: async () => deviceId,
      fetch: fetchImpl,
      subtleCrypto: webcrypto.subtle as SubtleCrypto,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(client.quota()).rejects.toMatchObject({
      code: 'CONFIGURATION_MISSING',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('CloudClient cancellation and deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps caller cancellation to ABORTED', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    );
    const controller = new AbortController();
    const request = createHarness(fetchImpl).recognize(
      'ocr',
      new Blob(['image-bytes'], { type: 'image/png' }),
      controller.signal,
    );
    const rejection = expect(request).rejects.toMatchObject({ code: 'ABORTED' });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort();

    await rejection;
  });

  it('maps the 20-second deadline to REQUEST_TIMEOUT', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
    );
    const request = createHarness(fetchImpl).quota();
    const rejection = expect(request).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(20_000);

    await rejection;
  });

  it('maps fetch failures to NETWORK_UNAVAILABLE without copying raw details', async () => {
    vi.useRealTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new Error('https://secret-host.invalid?token=raw'),
    );

    await expect(createHarness(fetchImpl).quota()).rejects.toEqual(
      expect.objectContaining({
        code: 'NETWORK_UNAVAILABLE',
        message: expect.not.stringContaining('secret-host'),
      }),
    );
  });
});

describe('CloudClientError', () => {
  it('carries stable optional status and request identifiers', () => {
    const error = new CloudClientError(
      'RATE_LIMITED',
      'Too many requests.',
      { status: 429, requestId: 'request-1' },
    );

    expect(error).toMatchObject({
      name: 'CloudClientError',
      code: 'RATE_LIMITED',
      message: 'Too many requests.',
      status: 429,
      requestId: 'request-1',
    });
  });
});
