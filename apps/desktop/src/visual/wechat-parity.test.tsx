import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopBridge, LongCaptureProgress } from '../bridge/desktop-bridge';
import { ScrollCapturePreview } from '../components/ScrollCapturePreview';
import { WechatToolbar } from '../components/WechatToolbar';
import { WECHAT_REFERENCE_METRICS } from './wechat-reference-metrics';

function previewBridge(progress: LongCaptureProgress): DesktopBridge {
  return {
    getLongCaptureProgress: vi.fn().mockResolvedValue(progress),
    requestLongCaptureTerminal: vi.fn().mockResolvedValue({
      sessionId: progress.sessionId,
      action: 'cancel',
      status: 'accepted',
    }),
  } as unknown as DesktopBridge;
}

const baseProgress: LongCaptureProgress = {
  sessionId: 1,
  revision: 1,
  frameCount: 1,
  stitchedHeight: 720,
  state: 'observing',
  previewPngBytes: [],
  navigatorPngBytes: [],
  acceptedBounds: { x: 0, y: 0, width: 420, height: 720 },
  warning: false,
  slowScrollWarning: false,
};

describe('WeChat 4.1.11 visual parity contract', () => {
  it('locks the measured ordinary toolbar and selection metrics', () => {
    const { container } = render(
      <WechatToolbar activeAction="rectangle" canUndo={false} onAction={vi.fn()} />,
    );

    expect(WECHAT_REFERENCE_METRICS).toMatchObject({
      accent: '#07c160',
      selectionHandle: 6,
      overlayMaskAlpha: 0.3,
      toolbar: { button: 28, icon: 20, gap: 2, radius: 8, stroke: 1.8 },
    });
    expect(container.querySelectorAll('.wechat-toolbar__button')).toHaveLength(15);
    expect(container.querySelectorAll('svg.lucide[stroke-width="1.8"]')).toHaveLength(15);
  });

  it('keeps the initial scrolling state free of counters and empty image placeholders', async () => {
    const { container } = render(
      <ScrollCapturePreview bridge={previewBridge(baseProgress)} side="right" />,
    );

    expect(await screen.findByText('滚动页面截取更多内容')).toBeInTheDocument();
    expect(container.querySelector('.scroll-preview__image')).not.toBeInTheDocument();
    expect(container.querySelector('.scroll-preview__navigator')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent(/\d+\s*(帧|px|像素)/i);
  });

  it('locks the grown scrolling preview geometry and icon-only actions', async () => {
    const progress = {
      ...baseProgress,
      frameCount: 5,
      stitchedHeight: 2680,
      previewPngBytes: [137, 80, 78, 71],
      navigatorPngBytes: [137, 80, 78, 71],
    };
    const { container } = render(
      <ScrollCapturePreview bridge={previewBridge(progress)} side="left" />,
    );

    expect(await screen.findByRole('img', { name: '累计长截图预览' })).toBeInTheDocument();
    expect(WECHAT_REFERENCE_METRICS.scrollPreview).toEqual({
      desiredWidth: 172,
      minimumWidth: 120,
      gap: 6,
      action: 34,
      actionGap: 4,
      edgeAnchor: 6,
    });
    expect(container.querySelector('.scroll-sidecar')).toHaveAttribute('data-side', 'left');
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(container).not.toHaveTextContent(/\d+\s*(帧|px|像素)/i);
  });
});
