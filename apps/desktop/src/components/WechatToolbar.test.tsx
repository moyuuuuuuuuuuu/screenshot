import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WechatToolbar } from './WechatToolbar';

const labels = [
  '矩形', '圆形', '表情', '箭头', '画笔', '马赛克', '文字', '隐私工具',
  '文字识别', '滚动截图', '撤销', '保存', '钉住', '转发', '取消', '完成',
];

describe('WechatToolbar', () => {
  it('matches the action order and first-edition Lucide icon contract', () => {
    const { container } = render(
      <WechatToolbar activeAction="rectangle" canUndo={false} onAction={vi.fn()} />,
    );

    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual(labels);
    expect(container.querySelectorAll('svg')).toHaveLength(labels.length);
    for (const icon of container.querySelectorAll('svg')) {
      expect(icon).toHaveAttribute('width', '20');
      expect(icon).toHaveAttribute('height', '20');
      expect(icon).toHaveAttribute('stroke-width', '1.8');
      expect(icon).toHaveClass('lucide');
    }
  });

  it('disables undo without history and dispatches the selected action', async () => {
    const onAction = vi.fn();
    render(<WechatToolbar activeAction="rectangle" canUndo={false} onAction={onAction} />);

    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '滚动截图' }));
    expect(onAction).toHaveBeenCalledWith('long-capture');
  });

  it('anchors drawing options to the active drawing tool', () => {
    render(<WechatToolbar activeAction="pen" canUndo onAction={vi.fn()} />);

    expect(screen.getByRole('group', { name: '画笔选项' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: '画笔粗细' })).toBeInTheDocument();
  });
});
