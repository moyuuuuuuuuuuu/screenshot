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
