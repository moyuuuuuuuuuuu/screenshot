import { AlertTriangle, Square, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DesktopBridge, LongCaptureProgress } from '../bridge/desktop-bridge';

type Props = Readonly<{ bridge: DesktopBridge }>;

function previewDataUrl(bytes: readonly number[]): string {
  if (bytes.length === 0) return '';
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

export function LongCaptureControls({ bridge }: Props) {
  const [progress, setProgress] = useState<LongCaptureProgress | null>(null);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      void bridge.getLongCaptureProgress()
        .then((next) => { if (!disposed) setProgress(next); })
        .catch(() => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 120);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [bridge]);

  const preview = useMemo(
    () => previewDataUrl(progress?.previewPngBytes ?? []),
    [progress?.previewPngBytes],
  );

  return (
    <main className={`long-capture-controls${progress?.warning ? ' long-capture-controls--warning' : ''}`}>
      <div className="long-capture-controls__preview" role="img" aria-label="长截图预览">
        {preview ? <img src={preview} alt="" aria-hidden="true" /> : null}
        {progress?.warning ? (
          <span className="long-capture-controls__warning" role="status" aria-label="滚动方向提示">
            <AlertTriangle aria-hidden="true" strokeWidth={1.8} />
          </span>
        ) : null}
      </div>
      <div className="long-capture-controls__actions">
        <button
          className="long-capture-controls__button long-capture-controls__button--stop"
          type="button"
          aria-label="完成长截图"
          title="完成长截图"
          onClick={() => void bridge.stopLongCapture()}
        >
          <Square aria-hidden="true" strokeWidth={1.8} />
        </button>
        <button
          className="long-capture-controls__button long-capture-controls__button--cancel"
          type="button"
          aria-label="取消长截图"
          title="取消长截图"
          onClick={() => void bridge.cancelLongCapture()}
        >
          <X aria-hidden="true" strokeWidth={1.8} />
        </button>
      </div>
    </main>
  );
}
