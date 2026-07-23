import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../bridge/desktop-bridge';
import { ScrollCapturePreview } from './ScrollCapturePreview';

const progressFixture = {
  sessionId: 17,
  revision: 3,
  frameCount: 7,
  stitchedHeight: 2400,
  state: 'observing',
  previewPngBytes: [137, 80, 78, 71],
  navigatorPngBytes: [137, 80, 78, 71],
  acceptedBounds: { x: 0, y: 0, width: 420, height: 2400 },
  warning: false,
  slowScrollWarning: false,
} as const;

function bridge(): DesktopBridge {
  return {
    getLongCaptureProgress: vi.fn().mockResolvedValue(progressFixture),
    requestLongCaptureTerminal: vi.fn().mockResolvedValue({
      sessionId: 17,
      action: 'finish',
      status: 'accepted',
    }),
  } as unknown as DesktopBridge;
}

describe('ScrollCapturePreview', () => {
  it('shows a narrow sidecar without an interactive stage over the selection', async () => {
    const desktop = bridge();
    render(<ScrollCapturePreview bridge={desktop} side="right" />);

    expect(await screen.findByRole('img', { name: '累计长截图预览' }))
      .toHaveClass('scroll-sidecar__preview');
    expect(screen.queryByRole('img', { name: '长截图导航' })).not.toBeInTheDocument();
    expect(document.querySelector('.scroll-sidecar__navigator-wrap')).not.toBeInTheDocument();
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

  });

  it('submits the current session and hides after an accepted terminal action', async () => {
    const desktop = bridge();
    desktop.requestLongCaptureTerminal = vi.fn().mockResolvedValue({
      sessionId: 17,
      action: 'finish',
      status: 'accepted',
    });
    const { container } = render(<ScrollCapturePreview bridge={desktop} side="right" />);

    await userEvent.click(await screen.findByRole('button', { name: '完成长截图' }));

    expect(desktop.requestLongCaptureTerminal).toHaveBeenCalledWith(17, 'finish');
    expect(container.querySelector('.scroll-sidecar'))
      .toHaveAttribute('data-terminating', 'true');
  });

  it('keeps terminating feedback when native already accepted another terminal action', async () => {
    const desktop = bridge();
    desktop.requestLongCaptureTerminal = vi.fn().mockResolvedValue({
      sessionId: 17,
      action: 'save',
      status: 'alreadyTerminating',
    });
    const { container } = render(<ScrollCapturePreview bridge={desktop} side="right" />);

    await userEvent.click(await screen.findByRole('button', { name: '取消长截图' }));

    expect(desktop.requestLongCaptureTerminal).toHaveBeenCalledWith(17, 'cancel');
    expect(container.querySelector('.scroll-sidecar'))
      .toHaveAttribute('data-terminating', 'true');
  });

  it.each([
    ['a stale session', { sessionId: 17, action: 'cancel', status: 'stale' } as const],
    ['an invoke rejection', new Error('invoke failed')],
  ])('restores all actions after %s', async (_reason, outcome) => {
    const desktop = bridge();
    desktop.requestLongCaptureTerminal = outcome instanceof Error
      ? vi.fn().mockRejectedValue(outcome)
      : vi.fn().mockResolvedValue(outcome);
    render(<ScrollCapturePreview bridge={desktop} side="right" />);

    await userEvent.click(await screen.findByRole('button', { name: '取消长截图' }));

    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeEnabled();
    }
  });

  it('does not send a terminal action before progress identifies the session', async () => {
    const desktop = bridge();
    desktop.getLongCaptureProgress = vi.fn().mockResolvedValue({
      ...progressFixture,
      sessionId: 0,
    });
    render(<ScrollCapturePreview bridge={desktop} side="right" />);

    await screen.findByRole('toolbar', { name: '长截图操作' });

    expect(screen.getAllByRole('button').every((button) => button.hasAttribute('disabled')))
      .toBe(true);
    expect(desktop.requestLongCaptureTerminal).not.toHaveBeenCalled();
  });

  it('enables actions when the reused sidecar observes a new session', async () => {
    const desktop = bridge();
    desktop.getLongCaptureProgress = vi.fn()
      .mockResolvedValueOnce(progressFixture)
      .mockResolvedValue({
        ...progressFixture,
        sessionId: 18,
        revision: 1,
      });
    desktop.requestLongCaptureTerminal = vi.fn().mockResolvedValue({
      sessionId: 17,
      action: 'finish',
      status: 'accepted',
    });
    const { container } = render(<ScrollCapturePreview bridge={desktop} side="right" />);

    await userEvent.click(await screen.findByRole('button', { name: '完成长截图' }));
    expect(container.querySelector('.scroll-sidecar'))
      .toHaveAttribute('data-terminating', 'true');

    await waitFor(() => {
      for (const button of screen.getAllByRole('button')) {
        expect(button).toBeEnabled();
      }
    });
    expect(container.querySelector('.scroll-sidecar'))
      .toHaveAttribute('data-terminating', 'false');
  });
});
