import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, captureFrameSource, createAppDesktopBridge } from './App';

const tauriInvoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const tauriRuntime = vi.hoisted(() => vi.fn().mockReturnValue(false));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke, isTauri: tauriRuntime }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

describe('App', () => {
  beforeEach(() => {
    tauriInvoke.mockClear();
    tauriRuntime.mockReturnValue(false);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  it('renders the screenshot overlay', () => {
    render(<App />);

    expect(screen.getByLabelText('截图编辑器')).toBeInTheDocument();
  });

  it('selects the Tauri bridge when the official runtime check succeeds', async () => {
    const bridge = createAppDesktopBridge(true);

    await bridge.closeOverlay();

    expect(tauriInvoke).toHaveBeenCalledWith('close_overlay');
  });

  it('creates a PNG source URL from a capture-ready frame', () => {
    expect(captureFrameSource([{ pngBase64: 'captured-pixels' }])).toBe(
      'data:image/png;base64,captured-pixels',
    );
    expect(captureFrameSource([])).toBe('');
  });
});
