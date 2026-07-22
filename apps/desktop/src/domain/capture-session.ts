import type { Rect } from './geometry';

export type CaptureMode =
  | 'selecting'
  | 'annotating'
  | 'scrolling'
  | 'scrollPreview'
  | 'serviceBusy';

export type CaptureService = 'ocr' | 'translate' | 'redact';

export type CaptureSession = Readonly<{
  mode: CaptureMode;
  selection: Rect | null;
  sourceUrl: string;
  scrollResult: Blob | null;
  service: CaptureService | null;
}>;

export type CaptureAction =
  | Readonly<{ type: 'selectionCommitted'; rect: Rect }>
  | Readonly<{ type: 'selectionChanged'; rect: Rect | null }>
  | Readonly<{ type: 'scrollStarted' }>
  | Readonly<{ type: 'scrollPreviewReady'; result: Blob }>
  | Readonly<{ type: 'scrollCancelled' }>
  | Readonly<{ type: 'scrollEditRequested'; imageUrl: string }>
  | Readonly<{ type: 'sessionReset' }>
  | Readonly<{ type: 'serviceStarted'; service: CaptureService }>
  | Readonly<{ type: 'serviceFinished' }>;

export function initialCaptureSession(sourceUrl = ''): CaptureSession {
  return {
    mode: 'selecting',
    selection: null,
    sourceUrl,
    scrollResult: null,
    service: null,
  };
}

export function captureSessionReducer(
  state: CaptureSession,
  action: CaptureAction,
): CaptureSession {
  switch (action.type) {
    case 'selectionCommitted':
      return { ...state, mode: 'annotating', selection: action.rect };
    case 'selectionChanged':
      return {
        ...state,
        mode: action.rect ? 'annotating' : 'selecting',
        selection: action.rect,
      };
    case 'scrollStarted':
      return { ...state, mode: 'scrolling' };
    case 'scrollPreviewReady':
      return { ...state, mode: 'scrollPreview', scrollResult: action.result };
    case 'scrollCancelled':
      return { ...state, mode: 'annotating', scrollResult: null };
    case 'scrollEditRequested':
      return {
        ...state,
        mode: 'annotating',
        sourceUrl: action.imageUrl,
        selection: null,
      };
    case 'sessionReset':
      return initialCaptureSession(state.sourceUrl);
    case 'serviceStarted':
      return { ...state, mode: 'serviceBusy', service: action.service };
    case 'serviceFinished':
      return { ...state, mode: 'annotating', service: null };
  }
}
