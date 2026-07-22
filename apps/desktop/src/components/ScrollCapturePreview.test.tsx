import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../bridge/desktop-bridge';
import { ScrollCapturePreview } from './ScrollCapturePreview';

function bridge(): DesktopBridge {
  return {
    getLongCaptureProgress: vi.fn().mockResolvedValue({
      frameCount: 7,
      stitchedHeight: 2400,
      state: 'observing',
      previewPngBytes: [137, 80, 78, 71],
      navigatorPngBytes: [137, 80, 78, 71],
      acceptedBounds: { x: 0, y: 0, width: 420, height: 2400 },
      warning: false,
      slowScrollWarning: false,
    }),
    editLongCapture: vi.fn(), saveLongCapture: vi.fn(), cancelLongCapture: vi.fn(),
    finishLongCapture: vi.fn(),
  } as unknown as DesktopBridge;
}

describe('ScrollCapturePreview', () => {
  it('shows a narrow sidecar without an interactive stage over the selection', async () => {
    const desktop = bridge();
    render(<ScrollCapturePreview bridge={desktop} side="right" />);

    expect(await screen.findByRole('img', { name: '累计长截图预览' }))
      .toHaveClass('scroll-sidecar__preview');
    expect(screen.getByRole('img', { name: '长截图导航' }))
      .toHaveClass('scroll-sidecar__navigator');
    expect(screen.getByRole('toolbar', { name: '长截图操作' }))
      .toHaveClass('scroll-sidecar__actions');
    expect(document.querySelector('.scroll-preview__stage')).not.toBeInTheDocument();
    expect(document.querySelector('.scroll-sidecar')).toHaveAttribute('data-side', 'right');
    expect(screen.queryByText(/2400|7 帧/)).not.toBeInTheDocument();
    for (const icon of document.querySelectorAll('.scroll-sidecar__actions svg')) {
      expect(icon).toHaveAttribute('width', '20');
      expect(icon).toHaveAttribute('height', '20');
      expect(icon).toHaveAttribute('stroke-width', '1.8');
      expect(icon).toHaveClass('lucide');
    }

    for (const [name, method] of [
      ['编辑长截图', desktop.editLongCapture],
      ['保存长截图', desktop.saveLongCapture],
      ['取消长截图', desktop.cancelLongCapture],
      ['完成长截图', desktop.finishLongCapture],
    ] as const) {
      await userEvent.click(screen.getByRole('button', { name }));
      expect(method).toHaveBeenCalledOnce();
    }
  });
});
