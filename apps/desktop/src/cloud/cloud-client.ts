export type TextBlock = Readonly<{
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type RecognitionResult = Readonly<{
  sourceLanguage: 'zh' | 'en';
  originalText: string;
  translatedText: string | null;
  blocks: readonly TextBlock[];
}>;

export type QuotaResult = Readonly<{
  ocr: Readonly<{ limit: 20; remaining: number }>;
  translate: Readonly<{ limit: 10; remaining: number }>;
  resetsAt: string;
}>;

export interface CloudClient {
  recognize(
    mode: 'ocr' | 'translate',
    image: Blob,
    signal: AbortSignal,
  ): Promise<RecognitionResult>;
  quota(signal?: AbortSignal): Promise<QuotaResult>;
}

export type CloudClientErrorCode =
  | 'ABORTED'
  | 'CONFIGURATION_MISSING'
  | 'IMAGE_TOO_LARGE'
  | 'INTERNAL_SERVER_ERROR'
  | 'INVALID_IMAGE'
  | 'INVALID_RESPONSE'
  | 'INVALID_SIGNATURE'
  | 'NETWORK_UNAVAILABLE'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'REQUEST_TIMEOUT'
  | 'UNSUPPORTED_LANGUAGE'
  | 'UNSUPPORTED_MEDIA_TYPE';

export class CloudClientError extends Error {
  readonly code: CloudClientErrorCode;
  readonly status: number | undefined;
  readonly requestId: string | undefined;

  constructor(
    code: CloudClientErrorCode,
    message: string,
    metadata: Readonly<{ status?: number; requestId?: string }> = {},
  ) {
    super(message);
    this.name = 'CloudClientError';
    this.code = code;
    this.status = metadata.status;
    this.requestId = metadata.requestId;
  }
}

type CloudOperation = 'ocr' | 'translate' | 'quota';

export type CloudRequestSignatureInput = Readonly<{
  deviceId: string;
  timestamp: string;
  operation: CloudOperation;
  body: Uint8Array;
  requestKey: string;
}>;

export type CreateCloudClientOptions = Readonly<{
  apiUrl: string;
  requestKey: string;
  getDeviceId(): Promise<string>;
  fetch?: typeof fetch;
  subtleCrypto?: SubtleCrypto;
  clock?: () => number;
  timeoutMilliseconds?: number;
}>;

const defaultTimeoutMilliseconds = 20_000;
const emptyBody = new Uint8Array();

export async function createCloudRequestSignature(
  input: CloudRequestSignatureInput,
  subtleCrypto: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const bodyDigest = await subtleCrypto.digest('SHA-256', copyToArrayBuffer(input.body));
  const canonicalPayload = [
    input.deviceId,
    input.timestamp,
    input.operation,
    bytesToHex(new Uint8Array(bodyDigest)),
  ].join('\n');
  const key = await subtleCrypto.importKey(
    'raw',
    new TextEncoder().encode(input.requestKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await subtleCrypto.sign(
    'HMAC',
    key,
    new TextEncoder().encode(canonicalPayload),
  );
  return bytesToHex(new Uint8Array(signature));
}

export function createCloudClient(options: CreateCloudClientOptions): CloudClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const subtleCrypto = options.subtleCrypto ?? globalThis.crypto.subtle;
  const clock = options.clock ?? Date.now;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? defaultTimeoutMilliseconds;

  async function request(
    operation: CloudOperation,
    body: Blob | null,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const apiUrl = options.apiUrl.trim().replace(/\/+$/, '');
    if (apiUrl.length === 0 || options.requestKey.trim().length === 0) {
      throw clientError('CONFIGURATION_MISSING');
    }
    if (callerSignal?.aborted) {
      throw clientError('ABORTED');
    }

    const deviceId = await options.getDeviceId();
    const timestamp = String(clock());
    const bodyBytes = body === null
      ? emptyBody
      : new Uint8Array(await readBlob(body));
    const signature = await createCloudRequestSignature(
      {
        deviceId,
        timestamp,
        operation,
        body: bodyBytes,
        requestKey: options.requestKey,
      },
      subtleCrypto,
    );
    if (callerSignal?.aborted) {
      throw clientError('ABORTED');
    }

    const controller = new AbortController();
    let deadlineReached = false;
    const abortFromCaller = () => controller.abort();
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const deadline = globalThis.setTimeout(() => {
      deadlineReached = true;
      controller.abort();
    }, timeoutMilliseconds);

    const headers: Record<string, string> = {
      'x-device-id': deviceId,
      'x-request-timestamp': timestamp,
      'x-request-signature': signature,
    };
    if (body !== null) {
      headers['content-type'] = body.type;
    }

    const init: RequestInit = body === null
      ? { method: 'GET', headers, signal: controller.signal }
      : { method: 'POST', headers, body, signal: controller.signal };

    try {
      const response = await fetchImpl(`${apiUrl}/v1/${operation}`, init);
      const payload = await parseJson(response);
      if (!response.ok) {
        throw parseErrorEnvelope(payload, response.status);
      }
      return payload;
    } catch (error) {
      if (error instanceof CloudClientError) {
        throw error;
      }
      if (callerSignal?.aborted) {
        throw clientError('ABORTED');
      }
      if (deadlineReached) {
        throw clientError('REQUEST_TIMEOUT');
      }
      throw clientError('NETWORK_UNAVAILABLE');
    } finally {
      globalThis.clearTimeout(deadline);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  return {
    async recognize(mode, image, signal) {
      return parseRecognitionResult(await request(mode, image, signal));
    },
    async quota(signal) {
      return parseQuotaResult(await request('quota', null, signal));
    },
  };
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error('Blob read failed.'));
      }
    }, { once: true });
    reader.addEventListener('error', () => reject(new Error('Blob read failed.')), {
      once: true,
    });
    reader.readAsArrayBuffer(blob);
  });
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    const value: unknown = await response.json();
    return value;
  } catch {
    throw clientError('INVALID_RESPONSE');
  }
}

