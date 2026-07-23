import type { Rect } from '../domain/geometry';

export type LongCaptureProgress = Readonly<{
  frameCount: number;
  stitchedHeight: number;
  state: 'preparing' | 'observing' | 'scrolling' | 'stabilizing' | 'matching'
    | 'pausedReverse' | 'warning' | 'completed' | 'partial' | 'cancelled' | 'failed';
  previewPngBytes: readonly number[];
  navigatorPngBytes: readonly number[];
  acceptedBounds: Rect | null;
  warning: boolean;
  slowScrollWarning: boolean;
}>;

export type LongCaptureResult = Readonly<{
  png: Blob;
  partial: boolean;
  action: 'edit' | 'save' | 'finish';
  clipboardError?: string;
  cleanupError?: string;
}>;

export type AppSettings = Readonly<{
  shortcut: string;
  cloudPrivacyAcknowledged: boolean;
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
  editLongCapture(): Promise<void>;
  saveLongCapture(): Promise<void>;
  finishLongCapture(): Promise<void>;
  cancelLongCapture(): Promise<void>;
  getLongCaptureProgress(): Promise<LongCaptureProgress>;
  getCloudDeviceId(): Promise<string>;
  loadSettings(): Promise<AppSettings>;
  updateShortcut(shortcut: string): Promise<AppSettings>;
  updateCloudPrivacyAcknowledgement(acknowledged: boolean): Promise<AppSettings>;
  pinPng(blob: Blob, bounds: Rect): Promise<string>;
  sharePng(blob: Blob): Promise<ShareOutcome>;
  getPinnedPng(label: string): Promise<Blob>;
  startWindowDragging(): Promise<void>;
  closePinWindow(label: string): Promise<void>;
}
