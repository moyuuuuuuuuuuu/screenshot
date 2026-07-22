import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../bridge/desktop-bridge';
import { LongCaptureControls } from './LongCaptureControls';

function bridge(): DesktopBridge {
  return {
    copyPng: vi.fn(),
    savePng: vi.fn(),
    closeOverlay: vi.fn(),
    startLongCapture: vi.fn(),
    stopLongCapture: vi.fn(),
    cancelLongCapture: vi.fn(),
    getLongCaptureProgress: vi.fn().mockResolvedValue({
      frameCount: 3,
      stitchedHeight: 1240,
      state: 'observing',
      previewPngBytes: [137, 80, 78, 71],
      warning: false,
    }),
  };
}

describe('LongCaptureControls', () => {
  it('renders an image preview and icon-only 36px stop/cancel controls', async () => {
    const desktop = bridge();
    render(<LongCaptureControls bridge={desktop} />);

    expect(await screen.findByRole('img', { name: '长截图预览' })).toBeInTheDocument();
    const stop = screen.getByRole('button', { name: '完成长截图' });
    const cancel = screen.getByRole('button', { name: '取消长截图' });
    expect(stop).toHaveClass('long-capture-controls__button');
    expect(cancel).toHaveClass('long-capture-controls__button');
    expect(stop).not.toHaveTextContent(/\S/);
    expect(cancel).not.toHaveTextContent(/\S/);

    await userEvent.click(stop);
    await userEvent.click(cancel);
    expect(desktop.stopLongCapture).toHaveBeenCalledOnce();
    expect(desktop.cancelLongCapture).toHaveBeenCalledOnce();
  });

  it('shows a warning icon when reverse or unmatched content is detected', async () => {
    const desktop = bridge();
    vi.mocked(desktop.getLongCaptureProgress).mockResolvedValue({
      frameCount: 2,
      stitchedHeight: 900,
      state: 'pausedReverse',
      previewPngBytes: [],
      warning: true,
    });
    render(<LongCaptureControls bridge={desktop} />);

    await waitFor(() => expect(screen.getByRole('status', { name: '滚动方向提示' })).toBeInTheDocument());
  });
});
