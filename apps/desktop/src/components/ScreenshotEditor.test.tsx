import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSettings,
  DesktopBridge,
  LongCaptureProgress,
  LongCaptureResult,
  LongCaptureTerminalOutcome,
} from '../bridge/desktop-bridge';
import {
  CloudClientError,
  type CloudClient,
  type CloudClientErrorCode,
  type RecognitionResult,
} from '../cloud/cloud-client';
import { ScreenshotEditor } from './ScreenshotEditor';

const ocrResult: RecognitionResult = {
  sourceLanguage: 'zh',
  originalText: '识别结果',
  translatedText: null,
  blocks: [{ text: '识别结果', x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
};

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
    requestLongCaptureTerminal: vi.fn().mockResolvedValue({
      sessionId: 1,
      action: 'finish',
      status: 'accepted',
    }),
    getLongCaptureProgress: vi.fn(),
    getCloudDeviceId: vi.fn().mockResolvedValue('123e4567-e89b-42d3-a456-426614174000'),
    loadSettings: vi.fn().mockResolvedValue({
      shortcut: 'Alt+Shift+A',
      cloudPrivacyAcknowledged: true,
    }),
    updateShortcut: vi.fn(async (shortcut) => ({
      shortcut,
      cloudPrivacyAcknowledged: true,
    })),
    updateCloudPrivacyAcknowledgement: vi.fn(async (acknowledged) => ({
      shortcut: 'Alt+Shift+A',
      cloudPrivacyAcknowledged: acknowledged,
    })),
    pinPng: vi.fn().mockResolvedValue('pin-1'),
    sharePng: vi.fn().mockResolvedValue('copiedFallback'),
    getPinnedPng: vi.fn(),
    startWindowDragging: vi.fn(),
    closePinWindow: vi.fn(),
    ...overrides,
  };
}

