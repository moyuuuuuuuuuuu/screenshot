import { z } from 'zod';

import type { RecognitionResult } from '../domain/result.js';
import {
  ProviderError,
  type OcrTranslationProvider,
  type RecognitionMode,
} from './provider.js';

const requestTimeoutMilliseconds = 20_000;

const uploadEnvelopeSchema = z.object({
  data: z.object({
    id: z.string().min(1),
  }),
});

const workflowEnvelopeSchema = z.object({
  code: z.literal(0),
  data: z.string(),
});

const normalizedCoordinateSchema = z.number().min(0).max(1);

const workflowOutputSchema = z
  .object({
    source_language: z.string(),
    original_text: z.string(),
    translated_text: z.string().nullable(),
    blocks: z.array(
      z
        .object({
          text: z.string().min(1),
          confidence: z.number().min(0).max(1),
          box: z
            .object({
              x: normalizedCoordinateSchema,
              y: normalizedCoordinateSchema,
              width: normalizedCoordinateSchema,
              height: normalizedCoordinateSchema,
            })
            .strict()
            .refine(({ x, width }) => x + width <= 1)
            .refine(({ y, height }) => y + height <= 1),
        })
        .strict(),
    ),
  })
  .strict();

export type CozeProviderOptions = Readonly<{
  baseUrl: string;
  token: string;
  workflowId: string;
  fetch: typeof fetch;
}>;

export class CozeOcrTranslationProvider implements OcrTranslationProvider {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly workflowId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CozeProviderOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.token = options.token.trim();
    this.workflowId = options.workflowId.trim();
    this.fetchImpl = options.fetch;
  }

  async recognize(
    mode: RecognitionMode,
    image: Uint8Array,
    _requestId: string,
  ): Promise<RecognitionResult> {
    const controller = new AbortController();
    let rejectDeadline: ((error: ProviderError) => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      rejectDeadline?.(new ProviderError('PROVIDER_TIMEOUT'));
    }, requestTimeoutMilliseconds);

    try {
      return await Promise.race([
        this.uploadAndRun(mode, image, controller.signal),
        deadline,
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async uploadAndRun(
    mode: RecognitionMode,
    image: Uint8Array,
    signal: AbortSignal,
  ): Promise<RecognitionResult> {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Uint8Array.from(image)], { type: 'application/octet-stream' }),
      'screenshot',
    );
    const uploadResponse = await this.request(
      `${this.baseUrl}/v1/files/upload`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}` },
        body: form,
      },
      signal,
    );
    const uploadEnvelope = uploadEnvelopeSchema.safeParse(
      await this.readJson(uploadResponse),
    );
    if (!uploadEnvelope.success) {
      throw new ProviderError('PROVIDER_INVALID_RESPONSE');
    }

    const workflowResponse = await this.request(
      `${this.baseUrl}/v1/workflow/run`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          workflow_id: this.workflowId,
          parameters: {
            operation: mode,
            image: JSON.stringify({ file_id: uploadEnvelope.data.data.id }),
          },
        }),
      },
      signal,
    );
    const workflowEnvelope = workflowEnvelopeSchema.safeParse(
      await this.readJson(workflowResponse),
    );
    if (!workflowEnvelope.success) {
      throw new ProviderError('PROVIDER_INVALID_RESPONSE');
    }

    const rawOutput = parseSerializedJson(workflowEnvelope.data.data);
    const output = workflowOutputSchema.safeParse(rawOutput);
    if (!output.success) {
      throw new ProviderError('PROVIDER_INVALID_RESPONSE');
    }
    if (output.data.source_language !== 'zh' && output.data.source_language !== 'en') {
      throw new ProviderError('UNSUPPORTED_LANGUAGE');
    }
    if (
      (mode === 'ocr' && output.data.translated_text !== null) ||
      (mode === 'translate' && output.data.translated_text === null)
    ) {
      throw new ProviderError('PROVIDER_INVALID_RESPONSE');
    }

    return {
      sourceLanguage: output.data.source_language,
      originalText: output.data.original_text,
      translatedText: output.data.translated_text,
      blocks: output.data.blocks.map(({ text, box }) => ({
        text,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      })),
    };
  }

  private async request(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    try {
      const response = await this.fetchImpl(url, { ...init, signal });
      if (signal.aborted) {
        throw new ProviderError('PROVIDER_TIMEOUT');
      }
      if (!response.ok) {
        throw new ProviderError('PROVIDER_UNAVAILABLE');
      }
      return response;
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError(
        signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
      );
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new ProviderError('PROVIDER_INVALID_RESPONSE');
    }
  }
}

function parseSerializedJson(serialized: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new ProviderError('PROVIDER_INVALID_RESPONSE');
  }
}
