import type { RecognitionResult } from '../domain/result.js';
import type { OcrTranslationProvider, RecognitionMode } from './provider.js';

const mockText = '模拟 OCR 文本';

export class MockOcrTranslationProvider implements OcrTranslationProvider {
  async recognize(
    mode: RecognitionMode,
    _image: Uint8Array,
    _requestId: string,
  ): Promise<RecognitionResult> {
    return {
      sourceLanguage: 'zh',
      originalText: mockText,
      translatedText: mode === 'translate' ? 'Mock translated text' : null,
      blocks: [
        {
          text: mockText,
          x: 0.1,
          y: 0.1,
          width: 0.8,
          height: 0.1,
        },
      ],
    };
  }
}
