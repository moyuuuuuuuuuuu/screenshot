import { useEffect, useMemo, useState } from 'react';
import type { DesktopBridge, LongCaptureProgress } from '../bridge/desktop-bridge';
import { CancelIcon, CompleteIcon, PenIcon, SaveIcon } from './icons/WechatIcons';

function dataUrl(bytes: readonly number[]): string {
  if (!bytes.length) return '';
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

type Props = Readonly<{ bridge: DesktopBridge; side: 'left' | 'right' }>;

export function ScrollCapturePreview({ bridge, side }: Props) {
  const [progress, setProgress] = useState<LongCaptureProgress | null>(null);
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
  const navigator = useMemo(() => dataUrl(progress?.navigatorPngBytes ?? []), [progress?.navigatorPngBytes]);
  const actions = [
    { label: '编辑长截图', Icon: PenIcon, action: bridge.editLongCapture },
    { label: '保存长截图', Icon: SaveIcon, action: bridge.saveLongCapture },
    { label: '取消长截图', Icon: CancelIcon, action: bridge.cancelLongCapture },
    { label: '完成长截图', Icon: CompleteIcon, action: bridge.finishLongCapture },
  ] as const;
  return (
    <main className="scroll-preview" data-side={side}>
      <div className="scroll-preview__stage">
        {preview ? <img className="scroll-preview__image" src={preview} alt="累计长截图预览" /> : null}
        <span className="scroll-preview__prompt">滚动页面截取更多内容</span>
      </div>
      <div className="scroll-preview__rail">
        {navigator ? <img className="scroll-preview__navigator" src={navigator} alt="长截图导航" /> : null}
      </div>
      {progress?.slowScrollWarning ? <div className="scroll-preview__warning" role="status">请慢一点滚动</div> : null}
      <div className="scroll-preview__actions" role="toolbar" aria-label="长截图操作">
        {actions.map(({ label, Icon, action }) => (
          <button key={label} type="button" aria-label={label}
            onClick={() => void action()}>
            <Icon />
          </button>
        ))}
      </div>
    </main>
  );
}
