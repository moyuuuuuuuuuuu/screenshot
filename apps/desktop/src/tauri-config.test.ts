import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function workflowSection(
  workflow: string,
  start: string,
  end?: string,
): string {
  const startIndex = workflow.indexOf(start);
  expect(startIndex, `missing workflow section: ${start}`).toBeGreaterThanOrEqual(
    0,
  );
  const endIndex =
    end === undefined ? workflow.length : workflow.indexOf(end, startIndex + 1);
  expect(endIndex, `missing workflow section boundary: ${end}`).toBeGreaterThan(
    startIndex,
  );
  return workflow.slice(startIndex, endIndex);
}

describe('Tauri overlay configuration', () => {
  it('starts as a hidden, input-capable, always-on-top window', () => {
    const config = JSON.parse(
      readFileSync('src-tauri/tauri.conf.json', 'utf8'),
    ) as {
      build: { devUrl: string };
      app: { withGlobalTauri: boolean; windows: Array<Record<string, unknown>> };
    };

    expect(config.build.devUrl).toBe('http://127.0.0.1:43127');
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
          wix: {
            language: string;
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
      wix: {
        language: 'zh-CN',
      },
    });

    for (const icon of requiredIcons) {
      expect(existsSync(`src-tauri/${icon}`), icon).toBe(true);
    }
  });

  it('keeps Windows release artifacts distinct and least-privileged', () => {
    const workflow = readFileSync(
      '../../.github/workflows/windows-release.yml',
      'utf8',
    );
    const unsignedJob = workflowSection(
      workflow,
      '  unsigned:',
      '\n  signing-secrets:',
    );
    const signingSecretsJob = workflowSection(
      workflow,
      '  signing-secrets:',
      '\n  signed:',
    );
    const signedJob = workflowSection(workflow, '  signed:');

    expect(workflow).toMatch(/\npermissions:\n  contents: read\n/);
    expect(unsignedJob).toContain(
      'args: --debug --bundles msi,nsis --no-sign',
    );
    expect(unsignedJob).toContain('name: windows-unsigned-debug');
    expect(unsignedJob).toContain(
      'apps/desktop/src-tauri/target/debug/bundle/msi/*.msi',
    );
    expect(unsignedJob).toContain(
      'apps/desktop/src-tauri/target/debug/bundle/nsis/*-setup.exe',
    );
    expect(signingSecretsJob).toContain('permissions: {}');
    for (const secret of [
      'WINDOWS_CERTIFICATE',
      'WINDOWS_CERTIFICATE_PASSWORD',
      'WINDOWS_CERTIFICATE_THUMBPRINT',
    ]) {
      expect(signingSecretsJob).toContain(
        `${secret}: \${{ secrets.${secret} }}`,
      );
      expect(signingSecretsJob).toContain(
        `[string]::IsNullOrWhiteSpace($env:${secret})`,
      );
    }
    expect(signedJob).toContain(
      "if: needs.signing-secrets.outputs.available == 'true'",
    );
    expect(signedJob).toContain(
      'args: --bundles msi,nsis --config "${{ runner.temp }}/tauri-signing.conf.json"',
    );
    expect(signedJob).not.toContain('--no-sign');
    expect(signedJob).toContain('name: windows-signed-release');
    expect(signedJob).toContain(
      'apps/desktop/src-tauri/target/release/bundle/msi/*.msi',
    );
    expect(signedJob).toContain(
      'apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe',
    );
    expect(signedJob).toMatch(
      /- name: Remove signing material\s+if: always\(\)/,
    );
  });

  it('can clean certificates after a partially successful PFX import', () => {
    const workflow = readFileSync(
      '../../.github/workflows/windows-release.yml',
      'utf8',
    );
    const importStep = workflowSection(
      workflow,
      '      - name: Import signing certificate and generate runtime config',
      '\n      - name: Build signed release installers',
    );
    const cleanupStep = workflowSection(
      workflow,
      '      - name: Remove signing material',
    );

    expect(importStep).toContain('$ErrorActionPreference = "Stop"');
    expect(importStep).toContain('certificate-store-before-import.txt');
    expect(importStep.indexOf('[IO.File]::WriteAllLines')).toBeLessThan(
      importStep.indexOf('Import-PfxCertificate'),
    );
    expect(cleanupStep).toContain('$ErrorActionPreference = "Stop"');
    expect(cleanupStep).toContain('certificate-store-before-import.txt');
    expect(cleanupStep).toContain('Get-ChildItem Cert:\\CurrentUser\\My');
    expect(cleanupStep).toContain('-notcontains');
    expect(cleanupStep).toContain('Remove-Item -LiteralPath');
    expect(cleanupStep).toContain('-ErrorAction Stop');
    expect(cleanupStep).toContain('$cleanupFailures');
    expect(cleanupStep).toContain('throw "Failed to remove signing material."');
  });
});
