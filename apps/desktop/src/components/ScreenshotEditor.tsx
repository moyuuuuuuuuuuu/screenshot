import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AppSettings, DesktopBridge, LongCaptureProgress } from '../bridge/desktop-bridge';
import {
  CloudClientError,
  createCloudClient,
  type CloudClient,
  type QuotaResult,
  type TextBlock,
} from '../cloud/cloud-client';
import { captureSessionReducer, initialCaptureSession } from '../domain/capture-session';
import {
  addAnnotation,
  createEditorHistory,
  redo,
  undo,
  type EditorHistory,
} from '../domain/editor-history';
import {
  continueDrawing,
  finishDrawing,
  startDrawing,
  type DrawingSession,
  type Tool,
} from '../domain/drawing-session';
import type { Point, Rect } from '../domain/geometry';
import { renderAnnotations } from '../render/render-annotations';
import { SelectionOverlay } from './SelectionOverlay';
import { EmojiPicker } from './EmojiPicker';
import { TextEditor } from './TextEditor';
import { WechatToolbar, type WechatToolbarAction } from './WechatToolbar';
import {
  RecognitionPanel,
  type RecognitionPanelState,
} from './RecognitionPanel';

type ScreenshotEditorProps = Readonly<{
  sourceUrl: string;
  bridge: DesktopBridge;
  cloudClient?: CloudClient;
}>;

type PendingPrivacy = Readonly<{
  image: Blob;
  mode: 'ocr' | 'translate';
  settings: AppSettings;
}>;

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG export failed'));
    }, 'image/png');
  });
}

function screenshotName(now = new Date()): string {
  const part = (value: number) => String(value).padStart(2, '0');
  return `截图-${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}.png`;
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return '未知错误';
}

function safeCloudErrorMessage(error: unknown): string {
  return error instanceof CloudClientError
    ? error.message
    : 'The cloud service is unavailable.';
}

