import { describe, expect, it, vi } from 'vitest';
import { createTauriDesktopBridge } from './tauri-desktop-bridge';

describe('createTauriDesktopBridge', () => {
  it('gets the anonymous cloud device ID through the exact Tauri command', async () => {
    const invoke = vi.fn().mockResolvedValue(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    const bridge = createTauriDesktopBridge(invoke);

    await expect(bridge.getCloudDeviceId()).resolves.toBe(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(invoke).toHaveBeenCalledWith('get_cloud_device_id');
  });

  it('rejects an invalid cloud device ID returned by Tauri', async () => {
    const bridge = createTauriDesktopBridge(
      vi.fn().mockResolvedValue('not-a-device-id'),
    );

    await expect(bridge.getCloudDeviceId()).rejects.toThrow(
      'get_cloud_device_id returned an invalid ID',
    );
  });

  it('uses the copy_png command and pngBytes payload', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const bridge = createTauriDesktopBridge(invoke);

    await bridge.copyPng(new Blob([new Uint8Array([1, 2, 255])], { type: 'image/png' }));

    expect(invoke).toHaveBeenCalledWith('copy_png', { pngBytes: [1, 2, 255] });
  });

  it('uses the save_png command with the exact payload keys', async () => {
    const invoke = vi.fn().mockResolvedValue('C:\\captures\\shot.png');
    const bridge = createTauriDesktopBridge(invoke);

    await expect(
      bridge.savePng(new Blob([new Uint8Array([8, 9])]), 'shot.png'),
    ).resolves.toBe('C:\\captures\\shot.png');
    expect(invoke).toHaveBeenCalledWith('save_png', {
      pngBytes: [8, 9],
      suggestedName: 'shot.png',
    });
  });

  it('uses the close_overlay command', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const bridge = createTauriDesktopBridge(invoke);

    await bridge.closeOverlay();

    expect(invoke).toHaveBeenCalledWith('close_overlay');
  });

  it('starts a long capture with typed PNG output', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({
      pngBytes: [1, 2, 3], partial: true, action: 'edit', clipboardError: 'clipboard busy',
    });
    const bridge = createTauriDesktopBridge(invoke);
    const progress = vi.fn();
    const region = { x: 10, y: 20, width: 300, height: 400 };

    const result = await bridge.startLongCapture(region, progress);

    expect(invoke).toHaveBeenCalledWith('start_long_capture', { region });
    expect(result.partial).toBe(true);
    expect(result.clipboardError).toBe('clipboard busy');
    expect(result.png).toMatchObject({ size: 3, type: 'image/png' });
    expect(progress).toHaveBeenCalledWith({
      sessionId: 0,
      revision: 0,
      frameCount: 0,
      stitchedHeight: 0,
      state: 'preparing',
      previewPngBytes: [],
      navigatorPngBytes: [],
      acceptedBounds: null,
      warning: false,
      slowScrollWarning: false,
    });
  });

  it('submits a session-scoped long capture terminal action', async () => {
    const invoke = vi.fn().mockResolvedValue({
      sessionId: 17,
      action: 'finish',
      status: 'accepted',
    });
    const bridge = createTauriDesktopBridge(invoke);

    await expect(bridge.requestLongCaptureTerminal(17, 'finish')).resolves.toEqual({
      sessionId: 17,
      action: 'finish',
      status: 'accepted',
    });
    expect(invoke).toHaveBeenCalledWith('request_long_capture_terminal', {
      sessionId: 17,
      action: 'finish',
    });
  });

  it('rejects an invalid terminal response', async () => {
    const bridge = createTauriDesktopBridge(
      vi.fn().mockResolvedValue({ sessionId: 17, action: 'finish', status: 'unknown' }),
    );

    await expect(bridge.requestLongCaptureTerminal(17, 'finish'))
      .rejects.toThrow('invalid long capture terminal response');
  });

  it.each([
    [0, 'finish'],
    [-1, 'finish'],
    [1.5, 'finish'],
    [17, 'none'],
  ] as const)('rejects invalid terminal request input (%s, %s)', async (sessionId, action) => {
    const invoke = vi.fn();
    const bridge = createTauriDesktopBridge(invoke);

    await expect(bridge.requestLongCaptureTerminal(
      sessionId,
      action as 'finish',
    )).rejects.toThrow('invalid long capture terminal request');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects an impossible Finish result carrying a clipboard error', async () => {
    const invoke = vi.fn().mockResolvedValue({
      pngBytes: [1, 2, 3], partial: false, action: 'finish', clipboardError: 'busy',
    });
    const bridge = createTauriDesktopBridge(invoke);

    await expect(bridge.startLongCapture(
      { x: 0, y: 0, width: 100, height: 100 },
      vi.fn(),
    )).rejects.toThrow('invalid long capture result');
  });

  it('reads expanded long capture progress', async () => {
    const progress = {
      sessionId: 17,
      revision: 3,
      frameCount: 4,
      stitchedHeight: 1600,
      state: 'observing',
      previewPngBytes: [1, 2, 3],
      navigatorPngBytes: [1, 2, 3],
      acceptedBounds: null,
      warning: false,
      slowScrollWarning: false,
    } as const;
    const invoke = vi.fn().mockResolvedValue(progress);
    const bridge = createTauriDesktopBridge(invoke);

    await expect(bridge.getLongCaptureProgress()).resolves.toEqual(progress);
    expect(invoke).toHaveBeenCalledWith('long_capture_progress');
  });

  it.each([
    { missingField: { revision: 3 }, fieldName: 'sessionId' },
    { missingField: { sessionId: 17 }, fieldName: 'revision' },
  ] as const)('rejects long capture progress without $fieldName', async ({ missingField }) => {
    const bridge = createTauriDesktopBridge(vi.fn().mockResolvedValue({
      ...missingField,
      frameCount: 4,
      stitchedHeight: 1600,
      state: 'observing',
      previewPngBytes: [],
      navigatorPngBytes: [],
      acceptedBounds: null,
      warning: false,
      slowScrollWarning: false,
    }));

    await expect(bridge.getLongCaptureProgress())
      .rejects.toThrow('invalid long capture progress');
  });

  it('updates only the shortcut and keeps the latest native privacy acknowledgement', async () => {
    const staleSettings = {
      shortcut: 'Ctrl+Alt+X',
      cloudPrivacyAcknowledged: false,
    };
    const currentSettings = {
      shortcut: 'Ctrl+Alt+X',
      cloudPrivacyAcknowledged: true,
    };
    const invoke = vi.fn()
      .mockResolvedValueOnce(staleSettings)
      .mockResolvedValueOnce(currentSettings);
    const bridge = createTauriDesktopBridge(invoke);

    await expect(bridge.loadSettings()).resolves.toEqual(staleSettings);
    await expect(bridge.updateShortcut(staleSettings.shortcut)).resolves.toEqual(currentSettings);
    expect(invoke).toHaveBeenNthCalledWith(1, 'load_settings');
    expect(invoke).toHaveBeenNthCalledWith(2, 'update_shortcut', { shortcut: 'Ctrl+Alt+X' });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalledWith(
      'update_cloud_privacy_acknowledgement',
      expect.anything(),
    );
  });

  it('updates cloud privacy acknowledgement without invoking the shortcut command', async () => {
    const settings = {
      shortcut: 'Ctrl+Alt+X',
      cloudPrivacyAcknowledged: true,
    };
    const invoke = vi.fn().mockResolvedValue(settings);
    const bridge = createTauriDesktopBridge(invoke);

    await expect(bridge.updateCloudPrivacyAcknowledgement(true)).resolves.toEqual(settings);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      'update_cloud_privacy_acknowledgement',
      { acknowledged: true },
    );
    expect(invoke).not.toHaveBeenCalledWith(
      'update_shortcut',
      expect.anything(),
    );
  });

  it('pins PNG bytes and reports copied share fallback', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce('pin-7')
      .mockResolvedValueOnce('copiedFallback');
    const bridge = createTauriDesktopBridge(invoke);
    const png = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

    await expect(bridge.pinPng(png, { x: 10, y: 20, width: 100, height: 80 })).resolves.toBe('pin-7');
    await expect(bridge.sharePng(png)).resolves.toBe('copiedFallback');
    expect(invoke).toHaveBeenNthCalledWith(1, 'pin_png', {
      pngBytes: [1, 2, 3], bounds: { x: 10, y: 20, width: 100, height: 80 },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'share_png', { pngBytes: [1, 2, 3] });
  });
});
