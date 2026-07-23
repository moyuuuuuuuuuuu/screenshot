import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import sharp from 'sharp';

import { recognitionResultSchema } from './domain/result.js';
import { CozeOcrTranslationProvider } from './providers/coze-provider.js';
import { MockOcrTranslationProvider } from './providers/mock-provider.js';
import {
  ProviderError,
  type OcrTranslationProvider,
  type ProviderErrorCode,
  type RecognitionMode,
} from './providers/provider.js';
import { MemoryQuotaStore } from './quota/memory-quota-store.js';
import type { QuotaStore } from './quota/quota-store.js';
import {
  verifyRequestSignature,
  type RequestOperation,
} from './security/request-signature.js';

const maximumImageBytes = 8 * 1024 * 1024;
const maximumImageEdge = 4096;
const parserBodyLimit = maximumImageBytes + 1;
const burstWindowMilliseconds = 60_000;
const burstRequestLimit = 30;
const freshnessWindowMilliseconds = 5 * 60_000;

type ErrorCode =
  | 'IMAGE_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INVALID_IMAGE'
  | 'INVALID_SIGNATURE'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | ProviderErrorCode
  | 'INTERNAL_SERVER_ERROR';

type ErrorEnvelope = Readonly<{
  error: Readonly<{
    code: ErrorCode;
    message: string;
    requestId: string;
  }>;
}>;

export type AuditEvent = Readonly<{
  requestId: string;
  operation: RequestOperation;
  durationMs: number;
  statusCode: number;
  errorCode?: ErrorCode;
}>;

export interface AuditLogger {
  log(event: AuditEvent): void;
}

export type ServerOptions = Readonly<{
  signingSecret: string;
  provider?: OcrTranslationProvider;
  environment?: CloudProviderEnvironment;
  providerFetch?: typeof fetch;
  quotaStore?: QuotaStore;
  clock?: () => number;
  auditLogger?: AuditLogger;
  requestIdFactory?: () => string;
}>;

type ServerDependencies = Readonly<{
  signingSecret: string;
  provider: OcrTranslationProvider;
  quotaStore: QuotaStore;
  clock: () => number;
  auditLogger: AuditLogger;
  rateLimiter: RollingIpRateLimiter;
  replayGuard: ReplayGuard;
}>;

const noopAuditLogger: AuditLogger = { log: () => undefined };

export type CloudProviderEnvironment = Readonly<{
  NODE_ENV?: string;
  CLOUD_PROVIDER?: string;
  COZE_API_BASE_URL?: string;
  COZE_API_TOKEN?: string;
  COZE_WORKFLOW_ID?: string;
}>;

export function createProviderFromEnvironment(
  environment: CloudProviderEnvironment = process.env,
  fetchImpl: typeof fetch = fetch,
): OcrTranslationProvider {
  const providerName = environment.CLOUD_PROVIDER;
  if (environment.NODE_ENV === 'production' && providerName !== 'coze') {
    throw new Error('Production requires CLOUD_PROVIDER=coze.');
  }
  if (providerName === 'mock') {
    return new MockOcrTranslationProvider();
  }
  if (providerName !== 'coze') {
    throw new Error('Unsupported CLOUD_PROVIDER.');
  }

  const baseUrl = requiredCozeEnvironment(environment, 'COZE_API_BASE_URL');
  const token = requiredCozeEnvironment(environment, 'COZE_API_TOKEN');
  const workflowId = requiredCozeEnvironment(environment, 'COZE_WORKFLOW_ID');
  return new CozeOcrTranslationProvider({
    baseUrl,
    token,
    workflowId,
    fetch: fetchImpl,
  });
}

