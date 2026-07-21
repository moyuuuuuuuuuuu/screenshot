import type { DesktopBridge } from './desktop-bridge';

export type TauriInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

async function blobBytes(blob: Blob): Promise<number[]> {
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read PNG blob'));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('PNG blob did not produce binary data'));
    };
    reader.readAsArrayBuffer(blob);
  });
  return Array.from(new Uint8Array(buffer));
}

export function createTauriDesktopBridge(invoke: TauriInvoke): DesktopBridge {
  return {
    async copyPng(blob) {
      await invoke('copy_png', { pngBytes: await blobBytes(blob) });
    },
    async savePng(blob, suggestedName) {
      const result = await invoke('save_png', {
        pngBytes: await blobBytes(blob),
        suggestedName,
      });
      if (result === null || typeof result === 'string') return result;
      throw new Error('save_png returned an invalid path');
    },
    async closeOverlay() {
      await invoke('close_overlay');
    },
  };
}
