export interface DesktopBridge {
  copyPng(blob: Blob): Promise<void>;
  savePng(blob: Blob, suggestedName: string): Promise<string | null>;
  closeOverlay(): Promise<void>;
}