function createFakeCloudClient(overrides: Partial<CloudClient> = {}): CloudClient {
  return {
    recognize: vi.fn().mockResolvedValue(ocrResult),
    quota: vi.fn().mockResolvedValue({
      ocr: { limit: 20, remaining: 19 },
      translate: { limit: 10, remaining: 10 },
      resetsAt: '2026-07-23T16:00:00.000Z',
    }),
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function selectRegion(
  start = { x: 20, y: 20 },
  end = { x: 220, y: 160 },
): void {
  const surface = screen.getByTestId('selection-surface');
  fireEvent.pointerDown(surface, { clientX: start.x, clientY: start.y, pointerId: 1 });
  fireEvent.pointerMove(surface, { clientX: end.x, clientY: end.y, pointerId: 1 });
  fireEvent.pointerUp(surface, { clientX: end.x, clientY: end.y, pointerId: 1 });
}

describe('ScreenshotEditor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it.each([
    ['QUOTA_EXCEEDED', 'The anonymous daily quota has been exceeded.'],
    ['PROVIDER_TIMEOUT', 'The recognition service timed out.'],
    ['NETWORK_UNAVAILABLE', 'The cloud service is unavailable.'],
    ['INVALID_RESPONSE', 'The cloud service returned an invalid response.'],
  ] satisfies ReadonlyArray<readonly [CloudClientErrorCode, string]>)(
    'preserves selection, annotations and undo history on %s',
    async (code, message) => {
      const client = createFakeCloudClient({
        recognize: vi.fn().mockRejectedValue(new CloudClientError(code, message)),
      });
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      render(
        <ScreenshotEditor
          sourceUrl="desktop.png"
          bridge={createBridge()}
          cloudClient={client}
        />,
      );
      selectRegion();
      const annotationSurface = screen.getByTestId('annotation-surface');
      fireEvent.pointerDown(annotationSurface, {
        clientX: 50,
        clientY: 50,
        pointerId: 2,
      });
      fireEvent.pointerMove(annotationSurface, {
        clientX: 150,
        clientY: 110,
        pointerId: 2,
      });
      fireEvent.pointerUp(annotationSurface, {
        clientX: 150,
        clientY: 110,
        pointerId: 2,
      });

      await userEvent.click(screen.getByRole('button', { name: '文字识别' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByText('200 × 140')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled();
      expect(screen.getByLabelText('截图编辑器')).toHaveAttribute(
        'data-capture-mode',
        'annotating',
      );
      expect(screen.getByAltText('')).toHaveAttribute('src', 'desktop.png');
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
    },
  );

  it('cancels with zero uploads, then accepts and remembers the privacy acknowledgement', async () => {
    const updateShortcut = vi.fn();
    const updateCloudPrivacyAcknowledgement = vi.fn().mockResolvedValue({
      shortcut: 'Ctrl+Alt+X',
      cloudPrivacyAcknowledged: true,
    });
    const bridge = createBridge({
      loadSettings: vi.fn().mockResolvedValue({
        shortcut: 'Ctrl+Alt+X',
        cloudPrivacyAcknowledged: false,
      }),
      updateShortcut,
      updateCloudPrivacyAcknowledgement,
    });
    const client = createFakeCloudClient();
    render(
      <ScreenshotEditor sourceUrl="" bridge={bridge} cloudClient={client} />,
    );
    selectRegion();

    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    expect(await screen.findByRole('dialog', { name: '云服务隐私提示' }))
      .toBeInTheDocument();
    expect(client.recognize).not.toHaveBeenCalled();
    expect(client.quota).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: '取消云服务' }));
    expect(screen.queryByRole('dialog', { name: '云服务隐私提示' }))
      .not.toBeInTheDocument();
    expect(client.recognize).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    await userEvent.click(await screen.findByRole('button', { name: '同意并继续' }));
    expect(updateCloudPrivacyAcknowledgement).toHaveBeenCalledWith(true);
    expect(updateShortcut).not.toHaveBeenCalled();
    await screen.findByLabelText('识别原文');
    expect(client.recognize).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole('button', { name: '关闭识别面板' }));
    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    expect(screen.queryByRole('dialog', { name: '云服务隐私提示' }))
      .not.toBeInTheDocument();
    await waitFor(() => expect(client.recognize).toHaveBeenCalledTimes(2));
  });

  it('does not run the global Enter action from the privacy accept button', async () => {
    const bridge = createBridge({
      loadSettings: vi.fn().mockResolvedValue({
        shortcut: 'Alt+Shift+A',
        cloudPrivacyAcknowledged: false,
      }),
    });
    render(
      <ScreenshotEditor
        sourceUrl=""
        bridge={bridge}
        cloudClient={createFakeCloudClient()}
      />,
    );
    selectRegion();
    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    const accept = await screen.findByRole('button', { name: '同意并继续' });
    accept.focus();

    await userEvent.keyboard('{Enter}');
    await screen.findByLabelText('识别原文');

    expect(bridge.copyPng).not.toHaveBeenCalled();
    expect(bridge.closeOverlay).not.toHaveBeenCalled();
  });

  it.each(['button', 'escape', 'unmount'] as const)(
    'does not upload when privacy persistence resolves after %s cancellation',
    async (dismissal) => {
      const acknowledgement = createDeferred<AppSettings>();
      const bridge = createBridge({
        loadSettings: vi.fn().mockResolvedValue({
          shortcut: 'Alt+Shift+A',
          cloudPrivacyAcknowledged: false,
        }),
        updateCloudPrivacyAcknowledgement: vi.fn(() => acknowledgement.promise),
      });
      const client = createFakeCloudClient();
      const view = render(
        <ScreenshotEditor sourceUrl="" bridge={bridge} cloudClient={client} />,
      );
      selectRegion();
      await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
      fireEvent.click(await screen.findByRole('button', { name: '同意并继续' }));
      expect(bridge.updateCloudPrivacyAcknowledgement).toHaveBeenCalledOnce();

      if (dismissal === 'button') {
        await userEvent.click(screen.getByRole('button', { name: '取消云服务' }));
      } else if (dismissal === 'escape') {
        await userEvent.keyboard('{Escape}');
      } else {
        view.unmount();
      }
      expect(screen.queryByRole('dialog', { name: '云服务隐私提示' }))
        .not.toBeInTheDocument();

      await act(async () => {
        acknowledgement.resolve({
          shortcut: 'Alt+Shift+A',
          cloudPrivacyAcknowledged: true,
        });
        await acknowledgement.promise;
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(client.recognize).not.toHaveBeenCalled();
      expect(client.quota).not.toHaveBeenCalled();
    },
  );

  it('persists and uploads only once when privacy acceptance is clicked twice', async () => {
    const acknowledgement = createDeferred<AppSettings>();
    const updateCloudPrivacyAcknowledgement = vi.fn(() => acknowledgement.promise);
    const client = createFakeCloudClient();
    render(
      <ScreenshotEditor
        sourceUrl=""
        bridge={createBridge({
          loadSettings: vi.fn().mockResolvedValue({
            shortcut: 'Alt+Shift+A',
            cloudPrivacyAcknowledged: false,
          }),
          updateCloudPrivacyAcknowledgement,
        })}
        cloudClient={client}
      />,
    );
    selectRegion();
    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    const accept = await screen.findByRole('button', { name: '同意并继续' });

    fireEvent.click(accept);
    fireEvent.click(accept);

    expect(updateCloudPrivacyAcknowledgement).toHaveBeenCalledOnce();
    expect(accept).toBeDisabled();
    await act(async () => {
      acknowledgement.resolve({
        shortcut: 'Alt+Shift+A',
        cloudPrivacyAcknowledged: true,
      });
      await acknowledgement.promise;
    });
    await screen.findByLabelText('识别原文');
    await waitFor(() => {
      expect(client.recognize).toHaveBeenCalledOnce();
      expect(client.quota).toHaveBeenCalledOnce();
    });
  });

  it('isolates panel controls, toolbar actions and Ctrl shortcuts from the editor', async () => {
    const bridge = createBridge();
    render(
      <ScreenshotEditor
        sourceUrl=""
        bridge={bridge}
        cloudClient={createFakeCloudClient()}
      />,
    );
    selectRegion();
    fireEvent.pointerDown(screen.getByTestId('annotation-surface'), {
      clientX: 50,
      clientY: 50,
      pointerId: 2,
    });
    fireEvent.pointerMove(screen.getByTestId('annotation-surface'), {
      clientX: 150,
      clientY: 110,
      pointerId: 2,
    });
    fireEvent.pointerUp(screen.getByTestId('annotation-surface'), {
      clientX: 150,
      clientY: 110,
      pointerId: 2,
    });
    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    const copyText = await screen.findByRole('button', { name: '复制文字' });
    copyText.focus();

    await userEvent.keyboard('{Enter}{Control>}s{/Control}{Control>}z{/Control}');

    const toolbar = screen.getByRole('toolbar', { name: '截图工具' });
    expect(toolbar.closest('.toolbar-positioner')).toHaveAttribute('inert');
    expect(toolbar.closest('.toolbar-positioner')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: '滚动截图' }));
    expect(bridge.copyPng).not.toHaveBeenCalled();
    expect(bridge.savePng).not.toHaveBeenCalled();
    expect(bridge.startLongCapture).not.toHaveBeenCalled();
    expect(bridge.closeOverlay).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '关闭识别面板' }));
    expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled();
  });

  it('keeps cloud preparation mutually exclusive with long capture and closes cloud UI first', async () => {
    let resolveSettings: ((settings: AppSettings) => void) | undefined;
    const bridge = createBridge({
      loadSettings: vi.fn(() => new Promise<AppSettings>((resolve) => {
        resolveSettings = resolve;
      })),
      startLongCapture: vi.fn(
        (): Promise<LongCaptureResult> => new Promise(() => undefined),
      ),
    });
    render(
      <ScreenshotEditor
        sourceUrl=""
        bridge={bridge}
        cloudClient={createFakeCloudClient()}
      />,
    );
    selectRegion();
    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    await waitFor(() => expect(bridge.loadSettings).toHaveBeenCalledOnce());

    const longCapture = screen.queryByRole('button', { name: '滚动截图' });
    if (longCapture) {
      fireEvent.click(longCapture);
    }
    resolveSettings?.({
      shortcut: 'Alt+Shift+A',
      cloudPrivacyAcknowledged: false,
    });
    await screen.findByRole('dialog', { name: '云服务隐私提示' });

    await userEvent.keyboard('{Escape}');

    expect(bridge.startLongCapture).not.toHaveBeenCalled();
    expect(bridge.requestLongCaptureTerminal).not.toHaveBeenCalled();
    expect(bridge.closeOverlay).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '云服务隐私提示' }))
      .not.toBeInTheDocument();
  });

  it('reuses the exact exported Blob for translation and retry', async () => {
    const translated: RecognitionResult = {
      ...ocrResult,
      translatedText: 'translated',
    };
    const recognize = vi.fn()
      .mockResolvedValueOnce(ocrResult)
      .mockResolvedValueOnce(translated)
      .mockResolvedValueOnce(translated);
    const client = createFakeCloudClient({ recognize });
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob');
    render(
      <ScreenshotEditor
        sourceUrl=""
        bridge={createBridge()}
        cloudClient={client}
      />,
    );
    selectRegion();

    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    await screen.findByLabelText('识别原文');
    const originalBlob = recognize.mock.calls[0]?.[1];
    await userEvent.click(screen.getByRole('button', { name: '翻译识别结果' }));
    await screen.findByLabelText('翻译结果');
    await userEvent.click(screen.getByRole('button', { name: '重试翻译' }));

    await waitFor(() => expect(recognize).toHaveBeenCalledTimes(3));
    expect(recognize.mock.calls.map((call) => call[0])).toEqual([
      'ocr',
      'translate',
      'translate',
    ]);
    expect(recognize.mock.calls.every((call) => call[1] === originalBlob)).toBe(true);
    expect(toBlob).toHaveBeenCalledOnce();
  });

  it('keeps recognition content when quota loading fails', async () => {
    const client = createFakeCloudClient({
      quota: vi.fn().mockRejectedValue(
        new CloudClientError('NETWORK_UNAVAILABLE', 'unavailable'),
      ),
    });
    render(
      <ScreenshotEditor sourceUrl="" bridge={createBridge()} cloudClient={client} />,
    );
    selectRegion();

    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));

    expect(await screen.findByLabelText('识别原文')).toHaveTextContent('识别结果');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('云服务额度')).not.toBeInTheDocument();
  });

  it('aborts an in-flight request when Escape closes the panel before the overlay', async () => {
    let requestSignal: AbortSignal | undefined;
    const recognize = vi.fn((_mode, _blob, signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise<RecognitionResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new CloudClientError('ABORTED', 'cancelled'));
        });
      });
    });
    const bridge = createBridge();
    render(
      <ScreenshotEditor
        sourceUrl=""
        bridge={bridge}
        cloudClient={createFakeCloudClient({ recognize })}
      />,
    );
    selectRegion();
    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    await screen.findByText('正在识别…');

    await userEvent.keyboard('{Escape}');

    expect(requestSignal?.aborted).toBe(true);
    expect(screen.queryByLabelText('识别结果')).not.toBeInTheDocument();
    expect(bridge.closeOverlay).not.toHaveBeenCalled();
    expect(screen.getByText('200 × 140')).toBeInTheDocument();
  });

  it('aborts an in-flight request on unmount', async () => {
    let requestSignal: AbortSignal | undefined;
    const recognize = vi.fn((_mode, _blob, signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise<RecognitionResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new CloudClientError('ABORTED', 'cancelled'));
        });
      });
    });
    const { unmount } = render(
      <ScreenshotEditor
        sourceUrl=""
        bridge={createBridge()}
        cloudClient={createFakeCloudClient({ recognize })}
      />,
    );
    selectRegion();
    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    await waitFor(() => expect(requestSignal).toBeDefined());

    unmount();

    expect(requestSignal?.aborted).toBe(true);
  });

  it('does not start cloud work when export resolves after unmount', async () => {
    let finishExport: ((blob: Blob | null) => void) | undefined;
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
      (callback) => {
        finishExport = callback;
      },
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = createFakeCloudClient();
    const view = render(
      <ScreenshotEditor
        sourceUrl=""
        bridge={createBridge()}
        cloudClient={client}
      />,
    );
    selectRegion();
    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    await waitFor(() => expect(finishExport).toBeDefined());

    view.unmount();
    await act(async () => {
      finishExport?.(new Blob(['png'], { type: 'image/png' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.recognize).not.toHaveBeenCalled();
    expect(client.quota).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does not start cloud work when settings resolve after unmount', async () => {
    const settings = createDeferred<AppSettings>();
    const bridge = createBridge({
      loadSettings: vi.fn(() => settings.promise),
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = createFakeCloudClient();
    const view = render(
      <ScreenshotEditor sourceUrl="" bridge={bridge} cloudClient={client} />,
    );
    selectRegion();
    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    await waitFor(() => expect(bridge.loadSettings).toHaveBeenCalledOnce());

    view.unmount();
    await act(async () => {
      settings.resolve({
        shortcut: 'Alt+Shift+A',
        cloudPrivacyAcknowledged: true,
      });
      await settings.promise;
      await Promise.resolve();
    });

    expect(client.recognize).not.toHaveBeenCalled();
    expect(client.quota).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('Escape dismisses privacy with no request and does not close the overlay', async () => {
    const bridge = createBridge({
      loadSettings: vi.fn().mockResolvedValue({
        shortcut: 'Alt+Shift+A',
        cloudPrivacyAcknowledged: false,
      }),
    });
    const client = createFakeCloudClient();
    render(
      <ScreenshotEditor sourceUrl="" bridge={bridge} cloudClient={client} />,
    );
    selectRegion();
    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    await screen.findByRole('dialog', { name: '云服务隐私提示' });

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: '云服务隐私提示' }))
      .not.toBeInTheDocument();
    expect(client.recognize).not.toHaveBeenCalled();
    expect(bridge.closeOverlay).not.toHaveBeenCalled();
  });

  it('draws a normalized green highlight inside the current selection', async () => {
    render(
      <ScreenshotEditor
        sourceUrl=""
        bridge={createBridge()}
        cloudClient={createFakeCloudClient()}
      />,
    );
    selectRegion({ x: 20, y: 30 }, { x: 220, y: 130 });
    await userEvent.click(screen.getByRole('button', { name: '文字识别' }));
    const block = await screen.findByText('识别结果', {
      selector: '.recognition-panel__block',
    });

    fireEvent.mouseEnter(block);

    expect(screen.getByTestId('recognition-highlight')).toHaveStyle({
      left: '40px',
      top: '50px',
      width: '60px',
      height: '40px',
    });
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

  it('closes after a natively copied long capture without copying twice', async () => {
    const bridge = createBridge({
      startLongCapture: vi.fn().mockResolvedValue({
        png: new Blob(['long'], { type: 'image/png' }),
        partial: false,
        action: 'finish',
      }),
    });
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });

    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));
    await waitFor(() => expect(bridge.closeOverlay).toHaveBeenCalledOnce());

    expect(bridge.copyPng).not.toHaveBeenCalled();
  });

  it('preserves the completed long image when native clipboard output fails', async () => {
    const createObjectUrl = vi.fn().mockReturnValue('blob:clipboard-retry');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    const bridge = createBridge({
      startLongCapture: vi.fn().mockResolvedValue({
        png: new Blob(['long'], { type: 'image/png' }),
        partial: false,
        action: 'edit',
        clipboardError: 'clipboard busy',
      }),
    });
    const { container } = render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });

    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '长截图复制失败：clipboard busy，已保留长图，可重试复制或保存',
    );
    expect(container.querySelector('.screenshot-source')).toHaveAttribute('src', 'blob:clipboard-retry');
    expect(bridge.closeOverlay).not.toHaveBeenCalled();
  });

  it('preserves the completed long image when mask cleanup fails', async () => {
    const createObjectUrl = vi.fn().mockReturnValue('blob:cleanup-retry');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    const bridge = createBridge({
      startLongCapture: vi.fn().mockResolvedValue({
        png: new Blob(['long'], { type: 'image/png' }),
        partial: false,
        action: 'edit',
        cleanupError: 'mask hide failed',
        clipboardError: 'clipboard busy',
      }),
    });
    const { container } = render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });

    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '长截图窗口清理失败：mask hide failed；长截图复制失败：clipboard busy，已保留长图，可重试复制或保存',
    );
    expect(container.querySelector('.screenshot-source')).toHaveAttribute('src', 'blob:cleanup-retry');
    expect(bridge.closeOverlay).not.toHaveBeenCalled();
  });

  it('ignores Enter in the restored overlay while native Finish is still pending', async () => {
    let resolveCapture: ((value: { png: Blob; partial: boolean; action: 'finish' }) => void) | undefined;
    const bridge = createBridge({
      startLongCapture: vi.fn().mockImplementation(() => new Promise((resolve) => {
        resolveCapture = resolve;
      })),
    });
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 20, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 220, clientY: 180, pointerId: 1 });
    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));

    await userEvent.keyboard('{Enter}{Enter}{Control>}s{/Control}{Control>}z{/Control}');

    expect(bridge.copyPng).not.toHaveBeenCalled();
    expect(bridge.savePng).not.toHaveBeenCalled();
    expect(bridge.closeOverlay).not.toHaveBeenCalled();
    resolveCapture?.({ png: new Blob(['long']), partial: false, action: 'finish' });
    await waitFor(() => expect(bridge.closeOverlay).toHaveBeenCalledOnce());
  });

  it('Esc delegates long-capture cancellation to the active native session', async () => {
    let reportProgress: ((progress: LongCaptureProgress) => void) | undefined;
    const bridge = createBridge({
      startLongCapture: vi.fn((_region, onProgress) => {
        reportProgress = onProgress;
        return new Promise<LongCaptureResult>(() => undefined);
      }),
      requestLongCaptureTerminal: vi.fn().mockResolvedValue({
        sessionId: 17,
        action: 'cancel',
        status: 'accepted',
      }),
    });
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 110, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 110, clientY: 90, pointerId: 1 });
    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));

    act(() => {
      reportProgress?.({
        sessionId: 17,
        revision: 3,
        frameCount: 3,
        stitchedHeight: 1240,
        state: 'matching',
        previewPngBytes: [],
        navigatorPngBytes: [],
        acceptedBounds: null,
        warning: false,
        slowScrollWarning: false,
      });
    });
    expect(screen.queryByRole('status', { name: '长截图进度' })).not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    expect(bridge.requestLongCaptureTerminal).toHaveBeenCalledWith(17, 'cancel');
    expect(bridge.closeOverlay).not.toHaveBeenCalled();
    expect(screen.getByLabelText('截图编辑器')).toHaveAttribute('data-capture-mode', 'selecting');
    expect(screen.queryByTestId('selection-box')).not.toBeInTheDocument();
  });

  it('keeps repeated Escape presses on the native cancel path until capture settles', async () => {
    let reportProgress: ((progress: LongCaptureProgress) => void) | undefined;
    const bridge = createBridge({
      startLongCapture: vi.fn((_region, onProgress) => {
        reportProgress = onProgress;
        return new Promise<LongCaptureResult>(() => undefined);
      }),
      requestLongCaptureTerminal: vi.fn().mockResolvedValue({
        sessionId: 17,
        action: 'cancel',
        status: 'alreadyTerminating',
      }),
    });
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    selectRegion({ x: 10, y: 10 }, { x: 110, y: 90 });
    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));
    act(() => {
      reportProgress?.({
        sessionId: 17,
        revision: 3,
        frameCount: 3,
        stitchedHeight: 1240,
        state: 'matching',
        previewPngBytes: [],
        navigatorPngBytes: [],
        acceptedBounds: null,
        warning: false,
        slowScrollWarning: false,
      });
    });

    await userEvent.keyboard('{Escape}{Escape}');

    expect(bridge.requestLongCaptureTerminal).toHaveBeenCalledTimes(2);
    expect(bridge.requestLongCaptureTerminal).toHaveBeenNthCalledWith(1, 17, 'cancel');
    expect(bridge.requestLongCaptureTerminal).toHaveBeenNthCalledWith(2, 17, 'cancel');
    expect(bridge.closeOverlay).not.toHaveBeenCalled();
  });

  it('shows a retryable error when native long-capture cancellation rejects', async () => {
    let reportProgress: ((progress: LongCaptureProgress) => void) | undefined;
    const bridge = createBridge({
      startLongCapture: vi.fn((_region, onProgress) => {
        reportProgress = onProgress;
        return new Promise<LongCaptureResult>(() => undefined);
      }),
      requestLongCaptureTerminal: vi.fn().mockRejectedValue(new Error('invoke failed')),
    });
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    selectRegion({ x: 10, y: 10 }, { x: 110, y: 90 });
    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));
    act(() => {
      reportProgress?.({
        sessionId: 17,
        revision: 3,
        frameCount: 3,
        stitchedHeight: 1240,
        state: 'matching',
        previewPngBytes: [],
        navigatorPngBytes: [],
        acceptedBounds: null,
        warning: false,
        slowScrollWarning: false,
      });
    });

    await userEvent.keyboard('{Escape}');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '长截图退出失败：invoke failed',
    );
    expect(bridge.closeOverlay).not.toHaveBeenCalled();
  });

  it('lets the native result win when Esc reaches an already-terminating save', async () => {
    let reportProgress: ((progress: LongCaptureProgress) => void) | undefined;
    let finishCapture: ((result: LongCaptureResult) => void) | undefined;
    const resultPng = new Blob(['native-save'], { type: 'image/png' });
    const bridge = createBridge({
      startLongCapture: vi.fn((_region, onProgress) => {
        reportProgress = onProgress;
        return new Promise<LongCaptureResult>((resolve) => { finishCapture = resolve; });
      }),
      requestLongCaptureTerminal: vi.fn().mockResolvedValue({
        sessionId: 17,
        action: 'save',
        status: 'alreadyTerminating',
      }),
    });
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    selectRegion({ x: 10, y: 10 }, { x: 110, y: 90 });
    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));
    reportProgress?.({
      sessionId: 17,
      revision: 3,
      frameCount: 3,
      stitchedHeight: 1240,
      state: 'matching',
      previewPngBytes: [],
      navigatorPngBytes: [],
      acceptedBounds: null,
      warning: false,
      slowScrollWarning: false,
    });

    await userEvent.keyboard('{Escape}');
    finishCapture?.({ png: resultPng, partial: false, action: 'save' });

    await waitFor(() => expect(bridge.savePng).toHaveBeenCalledWith(
      resultPng,
      expect.stringMatching(/\.png$/),
    ));
    expect(bridge.closeOverlay).toHaveBeenCalledOnce();
  });

  it('ignores a progress poll that resolves after native capture completion', async () => {
    let reportProgress: ((progress: LongCaptureProgress) => void) | undefined;
    let finishCapture: ((result: LongCaptureResult) => void) | undefined;
    const createObjectUrl = vi.fn().mockReturnValue('blob:completed-capture');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    });
    const bridge = createBridge({
      startLongCapture: vi.fn((_region, onProgress) => {
        reportProgress = onProgress;
        return new Promise<LongCaptureResult>((resolve) => { finishCapture = resolve; });
      }),
    });
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    selectRegion({ x: 10, y: 10 }, { x: 110, y: 90 });
    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));
    act(() => {
      reportProgress?.({
        sessionId: 17,
        revision: 3,
        frameCount: 3,
        stitchedHeight: 1240,
        state: 'matching',
        previewPngBytes: [],
        navigatorPngBytes: [],
        acceptedBounds: null,
        warning: false,
        slowScrollWarning: false,
      });
      finishCapture?.({
        png: new Blob(['completed'], { type: 'image/png' }),
        partial: false,
        action: 'edit',
      });
    });
    await waitFor(() => expect(createObjectUrl).toHaveBeenCalledOnce());

    act(() => {
      reportProgress?.({
        sessionId: 17,
        revision: 4,
        frameCount: 4,
        stitchedHeight: 1500,
        state: 'observing',
        previewPngBytes: [],
        navigatorPngBytes: [],
        acceptedBounds: null,
        warning: false,
        slowScrollWarning: false,
      });
    });
    await userEvent.keyboard('{Escape}');

    expect(bridge.requestLongCaptureTerminal).not.toHaveBeenCalled();
    expect(bridge.closeOverlay).toHaveBeenCalledOnce();
  });

  it('ignores a cancel rejection delivered after an authoritative native result', async () => {
    let reportProgress: ((progress: LongCaptureProgress) => void) | undefined;
    let finishCapture: ((result: LongCaptureResult) => void) | undefined;
    let rejectTerminal: ((reason: unknown) => void) | undefined;
    const createObjectUrl = vi.fn().mockReturnValue('blob:authoritative-edit');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrl,
    });
    const bridge = createBridge({
      startLongCapture: vi.fn((_region, onProgress) => {
        reportProgress = onProgress;
        return new Promise<LongCaptureResult>((resolve) => { finishCapture = resolve; });
      }),
      requestLongCaptureTerminal: vi.fn(() => new Promise<LongCaptureTerminalOutcome>(
        (_resolve, reject) => {
          rejectTerminal = reject;
        },
      )),
    });
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    selectRegion({ x: 10, y: 10 }, { x: 110, y: 90 });
    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));
    act(() => {
      reportProgress?.({
        sessionId: 17,
        revision: 3,
        frameCount: 3,
        stitchedHeight: 1240,
        state: 'matching',
        previewPngBytes: [],
        navigatorPngBytes: [],
        acceptedBounds: null,
        warning: false,
        slowScrollWarning: false,
      });
    });
    await userEvent.keyboard('{Escape}');
    act(() => {
      finishCapture?.({
        png: new Blob(['authoritative'], { type: 'image/png' }),
        partial: false,
        action: 'edit',
      });
    });
    await waitFor(() => expect(createObjectUrl).toHaveBeenCalledOnce());

    await act(async () => {
      rejectTerminal?.(new Error('late invoke failure'));
      await Promise.resolve();
    });

    expect(screen.queryByText('长截图退出失败：late invoke failure'))
      .not.toBeInTheDocument();
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

  it('shows cleanup failures that happen while cancelling long capture', async () => {
    const bridge = createBridge({
      startLongCapture: vi.fn().mockRejectedValue(
        'long capture cancelled; cleanup: failed to hide scroll-mask-right',
      ),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ScreenshotEditor sourceUrl="" bridge={bridge} />);
    const selectionSurface = screen.getByTestId('selection-surface');
    fireEvent.pointerDown(selectionSurface, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(selectionSurface, { clientX: 110, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(selectionSurface, { clientX: 110, clientY: 90, pointerId: 1 });

    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '长截图失败：long capture cancelled; cleanup: failed to hide scroll-mask-right',
    );
  });
});
