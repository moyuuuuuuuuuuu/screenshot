import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProviderFromEnvironment } from '../server.js';
import { CozeOcrTranslationProvider } from './coze-provider.js';
import { MockOcrTranslationProvider } from './mock-provider.js';
import { ProviderError } from './provider.js';

const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const token = 'server-only-coze-token';
const workflowId = 'published-workflow-id';
const validOutput = {
  source_language: 'zh',
  original_text: '识别文本',
  translated_text: null,
  blocks: [
    {
      text: '识别文本',
      confidence: 0.98,
      box: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
    },
  ],
};

type FetchCall = Readonly<{
  url: string;
  init: RequestInit;
}>;

afterEach(() => {
  vi.useRealTimers();
});

describe('CozeOcrTranslationProvider request contract', () => {
  it('uploads the file multipart and runs OCR with the serialized file ID', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return jsonResponse({ data: { id: 'uploaded-file-id' } });
      }
      return jsonResponse({ code: 0, data: JSON.stringify(validOutput) });
    };
    const provider = createProvider(fetchImpl, ' https://api.coze.cn/ ');

    const result = await provider.recognize('ocr', image, 'private-request-id');

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://api.coze.cn/v1/files/upload');
    expect(calls[0]?.init.method).toBe('POST');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe(`Bearer ${token}`);
    const uploadBody = calls[0]?.init.body;
    expect(uploadBody).toBeInstanceOf(FormData);
    const form = uploadBody as FormData;
    expect([...form.keys()]).toEqual(['file']);
    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect(Buffer.from(await (file as Blob).arrayBuffer())).toEqual(image);

    expect(calls[1]?.url).toBe('https://api.coze.cn/v1/workflow/run');
    expect(calls[1]?.init.method).toBe('POST');
    expect(new Headers(calls[1]?.init.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(new Headers(calls[1]?.init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      workflow_id: workflowId,
      parameters: {
        operation: 'ocr',
        image: '{"file_id":"uploaded-file-id"}',
      },
    });
    expect(calls[0]?.init.signal).toBe(calls[1]?.init.signal);
    expect(result).toEqual({
      sourceLanguage: 'zh',
      originalText: '识别文本',
      translatedText: null,
      blocks: [
        {
          text: '识别文本',
          x: 0.1,
          y: 0.2,
          width: 0.4,
          height: 0.1,
        },
      ],
    });
  });

  it('normalizes a translated English result', async () => {
    const translatedOutput = {
      ...validOutput,
      source_language: 'en',
      original_text: 'recognized text',
      translated_text: '识别文本',
      blocks: [
        {
          text: 'recognized text',
          confidence: 0,
          box: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    };
    const requestBodies: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init = {}) => {
      if (init.body instanceof FormData) {
        return jsonResponse({ data: { id: 'translation-file-id' } });
      }
      requestBodies.push(String(init.body));
      return jsonResponse({
        code: 0,
        data: JSON.stringify(translatedOutput),
        msg: 'must not affect parsing',
        debug_url: 'https://debug.example/private',
      });
    };
    const provider = createProvider(fetchImpl);

    const result = await provider.recognize('translate', image, 'private-request-id');

    expect(JSON.parse(requestBodies[0] ?? '')).toMatchObject({
      parameters: { operation: 'translate' },
    });
    expect(result).toEqual({
      sourceLanguage: 'en',
      originalText: 'recognized text',
      translatedText: '识别文本',
      blocks: [
        {
          text: 'recognized text',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      ],
    });
  });

  it('uses one 20-second deadline for upload and workflow and aborts outstanding fetch work', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let workflowWasAborted = false;
    const fetchImpl: typeof fetch = async (_input, init = {}) => {
      const signal = init.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error('expected an abort signal');
      }
      signals.push(signal);
      if (signals.length === 1) {
        return await new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse({ data: { id: 'slow-upload-id' } })), 15_000);
        });
      }
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          workflowWasAborted = true;
          reject(new DOMException('raw abort detail', 'AbortError'));
        });
      });
    };
    const provider = createProvider(fetchImpl);
    const recognition = provider.recognize('ocr', image, 'private-request-id');
    const timeoutAssertion = expect(recognition).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(workflowWasAborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await timeoutAssertion;
    expect(workflowWasAborted).toBe(true);
  });
});

