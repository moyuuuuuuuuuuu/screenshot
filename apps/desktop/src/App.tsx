import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';
import { createDefaultBrowserDesktopBridge } from './bridge/browser-desktop-bridge';
import type { DesktopBridge } from './bridge/desktop-bridge';
import { createTauriDesktopBridge } from './bridge/tauri-desktop-bridge';
import { ScreenshotEditor } from './components/ScreenshotEditor';
import './styles.css';

type MonitorFrame = Readonly<{
  pngBase64: string;
}>;

export function captureFrameSource(frames: readonly MonitorFrame[]): string {
  const first = frames[0];
  return first ? `data:image/png;base64,${first.pngBase64}` : '';
}

export function createAppDesktopBridge(
  runtimeIsTauri = isTauri(),
): DesktopBridge {
  return runtimeIsTauri
    ? createTauriDesktopBridge(invoke)
    : createDefaultBrowserDesktopBridge();
}

const desktopBridge = createAppDesktopBridge();

export function App() {
  const [sourceUrl, setSourceUrl] = useState('');
  const [session, setSession] = useState(0);
  const [captureError, setCaptureError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    const unlistenCallbacks: Array<() => void> = [];
    let disposed = false;
    const retainUnlisten = (unlisten: () => void) => {
      if (disposed) unlisten();
      else unlistenCallbacks.push(unlisten);
    };

    void listen<MonitorFrame[]>('capture-ready', (event) => {
      setCaptureError(null);
      setSourceUrl(captureFrameSource(event.payload));
      setSession((current) => current + 1);
    }).then(retainUnlisten);
    void listen<string>('capture-error', (event) => {
      setCaptureError(event.payload);
    }).then(retainUnlisten);

    return () => {
      disposed = true;
      unlistenCallbacks.forEach((unlisten) => unlisten());
    };
  }, []);

  return (
    <>
      <ScreenshotEditor
        key={session}
        sourceUrl={sourceUrl}
        bridge={desktopBridge}
      />
      {captureError ? <div className="capture-error" role="alert">{captureError}</div> : null}
    </>
  );
}
