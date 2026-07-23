import { describe, expect, it, vi } from 'vitest';

import {
  readCloudRuntimeConfiguration,
  runCloudMain,
  startCloudServer,
  type CloudRuntimeEnvironment,
  type RuntimeLauncher,
} from './main.js';

const developmentEnvironment: CloudRuntimeEnvironment = {
  NODE_ENV: 'development',
  CLOUD_PROVIDER: 'mock',
  REQUEST_SIGNING_SECRET: 'server-only-signing-secret',
};

describe('cloud runtime configuration', () => {
  it('defaults to 127.0.0.1:3000 and passes server environment through', () => {
    const configuration = readCloudRuntimeConfiguration(developmentEnvironment);

    expect(configuration.listenOptions).toEqual({
      host: '127.0.0.1',
      port: 3000,
    });
    expect(configuration.serverOptions).toEqual({
      signingSecret: 'server-only-signing-secret',
      environment: developmentEnvironment,
    });
  });

  it('reads trimmed HOST and PORT values', () => {
    const environment: CloudRuntimeEnvironment = {
      ...developmentEnvironment,
      HOST: ' 0.0.0.0 ',
      PORT: ' 8080 ',
    };

    expect(readCloudRuntimeConfiguration(environment).listenOptions).toEqual({
      host: '0.0.0.0',
      port: 8080,
    });
  });

  it.each(['not-a-number', '12.5', '-1', '65536'])(
    'rejects invalid PORT value %s',
    (port) => {
      expect(() =>
        readCloudRuntimeConfiguration({
          ...developmentEnvironment,
          PORT: port,
        }),
      ).toThrow('PORT must be an integer between 0 and 65535.');
    },
  );
});

describe('cloud runtime startup', () => {
  it('passes configuration to an injected launcher without binding a port', async () => {
    const launch = vi.fn<RuntimeLauncher>(async () => undefined);

    await startCloudServer(developmentEnvironment, launch);

    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith({
      serverOptions: {
        signingSecret: 'server-only-signing-secret',
        environment: developmentEnvironment,
      },
      listenOptions: {
        host: '127.0.0.1',
        port: 3000,
      },
    });
  });

  it('redacts startup failures and sets a nonzero exit code', async () => {
    const rawFailure =
      'server-only-coze-token private OCR text https://debug.example/private';
    const writeError = vi.fn<(message: string) => void>();
    const setExitCode = vi.fn<(code: number) => void>();

    await runCloudMain({
      environment: developmentEnvironment,
      launch: async () => {
        throw new Error(rawFailure);
      },
      writeError,
      setExitCode,
    });

    expect(writeError).toHaveBeenCalledWith('Cloud server failed to start.');
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(JSON.stringify(writeError.mock.calls)).not.toContain(rawFailure);
  });
});
