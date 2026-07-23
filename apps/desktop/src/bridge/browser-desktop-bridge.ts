import type { DesktopBridge } from './desktop-bridge';

export type BrowserDesktopDependencies = Readonly<{
  writeClipboard(blob: Blob): Promise<void>;
  download(blob: Blob, filename: string): void;
  close(): Promise<void>;
  storage?: Readonly<{
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  }>;
  randomUuid?: () => string;
}>;

const cloudDeviceIdStorageKey = 'screenshot-tool.cloud-device-id';
const settingsStorageKey = 'screenshot-tool.settings';
const lowercaseUuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createBrowserDesktopBridge(
  dependencies: BrowserDesktopDependencies,
): DesktopBridge {
  return {
    copyPng(blob) {
      return dependencies.writeClipboard(blob);
    },
    async savePng(blob, suggestedName) {
      dependencies.download(blob, suggestedName);
      return suggestedName;
    },
    closeOverlay() {
      return dependencies.close();
    },
    async startLongCapture() {
      throw new Error('Long capture requires the desktop application');
    },
    async stopLongCapture() {},
    async editLongCapture() {},
    async saveLongCapture() {},
    async finishLongCapture() {},
    async cancelLongCapture() {},
    async getLongCaptureProgress() {
      return {
        frameCount: 0,
        stitchedHeight: 0,
        state: 'failed',
        previewPngBytes: [],
        navigatorPngBytes: [],
        acceptedBounds: null,
        warning: true,
        slowScrollWarning: false,
      };
    },
    async getCloudDeviceId() {
      const storage = dependencies.storage ?? window.localStorage;
      const existing = storage.getItem(cloudDeviceIdStorageKey);
      if (existing !== null && lowercaseUuidV4Pattern.test(existing)) {
        return existing;
      }
      const deviceId = (dependencies.randomUuid ?? crypto.randomUUID.bind(crypto))();
      if (!lowercaseUuidV4Pattern.test(deviceId)) {
        throw new Error('Browser UUID generator returned an invalid ID');
      }
      storage.setItem(cloudDeviceIdStorageKey, deviceId);
      return deviceId;
    },
    async loadSettings() {
      const storage = dependencies.storage ?? window.localStorage;
      const stored = storage.getItem(settingsStorageKey);
      if (stored !== null) {
        try {
          const value: unknown = JSON.parse(stored);
          if (isAppSettings(value)) {
            return value;
          }
        } catch {
          // Fall through to a safe local default.
        }
      }
      return {
        shortcut: 'Alt+Shift+A',
        cloudPrivacyAcknowledged: false,
      };
    },
    async updateSettings(settings) {
      const storage = dependencies.storage ?? window.localStorage;
      storage.setItem(settingsStorageKey, JSON.stringify(settings));
      return settings;
    },
    async pinPng() {
      throw new Error('Pin windows require the desktop application');
    },
    async sharePng(blob) {
      await dependencies.writeClipboard(blob);
      return 'copiedFallback';
    },
    async getPinnedPng() {
      throw new Error('Pin windows require the desktop application');
    },
    async startWindowDragging() {},
    async closePinWindow() {},
  };
}

function isAppSettings(value: unknown): value is Awaited<ReturnType<DesktopBridge['loadSettings']>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const settings = value as Record<string, unknown>;
  return (
    Object.keys(settings).length === 2
    && typeof settings.shortcut === 'string'
    && typeof settings.cloudPrivacyAcknowledged === 'boolean'
  );
}

export function createDefaultBrowserDesktopBridge(): DesktopBridge {
  return createBrowserDesktopBridge({
    async writeClipboard(blob) {
      if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
        throw new Error('Clipboard image writing is unavailable');
      }
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ]);
    },
    download(blob, filename) {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    },
    async close() {
      window.close();
    },
  });
}
