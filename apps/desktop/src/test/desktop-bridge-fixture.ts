import type { DesktopBridge } from '../bridge/desktop-bridge';

export function createDesktopBridgeFixture(): DesktopBridge {
  return {
    async copyPng() {},
    async savePng() { return null; },
    async closeOverlay() {},
    async startLongCapture() {
      return {
        png: new Blob([], { type: 'image/png' }),
        partial: false,
        action: 'edit',
      };
    },
    async requestLongCaptureTerminal(sessionId, action) {
      return { sessionId, action, status: 'accepted' };
    },
    async getLongCaptureProgress() {
      return {
        sessionId: 0,
        revision: 0,
        frameCount: 0,
        stitchedHeight: 0,
        state: 'preparing',
        previewPngBytes: [],
        navigatorPngBytes: [],
        acceptedBounds: null,
        warning: false,
        slowScrollWarning: false,
      };
    },
    async getCloudDeviceId() {
      return '123e4567-e89b-42d3-a456-426614174000';
    },
    async loadSettings() {
      return { shortcut: 'Alt+Shift+A', cloudPrivacyAcknowledged: false };
    },
    async updateShortcut(shortcut) {
      return { shortcut, cloudPrivacyAcknowledged: false };
    },
    async updateCloudPrivacyAcknowledgement(cloudPrivacyAcknowledged) {
      return { shortcut: 'Alt+Shift+A', cloudPrivacyAcknowledged };
    },
    async pinPng() { return 'pin-test'; },
    async sharePng() { return 'copiedFallback'; },
    async getPinnedPng() { return new Blob([], { type: 'image/png' }); },
    async startWindowDragging() {},
    async closePinWindow() {},
  } satisfies DesktopBridge;
}