export function ScreenshotEditor({
  sourceUrl,
  bridge,
  cloudClient: providedCloudClient,
}: ScreenshotEditorProps) {
  const cloudClient = useMemo(
    () => providedCloudClient ?? createCloudClient({
      apiUrl: import.meta.env.VITE_CLOUD_API_URL ?? '',
      requestKey: import.meta.env.VITE_CLOUD_REQUEST_KEY ?? '',
      getDeviceId: () => bridge.getCloudDeviceId(),
    }),
    [bridge, providedCloudClient],
  );
  const [captureSession, dispatchCapture] = useReducer(
    captureSessionReducer,
    sourceUrl,
    initialCaptureSession,
  );
  const selection = captureSession.selection;
  const [activeTool, setActiveTool] = useState<Tool>('rectangle');
  const [history, setHistory] = useState<EditorHistory>(createEditorHistory);
  const [textPosition, setTextPosition] = useState<Point | null>(null);
  const [selectedEmoji, setSelectedEmoji] = useState('😊');
  const [error, setError] = useState<string | null>(null);
  const [recognitionState, setRecognitionState] =
    useState<RecognitionPanelState | null>(null);
  const [quota, setQuota] = useState<QuotaResult | null>(null);
  const [pendingPrivacy, setPendingPrivacy] = useState<PendingPrivacy | null>(null);
  const [highlightedBlock, setHighlightedBlock] = useState<TextBlock | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [drawingPreview, setDrawingPreview] = useState<DrawingSession | null>(null);
  const [penWidth, setPenWidth] = useState(4);
  const [mosaicWidth, setMosaicWidth] = useState(20);
  const [imageRevision, setImageRevision] = useState(0);
  const [toolbarWidth, setToolbarWidth] = useState(570);
  const [longCaptureBounds, setLongCaptureBounds] = useState<Rect | null>(null);
  const [longCaptureProgress, setLongCaptureProgress] = useState<LongCaptureProgress | null>(null);
  const [editorSourceUrl, setEditorSourceUrl] = useState(sourceUrl);
  const sourceImage = useRef<HTMLImageElement>(null);
  const annotationCanvas = useRef<HTMLCanvasElement>(null);
  const drawingSession = useRef<DrawingSession | null>(null);
  const annotationSequence = useRef(0);
  const generatedSourceUrl = useRef<string | null>(null);
  const longCaptureSource = useRef<Blob | null>(null);
  const longCaptureCancelled = useRef(false);
  const longCaptureCancelInFlight = useRef(false);
  const cloudSource = useRef<Blob | null>(null);
  const privacyAcknowledged = useRef<boolean | null>(null);
  const activeCloudRequest = useRef<AbortController | null>(null);
  const cloudRequestSequence = useRef(0);
  const toolbarPositioner = useRef<HTMLDivElement>(null);

  useEffect(() => {
    longCaptureSource.current = null;
    setLongCaptureBounds(null);
    setEditorSourceUrl(sourceUrl);
    dispatchCapture({ type: 'selectionChanged', rect: null });
  }, [sourceUrl]);

  useEffect(() => () => {
    if (generatedSourceUrl.current) URL.revokeObjectURL(generatedSourceUrl.current);
  }, []);

  useEffect(() => () => {
    cloudRequestSequence.current += 1;
    activeCloudRequest.current?.abort();
    activeCloudRequest.current = null;
  }, []);

  useEffect(() => {
    const canvas = annotationCanvas.current;
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const context = canvas.getContext('2d');
    if (!context) return;

    const image = sourceImage.current;
    const preview = drawingPreview
      ? finishDrawing(drawingPreview, 'annotation-preview', {
          strokeWidth: penWidth,
          mosaicBrushWidth: mosaicWidth,
        })
      : null;
    const annotations = preview ? [...history.present, preview] : history.present;
    if (image?.complete && image.naturalWidth > 0) {
      renderAnnotations(context, image, annotations, {
        width: canvas.width,
        height: canvas.height,
      });
      return;
    }

    const blankSource = document.createElement('canvas');
    blankSource.width = canvas.width;
    blankSource.height = canvas.height;
    renderAnnotations(context, blankSource, annotations, {
      width: canvas.width,
      height: canvas.height,
    });
  }, [drawingPreview, history, imageRevision, mosaicWidth, penWidth]);

  const pointInsideSelection = useCallback(
    (x: number, y: number) => {
      if (!selection) return null;
      return {
        x: Math.min(Math.max(x, selection.x), selection.x + selection.width),
        y: Math.min(Math.max(y, selection.y), selection.y + selection.height),
      };
    },
    [selection],
  );

  const startAnnotation = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const point = pointInsideSelection(event.clientX, event.clientY);
      if (!point) return;
      if (activeTool === 'text') {
        setTextPosition(point);
        return;
      }
      if (activeTool === 'emoji') {
        setHistory((historyState) => addAnnotation(historyState, {
          id: `annotation-${++annotationSequence.current}`,
          kind: 'emoji',
          position: point,
          emoji: selectedEmoji,
          size: 32,
        }));
        return;
      }
      drawingSession.current = startDrawing(activeTool, point);
      setDrawingPreview(drawingSession.current);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [activeTool, pointInsideSelection, selectedEmoji],
  );

  const continueAnnotation = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const point = pointInsideSelection(event.clientX, event.clientY);
      if (!point || !drawingSession.current) return;
      drawingSession.current = continueDrawing(drawingSession.current, point);
      setDrawingPreview(drawingSession.current);
    },
    [pointInsideSelection],
  );

  const finishAnnotation = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const point = pointInsideSelection(event.clientX, event.clientY);
      const current = drawingSession.current;
      drawingSession.current = null;
      setDrawingPreview(null);
      if (!point || !current) return;

      const completed = finishDrawing(
        continueDrawing(current, point),
        `annotation-${++annotationSequence.current}`,
        { strokeWidth: penWidth, mosaicBrushWidth: mosaicWidth },
      );
      if (completed) {
        setHistory((historyState) => addAnnotation(historyState, completed));
      }
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    },
    [mosaicWidth, penWidth, pointInsideSelection],
  );

  const exportSelection = useCallback(async () => {
    if (!selection || selection.width <= 0 || selection.height <= 0) {
      throw new Error('No selection');
    }
    if (
      longCaptureSource.current
      && longCaptureBounds
      && selection.x === longCaptureBounds.x
      && selection.y === longCaptureBounds.y
      && selection.width === longCaptureBounds.width
      && selection.height === longCaptureBounds.height
      && history.present.length === 0
    ) {
      return longCaptureSource.current;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(selection.width));
    canvas.height = Math.max(1, Math.round(selection.height));
    const context = canvas.getContext('2d');
    if (context) {
      if (sourceImage.current?.complete) {
        context.drawImage(
          sourceImage.current,
          selection.x,
          selection.y,
          selection.width,
          selection.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
      }
      if (annotationCanvas.current) {
        context.drawImage(
          annotationCanvas.current,
          selection.x,
          selection.y,
          selection.width,
          selection.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
      }
    }
    return canvasToBlob(canvas);
  }, [history.present.length, longCaptureBounds, selection]);

  const copyAndClose = useCallback(async () => {
    try {
      setError(null);
      await bridge.copyPng(await exportSelection());
      await bridge.closeOverlay();
    } catch {
      setError('复制失败，请重试');
    }
  }, [bridge, exportSelection]);

  const save = useCallback(async () => {
    try {
      setError(null);
      const savedPath = await bridge.savePng(await exportSelection(), screenshotName());
      if (savedPath) await bridge.closeOverlay();
    } catch {
      setError('保存失败，请重试');
    }
  }, [bridge, exportSelection]);

  const startLongCapture = useCallback(async () => {
    if (!selection || longCaptureProgress) return;
    longCaptureCancelled.current = false;
    longCaptureCancelInFlight.current = false;
    dispatchCapture({ type: 'scrollStarted' });
    setError(null);
    setLongCaptureProgress({
      frameCount: 0,
      stitchedHeight: 0,
      state: 'preparing',
      previewPngBytes: [],
      navigatorPngBytes: [],
      acceptedBounds: null,
      warning: false,
      slowScrollWarning: false,
    });
    try {
      const result = await bridge.startLongCapture(selection, setLongCaptureProgress);
      if (longCaptureCancelled.current) {
        dispatchCapture({ type: 'scrollCancelled' });
        return;
      }
      if (result.action === 'save') {
        const savedPath = await bridge.savePng(result.png, screenshotName());
        if (savedPath) await bridge.closeOverlay();
        return;
      }
      if (result.action === 'finish') {
        await bridge.closeOverlay();
        return;
      }
      if (generatedSourceUrl.current) URL.revokeObjectURL(generatedSourceUrl.current);
      const resultUrl = URL.createObjectURL(result.png);
      generatedSourceUrl.current = resultUrl;
      longCaptureSource.current = result.png;
      setEditorSourceUrl(resultUrl);
      dispatchCapture({ type: 'scrollEditRequested', imageUrl: resultUrl });
      setHistory(createEditorHistory());
      if (result.cleanupError || result.clipboardError) {
        const completionErrors = [
          result.cleanupError ? `长截图窗口清理失败：${result.cleanupError}` : null,
          result.clipboardError ? `长截图复制失败：${result.clipboardError}` : null,
        ].filter((message): message is string => Boolean(message));
        const recovery = result.clipboardError
          ? '，已保留长图，可重试复制或保存'
          : '，已保留长图';
        setError(`${completionErrors.join('；')}${recovery}`);
      } else if (result.partial) {
        setError('长截图已停止，已保留部分结果');
      }
    } catch (captureError) {
      dispatchCapture({ type: 'scrollCancelled' });
      const message = errorMessage(captureError);
      if (message.toLowerCase() === 'long capture cancelled') return;
      console.error('Long capture failed', captureError);
      setError(`长截图失败：${message}`);
    } finally {
      setLongCaptureProgress(null);
    }
  }, [bridge, longCaptureProgress, selection]);

  const resetEditorSession = useCallback(() => {
    cloudRequestSequence.current += 1;
    activeCloudRequest.current?.abort();
    activeCloudRequest.current = null;
    dispatchCapture({ type: 'sessionReset' });
    setHistory(createEditorHistory());
    setActiveTool('rectangle');
    setTextPosition(null);
    setError(null);
    setRecognitionState(null);
    setQuota(null);
    setPendingPrivacy(null);
    setHighlightedBlock(null);
    setToast(null);
    setDrawingPreview(null);
    setLongCaptureBounds(null);
    setLongCaptureProgress(null);
    drawingSession.current = null;
    longCaptureSource.current = null;
    cloudSource.current = null;
    if (generatedSourceUrl.current) {
      URL.revokeObjectURL(generatedSourceUrl.current);
      generatedSourceUrl.current = null;
    }
  }, []);

  const cancelLongCaptureAndClose = useCallback(async () => {
    if (longCaptureCancelInFlight.current) return;
    longCaptureCancelInFlight.current = true;
    longCaptureCancelled.current = true;
    resetEditorSession();
    try {
      await bridge.cancelLongCapture();
    } finally {
      await bridge.closeOverlay();
    }
  }, [bridge, resetEditorSession]);

  const performRecognition = useCallback(async (
    mode: 'ocr' | 'translate',
    image: Blob,
  ) => {
    activeCloudRequest.current?.abort();
    const controller = new AbortController();
    activeCloudRequest.current = controller;
    const requestSequence = ++cloudRequestSequence.current;
    dispatchCapture({ type: 'serviceStarted', service: mode });
    setError(null);
    setQuota(null);
    setHighlightedBlock(null);
    setRecognitionState({ status: 'loading', mode });

    try {
      const result = await cloudClient.recognize(mode, image, controller.signal);
      if (requestSequence !== cloudRequestSequence.current) return;
      setRecognitionState({ status: 'success', mode, result });
      try {
        const nextQuota = await cloudClient.quota(controller.signal);
        if (requestSequence === cloudRequestSequence.current) {
          setQuota(nextQuota);
        }
      } catch {
        // Quota status is supplementary and never replaces recognition content.
      }
    } catch (cloudError) {
      if (requestSequence !== cloudRequestSequence.current) return;
      if (cloudError instanceof CloudClientError && cloudError.code === 'ABORTED') {
        return;
      }
      setRecognitionState({
        status: 'error',
        mode,
        message: safeCloudErrorMessage(cloudError),
      });
    } finally {
      if (requestSequence === cloudRequestSequence.current) {
        activeCloudRequest.current = null;
        dispatchCapture({ type: 'serviceFinished' });
      }
    }
  }, [cloudClient]);

  const closeRecognitionPanel = useCallback(() => {
    cloudRequestSequence.current += 1;
    activeCloudRequest.current?.abort();
    activeCloudRequest.current = null;
    setRecognitionState(null);
    setQuota(null);
    setHighlightedBlock(null);
    dispatchCapture({ type: 'serviceFinished' });
  }, []);

  const runOcr = useCallback(async () => {
    try {
      const image = await exportSelection();
      cloudSource.current = image;
      if (privacyAcknowledged.current === true) {
        void performRecognition('ocr', image);
        return;
      }

      const settings = await bridge.loadSettings();
      privacyAcknowledged.current = settings.cloudPrivacyAcknowledged;
      if (settings.cloudPrivacyAcknowledged) {
        void performRecognition('ocr', image);
      } else {
        setPendingPrivacy({ image, mode: 'ocr', settings });
      }
    } catch {
      setError('无法准备云服务请求，请重试');
    }
  }, [bridge, exportSelection, performRecognition]);

  const acceptPrivacy = useCallback(async () => {
    const pending = pendingPrivacy;
    if (!pending) return;
    try {
      await bridge.updateSettings({
        shortcut: pending.settings.shortcut,
        cloudPrivacyAcknowledged: true,
      });
      privacyAcknowledged.current = true;
      setPendingPrivacy(null);
      void performRecognition(pending.mode, pending.image);
    } catch {
      setError('无法保存隐私设置，未上传截图');
    }
  }, [bridge, pendingPrivacy, performRecognition]);

  const cancelPrivacy = useCallback(() => {
    setPendingPrivacy(null);
    cloudSource.current = null;
  }, []);

  const runTranslation = useCallback(() => {
    const image = cloudSource.current;
    if (image) void performRecognition('translate', image);
  }, [performRecognition]);

  const retryRecognition = useCallback(() => {
    const image = cloudSource.current;
    if (image && recognitionState) {
      void performRecognition(recognitionState.mode, image);
    }
  }, [performRecognition, recognitionState]);

  const copyRecognitionText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setToast('已复制文字');
    } catch {
      setError('复制文字失败，请重试');
    }
  }, []);

  const pinSelection = useCallback(async () => {
    if (!selection) return;
    setError(null);
    try {
      await bridge.pinPng(await exportSelection(), selection);
      await bridge.closeOverlay();
    } catch (pinError) {
      setError(errorMessage(pinError));
    }
  }, [bridge, exportSelection, selection]);

  const shareSelection = useCallback(async () => {
    setError(null);
    try {
      const outcome = await bridge.sharePng(await exportSelection());
      setToast(outcome === 'copiedFallback' ? '已复制图片，可粘贴到要转发的应用' : '已打开系统分享');
    } catch (shareError) {
      setError(errorMessage(shareError));
    }
  }, [bridge, exportSelection]);

  const handleAction = useCallback(
    (action: WechatToolbarAction) => {
      if (longCaptureProgress) return;
      if (['rectangle', 'ellipse', 'emoji', 'arrow', 'pen', 'text', 'mosaic'].includes(action)) {
        setActiveTool(action as Tool);
        setTextPosition(null);
        return;
      }
      if (action === 'undo') setHistory((current) => undo(current));
      if (action === 'complete') void copyAndClose();
      if (action === 'save') void save();
      if (action === 'long-capture') void startLongCapture();
      if (action === 'cancel') void bridge.closeOverlay();
      if (action === 'ocr') void runOcr();
      if (action === 'pin') void pinSelection();
      if (action === 'share') void shareSelection();
    },
    [bridge, copyAndClose, longCaptureProgress, pinSelection, runOcr, save, shareSelection, startLongCapture],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (longCaptureProgress || longCaptureCancelInFlight.current) {
          void cancelLongCaptureAndClose();
        } else if (pendingPrivacy) {
          cancelPrivacy();
        } else if (recognitionState) {
          closeRecognitionPanel();
        } else {
          void bridge.closeOverlay();
        }
        return;
      }
      if (longCaptureProgress || longCaptureCancelInFlight.current) {
        event.preventDefault();
        return;
      }
      if (event.key === 'Enter') void copyAndClose();
      if (event.ctrlKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        setHistory((current) => (event.shiftKey ? redo(current) : undo(current)));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    bridge,
    cancelLongCaptureAndClose,
    cancelPrivacy,
    closeRecognitionPanel,
    copyAndClose,
    longCaptureProgress,
    pendingPrivacy,
    recognitionState,
    save,
  ]);

  const showToolbar = selection && selection.width > 0 && selection.height > 0;
  const viewportBounds: Rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  const toolbarTop = showToolbar
    ? selection.y + selection.height + 10 + 50 > window.innerHeight
      ? Math.max(8, selection.y - 54)
      : selection.y + selection.height + 10
    : 0;
  const toolbarLeft = showToolbar
    ? Math.min(
        Math.max(8, selection.x + selection.width - toolbarWidth),
        Math.max(8, window.innerWidth - toolbarWidth - 8),
      )
    : 0;

  const handleSourceLoad = () => {
    setImageRevision((revision) => revision + 1);
    const image = sourceImage.current;
    if (!longCaptureSource.current || !image?.naturalWidth || !image.naturalHeight) return;
    const scale = Math.min(
      window.innerWidth / image.naturalWidth,
      window.innerHeight / image.naturalHeight,
      1,
    );
    const bounds = {
      x: (window.innerWidth - image.naturalWidth * scale) / 2,
      y: (window.innerHeight - image.naturalHeight * scale) / 2,
      width: image.naturalWidth * scale,
      height: image.naturalHeight * scale,
    };
    setLongCaptureBounds(bounds);
    dispatchCapture({ type: 'selectionCommitted', rect: bounds });
  };

  useLayoutEffect(() => {
    const width = toolbarPositioner.current?.offsetWidth;
    if (width && width !== toolbarWidth) setToolbarWidth(width);
  }, [activeTool, showToolbar, toolbarWidth]);

  return (
    <main
      className="screenshot-editor"
      aria-label="截图编辑器"
      data-capture-mode={captureSession.mode}
    >
      {editorSourceUrl ? (
        <img
          ref={sourceImage}
          className={`screenshot-source${longCaptureSource.current ? ' screenshot-source--long' : ''}`}
          src={editorSourceUrl}
          alt=""
          style={longCaptureSource.current
            ? longCaptureBounds
              ? {
                  left: longCaptureBounds.x,
                  top: longCaptureBounds.y,
                  width: longCaptureBounds.width,
                  height: longCaptureBounds.height,
                  visibility: 'visible',
                }
              : { visibility: 'hidden' }
            : undefined}
          onLoad={handleSourceLoad}
        />
      ) : null}
      <canvas
        ref={annotationCanvas}
        className={`annotation-canvas${showToolbar ? ' annotation-canvas--active' : ''}`}
        data-testid="annotation-surface"
        onPointerDown={startAnnotation}
        onPointerMove={continueAnnotation}
        onPointerUp={finishAnnotation}
      />
      <SelectionOverlay
        selection={selection}
        bounds={viewportBounds}
        locked={Boolean(showToolbar)}
        onSelectionChange={(nextSelection) => dispatchCapture({
          type: 'selectionCommitted',
          rect: nextSelection,
        })}
      />
      {highlightedBlock && selection ? (
        <div
          className="recognition-highlight"
          data-testid="recognition-highlight"
          aria-hidden="true"
          style={{
            left: selection.x + highlightedBlock.x * selection.width,
            top: selection.y + highlightedBlock.y * selection.height,
            width: highlightedBlock.width * selection.width,
            height: highlightedBlock.height * selection.height,
          }}
        />
      ) : null}
      {textPosition ? (
        <TextEditor
          position={textPosition}
          onCancel={() => setTextPosition(null)}
          onCommit={(text) => {
            setHistory((current) =>
              addAnnotation(current, {
                id: `annotation-${++annotationSequence.current}`,
                kind: 'text',
                position: textPosition,
                text,
                fontSize: 18,
                color: '#ff3b30',
              }),
            );
            setTextPosition(null);
          }}
        />
      ) : null}
      {showToolbar && !longCaptureProgress ? (
        <div
          ref={toolbarPositioner}
          className="toolbar-positioner"
          style={{ left: toolbarLeft, top: toolbarTop }}
        >
          <WechatToolbar
            activeAction={activeTool}
            canUndo={history.past.length > 0}
            drawingWidth={activeTool === 'mosaic' ? mosaicWidth : penWidth}
            onDrawingWidthChange={activeTool === 'mosaic' ? setMosaicWidth : setPenWidth}
            onAction={handleAction}
          />
          {activeTool === 'emoji' ? (
            <EmojiPicker onSelect={setSelectedEmoji} />
          ) : null}
        </div>
      ) : null}
      {error ? <div className="editor-alert" role="alert">{error}</div> : null}
      {pendingPrivacy ? (
        <div className="privacy-dialog-backdrop">
          <section
            className="privacy-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="云服务隐私提示"
          >
            <h2>云服务隐私提示</h2>
            <p>
              所选截图将发送到本服务及第三方 Coze（扣子）平台，
              用于在线 OCR 或翻译处理。
            </p>
            <div className="privacy-dialog__actions">
              <button type="button" aria-label="取消云服务" onClick={cancelPrivacy}>
                取消
              </button>
              <button type="button" aria-label="同意并继续" onClick={() => void acceptPrivacy()}>
                同意并继续
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {recognitionState ? (
        <RecognitionPanel
          state={recognitionState}
          quota={quota}
          onClose={closeRecognitionPanel}
          onRetry={retryRecognition}
          onCopy={(text) => void copyRecognitionText(text)}
          onTranslate={runTranslation}
          onBlockHighlight={setHighlightedBlock}
        />
      ) : null}
      {toast ? <div className="editor-toast" role="status">{toast}</div> : null}
    </main>
  );
}