function parseRecognitionResult(value: unknown): RecognitionResult {
  if (
    !isExactObject(value, ['sourceLanguage', 'originalText', 'translatedText', 'blocks'])
    || (value.sourceLanguage !== 'zh' && value.sourceLanguage !== 'en')
    || typeof value.originalText !== 'string'
    || (typeof value.translatedText !== 'string' && value.translatedText !== null)
    || !Array.isArray(value.blocks)
  ) {
    throw clientError('INVALID_RESPONSE');
  }

  const blocks = value.blocks.map(parseTextBlock);
  return {
    sourceLanguage: value.sourceLanguage,
    originalText: value.originalText,
    translatedText: value.translatedText,
    blocks,
  };
}

function parseTextBlock(value: unknown): TextBlock {
  if (
    !isExactObject(value, ['text', 'x', 'y', 'width', 'height'])
    || typeof value.text !== 'string'
    || !isNormalizedNumber(value.x)
    || !isNormalizedNumber(value.y)
    || !isNormalizedNumber(value.width)
    || !isNormalizedNumber(value.height)
    || value.x + value.width > 1
    || value.y + value.height > 1
  ) {
    throw clientError('INVALID_RESPONSE');
  }
  return {
    text: value.text,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };
}

function parseQuotaResult(value: unknown): QuotaResult {
  if (
    !isExactObject(value, ['ocr', 'translate', 'resetsAt'])
    || !isQuotaCounter(value.ocr, 20)
    || !isQuotaCounter(value.translate, 10)
    || typeof value.resetsAt !== 'string'
    || !isCanonicalIsoDate(value.resetsAt)
  ) {
    throw clientError('INVALID_RESPONSE');
  }
  return {
    ocr: { limit: 20, remaining: value.ocr.remaining },
    translate: { limit: 10, remaining: value.translate.remaining },
    resetsAt: value.resetsAt,
  };
}

function parseErrorEnvelope(value: unknown, status: number): CloudClientError {
  if (
    !isExactObject(value, ['error'])
    || !isExactObject(value.error, ['code', 'message', 'requestId'])
    || !isServerErrorCode(value.error.code)
    || typeof value.error.message !== 'string'
    || value.error.message.length === 0
    || typeof value.error.requestId !== 'string'
    || value.error.requestId.length === 0
  ) {
    return clientError('INVALID_RESPONSE');
  }
  return new CloudClientError(
    value.error.code,
    safeMessages[value.error.code],
    { status, requestId: value.error.requestId },
  );
}

function isQuotaCounter(
  value: unknown,
  limit: 20 | 10,
): value is Readonly<{ limit: 20 | 10; remaining: number }> {
  return (
    isExactObject(value, ['limit', 'remaining'])
    && value.limit === limit
    && typeof value.remaining === 'number'
    && Number.isInteger(value.remaining)
    && value.remaining >= 0
    && value.remaining <= limit
  );
}

function isCanonicalIsoDate(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNormalizedNumber(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= 1
  );
}

function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

const serverErrorCodes = [
  'IMAGE_TOO_LARGE',
  'INTERNAL_SERVER_ERROR',
  'INVALID_IMAGE',
  'INVALID_SIGNATURE',
  'PROVIDER_INVALID_RESPONSE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'UNSUPPORTED_LANGUAGE',
  'UNSUPPORTED_MEDIA_TYPE',
] as const;

type ServerErrorCode = (typeof serverErrorCodes)[number];

function isServerErrorCode(value: unknown): value is ServerErrorCode {
  return typeof value === 'string'
    && (serverErrorCodes as readonly string[]).includes(value);
}

const safeMessages: Readonly<Record<ServerErrorCode, string>> = {
  IMAGE_TOO_LARGE: 'The selected image is too large.',
  INTERNAL_SERVER_ERROR: 'The cloud service could not complete the request.',
  INVALID_IMAGE: 'The selected image is not supported.',
  INVALID_SIGNATURE: 'The cloud request could not be verified.',
  PROVIDER_INVALID_RESPONSE: 'The recognition service returned an invalid response.',
  PROVIDER_TIMEOUT: 'The recognition service timed out.',
  PROVIDER_UNAVAILABLE: 'The recognition service is unavailable.',
  QUOTA_EXCEEDED: 'The anonymous daily quota has been exceeded.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  UNSUPPORTED_LANGUAGE: 'The detected language is not supported.',
  UNSUPPORTED_MEDIA_TYPE: 'The selected image type is not supported.',
};

const clientMessages: Readonly<
  Record<
    Extract<
      CloudClientErrorCode,
      | 'ABORTED'
      | 'CONFIGURATION_MISSING'
      | 'INVALID_RESPONSE'
      | 'NETWORK_UNAVAILABLE'
      | 'REQUEST_TIMEOUT'
    >,
    string
  >
> = {
  ABORTED: 'The cloud request was cancelled.',
  CONFIGURATION_MISSING: 'Cloud OCR is not configured.',
  INVALID_RESPONSE: 'The cloud service returned an invalid response.',
  NETWORK_UNAVAILABLE: 'The cloud service is unavailable.',
  REQUEST_TIMEOUT: 'The cloud request timed out.',
};

function clientError(code: keyof typeof clientMessages): CloudClientError {
  return new CloudClientError(code, clientMessages[code]);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
