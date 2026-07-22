import type { DesktopBridge } from './desktop-bridge';

export type BrowserDesktopDependencies = Readonly<{
  writeClipboard(blob: Blob): Promise<void>;
  download(blob: Blob, filename: string): void;
  close(): Promise<void>;
}>;

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
    async cancelLongCapture() {},
    async getLongCaptureProgress() {
      return {
        frameCount: 0,
        stitchedHeight: 0,
        state: 'failed',
        previewPngBytes: [],
        warning: true,
      };
    },
    async loadSettings() {
      return { shortcut: 'Alt+Shift+A', coze: { token: '', workflowId: '' } };
    },
    async updateSettings(settings) {
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