describe('CozeOcrTranslationProvider response validation', () => {
  it.each([
    ['upload non-2xx', [textResponse('private upload body', 503)], 'PROVIDER_UNAVAILABLE'],
    [
      'workflow non-2xx',
      [jsonResponse({ data: { id: 'file-id' } }), textResponse('private workflow body', 502)],
      'PROVIDER_UNAVAILABLE',
    ],
    ['upload invalid JSON', [textResponse('{', 200)], 'PROVIDER_INVALID_RESPONSE'],
    ['upload missing file ID', [jsonResponse({ data: {} })], 'PROVIDER_INVALID_RESPONSE'],
    [
      'workflow invalid JSON',
      [jsonResponse({ data: { id: 'file-id' } }), textResponse('{', 200)],
      'PROVIDER_INVALID_RESPONSE',
    ],
    [
      'workflow nonzero code',
      [
        jsonResponse({ data: { id: 'file-id' } }),
        jsonResponse({
          code: 7,
          data: '{}',
          msg: 'private provider message',
          debug_url: 'https://debug.example/private',
        }),
      ],
      'PROVIDER_INVALID_RESPONSE',
    ],
    [
      'invalid JSON in data',
      [jsonResponse({ data: { id: 'file-id' } }), jsonResponse({ code: 0, data: '{' })],
      'PROVIDER_INVALID_RESPONSE',
    ],
    [
      'missing output field',
      [
        jsonResponse({ data: { id: 'file-id' } }),
        workflowResponse({ ...validOutput, blocks: undefined }),
      ],
      'PROVIDER_INVALID_RESPONSE',
    ],
    [
      'extra output field',
      [
        jsonResponse({ data: { id: 'file-id' } }),
        workflowResponse({ ...validOutput, leaked_field: 'private provider payload' }),
      ],
      'PROVIDER_INVALID_RESPONSE',
    ],
    [
      'bad normalized box',
      [
        jsonResponse({ data: { id: 'file-id' } }),
        workflowResponse({
          ...validOutput,
          blocks: [
            {
              ...validOutput.blocks[0],
              box: { x: 0.8, y: 0.2, width: 0.4, height: 0.1 },
            },
          ],
        }),
      ],
      'PROVIDER_INVALID_RESPONSE',
    ],
    [
      'bad confidence',
      [
        jsonResponse({ data: { id: 'file-id' } }),
        workflowResponse({
          ...validOutput,
          blocks: [{ ...validOutput.blocks[0], confidence: 1.01 }],
        }),
      ],
      'PROVIDER_INVALID_RESPONSE',
    ],
    [
      'empty block text',
      [
        jsonResponse({ data: { id: 'file-id' } }),
        workflowResponse({
          ...validOutput,
          blocks: [{ ...validOutput.blocks[0], text: '' }],
        }),
      ],
      'PROVIDER_INVALID_RESPONSE',
    ],
  ] as const)('maps %s to a redacted typed error', async (_label, responses, expectedCode) => {
    const provider = createProvider(sequenceFetch([...responses]));

    const error = await captureProviderError(() =>
      provider.recognize('ocr', image, 'private-request-id'),
    );

    expect(error.code).toBe(expectedCode);
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain('private');
    expect(error.message).not.toContain('debug.example');
    expect(error.message).not.toContain('识别文本');
  });

  it('requires a string translation for translate and null for OCR', async () => {
    const invalidByMode = [
      ['translate', validOutput],
      ['ocr', { ...validOutput, translated_text: 'must be null' }],
    ] as const;

    for (const [mode, output] of invalidByMode) {
      const provider = createProvider(
        sequenceFetch([
          jsonResponse({ data: { id: 'file-id' } }),
          workflowResponse(output),
        ]),
      );
      await expect(provider.recognize(mode, image, 'private-request-id')).rejects.toMatchObject({
        code: 'PROVIDER_INVALID_RESPONSE',
      });
    }
  });

  it('maps an unsupported detected language to UNSUPPORTED_LANGUAGE', async () => {
    const provider = createProvider(
      sequenceFetch([
        jsonResponse({ data: { id: 'file-id' } }),
        workflowResponse({ ...validOutput, source_language: 'ja' }),
      ]),
    );

    await expect(provider.recognize('ocr', image, 'private-request-id')).rejects.toMatchObject({
      code: 'UNSUPPORTED_LANGUAGE',
    });
  });

  it('redacts raw network errors from thrown messages', async () => {
    const rawDetail = `${token} private network failure https://debug.example/private`;
    const provider = createProvider(async () => {
      throw new Error(rawDetail);
    });

    const error = await captureProviderError(() =>
      provider.recognize('ocr', image, 'private-request-id'),
    );

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.message).not.toContain(rawDetail);
    expect(error.message).not.toContain(token);
  });

  it('maps a 2xx response body stream failure to PROVIDER_UNAVAILABLE', async () => {
    const rawDetail = `${token} private body failure https://debug.example/private`;
    const provider = createProvider(
      sequenceFetch([failedBodyResponse(new Error(rawDetail))]),
    );

    const error = await captureProviderError(() =>
      provider.recognize('ocr', image, 'private-request-id'),
    );

    expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(error.message).not.toContain(rawDetail);
    expect(error.message).not.toContain(token);
  });
});

