import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../bridge/desktop-bridge';
import { PinWindow } from './PinWindow';

describe('PinWindow', () => {
  it('loads pinned pixels, drags from the image, and closes cleanly', async () => {
    const bridge = {
      getPinnedPng: vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' })),
      startWindowDragging: vi.fn().mockResolvedValue(undefined),
      closePinWindow: vi.fn().mockResolvedValue(undefined),
    } as unknown as DesktopBridge;
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:pin') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });

    render(<PinWindow label="pin-7" bridge={bridge} />);

    const image = await screen.findByRole('img', { name: '钉图' });
    expect(image).toHaveAttribute('src', 'blob:pin');
    fireEvent.pointerDown(image);
    expect(bridge.startWindowDragging).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '关闭钉图' }));
    expect(bridge.closePinWindow).toHaveBeenCalledWith('pin-7');
  });
});
