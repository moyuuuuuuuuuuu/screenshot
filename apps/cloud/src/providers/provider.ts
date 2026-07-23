import type { RecognitionResult } from '../domain/result.js';

export type RecognitionMode = 'ocr' | 'translate';

export type ProviderErrorCode =
  | 'UNSUPPORTED_LANGUAGE'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE';

const providerErrorMessages: Readonly<Record<ProviderErrorCode, string>> = {
  UNSUPPORTED_LANGUAGE: 'The detected language is not supported.',
  PROVIDER_INVALID_RESPONSE: 'The OCR provider returned an invalid response.',
  PROVIDER_TIMEOUT: 'The OCR provider timed out.',
  PROVIDER_UNAVAILABLE: 'The OCR provider is unavailable.',
};

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode) {
    super(providerErrorMessages[code]);
    this.name = 'ProviderError';
    this.code = code;
  }
}

export interface OcrTranslationProvider {
  recognize(
    mode: RecognitionMode,
    image: Uint8Array,
    requestId: string,
  ): Promise<RecognitionResult>;
}
