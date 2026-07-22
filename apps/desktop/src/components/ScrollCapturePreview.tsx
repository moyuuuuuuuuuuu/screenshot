import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, PenLine, Save, X } from 'lucide-react';
import type { DesktopBridge, LongCaptureProgress } from '../bridge/desktop-bridge';

function dataUrl(bytes: readonly number[]): string {
  if (!bytes.length) return '';
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

type Props = Readonly<{ bridge: DesktopBridge; side: 'left' | 'right' }>;

export function ScrollCapturePreview({ bridge, side }: Props) {
  const [progress, setProgress] = useState<LongCaptureProgress | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const submittedRef = useRef(false);
  useEffect(() => {
    let disposed = false;
    const refresh = () => void bridge.getLongCaptureProgress()
      .then((value) => { if (!disposed) setProgress(value); })
      .catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 120);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [bridge]);
  const preview = useMemo(() => dataUrl(progress?.previewPngBytes ?? []), [progress?.previewPngBytes]);
  const actions = [
    { label: '编辑长截图', Icon: PenLine, action: bridge.editLongCapture },
    { label: '保存长截图', Icon: Save, action: bridge.saveLongCapture },
    { label: '取消长截图', Icon: X, action: bridge.cancelLongCapture },
    { label: '完成长截图', Icon: Check, action: bridge.finishLongCapture },
  ] as const;
  const submit = async (action: () => Promise<void>) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setSubmitted(true);
    try {
      await action();
    } catch {
      submittedRef.current = false;
      setSubmitted(false);
    }
  };
  return (
    <main className="scroll-sidecar" data-side={side}>
      <div className="scroll-sidecar__preview-wrap">
        {preview ? <img className="scroll-sidecar__preview" src={preview} alt="累计长截图预览" /> : null}
        <span className="scroll-sidecar__prompt">滚动页面截取更多内容</span>
      </div>
      {progress?.slowScrollWarning ? <div className="scroll-sidecar__warning" role="status">请慢一点滚动</div> : null}
      <div className="scroll-sidecar__actions" role="toolbar" aria-label="长截图操作">
        {actions.map(({ label, Icon, action }) => (
          <button key={label} type="button" aria-label={label} disabled={submitted}
            onClick={() => void submit(action)}>
            <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
          </button>
        ))}
      </div>
    </main>
  );
}
