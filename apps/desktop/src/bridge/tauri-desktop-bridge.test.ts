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
});
