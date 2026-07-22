import { describe, expect, it } from 'vitest';
import {
  captureSessionReducer,
  initialCaptureSession,
  type CaptureSession,
} from './capture-session';

const rect = { x: 20, y: 30, width: 300, height: 180 };

function annotatingSession(): CaptureSession {
  return captureSessionReducer(initialCaptureSession('desktop.png'), {
    type: 'selectionCommitted',
    rect,
  });
}

describe('captureSessionReducer', () => {
  it('commits a selection into annotation mode', () => {
    expect(annotatingSession()).toMatchObject({
      mode: 'annotating',
      selection: rect,
      sourceUrl: 'desktop.png',
    });
  });

  it('restores annotation state when scrolling is cancelled', () => {
    const scrolling = captureSessionReducer(annotatingSession(), { type: 'scrollStarted' });

    expect(captureSessionReducer(scrolling, { type: 'scrollCancelled' })).toMatchObject({
      mode: 'annotating',
      selection: rect,
      scrollResult: null,
    });
  });

  it('keeps a completed scroll image when editing resumes', () => {
    const previewing: CaptureSession = {
      ...annotatingSession(),
      mode: 'scrollPreview',
      scrollResult: new Blob(['long']),
    };

    expect(captureSessionReducer(previewing, {
      type: 'scrollEditRequested',
      imageUrl: 'blob:long',
    })).toMatchObject({
      mode: 'annotating',
      sourceUrl: 'blob:long',
      selection: null,
    });
  });

  it('returns to annotation mode after a cloud service finishes', () => {
    const busy = captureSessionReducer(annotatingSession(), {
      type: 'serviceStarted',
      service: 'ocr',
    });

    expect(captureSessionReducer(busy, { type: 'serviceFinished' })).toMatchObject({
      mode: 'annotating',
      service: null,
    });
  });
});
