import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Tauri overlay configuration', () => {
  it('starts as a hidden, input-capable, always-on-top window', () => {
    const config = JSON.parse(
      readFileSync('src-tauri/tauri.conf.json', 'utf8'),
    ) as {
      app: { withGlobalTauri: boolean; windows: Array<Record<string, unknown>> };
    };

    expect(config.app.withGlobalTauri).toBe(true);
    expect(config.app.windows[0]).toMatchObject({
      label: 'overlay',
      visible: false,
      transparent: false,
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

  it('keeps cross-platform bundles while hardening Windows installers', () => {
    const config = JSON.parse(
      readFileSync('src-tauri/tauri.conf.json', 'utf8'),
    ) as {
      bundle: {
        targets: string;
        icon: string[];
        windows: {
          allowDowngrades: boolean;
          webviewInstallMode: {
            type: string;
            silent: boolean;
          };
        };
      };
    };
    const requiredIcons = [
      'icons/32x32.png',
      'icons/128x128.png',
      'icons/128x128@2x.png',
      'icons/icon.icns',
      'icons/icon.ico',
    ];

    expect(config.bundle.targets).toBe('all');
    expect(config.bundle.icon).toEqual(requiredIcons);
    expect(config.bundle.windows).toMatchObject({
      allowDowngrades: false,
      webviewInstallMode: {
        type: 'downloadBootstrapper',
        silent: true,
      },
    });

    for (const icon of requiredIcons) {
      expect(existsSync(`src-tauri/${icon}`), icon).toBe(true);
    }
  });

  it('limits both Windows release builds to MSI and NSIS bundles', () => {
    const workflow = readFileSync(
      '../../.github/workflows/windows-release.yml',
      'utf8',
    );

    expect(workflow).toContain(
      'args: --debug --bundles msi,nsis --no-sign',
    );
    expect(workflow).toContain(
      'args: --bundles msi,nsis --config "${{ runner.temp }}/tauri-signing.conf.json"',
    );
  });
});
