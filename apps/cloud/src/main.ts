import { pathToFileURL } from 'node:url';

import type { CloudProviderEnvironment, ServerOptions } from './server.js';
import { buildServer } from './server.js';

const defaultHost = '127.0.0.1';
const defaultPort = 3000;
const startupErrorMessage = 'Cloud server failed to start.';

export type CloudRuntimeEnvironment = CloudProviderEnvironment &
  Readonly<{
    REQUEST_SIGNING_SECRET?: string;
    HOST?: string;
    PORT?: string;
  }>;

export type CloudRuntimeConfiguration = Readonly<{
  serverOptions: ServerOptions;
  listenOptions: Readonly<{
    host: string;
    port: number;
  }>;
}>;

export type RuntimeLauncher = (
  configuration: CloudRuntimeConfiguration,
) => Promise<void>;

export type CloudMainOptions = Readonly<{
  environment?: CloudRuntimeEnvironment;
  launch?: RuntimeLauncher;
  writeError?: (message: string) => void;
  setExitCode?: (code: number) => void;
}>;

export function readCloudRuntimeConfiguration(
  environment: CloudRuntimeEnvironment,
): CloudRuntimeConfiguration {
  const host = environment.HOST?.trim() || defaultHost;
  const rawPort = environment.PORT?.trim() || String(defaultPort);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('PORT must be an integer between 0 and 65535.');
  }

  return {
    serverOptions: {
      signingSecret: environment.REQUEST_SIGNING_SECRET ?? '',
      environment,
    },
    listenOptions: { host, port },
  };
}

export async function startCloudServer(
  environment: CloudRuntimeEnvironment = process.env,
  launch: RuntimeLauncher = launchFastifyServer,
): Promise<void> {
  await launch(readCloudRuntimeConfiguration(environment));
}

export async function runCloudMain(options: CloudMainOptions = {}): Promise<void> {
  try {
    await startCloudServer(
      options.environment ?? process.env,
      options.launch ?? launchFastifyServer,
    );
  } catch {
    (options.writeError ?? writeStartupError)(startupErrorMessage);
    (options.setExitCode ?? setProcessExitCode)(1);
  }
}

async function launchFastifyServer(
  configuration: CloudRuntimeConfiguration,
): Promise<void> {
  const app = buildServer(configuration.serverOptions);
  await app.listen(configuration.listenOptions);
}

function writeStartupError(message: string): void {
  console.error(message);
}

function setProcessExitCode(code: number): void {
  process.exitCode = code;
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  pathToFileURL(executedPath).href === import.meta.url
) {
  void runCloudMain();
}
