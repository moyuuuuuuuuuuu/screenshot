import { useEffect, useState } from 'react';
import type { DesktopBridge } from '../bridge/desktop-bridge';

type PinWindowProps = Readonly<{
  label: string;
  bridge: DesktopBridge;
}>;

export function PinWindow({ label, bridge }: PinWindowProps) {
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl = '';
    let disposed = false;
    void bridge.getPinnedPng(label).then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setSource(objectUrl);
    }).catch((loadError: unknown) => {
      if (!disposed) setError(loadError instanceof Error ? loadError.message : '钉图加载失败');
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bridge, label]);

  return (
    <main className="pin-window">
      {source ? (
        <img
          src={source}
          alt="钉图"
          draggable={false}
          onPointerDown={() => void bridge.startWindowDragging()}
        />
      ) : null}
      {error ? <div role="alert">{error}</div> : null}
      <button type="button" aria-label="关闭钉图" onClick={() => void bridge.closePinWindow(label)}>×</button>
    </main>
  );
}
