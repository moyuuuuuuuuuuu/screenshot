import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, captureFrameSource, createAppDesktopBridge } from './App';

const tauriInvoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

describe('App', () => {
  beforeEach(() => {
    tauriInvoke.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  it('renders the screenshot overlay', () => {
    render(<App />);

    expect(screen.getByLabelText('截图编辑器')).toBeInTheDocument();
  });

  it('selects the Tauri bridge when Tauri internals exist', async () => {
    const bridge = createAppDesktopBridge({ __TAURI_INTERNALS__: {} });

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
