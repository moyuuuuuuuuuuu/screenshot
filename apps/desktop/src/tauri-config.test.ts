import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Tauri overlay configuration', () => {
  it('starts as a hidden, transparent, always-on-top window', () => {
    const config = JSON.parse(
      readFileSync('src-tauri/tauri.conf.json', 'utf8'),
    ) as {
      app: { windows: Array<Record<string, unknown>> };
    };

    expect(config.app.windows[0]).toMatchObject({
      label: 'overlay',
      visible: false,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
    });
  });
});
