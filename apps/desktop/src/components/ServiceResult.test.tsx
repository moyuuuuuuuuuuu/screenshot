import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ServiceResult } from './ServiceResult';

describe('ServiceResult', () => {
  it('shows recognized text and offers explicit translation', async () => {
    const onTranslate = vi.fn();
    render(
      <ServiceResult
        title="文字识别"
        text="Hello"
        onTranslate={onTranslate}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: '服务结果' })).toHaveValue('Hello');
    await userEvent.click(screen.getByRole('button', { name: '翻译为中文' }));
    expect(onTranslate).toHaveBeenCalledWith('zh-CN');
  });
});
