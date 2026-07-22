import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from './bridge/desktop-bridge';
import type { AppSettings } from './bridge/desktop-bridge';
import { createTauriDesktopBridge } from './bridge/tauri-desktop-bridge';
import { ScreenshotEditor } from './components/ScreenshotEditor';
import { ScrollCapturePreview } from './components/ScrollCapturePreview';
import { SettingsPanel } from './components/SettingsPanel';
import { PinWindow } from './components/PinWindow';
import './styles.css';

type MonitorFrame = Readonly<{
  pngBase64: string;
}>;

type CaptureSessionPayload = Readonly<{
  sessionId: number;
}>;

type CaptureReadyPayload = Readonly<{
  sessionId: number;
  frames: readonly MonitorFrame[];
}>;

export function captureFrameSource(frames: readonly MonitorFrame[]): string {
  const first = frames[0];
  return first ? `data:image/png;base64,${first.pngBase64}` : '';
}

export function createAppDesktopBridge(): DesktopBridge {
  return createTauriDesktopBridge(invoke);
}

const desktopBridge = createAppDesktopBridge();

export function App() {
  const windowParameters = new URLSearchParams(window.location.search);
  const windowKind = windowParameters.get('window');
  const controlWindow = windowKind === 'scroll-capture-preview';
  const borderWindow = windowKind === 'scroll-border';
  const pinLabel = windowKind === 'pin' ? windowParameters.get('label') : null;
  const [sourceUrl, setSourceUrl] = useState('');
  const [session, setSession] = useState(0);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const latestSessionId = useRef(0);

  useEffect(() => {
    const unlistenCallbacks: Array<() => void> = [];
    let disposed = false;
    const retainUnlisten = (unlisten: () => void) => {
      if (disposed) unlisten();
      else unlistenCallbacks.push(unlisten);
    };

    void listen<CaptureReadyPayload>('capture-ready', (event) => {
      if (event.payload.sessionId < latestSessionId.current) return;
      latestSessionId.current = event.payload.sessionId;
      setCaptureError(null);
      setSourceUrl(captureFrameSource(event.payload.frames));
      setSession((current) => current + 1);
    }).then(retainUnlisten).catch(() => undefined);
    void listen<CaptureSessionPayload>('capture-started', (event) => {
      if (event.payload.sessionId <= latestSessionId.current) return;
      latestSessionId.current = event.payload.sessionId;
      setCaptureError(null);
      setSourceUrl('');
      setSession((current) => current + 1);
    }).then(retainUnlisten).catch(() => undefined);
    void listen<CaptureSessionPayload>('capture-session-reset', (event) => {
      if (event.payload.sessionId !== latestSessionId.current) return;
      setCaptureError(null);
      setSourceUrl('');
      setSession((current) => current + 1);
    }).then(retainUnlisten).catch(() => undefined);
    void listen<string>('capture-error', (event) => {
      setCaptureError(event.payload);
    }).then(retainUnlisten).catch(() => undefined);
    void listen<boolean>('long-capture-presentation', (event) => {
      document.documentElement.classList.toggle('long-capture-presentation', event.payload);
    }).then(retainUnlisten).catch(() => undefined);
    void listen('settings-requested', () => {
      void desktopBridge.loadSettings().then(setSettings).catch((error: unknown) => {
        setCaptureError(error instanceof Error ? error.message : '无法读取设置');
      });
    }).then(retainUnlisten).catch(() => undefined);

    return () => {
      disposed = true;
      document.documentElement.classList.remove('long-capture-presentation');
      unlistenCallbacks.forEach((unlisten) => unlisten());
    };
  }, []);

  if (borderWindow) return <div className="scroll-capture-border" aria-hidden="true" />;
  if (controlWindow) return <ScrollCapturePreview bridge={desktopBridge}
    side={windowParameters.get('side') === 'left' ? 'left' : 'right'} />;
  if (pinLabel) return <PinWindow label={pinLabel} bridge={desktopBridge} />;

  return (
    <>
      <ScreenshotEditor
        key={session}
        sourceUrl={sourceUrl}
        bridge={desktopBridge}
      />
      {settings ? (
        <SettingsPanel
          initialSettings={settings}
          onClose={() => setSettings(null)}
          onSave={async (nextSettings) => {
            setSettings(await desktopBridge.updateSettings(nextSettings));
          }}
        />
      ) : null}
      {captureError ? <div className="capture-error" role="alert">{captureError}</div> : null}
    </>
  );
}
