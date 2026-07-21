import { invoke } from '@tauri-apps/api/core';
import { createDefaultBrowserDesktopBridge } from './bridge/browser-desktop-bridge';
import type { DesktopBridge } from './bridge/desktop-bridge';
import { createTauriDesktopBridge } from './bridge/tauri-desktop-bridge';
import { ScreenshotEditor } from './components/ScreenshotEditor';
import './styles.css';

type DesktopEnvironment = Readonly<{ __TAURI_INTERNALS__?: unknown }>;

export function createAppDesktopBridge(
  environment?: DesktopEnvironment,
): DesktopBridge {
  const runtime = environment ?? (window as unknown as DesktopEnvironment);
  return runtime.__TAURI_INTERNALS__ !== undefined
    ? createTauriDesktopBridge(invoke)
    : createDefaultBrowserDesktopBridge();
}

const desktopBridge = createAppDesktopBridge();

export function App() {
  return <ScreenshotEditor sourceUrl="" bridge={desktopBridge} />;
}
