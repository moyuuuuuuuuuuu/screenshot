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
const lowercaseUuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function parseLongCaptureProgress(value: unknown): LongCaptureProgress {
  if (!value || typeof value !== 'object') throw new Error('invalid long capture progress');
  const progress = value as Record<string, unknown>;
  if (
    typeof progress.frameCount !== 'number'
    || typeof progress.stitchedHeight !== 'number'
    || !progressStates.has(progress.state as LongCaptureProgress['state'])
    || !Array.isArray(progress.previewPngBytes)
    || !Array.isArray(progress.navigatorPngBytes)
    || typeof progress.warning !== 'boolean'
    || typeof progress.slowScrollWarning !== 'boolean'
  ) throw new Error('invalid long capture progress');
  return progress as LongCaptureProgress;
}

function parseSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') throw new Error('invalid settings');
  const settings = value as Record<string, unknown>;
  if (
    Object.keys(settings).length !== 2
    || typeof settings.shortcut !== 'string'
    || typeof settings.cloudPrivacyAcknowledged !== 'boolean'
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
        navigatorPngBytes: [],
        acceptedBounds: null,
        warning: false,
        slowScrollWarning: false,
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
      const result = value as {
        pngBytes?: unknown; partial?: unknown; action?: unknown;
        clipboardError?: unknown; cleanupError?: unknown;
      };
      const action = result.action ?? 'edit';
      if (!Array.isArray(result.pngBytes) || typeof result.partial !== 'boolean'
        || !['edit', 'save', 'finish'].includes(action as string)
        || (result.clipboardError != null && typeof result.clipboardError !== 'string')
        || (result.cleanupError != null && typeof result.cleanupError !== 'string')
        || (action !== 'edit' && (result.clipboardError != null || result.cleanupError != null))) {
        throw new Error('invalid long capture result');
      }
      return {
        png: new Blob([new Uint8Array(result.pngBytes as number[])], { type: 'image/png' }),
        partial: result.partial,
        action: action as LongCaptureResult['action'],
        ...(typeof result.clipboardError === 'string'
          ? { clipboardError: result.clipboardError }
          : {}),
        ...(typeof result.cleanupError === 'string'
          ? { cleanupError: result.cleanupError }
          : {}),
      } satisfies LongCaptureResult;
    },
    async stopLongCapture() {
      await invoke('stop_long_capture');
    },
    async editLongCapture() { await invoke('edit_long_capture'); },
    async saveLongCapture() { await invoke('save_long_capture'); },
    async finishLongCapture() { await invoke('finish_long_capture'); },
    async cancelLongCapture() {
      await invoke('cancel_long_capture');
    },
    async getLongCaptureProgress() {
      return parseLongCaptureProgress(await invoke('long_capture_progress'));
    },
    async getCloudDeviceId() {
      const value = await invoke('get_cloud_device_id');
      if (typeof value !== 'string' || !lowercaseUuidV4Pattern.test(value)) {
        throw new Error('get_cloud_device_id returned an invalid ID');
      }
      return value;
    },
    async loadSettings() {
      return parseSettings(await invoke('load_settings'));
    },
    async updateSettings(settings) {
      await invoke('update_shortcut', { shortcut: settings.shortcut });
      return parseSettings(await invoke('update_cloud_privacy_acknowledgement', {
        acknowledged: settings.cloudPrivacyAcknowledged,
      }));
    },
    async pinPng(blob, bounds) {
      const result = await invoke('pin_png', { pngBytes: await blobBytes(blob), bounds });
      if (typeof result !== 'string') throw new Error('pin_png returned an invalid label');
      return result;
    },
    async sharePng(blob) {
      const result = await invoke('share_png', { pngBytes: await blobBytes(blob) });
      if (result === 'nativeShared' || result === 'copiedFallback') return result;
      throw new Error('share_png returned an invalid outcome');
    },
    async getPinnedPng(label) {
      const result = await invoke('get_pinned_png', { label });
      if (!Array.isArray(result)) throw new Error('get_pinned_png returned invalid bytes');
      return new Blob([new Uint8Array(result as number[])], { type: 'image/png' });
    },
    async startWindowDragging() {
      await invoke('start_window_dragging');
    },
    async closePinWindow(label) {
      await invoke('close_pin_window', { label });
    },
  };
}
