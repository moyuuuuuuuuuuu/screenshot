import { createDefaultBrowserDesktopBridge } from './bridge/browser-desktop-bridge';
import { ScreenshotEditor } from './components/ScreenshotEditor';
import './styles.css';

const browserBridge = createDefaultBrowserDesktopBridge();

export function App() {
  return <ScreenshotEditor sourceUrl="" bridge={browserBridge} />;
}
