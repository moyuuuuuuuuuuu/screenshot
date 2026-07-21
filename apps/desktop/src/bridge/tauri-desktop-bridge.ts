import type { DesktopBridge } from './desktop-bridge';
import type { LongCaptureResult } from './desktop-bridge';

export type TauriInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

async function blobBytes(blob: Blob): Promise<number[]> {
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read PNG blob'));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('PNG blob did not produce binary data'));
    };
    reader.readAsArrayBuffer(blob);
  });
  return Array.from(new Uint8Array(buffer));
}

export function createTauriDesktopBridge(invoke: TauriInvoke): DesktopBridge {
  return {
    async copyPng(blob) {
      await invoke('copy_png', { pngBytes: await blobBytes(blob) });
    },
    async savePng(blob, suggestedName) {
      const result = await invoke('save_png', {
        pngBytes: await blobBytes(blob),
        suggestedName,
      });
      if (result === null || typeof result === 'string') return result;
      throw new Error('save_png returned an invalid path');
    },
    async closeOverlay() {
      await invoke('close_overlay');
    },
    async startLongCapture(region, onProgress) {
      onProgress({ frameCount: 0, stitchedHeight: 0, state: 'preparing' });
      const progressTimer = window.setInterval(() => {
        void invoke('long_capture_progress').then((value) => {
          if (!value || typeof value !== 'object') return;
          const progress = value as Record<string, unknown>;
          if (
            typeof progress.frameCount === 'number'
            && typeof progress.stitchedHeight === 'number'
            && ['preparing', 'capturing', 'scrolling', 'stabilizing', 'matching'].includes(String(progress.state))
          ) {
            onProgress(progress as unknown as Parameters<typeof onProgress>[0]);
          }
        }).catch(() => undefined);
      }, 120);
      let value: unknown;
      try {
        value = await invoke('start_long_capture', { region });
      } finally {
        window.clearInterval(progressTimer);
      }
      if (!value || typeof value !== 'object') throw new Error('invalid long capture result');
      const result = value as { pngBytes?: unknown; partial?: unknown };
      if (!Array.isArray(result.pngBytes) || typeof result.partial !== 'boolean') {
        throw new Error('invalid long capture result');
      }
      return {
        png: new Blob([new Uint8Array(result.pngBytes as number[])], { type: 'image/png' }),
        partial: result.partial,
      } satisfies LongCaptureResult;
    },
    async stopLongCapture() {
      await invoke('stop_long_capture');
    },
  };
}
