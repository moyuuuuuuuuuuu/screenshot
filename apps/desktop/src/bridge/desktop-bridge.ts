import type { Rect } from '../domain/geometry';

export type LongCaptureProgress = Readonly<{
  frameCount: number;
  stitchedHeight: number;
  state: 'preparing' | 'capturing' | 'scrolling' | 'stabilizing' | 'matching';
}>;

export type LongCaptureResult = Readonly<{
  png: Blob;
  partial: boolean;
}>;

export interface DesktopBridge {
  copyPng(blob: Blob): Promise<void>;
  savePng(blob: Blob, suggestedName: string): Promise<string | null>;
  closeOverlay(): Promise<void>;
  startLongCapture(
    region: Rect,
    onProgress: (progress: LongCaptureProgress) => void,
  ): Promise<LongCaptureResult>;
  stopLongCapture(): Promise<void>;
}
