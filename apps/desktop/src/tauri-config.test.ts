import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Tauri overlay configuration', () => {
  it('starts as a hidden, transparent, always-on-top window', () => {
    const config = JSON.parse(
      readFileSync('src-tauri/tauri.conf.json', 'utf8'),
    ) as {
      app: { withGlobalTauri: boolean; windows: Array<Record<string, unknown>> };
    };

    expect(config.app.withGlobalTauri).toBe(true);
    expect(config.app.windows[0]).toMatchObject({
      label: 'overlay',
      visible: false,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
    });
  });

  it('allows every screenshot window to receive native lifecycle events', () => {
    const capability = JSON.parse(
      readFileSync('src-tauri/capabilities/default.json', 'utf8'),
    ) as { windows: string[]; permissions: string[] };

    expect(capability.windows).toContain('*');
    expect(capability.permissions).toContain('core:event:default');
  });
});