export function buildServer(options: ServerOptions): FastifyInstance {
  if (options.signingSecret.trim().length === 0) {
    throw new Error('A non-empty signing secret is required.');
  }

  const clock = options.clock ?? Date.now;
  const dependencies: ServerDependencies = {
    signingSecret: options.signingSecret,
    provider:
      options.provider ??
      createProviderFromEnvironment(
        options.environment ?? process.env,
        options.providerFetch ?? fetch,
      ),
    quotaStore: options.quotaStore ?? new MemoryQuotaStore(),
    clock,
    auditLogger: options.auditLogger ?? noopAuditLogger,
    rateLimiter: new RollingIpRateLimiter(),
    replayGuard: new ReplayGuard(),
  };
  const app = Fastify({
    bodyLimit: parserBodyLimit,
    genReqId: () => options.requestIdFactory?.() ?? randomUUID(),
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = getRequestId(request);
    const operation = getOperation(request);
    if (isBodyTooLargeError(error)) {
      dependencies.auditLogger.log({
        requestId,
        operation,
        durationMs: 0,
        statusCode: 413,
        errorCode: 'IMAGE_TOO_LARGE',
      });
      void reply.status(413).send(
        createErrorEnvelope(
          'IMAGE_TOO_LARGE',
          'Image uploads must not exceed 8 MB.',
          requestId,
        ),
      );
      return;
    }

    dependencies.auditLogger.log({
      requestId,
      operation,
      durationMs: 0,
      statusCode: 500,
      errorCode: 'INTERNAL_SERVER_ERROR',
    });
    void reply.status(500).send(
      createErrorEnvelope(
        'INTERNAL_SERVER_ERROR',
        'An unexpected error occurred.',
        requestId,
      ),
    );
  });

  app.post('/v1/ocr', async (request, reply) =>
    recognize('ocr', request, reply, dependencies),
  );
  app.post('/v1/translate', async (request, reply) =>
    recognize('translate', request, reply, dependencies),
  );
  app.get('/v1/quota', async (request, reply) =>
    readQuota(request, reply, dependencies),
  );

  return app;
}

async function readQuota(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ServerDependencies,
): Promise<FastifyReply> {
  const startedAt = dependencies.clock();
  const requestId = getRequestId(request);
  const now = dependencies.clock();
  if (!dependencies.rateLimiter.accept(request.ip, now)) {
    return reject(
      reply,
      dependencies,
      startedAt,
      requestId,
      'quota',
      429,
      'RATE_LIMITED',
      'Too many requests. Try again later.',
    );
  }

  const authentication = verifyAuthentication(
    'quota',
    request,
    dependencies,
    now,
    new Uint8Array(),
  );
  if (authentication === null) {
    return reject(
      reply,
      dependencies,
      startedAt,
      requestId,
      'quota',
      401,
      'INVALID_SIGNATURE',
      'The request signature is invalid.',
    );
  }

  if (
    !dependencies.replayGuard.accept(
      authentication.deviceId,
      authentication.timestamp,
      authentication.signature,
      authentication.timestampMilliseconds,
      now,
    )
  ) {
    return reject(
      reply,
      dependencies,
      startedAt,
      requestId,
      'quota',
      401,
      'INVALID_SIGNATURE',
      'The request signature is invalid.',
    );
  }

  const status = await dependencies.quotaStore.status(authentication.deviceId, now);
  dependencies.auditLogger.log({
    requestId,
    operation: 'quota',
    durationMs: elapsed(dependencies.clock(), startedAt),
    statusCode: 200,
  });
  return reply.send({
    ocr: { limit: 20, remaining: status.ocr.remaining },
    translate: { limit: 10, remaining: status.translate.remaining },
    resetsAt: status.resetsAt,
  });
}

async function recognize(
  mode: RecognitionMode,
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ServerDependencies,
): Promise<FastifyReply> {
  const startedAt = dependencies.clock();
  const requestId = getRequestId(request);
  const contentType = request.headers['content-type'];

  if (!isImageMime(contentType)) {
    return reject(
      reply,
      dependencies,
      startedAt,
      requestId,
      mode,
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Only image uploads are supported.',
    );
  }

  if (!Buffer.isBuffer(request.body) || request.body.byteLength > maximumImageBytes) {
    return reject(
      reply,
      dependencies,
      startedAt,
      requestId,
      mode,
      413,
      'IMAGE_TOO_LARGE',
      'Image uploads must not exceed 8 MB.',
    );
  }

  const now = dependencies.clock();
  if (!dependencies.rateLimiter.accept(request.ip, now)) {
    return reject(
      reply,
      dependencies,
      startedAt,
      requestId,
      mode,
      429,
      'RATE_LIMITED',
      'Too many requests. Try again later.',
    );
  }

  const authentication = verifyAuthentication(mode, request, dependencies, now);
  if (authentication === null) {
    return reject(
      reply,
      dependencies,
      startedAt,
      requestId,
      mode,
      401,
      'INVALID_SIGNATURE',
      'The request signature is invalid.',
    );
  }

  if (!(await isValidImage(request.body))) {
    return reject(
      reply,
      dependencies,
      startedAt,
      requestId,
      mode,
      400,
      'INVALID_IMAGE',
      'The upload must be a valid PNG or JPEG within 4096 pixels per edge.',
    );
  }

  if (
    !dependencies.replayGuard.accept(
      authentication.deviceId,
      authentication.timestamp,
      authentication.signature,
      authentication.timestampMilliseconds,
      now,
    )
  ) {
    return reject(
      reply,
      dependencies,
      startedAt,
      requestId,
      mode,
      401,
      'INVALID_SIGNATURE',
      'The request signature is invalid.',
    );
  }

  const quota = await dependencies.quotaStore.consume(authentication.deviceId, mode, now);
  if (!quota.accepted) {
    return reject(
      reply,
      dependencies,
      startedAt,
      requestId,
      mode,
      429,
      'QUOTA_EXCEEDED',
      'The anonymous daily quota has been exceeded.',
    );
  }

  let result;
  try {
    result = recognitionResultSchema.parse(
      await dependencies.provider.recognize(mode, request.body, requestId),
    );
  } catch (error) {
    if (error instanceof ProviderError) {
      const response = providerErrorResponses[error.code];
      return reject(
        reply,
        dependencies,
        startedAt,
        requestId,
        mode,
        response.statusCode,
        error.code,
        error.message,
      );
    }
    throw error;
  }
  dependencies.auditLogger.log({
    requestId,
    operation: mode,
    durationMs: elapsed(dependencies.clock(), startedAt),
    statusCode: 200,
  });
  return reply.send(result);
}