describe('cloud provider environment selection', () => {
  it('selects Mock for development', () => {
    expect(
      createProviderFromEnvironment({
        NODE_ENV: 'development',
        CLOUD_PROVIDER: 'mock',
      }),
    ).toBeInstanceOf(MockOcrTranslationProvider);
  });

  it('selects Coze when all trimmed configuration is present', () => {
    expect(
      createProviderFromEnvironment(
        {
          NODE_ENV: 'development',
          CLOUD_PROVIDER: 'coze',
          COZE_API_BASE_URL: ' https://api.coze.cn/ ',
          COZE_API_TOKEN: ` ${token} `,
          COZE_WORKFLOW_ID: ` ${workflowId} `,
        },
        async () => {
          throw new Error('must not make a network request while selecting');
        },
      ),
    ).toBeInstanceOf(CozeOcrTranslationProvider);
  });

  it.each(['COZE_API_BASE_URL', 'COZE_API_TOKEN', 'COZE_WORKFLOW_ID'] as const)(
    'rejects Coze startup when %s is missing',
    (missingName) => {
      const environment: Record<string, string> = {
        NODE_ENV: 'development',
        CLOUD_PROVIDER: 'coze',
        COZE_API_BASE_URL: 'https://api.coze.cn',
        COZE_API_TOKEN: token,
        COZE_WORKFLOW_ID: workflowId,
      };
      delete environment[missingName];

      expect(() => createProviderFromEnvironment(environment)).toThrow(
        `${missingName} is required when CLOUD_PROVIDER=coze.`,
      );
    },
  );

  it('rejects unsupported provider names', () => {
    expect(() =>
      createProviderFromEnvironment({
        NODE_ENV: 'development',
        CLOUD_PROVIDER: 'other',
      }),
    ).toThrow('Unsupported CLOUD_PROVIDER.');
  });

  it.each([undefined, 'mock', 'other'])(
    'requires production CLOUD_PROVIDER to be exactly coze (received %s)',
    (providerName) => {
      expect(() =>
        createProviderFromEnvironment({
          NODE_ENV: 'production',
          ...(providerName === undefined ? {} : { CLOUD_PROVIDER: providerName }),
        }),
      ).toThrow('Production requires CLOUD_PROVIDER=coze.');
    },
  );
});

function createProvider(
  fetchImpl: typeof fetch,
  baseUrl = 'https://api.coze.cn',
): CozeOcrTranslationProvider {
  return new CozeOcrTranslationProvider({
    baseUrl,
    token,
    workflowId,
    fetch: fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

function workflowResponse(output: unknown): Response {
  return jsonResponse({ code: 0, data: JSON.stringify(output) });
}

function failedBodyResponse(error: Error): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error);
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function sequenceFetch(responses: Response[]): typeof fetch {
  return async () => {
    const response = responses.shift();
    if (response === undefined) {
      throw new Error('unexpected fetch call');
    }
    return response;
  };
}

async function captureProviderError(action: () => Promise<unknown>): Promise<ProviderError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error('expected provider error');
}
