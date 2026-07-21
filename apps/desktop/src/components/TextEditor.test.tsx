import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TextEditor } from './TextEditor';

describe('TextEditor', () => {
  it('commits trimmed text with Enter', async () => {
    const onCommit = vi.fn();
    render(
      <TextEditor
        position={{ x: 30, y: 40 }}
        onCommit={onCommit}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByRole('textbox', { name: '输入标注文字' });
    await userEvent.type(input, '  重点内容  {Enter}');

    expect(onCommit).toHaveBeenCalledWith('重点内容');
  });

  it('cancels with Escape', async () => {
    const onCancel = vi.fn();
    render(
      <TextEditor
        position={{ x: 30, y: 40 }}
        onCommit={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await userEvent.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('cancels an empty Enter submission', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(
      <TextEditor
        position={{ x: 30, y: 40 }}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );

    await userEvent.keyboard('{Enter}');

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
