import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../bridge/desktop-bridge';
import { ScreenshotEditor } from './ScreenshotEditor';

function createBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    copyPng: vi.fn().mockResolvedValue(undefined),
    savePng: vi.fn().mockResolvedValue('capture.png'),
    closeOverlay: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ScreenshotEditor', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback) => callback(new Blob(['png'], { type: 'image/png' })),
    );
  });

  it('creates a normalized selection from a reverse drag', () => {
    render(<ScreenshotEditor sourceUrl="" bridge={createBridge()} />);
    const overlay = screen.getByTestId('selection-surface');

    fireEvent.pointerDown(overlay, { clientX: 180, clientY: 140, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 40, clientY: 30, pointerId: 1 });

    expect(screen.getByText('140 × 110')).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: '截图工具' })).toBeInTheDocument();
  });

  it('keeps editor state when clipboard output rejects', async () => {
    const bridge = createBridge({
      copyPng: vi.fn().mockRejectedValue(new Error('busy')),
    });
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    const overlay = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(overlay, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 120, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 120, clientY: 80, pointerId: 1 });

    await userEvent.keyboard('{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent('复制失败');
    expect(screen.getByLabelText('截图编辑器')).toBeInTheDocument();
    expect(bridge.closeOverlay).not.toHaveBeenCalled();
  });

  it('adds a pointer-drawn rectangle to undo history', () => {
    render(<ScreenshotEditor sourceUrl="" bridge={createBridge()} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 220, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 220, clientY: 160, pointerId: 1 });

    const annotationSurface = screen.getByTestId('annotation-surface');
    fireEvent.pointerDown(annotationSurface, { clientX: 50, clientY: 50, pointerId: 2 });
    fireEvent.pointerMove(annotationSurface, { clientX: 150, clientY: 110, pointerId: 2 });
    fireEvent.pointerUp(annotationSurface, { clientX: 150, clientY: 110, pointerId: 2 });

    expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled();
  });

  it('commits inline text without closing the overlay', async () => {
    const bridge = createBridge();
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 220, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 220, clientY: 160, pointerId: 1 });

    await userEvent.click(screen.getByRole('button', { name: '文字' }));
    fireEvent.pointerDown(screen.getByTestId('annotation-surface'), {
      clientX: 60,
      clientY: 70,
      pointerId: 2,
    });

    const editor = await screen.findByRole('textbox', { name: '输入标注文字' });
    await userEvent.type(editor, 'hello{Enter}');

    expect(screen.queryByRole('textbox', { name: '输入标注文字' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled();
    expect(bridge.copyPng).not.toHaveBeenCalled();
    expect(bridge.closeOverlay).not.toHaveBeenCalled();
  });
});
