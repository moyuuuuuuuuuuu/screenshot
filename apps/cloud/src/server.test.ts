import { describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

const png = new Uint8Array([137, 80, 78, 71]);

describe('cloud OCR and translation API', () => {
  it('returns a mock OCR result for a PNG image', async () => {
    const app = buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: {
        'content-type': 'image/png',
        'x-request-id': 'ocr-request',
      },
      payload: png,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sourceLanguage: 'zh',
      originalText: '模拟 OCR 文本',
      translatedText: null,
      blocks: [
        {
          text: '模拟 OCR 文本',
          x: 0.1,
          y: 0.1,
          width: 0.8,
          height: 0.1,
        },
      ],
    });

    await app.close();
  });

  it('returns a mock translation result for a PNG image', async () => {
    const app = buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: {
        'content-type': 'image/png',
        'x-request-id': 'translation-request',
      },
      payload: png,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sourceLanguage: 'zh',
      originalText: '模拟 OCR 文本',
      translatedText: 'Mock translated text',
      blocks: [
        {
          text: '模拟 OCR 文本',
          x: 0.1,
          y: 0.1,
          width: 0.8,
          height: 0.1,
        },
      ],
    });

    await app.close();
  });

  it('returns a stable error envelope for an invalid MIME type', async () => {
    const app = buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ocr',
      headers: {
        'content-type': 'text/plain',
        'x-request-id': 'invalid-mime-request',
      },
      payload: 'not an image',
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Only image uploads are supported.',
        requestId: 'invalid-mime-request',
      },
    });

    await app.close();
  });

  it('returns a stable error envelope for images over 8 MB', async () => {
    const app = buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/translate',
      headers: {
        'content-type': 'image/png',
        'x-request-id': 'large-image-request',
      },
      payload: Buffer.alloc(8 * 1024 * 1024 + 1),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: {
        code: 'IMAGE_TOO_LARGE',
        message: 'Image uploads must not exceed 8 MB.',
        requestId: 'large-image-request',
      },
    });

    await app.close();
  });
});
