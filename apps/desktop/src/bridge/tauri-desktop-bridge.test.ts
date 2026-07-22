import { describe, expect, it, vi } from 'vitest';
import { createTauriDesktopBridge } from './tauri-desktop-bridge';

describe('createTauriDesktopBridge', () => {
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

  it('starts and stops a long capture with typed PNG output', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ pngBytes: [1, 2, 3], partial: true })
      .mockResolvedValueOnce(undefined);
    const bridge = createTauriDesktopBridge(invoke);
    const progress = vi.fn();
    const region = { x: 10, y: 20, width: 300, height: 400 };

    const result = await bridge.startLongCapture(region, progress);
    await bridge.stopLongCapture();
    await bridge.cancelLongCapture();

    expect(invoke).toHaveBeenNthCalledWith(1, 'start_long_capture', { region });
    expect(invoke).toHaveBeenNthCalledWith(2, 'stop_long_capture');
    expect(invoke).toHaveBeenNthCalledWith(3, 'cancel_long_capture');
    expect(result.partial).toBe(true);
    expect(result.png).toMatchObject({ size: 3, type: 'image/png' });
    expect(progress).toHaveBeenCalledWith({
      frameCount: 0,
      stitchedHeight: 0,
      state: 'preparing',
      previewPngBytes: [],
      warning: false,
    });
  });

  it('reads expanded long capture progress', async () => {
    const progress = {
      frameCount: 4,
      stitchedHeight: 1600,
      state: 'observing',
      previewPngBytes: [1, 2, 3],
      warning: false,
    } as const;
    const invoke = vi.fn().mockResolvedValue(progress);
    const bridge = createTauriDesktopBridge(invoke);

    await expect(bridge.getLongCaptureProgress()).resolves.toEqual(progress);
    expect(invoke).toHaveBeenCalledWith('long_capture_progress');
  });

  it('loads and updates shortcut and Coze settings through native commands', async () => {
    const settings = {
      shortcut: 'Ctrl+Alt+X',
      coze: { token: 'secret', workflowId: 'workflow-1' },
    };
    const invoke = vi.fn()
      .mockResolvedValueOnce(settings)
      .mockResolvedValueOnce(settings)
      .mockResolvedValueOnce(settings);
    const bridge = createTauriDesktopBridge(invoke);

    await expect(bridge.loadSettings()).resolves.toEqual(settings);
    await expect(bridge.updateSettings(settings)).resolves.toEqual(settings);
    expect(invoke).toHaveBeenNthCalledWith(1, 'load_settings');
    expect(invoke).toHaveBeenNthCalledWith(2, 'update_shortcut', { shortcut: 'Ctrl+Alt+X' });
    expect(invoke).toHaveBeenNthCalledWith(3, 'update_coze_config', { config: settings.coze });
  });
});
