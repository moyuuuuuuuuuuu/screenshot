import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App, captureFrameSource, createAppDesktopBridge } from './App';

const tauriInvoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const tauriListeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauriInvoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, callback: (event: { payload: unknown }) => void) => {
    tauriListeners.set(name, callback);
    return Promise.resolve(vi.fn());
  }),
}));

describe('App', () => {
  beforeEach(() => {
    tauriInvoke.mockClear();
    tauriListeners.clear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  it('renders the screenshot overlay', () => {
    render(<App />);

    expect(screen.getByLabelText('截图编辑器')).toBeInTheDocument();
  });

  it('uses the native bridge for the desktop entrypoint', async () => {
    const bridge = createAppDesktopBridge();

    await bridge.closeOverlay();

    expect(tauriInvoke).toHaveBeenCalledWith('close_overlay');
  });

  it('creates a PNG source URL from a capture-ready frame', () => {
    expect(captureFrameSource([{ pngBase64: 'captured-pixels' }])).toBe(
      'data:image/png;base64,captured-pixels',
    );
    expect(captureFrameSource([])).toBe('');
  });

  it('replaces the editor source on every capture-ready event', async () => {
    const { container } = render(<App />);
    await act(async () => undefined);

    act(() => tauriListeners.get('capture-ready')?.({ payload: [{ pngBase64: 'first' }] }));
    expect(container.querySelector('.screenshot-source')).toHaveAttribute(
      'src',
      'data:image/png;base64,first',
    );

    act(() => tauriListeners.get('capture-ready')?.({ payload: [{ pngBase64: 'second' }] }));
    expect(container.querySelector('.screenshot-source')).toHaveAttribute(
      'src',
      'data:image/png;base64,second',
    );
  });
});
