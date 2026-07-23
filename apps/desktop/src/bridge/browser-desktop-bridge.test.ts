import { describe, expect, it, vi } from 'vitest';
import { createBrowserDesktopBridge } from './browser-desktop-bridge';

describe('browser desktop bridge', () => {
  it('creates, persists, and reuses one namespaced lowercase UUIDv4 device ID', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const randomUuid = vi.fn()
      .mockReturnValue('123e4567-e89b-42d3-a456-426614174000');
    const bridge = createBrowserDesktopBridge({
      writeClipboard: vi.fn(),
      download: vi.fn(),
      close: vi.fn(),
      storage,
      randomUuid,
    });

    await expect(bridge.getCloudDeviceId()).resolves.toBe(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    await expect(bridge.getCloudDeviceId()).resolves.toBe(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(randomUuid).toHaveBeenCalledOnce();
    expect(storage.setItem).toHaveBeenCalledOnce();
    expect(storage.setItem.mock.calls[0]?.[0]).toBe(
      'screenshot-tool.cloud-device-id',
    );
  });

  it('replaces an invalid browser device ID', async () => {
    const storage = {
      getItem: vi.fn().mockReturnValue('legacy-invalid-id'),
      setItem: vi.fn(),
    };
    const bridge = createBrowserDesktopBridge({
      writeClipboard: vi.fn(),
      download: vi.fn(),
      close: vi.fn(),
      storage,
      randomUuid: () => '123e4567-e89b-42d3-a456-426614174000',
    });

    await expect(bridge.getCloudDeviceId()).resolves.toBe(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(storage.setItem).toHaveBeenCalledWith(
      'screenshot-tool.cloud-device-id',
      '123e4567-e89b-42d3-a456-426614174000',
    );
  });

  it('updates only the shortcut and preserves the latest browser privacy acknowledgement', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const bridge = createBrowserDesktopBridge({
      writeClipboard: vi.fn(),
      download: vi.fn(),
      close: vi.fn(),
      storage,
    });

    await expect(bridge.loadSettings()).resolves.toEqual({
      shortcut: 'Alt+Shift+A',
      cloudPrivacyAcknowledged: false,
    });
    await bridge.updateCloudPrivacyAcknowledgement(true);
    await expect(bridge.updateShortcut('Ctrl+Alt+X')).resolves.toEqual({
      shortcut: 'Ctrl+Alt+X',
      cloudPrivacyAcknowledged: true,
    });
    await expect(bridge.loadSettings()).resolves.toEqual({
      shortcut: 'Ctrl+Alt+X',
      cloudPrivacyAcknowledged: true,
    });
    expect([...values.values()].join('')).not.toContain('coze');
  });

  it('updates only cloud acknowledgement while preserving the stored shortcut', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    const bridge = createBrowserDesktopBridge({
      writeClipboard: vi.fn(),
      download: vi.fn(),
      close: vi.fn(),
      storage,
    });
    await bridge.updateShortcut('Ctrl+Alt+X');

    await expect(bridge.updateCloudPrivacyAcknowledgement(true)).resolves.toEqual({
      shortcut: 'Ctrl+Alt+X',
      cloudPrivacyAcknowledged: true,
    });
    await expect(bridge.loadSettings()).resolves.toEqual({
      shortcut: 'Ctrl+Alt+X',
      cloudPrivacyAcknowledged: true,
    });
  });

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
