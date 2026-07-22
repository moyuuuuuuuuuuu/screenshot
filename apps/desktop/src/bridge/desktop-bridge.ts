import type { Rect } from '../domain/geometry';

export type LongCaptureProgress = Readonly<{
  frameCount: number;
  stitchedHeight: number;
  state: 'preparing' | 'observing' | 'scrolling' | 'stabilizing' | 'matching'
    | 'pausedReverse' | 'warning' | 'completed' | 'partial' | 'cancelled' | 'failed';
  previewPngBytes: readonly number[];
  warning: boolean;
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
  cancelLongCapture(): Promise<void>;
  getLongCaptureProgress(): Promise<LongCaptureProgress>;
}
