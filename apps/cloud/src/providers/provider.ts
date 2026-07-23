import type { RecognitionResult } from '../domain/result.js';

export type RecognitionMode = 'ocr' | 'translate';

export interface OcrTranslationProvider {
  recognize(
    mode: RecognitionMode,
    image: Uint8Array,
    requestId: string,
  ): Promise<RecognitionResult>;
}
