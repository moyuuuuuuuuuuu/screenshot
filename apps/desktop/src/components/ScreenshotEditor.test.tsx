import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge, LongCaptureProgress } from '../bridge/desktop-bridge';
import { ScreenshotEditor } from './ScreenshotEditor';
import type { CozeService } from '../services/coze-service';

function createBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    copyPng: vi.fn().mockResolvedValue(undefined),
    savePng: vi.fn().mockResolvedValue('capture.png'),
    closeOverlay: vi.fn().mockResolvedValue(undefined),
    startLongCapture: vi.fn().mockResolvedValue({
      png: new Blob(['long-png'], { type: 'image/png' }),
      partial: false,
      action: 'edit',
    }),
    stopLongCapture: vi.fn().mockResolvedValue(undefined),
    editLongCapture: vi.fn().mockResolvedValue(undefined),
    saveLongCapture: vi.fn().mockResolvedValue(undefined),
    finishLongCapture: vi.fn().mockResolvedValue(undefined),
    cancelLongCapture: vi.fn().mockResolvedValue(undefined),
    getLongCaptureProgress: vi.fn(),
    loadSettings: vi.fn().mockResolvedValue({ shortcut: 'Alt+Shift+A', coze: { token: '', workflowId: '' } }),
    updateSettings: vi.fn(),
    pinPng: vi.fn().mockResolvedValue('pin-1'),
    sharePng: vi.fn().mockResolvedValue('copiedFallback'),
    getPinnedPng: vi.fn(),
    startWindowDragging: vi.fn(),
    closePinWindow: vi.fn(),
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

  it('publishes the centralized capture mode as selection is committed', () => {
    render(<ScreenshotEditor sourceUrl="" bridge={createBridge()} />);
    const editor = screen.getByLabelText('截图编辑器');
    expect(editor).toHaveAttribute('data-capture-mode', 'selecting');

    const overlay = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(overlay, { clientX: 20, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(overlay, { clientX: 220, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(overlay, { clientX: 220, clientY: 180, pointerId: 1 });

    expect(editor).toHaveAttribute('data-capture-mode', 'annotating');
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

  it('renders a rectangle preview before pointer release', () => {
    const context = {
      clearRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(),
      strokeRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      stroke: vi.fn(), fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    render(<ScreenshotEditor sourceUrl="" bridge={createBridge()} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 220, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 220, clientY: 160, pointerId: 1 });

    const annotationSurface = screen.getByTestId('annotation-surface');
    fireEvent.pointerDown(annotationSurface, { clientX: 40, clientY: 40, pointerId: 2 });
    fireEvent.pointerMove(annotationSurface, { clientX: 120, clientY: 100, pointerId: 2 });

    expect(context.strokeRect).toHaveBeenCalledWith(40, 40, 80, 60);
    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
  });

  it('closes the overlay after a successful save', async () => {
    const bridge = createBridge();
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 120, clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 120, clientY: 80, pointerId: 1 });

    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(bridge.savePng).toHaveBeenCalledOnce();
    expect(bridge.closeOverlay).toHaveBeenCalledOnce();
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

  it('places the selected emoji at the clicked canvas position', async () => {
    render(<ScreenshotEditor sourceUrl="" bridge={createBridge()} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 220, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 220, clientY: 160, pointerId: 1 });

    await userEvent.click(screen.getByRole('button', { name: '表情' }));
    await userEvent.click(screen.getByRole('button', { name: '微笑' }));
    fireEvent.pointerDown(screen.getByTestId('annotation-surface'), {
      clientX: 60,
      clientY: 70,
      pointerId: 2,
    });

    expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled();
  });

  it('preserves selection and annotations when OCR fails', async () => {
    const cozeService: CozeService = {
      ocr: vi.fn().mockRejectedValue(new Error('服务不可用')),
      translate: vi.fn(),
      redact: vi.fn(),
    };
    render(<ScreenshotEditor sourceUrl="" bridge={createBridge()} cozeService={cozeService} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 220, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 220, clientY: 160, pointerId: 1 });

    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('服务不可用');
    expect(screen.getByText('200 × 140')).toBeInTheDocument();
    expect(screen.getByLabelText('截图编辑器')).toHaveAttribute('data-capture-mode', 'annotating');
  });

  it('pins the selection and shows the copied share fallback', async () => {
    const bridge = createBridge();
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 220, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 220, clientY: 160, pointerId: 1 });

    await userEvent.click(screen.getByRole('button', { name: '钉住' }));
    expect(bridge.pinPng).toHaveBeenCalledWith(expect.any(Blob), {
      x: 20, y: 20, width: 200, height: 140,
    });

    await userEvent.click(screen.getByRole('button', { name: '转发' }));
    expect(await screen.findByText(/已复制图片/)).toBeInTheDocument();
  });

  it('starts long capture for the selection and loads the result back into the editor', async () => {
    const bridge = createBridge();
    const createObjectUrl = vi.fn().mockReturnValue('blob:long-capture');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const { container } = render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });

    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));

    expect(bridge.startLongCapture).toHaveBeenCalledWith(
      { x: 20, y: 30, width: 200, height: 150 },
      expect.any(Function),
    );
    await screen.findByTestId('selection-surface');
    const longImage = container.querySelector('.screenshot-source') as HTMLImageElement;
    expect(longImage).toHaveAttribute('src', 'blob:long-capture');
    Object.defineProperty(longImage, 'naturalWidth', { configurable: true, value: 200 });
    Object.defineProperty(longImage, 'naturalHeight', { configurable: true, value: 1200 });
    fireEvent.load(longImage);
    expect(longImage).toHaveStyle({ left: '448px', top: '0px', width: '128px', height: '768px' });
    expect(createObjectUrl).toHaveBeenCalledOnce();
  });

  it('Esc cancels long capture and exits the overlay', async () => {
    let reportProgress: ((progress: LongCaptureProgress) => void) | undefined;
    let finishCapture: ((result: { png: Blob; partial: boolean; action: 'edit' }) => void) | undefined;
    const createObjectUrl = vi.fn().mockReturnValue('blob:long-capture');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    const bridge = createBridge({
      startLongCapture: vi.fn((_region, onProgress) => {
        reportProgress = onProgress;
        return new Promise<{ png: Blob; partial: boolean; action: 'edit' }>((resolve) => { finishCapture = resolve; });
      }),
    });
    const { container } = render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 110, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 110, clientY: 90, pointerId: 1 });
    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));

    reportProgress?.({
      frameCount: 3,
      stitchedHeight: 1240,
      state: 'matching',
      previewPngBytes: [],
      navigatorPngBytes: [],
      acceptedBounds: null,
      warning: false,
      slowScrollWarning: false,
    });
    expect(screen.queryByRole('status', { name: '长截图进度' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}{Escape}');

    expect(bridge.cancelLongCapture).toHaveBeenCalledOnce();
    expect(bridge.stopLongCapture).not.toHaveBeenCalled();
    expect(bridge.closeOverlay).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('截图编辑器')).toHaveAttribute('data-capture-mode', 'selecting');
    expect(screen.queryByTestId('selection-box')).not.toBeInTheDocument();
    finishCapture?.({ png: new Blob(['discarded']), partial: true, action: 'edit' });
    await waitFor(() => expect(createObjectUrl).not.toHaveBeenCalled());
    expect(container.querySelector('img[src="blob:long-capture"]')).not.toBeInTheDocument();
  });

  it('shows the native long-capture failure reason', async () => {
    const bridge = createBridge({
      startLongCapture: vi.fn().mockRejectedValue('selection must fit within one monitor'),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 110, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 110, clientY: 90, pointerId: 1 });

    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '长截图失败：selection must fit within one monitor',
    );
  });
});
