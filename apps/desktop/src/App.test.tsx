import { act, fireEvent, render, screen } from '@testing-library/react';
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
    window.history.replaceState({}, '', '/');
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

    act(() => tauriListeners.get('capture-started')?.({ payload: { sessionId: 1 } }));
    act(() => tauriListeners.get('capture-ready')?.({
      payload: { sessionId: 1, frames: [{ pngBase64: 'first' }] },
    }));
    expect(container.querySelector('.screenshot-source')).toHaveAttribute(
      'src',
      'data:image/png;base64,first',
    );

    act(() => tauriListeners.get('capture-started')?.({ payload: { sessionId: 2 } }));
    expect(container.querySelector('.screenshot-source')).not.toBeInTheDocument();

    act(() => tauriListeners.get('capture-ready')?.({
      payload: { sessionId: 2, frames: [{ pngBase64: 'second' }] },
    }));
    expect(container.querySelector('.screenshot-source')).toHaveAttribute(
      'src',
      'data:image/png;base64,second',
    );
  });

  it('renders an input-blocking long-capture mask with its inward edge', () => {
    window.history.replaceState(
      {},
      '',
      '/?window=scroll-mask&edge=bottom&edgeStart=500&edgeLength=1000',
    );
    const { container } = render(<App />);

    expect(container.querySelector('.scroll-capture-mask')).toBeInTheDocument();
    expect(container.querySelector('.scroll-capture-mask__edge'))
      .toHaveAttribute('data-edge', 'bottom');
    expect(container.querySelector('.scroll-capture-mask__edge'))
      .toHaveStyle('--edge-start: 500px; --edge-length: 1000px');
    expect(screen.queryByLabelText('截图编辑器')).not.toBeInTheDocument();
  });

  it('updates a reused mask edge from the native layout event', async () => {
    window.history.replaceState(
      {},
      '',
      '/?window=scroll-mask&edge=top&edgeStart=20&edgeLength=200',
    );
    const { container } = render(<App />);
    await act(async () => undefined);
    expect(container.querySelector('.scroll-capture-mask__edge'))
      .toHaveStyle('--edge-start: 20px; --edge-length: 200px');

    act(() => tauriListeners.get('scroll-mask-layout')?.({
      payload: { edge: 'bottom', edgeStart: 80, edgeLength: 640 },
    }));

    expect(container.querySelector('.scroll-capture-mask__edge'))
      .toHaveAttribute('data-edge', 'bottom');
    expect(container.querySelector('.scroll-capture-mask__edge'))
      .toHaveStyle('--edge-start: 80px; --edge-length: 640px');
  });

  it('updates a reused scroll preview side from the native layout event', async () => {
    window.history.replaceState(
      {},
      '',
      '/?window=scroll-capture-preview&side=right',
    );
    const { container } = render(<App />);
    await act(async () => undefined);
    expect(container.querySelector('.scroll-sidecar'))
      .toHaveAttribute('data-side', 'right');

    act(() => tauriListeners.get('scroll-preview-layout')?.({
      payload: { side: 'left' },
    }));

    expect(container.querySelector('.scroll-sidecar'))
      .toHaveAttribute('data-side', 'left');
  });

  it('clears an old selection when the native long-capture session resets', async () => {
    render(<App />);
    await act(async () => undefined);

    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });
    expect(screen.getByTestId('selection-box')).toBeInTheDocument();

    act(() => tauriListeners.get('capture-session-reset')?.({ payload: { sessionId: 0 } }));

    expect(screen.queryByTestId('selection-box')).not.toBeInTheDocument();
    expect(screen.getByLabelText('截图编辑器')).toHaveAttribute('data-capture-mode', 'selecting');
  });

  it('ignores capture events from an older native session', async () => {
    const { container } = render(<App />);
    await act(async () => undefined);

    act(() => tauriListeners.get('capture-started')?.({ payload: { sessionId: 2 } }));
    act(() => tauriListeners.get('capture-ready')?.({
      payload: { sessionId: 2, frames: [{ pngBase64: 'new' }] },
    }));
    act(() => tauriListeners.get('capture-ready')?.({
      payload: { sessionId: 1, frames: [{ pngBase64: 'old' }] },
    }));

    expect(container.querySelector('.screenshot-source')).toHaveAttribute(
      'src',
      'data:image/png;base64,new',
    );
  });

  it('accepts capture-ready when a hidden window missed capture-started', async () => {
    const { container } = render(<App />);
    await act(async () => undefined);

    act(() => tauriListeners.get('capture-ready')?.({
      payload: { sessionId: 3, frames: [{ pngBase64: 'recovered' }] },
    }));

    expect(container.querySelector('.screenshot-source')).toHaveAttribute(
      'src',
      'data:image/png;base64,recovered',
    );
  });

  it('only resets the selection for the current native session', async () => {
    render(<App />);
    await act(async () => undefined);
    act(() => tauriListeners.get('capture-started')?.({ payload: { sessionId: 2 } }));

    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });
    expect(screen.getByTestId('selection-box')).toBeInTheDocument();

    act(() => tauriListeners.get('capture-session-reset')?.({ payload: { sessionId: 1 } }));
    expect(screen.getByTestId('selection-box')).toBeInTheDocument();

    act(() => tauriListeners.get('capture-session-reset')?.({ payload: { sessionId: 2 } }));
    expect(screen.queryByTestId('selection-box')).not.toBeInTheDocument();
  });

  it('opens local settings when requested from the tray', async () => {
    tauriInvoke.mockResolvedValueOnce({
      shortcut: 'Alt+Shift+A',
      cloudPrivacyAcknowledged: false,
    });
    render(<App />);
    await act(async () => undefined);

    await act(async () => {
      tauriListeners.get('settings-requested')?.({ payload: undefined });
    });

    expect(await screen.findByRole('region', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '录制快捷键' })).toHaveTextContent('Alt+Shift+A');
  });
});
