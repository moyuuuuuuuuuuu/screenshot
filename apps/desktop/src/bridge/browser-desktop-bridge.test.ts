import { describe, expect, it, vi } from 'vitest';
import { createBrowserDesktopBridge } from './browser-desktop-bridge';

describe('browser desktop bridge', () => {
  it('downloads a PNG with the suggested filename', async () => {
    const downloaded: string[] = [];
    const bridge = createBrowserDesktopBridge({
      writeClipboard: vi.fn(),
      download: (_blob, filename) => downloaded.push(filename),
      close: vi.fn(),
    });

    await expect(
      bridge.savePng(new Blob(), '截图-20260721-182000.png'),
    ).resolves.toBe('截图-20260721-182000.png');
    expect(downloaded).toEqual(['截图-20260721-182000.png']);
  });

  it('delegates clipboard and close operations', async () => {
    const writeClipboard = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const bridge = createBrowserDesktopBridge({
      writeClipboard,
      download: vi.fn(),
      close,
    });
    const blob = new Blob(['png'], { type: 'image/png' });

    await bridge.copyPng(blob);
    await bridge.closeOverlay();

    expect(writeClipboard).toHaveBeenCalledWith(blob);
    expect(close).toHaveBeenCalledOnce();
  });
});