type VerifiedAuthentication = Readonly<{
  deviceId: string;
  timestamp: string;
  signature: string;
  timestampMilliseconds: number;
}>;

function verifyAuthentication(
  mode: RequestOperation,
  request: FastifyRequest,
  dependencies: ServerDependencies,
  now: number,
  body: Uint8Array = request.body as Buffer,
): VerifiedAuthentication | null {
  const deviceId = singleHeader(request.headers['x-device-id']);
  const timestamp = singleHeader(request.headers['x-request-timestamp']);
  const signature = singleHeader(request.headers['x-request-signature']);
  if (
    deviceId === null ||
    timestamp === null ||
    signature === null ||
    !lowercaseUuidPattern.test(deviceId) ||
    !timestampPattern.test(timestamp)
  ) {
    return null;
  }

  const timestampMilliseconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampMilliseconds) ||
    Math.abs(now - timestampMilliseconds) > freshnessWindowMilliseconds ||
    !verifyRequestSignature(
      { deviceId, timestamp, mode, image: body },
      dependencies.signingSecret,
      signature,
    )
  ) {
    return null;
  }

  return { deviceId, timestamp, signature, timestampMilliseconds };
}

const lowercaseUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const timestampPattern = /^(0|[1-9][0-9]*)$/;

function singleHeader(header: string | string[] | undefined): string | null {
  return typeof header === 'string' ? header : null;
}

class RollingIpRateLimiter {
  private readonly acceptedCounts = new Map<string, number>();
  private acceptedRequests: Array<Readonly<{ ipAddress: string; acceptedAt: number }>> = [];
  private firstActiveRequest = 0;

  accept(ipAddress: string, now: number): boolean {
    this.expireRequests(now - burstWindowMilliseconds);
    const acceptedCount = this.acceptedCounts.get(ipAddress) ?? 0;
    if (acceptedCount >= burstRequestLimit) {
      return false;
    }

    this.acceptedCounts.set(ipAddress, acceptedCount + 1);
    this.acceptedRequests.push({ ipAddress, acceptedAt: now });
    return true;
  }

  private expireRequests(windowStart: number): void {
    while (this.firstActiveRequest < this.acceptedRequests.length) {
      const request = this.acceptedRequests[this.firstActiveRequest];
      if (request === undefined || request.acceptedAt > windowStart) {
        break;
      }

      const count = this.acceptedCounts.get(request.ipAddress) ?? 0;
      if (count <= 1) {
        this.acceptedCounts.delete(request.ipAddress);
      } else {
        this.acceptedCounts.set(request.ipAddress, count - 1);
      }
      this.firstActiveRequest += 1;
    }

    if (
      this.firstActiveRequest >= 1_024 &&
      this.firstActiveRequest * 2 >= this.acceptedRequests.length
    ) {
      this.acceptedRequests = this.acceptedRequests.slice(this.firstActiveRequest);
      this.firstActiveRequest = 0;
    }
  }
}

type ReplayExpiration = Readonly<{ key: string; expiresAt: number }>;

class ReplayGuard {
  private readonly expirations = new Map<string, number>();
  private readonly expirationHeap: ReplayExpiration[] = [];

  accept(
    deviceId: string,
    timestamp: string,
    signature: string,
    timestampMilliseconds: number,
    now: number,
  ): boolean {
    this.expireTuples(now);

    const key = `${deviceId}\n${timestamp}\n${signature}`;
    if (this.expirations.has(key)) {
      return false;
    }

    const expiresAt = timestampMilliseconds + freshnessWindowMilliseconds;
    this.expirations.set(key, expiresAt);
    this.pushExpiration({ key, expiresAt });
    return true;
  }

