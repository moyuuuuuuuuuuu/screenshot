import type { DesktopBridge } from './desktop-bridge';
import type { LongCaptureProgress, LongCaptureResult } from './desktop-bridge';
import type { AppSettings } from './desktop-bridge';

export type TauriInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const progressStates = new Set<LongCaptureProgress['state']>([
  'preparing', 'observing', 'scrolling', 'stabilizing', 'matching',
  'pausedReverse', 'warning', 'completed', 'partial', 'cancelled', 'failed',
]);

function parseLongCaptureProgress(value: unknown): LongCaptureProgress {
  if (!value || typeof value !== 'object') throw new Error('invalid long capture progress');
  const progress = value as Record<string, unknown>;
  if (
    typeof progress.frameCount !== 'number'
    || typeof progress.stitchedHeight !== 'number'
    || !progressStates.has(progress.state as LongCaptureProgress['state'])
    || !Array.isArray(progress.previewPngBytes)
    || typeof progress.warning !== 'boolean'
  ) throw new Error('invalid long capture progress');
  return progress as LongCaptureProgress;
}

function parseSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') throw new Error('invalid settings');
  const settings = value as Record<string, unknown>;
  const coze = settings.coze as Record<string, unknown> | undefined;
  if (
    typeof settings.shortcut !== 'string'
    || !coze
    || typeof coze.token !== 'string'
    || typeof coze.workflowId !== 'string'
  ) throw new Error('invalid settings');
  return settings as AppSettings;
}

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
      onProgress({
        frameCount: 0,
        stitchedHeight: 0,
        state: 'preparing',
        previewPngBytes: [],
        warning: false,
      });
      const progressTimer = window.setInterval(() => {
        void invoke('long_capture_progress').then((value) => {
          onProgress(parseLongCaptureProgress(value));
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
    async cancelLongCapture() {
      await invoke('cancel_long_capture');
    },
    async getLongCaptureProgress() {
      return parseLongCaptureProgress(await invoke('long_capture_progress'));
    },
    async loadSettings() {
      return parseSettings(await invoke('load_settings'));
    },
    async updateSettings(settings) {
      await invoke('update_shortcut', { shortcut: settings.shortcut });
      return parseSettings(await invoke('update_coze_config', { config: settings.coze }));
    },
  };
}
