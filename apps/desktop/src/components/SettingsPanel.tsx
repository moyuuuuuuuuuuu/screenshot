import { useState } from 'react';
import type { AppSettings } from '../bridge/desktop-bridge';

const DEFAULT_SHORTCUT = 'Alt+Shift+A';

function shortcutFromEvent(event: React.KeyboardEvent): string | null {
  const key = event.code.startsWith('Key') ? event.code.slice(3) : event.key.toUpperCase();
  if (['CONTROL', 'ALT', 'SHIFT', 'META'].includes(key)) return null;
  const modifiers = [
    event.ctrlKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    event.metaKey ? 'Meta' : '',
  ].filter(Boolean);
  return modifiers.length ? [...modifiers, key].join('+') : null;
}

type SettingsPanelProps = Readonly<{
  initialSettings: AppSettings;
  onSave(settings: AppSettings): Promise<void>;
  onClose(): void;
}>;

export function SettingsPanel({ initialSettings, onSave, onClose }: SettingsPanelProps) {
  const [settings, setSettings] = useState(initialSettings);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      setError(null);
      await onSave(settings);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存设置失败');
    }
  };

  return (
    <section className="settings-panel" aria-label="设置">
      <header>
        <h2>设置</h2>
        <button type="button" aria-label="关闭设置" onClick={onClose}>×</button>
      </header>
      <label>
        <span>截图快捷键</span>
        <button
          type="button"
          className="shortcut-recorder"
          aria-label="录制快捷键"
          onKeyDown={(event) => {
            event.preventDefault();
            const shortcut = shortcutFromEvent(event);
            if (shortcut) setSettings((current) => ({ ...current, shortcut }));
          }}
        >
          {settings.shortcut}
        </button>
      </label>
      <button
        type="button"
        className="settings-link"
        aria-label="恢复默认快捷键"
        onClick={() => setSettings((current) => ({ ...current, shortcut: DEFAULT_SHORTCUT }))}
      >
        恢复默认
      </button>
      <label>
        <span>Coze Token</span>
        <input
          type="password"
          value={settings.coze.token}
          autoComplete="off"
          onChange={(event) => setSettings((current) => ({
            ...current, coze: { ...current.coze, token: event.currentTarget.value },
          }))}
        />
      </label>
      <label>
        <span>Coze Workflow ID</span>
        <input
          value={settings.coze.workflowId}
          onChange={(event) => setSettings((current) => ({
            ...current, coze: { ...current.coze, workflowId: event.currentTarget.value },
          }))}
        />
      </label>
      {error ? <div role="alert">{error}</div> : null}
      <footer>
        <button type="button" onClick={onClose}>取消</button>
        <button type="button" aria-label="保存设置" onClick={() => void save()}>保存</button>
      </footer>
    </section>
  );
}