  private expireTuples(now: number): void {
    while ((this.expirationHeap[0]?.expiresAt ?? Number.POSITIVE_INFINITY) < now) {
      const expiration = this.popExpiration();
      if (
        expiration !== undefined &&
        this.expirations.get(expiration.key) === expiration.expiresAt
      ) {
        this.expirations.delete(expiration.key);
      }
    }
  }

  private pushExpiration(expiration: ReplayExpiration): void {
    this.expirationHeap.push(expiration);
    let index = this.expirationHeap.length - 1;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = this.expirationHeap[parentIndex];
      if (parent === undefined || parent.expiresAt <= expiration.expiresAt) {
        break;
      }
      this.expirationHeap[index] = parent;
      index = parentIndex;
    }
    this.expirationHeap[index] = expiration;
  }

  private popExpiration(): ReplayExpiration | undefined {
    const first = this.expirationHeap[0];
    const last = this.expirationHeap.pop();
    if (first === undefined || last === undefined || this.expirationHeap.length === 0) {
      return first;
    }

    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      const rightIndex = leftIndex + 1;
      const left = this.expirationHeap[leftIndex];
      const right = this.expirationHeap[rightIndex];
      if (left === undefined) {
        break;
      }
      const childIndex = right !== undefined && right.expiresAt < left.expiresAt
        ? rightIndex
        : leftIndex;
      const child = this.expirationHeap[childIndex];
      if (child === undefined || child.expiresAt >= last.expiresAt) {
        break;
      }
      this.expirationHeap[index] = child;
      index = childIndex;
    }
    this.expirationHeap[index] = last;
    return first;
  }
}

async function isValidImage(image: Buffer): Promise<boolean> {
  try {
    const pipeline = sharp(image, {
      failOn: 'warning',
      limitInputPixels: maximumImageEdge * maximumImageEdge,
      sequentialRead: true,
    });
    const metadata = await pipeline.metadata();
    if (
      (metadata.format !== 'png' && metadata.format !== 'jpeg') ||
      metadata.width === undefined ||
      metadata.height === undefined ||
      metadata.width === 0 ||
      metadata.height === 0 ||
      metadata.width > maximumImageEdge ||
      metadata.height > maximumImageEdge
    ) {
      return false;
    }

    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    return data.byteLength > 0 && info.width === metadata.width && info.height === metadata.height;
  } catch {
    return false;
  }
}

function reject(
  reply: FastifyReply,
  dependencies: ServerDependencies,
  startedAt: number,
  requestId: string,
  operation: RequestOperation,
  statusCode: number,
  errorCode: ErrorCode,
  message: string,
): FastifyReply {
  dependencies.auditLogger.log({
    requestId,
    operation,
    durationMs: elapsed(dependencies.clock(), startedAt),
    statusCode,
    errorCode,
  });
  return reply.status(statusCode).send(createErrorEnvelope(errorCode, message, requestId));
}

function elapsed(finishedAt: number, startedAt: number): number {
  return Math.max(0, finishedAt - startedAt);
}

function getRequestId(request: FastifyRequest): string {
  return request.id;
}

function getOperation(request: FastifyRequest): RequestOperation {
  if (request.url.startsWith('/v1/quota')) {
    return 'quota';
  }
  return request.url.startsWith('/v1/translate') ? 'translate' : 'ocr';
}

function isImageMime(contentType: string | undefined): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase().startsWith('image/') ?? false;
}

function createErrorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
): ErrorEnvelope {
  return { error: { code, message, requestId } };
}

function isBodyTooLargeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
  );
}

function requiredCozeEnvironment(
  environment: CloudProviderEnvironment,
  name: 'COZE_API_BASE_URL' | 'COZE_API_TOKEN' | 'COZE_WORKFLOW_ID',
): string {
  const value = environment[name]?.trim() ?? '';
  if (value.length === 0) {
    throw new Error(`${name} is required when CLOUD_PROVIDER=coze.`);
  }
  return value;
}

const providerErrorResponses: Readonly<
  Record<ProviderErrorCode, Readonly<{ statusCode: number }>>
> = {
  UNSUPPORTED_LANGUAGE: { statusCode: 422 },
  PROVIDER_INVALID_RESPONSE: { statusCode: 502 },
  PROVIDER_TIMEOUT: { statusCode: 504 },
  PROVIDER_UNAVAILABLE: { statusCode: 503 },
};
