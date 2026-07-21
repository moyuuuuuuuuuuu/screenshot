import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Toolbar } from './Toolbar';

describe('Toolbar', () => {
  it('renders icon-only actions with accessible names', () => {
    render(
      <Toolbar
        activeTool="rectangle"
        canUndo={false}
        canRedo={false}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '矩形' })).toHaveAttribute(
      'title',
      '矩形',
    );
    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '长截图' })).toHaveAttribute(
      'title',
      '长截图',
    );
    expect(screen.queryByText('矩形')).not.toBeInTheDocument();
  });

  it('uses the selected state only for the active drawing tool', () => {
    render(
      <Toolbar
        activeTool="mosaic"
        canUndo
        canRedo
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '马赛克' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '矩形' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
