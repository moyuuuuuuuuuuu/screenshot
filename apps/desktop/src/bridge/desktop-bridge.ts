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

export type AppSettings = Readonly<{
  shortcut: string;
  coze: Readonly<{
    token: string;
    workflowId: string;
  }>;
}>;

export type ShareOutcome = 'nativeShared' | 'copiedFallback';

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
  loadSettings(): Promise<AppSettings>;
  updateSettings(settings: AppSettings): Promise<AppSettings>;
  pinPng(blob: Blob, bounds: Rect): Promise<string>;
  sharePng(blob: Blob): Promise<ShareOutcome>;
  getPinnedPng(label: string): Promise<Blob>;
  startWindowDragging(): Promise<void>;
  closePinWindow(label: string): Promise<void>;
}
