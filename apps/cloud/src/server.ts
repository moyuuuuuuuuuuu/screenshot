import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { recognitionResultSchema } from './domain/result.js';
import { MockOcrTranslationProvider } from './providers/mock-provider.js';
import type { OcrTranslationProvider, RecognitionMode } from './providers/provider.js';

const maximumImageBytes = 8 * 1024 * 1024;
const parserBodyLimit = maximumImageBytes + 1;

type ErrorCode = 'IMAGE_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE' | 'INTERNAL_SERVER_ERROR';

type ErrorEnvelope = Readonly<{
  error: Readonly<{
    code: ErrorCode;
    message: string;
    requestId: string;
  }>;
}>;

export function buildServer(
  provider: OcrTranslationProvider = new MockOcrTranslationProvider(),
): FastifyInstance {
  const app = Fastify({ bodyLimit: parserBodyLimit });

  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.setErrorHandler((error, request, reply) => {
    const requestId = getRequestId(request);
    if (isBodyTooLargeError(error)) {
      void reply.status(413).send(
        createErrorEnvelope(
          'IMAGE_TOO_LARGE',
          'Image uploads must not exceed 8 MB.',
          requestId,
        ),
      );
      return;
    }

    void reply.status(500).send(
      createErrorEnvelope(
        'INTERNAL_SERVER_ERROR',
        'An unexpected error occurred.',
        requestId,
      ),
    );
  });

  app.post('/v1/ocr', async (request, reply) => recognize('ocr', request, reply, provider));
  app.post('/v1/translate', async (request, reply) =>
    recognize('translate', request, reply, provider),
  );

  return app;
}

async function recognize(
  mode: RecognitionMode,
  request: FastifyRequest,
  reply: FastifyReply,
  provider: OcrTranslationProvider,
): Promise<FastifyReply> {
  const requestId = getRequestId(request);
  const contentType = request.headers['content-type'];

  if (!isImageMime(contentType)) {
    return reply.status(415).send(
      createErrorEnvelope(
        'UNSUPPORTED_MEDIA_TYPE',
        'Only image uploads are supported.',
        requestId,
      ),
    );
  }

  if (!Buffer.isBuffer(request.body) || request.body.byteLength > maximumImageBytes) {
    return reply.status(413).send(
      createErrorEnvelope('IMAGE_TOO_LARGE', 'Image uploads must not exceed 8 MB.', requestId),
    );
  }

  const result = recognitionResultSchema.parse(
    await provider.recognize(mode, request.body, requestId),
  );
  return reply.send(result);
}

function getRequestId(request: FastifyRequest): string {
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && header.length > 0 ? header : randomUUID();
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
