import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { DesktopBridge, LongCaptureProgress } from '../bridge/desktop-bridge';
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
import { ServiceResult } from './ServiceResult';
import { createCozeService, type CozeService } from '../services/coze-service';

type ScreenshotEditorProps = Readonly<{
  sourceUrl: string;
  bridge: DesktopBridge;
  cozeService?: CozeService;
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

export function ScreenshotEditor({ sourceUrl, bridge, cozeService: providedCozeService }: ScreenshotEditorProps) {
  const cozeService = useMemo(
    () => providedCozeService ?? createCozeService({
      getConfig: async () => (await bridge.loadSettings()).coze,
    }),
    [bridge, providedCozeService],
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
  const [serviceResult, setServiceResult] = useState<{ title: string; text: string; translatable: boolean } | null>(null);
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
  const serviceSource = useRef<Blob | null>(null);
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
        await bridge.copyPng(result.png);
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
      if (result.partial) setError('长截图已停止，已保留部分结果');
    } catch (captureError) {
      dispatchCapture({ type: 'scrollCancelled' });
      if (errorMessage(captureError).toLowerCase().includes('cancelled')) return;
      console.error('Long capture failed', captureError);
      setError(`长截图失败：${errorMessage(captureError)}`);
    } finally {
      setLongCaptureProgress(null);
    }
  }, [bridge, longCaptureProgress, selection]);

  const resetEditorSession = useCallback(() => {
    dispatchCapture({ type: 'sessionReset' });
    setHistory(createEditorHistory());
    setActiveTool('rectangle');
    setTextPosition(null);
    setError(null);
    setServiceResult(null);
    setToast(null);
    setDrawingPreview(null);
    setLongCaptureBounds(null);
    setLongCaptureProgress(null);
    drawingSession.current = null;
    longCaptureSource.current = null;
    serviceSource.current = null;
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

  const runOcr = useCallback(async () => {
    dispatchCapture({ type: 'serviceStarted', service: 'ocr' });
    setError(null);
    try {
      const image = await exportSelection();
      serviceSource.current = image;
      const result = await cozeService.ocr(image);
      setServiceResult({ title: '文字识别', text: result.text, translatable: true });
    } catch (serviceError) {
      setError(errorMessage(serviceError));
    } finally {
      dispatchCapture({ type: 'serviceFinished' });
    }
  }, [cozeService, exportSelection]);

  const runTranslation = useCallback(async (targetLanguage: string) => {
    const image = serviceSource.current;
    if (!image) return;
    dispatchCapture({ type: 'serviceStarted', service: 'translate' });
    setError(null);
    try {
      const result = await cozeService.translate(image, targetLanguage);
      setServiceResult({ title: '翻译结果', text: result.text, translatable: false });
    } catch (serviceError) {
      setError(errorMessage(serviceError));
    } finally {
      dispatchCapture({ type: 'serviceFinished' });
    }
  }, [cozeService]);

  const runPrivacyRedaction = useCallback(async () => {
    if (!selection) return;
    dispatchCapture({ type: 'serviceStarted', service: 'redact' });
    setError(null);
    try {
      const regions = await cozeService.redact(await exportSelection());
      setHistory((current) => regions.reduce((next, region) => addAnnotation(next, {
        id: `annotation-${++annotationSequence.current}`,
        kind: 'mosaic',
        points: [
          { x: selection.x + region.x, y: selection.y + region.y + region.height / 2 },
          { x: selection.x + region.x + region.width, y: selection.y + region.y + region.height / 2 },
        ],
        brushWidth: region.height,
        blockSize: 10,
      }), current));
    } catch (serviceError) {
      setError(errorMessage(serviceError));
    } finally {
      dispatchCapture({ type: 'serviceFinished' });
    }
  }, [cozeService, exportSelection, selection]);

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
      if (action === 'privacy') void runPrivacyRedaction();
      if (action === 'pin') void pinSelection();
      if (action === 'share') void shareSelection();
    },
    [bridge, copyAndClose, pinSelection, runOcr, runPrivacyRedaction, save, shareSelection, startLongCapture],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter') void copyAndClose();
      if (event.key === 'Escape') {
        if (longCaptureProgress || longCaptureCancelInFlight.current) {
          void cancelLongCaptureAndClose();
        } else {
          void bridge.closeOverlay();
        }
      }
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
  }, [bridge, cancelLongCaptureAndClose, copyAndClose, longCaptureProgress, save]);

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
      {captureSession.mode === 'serviceBusy' ? (
        <div className="service-busy" role="status">正在处理…</div>
      ) : null}
      {serviceResult ? (
        <ServiceResult
          title={serviceResult.title}
          text={serviceResult.text}
          onClose={() => setServiceResult(null)}
          {...(serviceResult.translatable ? { onTranslate: runTranslation } : {})}
        />
      ) : null}
      {toast ? <div className="editor-toast" role="status">{toast}</div> : null}
    </main>
  );
}
