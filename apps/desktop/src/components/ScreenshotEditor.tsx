import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '../bridge/desktop-bridge';
import {
  createEditorHistory,
  redo,
  undo,
  type EditorHistory,
} from '../domain/editor-history';
import type { Rect } from '../domain/geometry';
import { SelectionOverlay } from './SelectionOverlay';
import { Toolbar, type Tool, type ToolbarAction } from './Toolbar';

type ScreenshotEditorProps = Readonly<{
  sourceUrl: string;
  bridge: DesktopBridge;
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

export function ScreenshotEditor({ sourceUrl, bridge }: ScreenshotEditorProps) {
  const [selection, setSelection] = useState<Rect | null>(null);
  const [activeTool, setActiveTool] = useState<Tool>('rectangle');
  const [history, setHistory] = useState<EditorHistory>(createEditorHistory);
  const [error, setError] = useState<string | null>(null);
  const sourceImage = useRef<HTMLImageElement>(null);
  const annotationCanvas = useRef<HTMLCanvasElement>(null);

  const exportSelection = useCallback(async () => {
    if (!selection || selection.width <= 0 || selection.height <= 0) {
      throw new Error('No selection');
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
  }, [selection]);

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
      await bridge.savePng(await exportSelection(), screenshotName());
    } catch {
      setError('保存失败，请重试');
    }
  }, [bridge, exportSelection]);

  const handleAction = useCallback(
    (action: ToolbarAction) => {
      if (['rectangle', 'arrow', 'pen', 'text', 'mosaic'].includes(action)) {
        setActiveTool(action as Tool);
        return;
      }
      if (action === 'undo') setHistory((current) => undo(current));
      if (action === 'redo') setHistory((current) => redo(current));
      if (action === 'copy' || action === 'complete') void copyAndClose();
      if (action === 'save') void save();
      if (action === 'cancel') void bridge.closeOverlay();
      if (action === 'ocr' || action === 'translate') {
        setError('云端功能将在后续阶段接入');
      }
    },
    [bridge, copyAndClose, save],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter') void copyAndClose();
      if (event.key === 'Escape') void bridge.closeOverlay();
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
  }, [bridge, copyAndClose, save]);

  const showToolbar = selection && selection.width > 0 && selection.height > 0;
  const toolbarTop = showToolbar
    ? selection.y + selection.height + 10 + 50 > window.innerHeight
      ? Math.max(8, selection.y - 54)
      : selection.y + selection.height + 10
    : 0;

  return (
    <main className="screenshot-editor" aria-label="截图编辑器">
      {sourceUrl ? <img ref={sourceImage} className="screenshot-source" src={sourceUrl} alt="" /> : null}
      <canvas ref={annotationCanvas} className="annotation-canvas" />
      <SelectionOverlay selection={selection} onSelectionChange={setSelection} />
      {showToolbar ? (
        <div
          className="toolbar-positioner"
          style={{ left: Math.max(8, selection.x + selection.width - 570), top: toolbarTop }}
        >
          <Toolbar
            activeTool={activeTool}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            onAction={handleAction}
          />
        </div>
      ) : null}
      {error ? <div className="editor-alert" role="alert">{error}</div> : null}
    </main>
  );
}
