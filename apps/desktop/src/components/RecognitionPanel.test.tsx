import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { QuotaResult, RecognitionResult, TextBlock } from '../cloud/cloud-client';
import { RecognitionPanel } from './RecognitionPanel';

const firstBlock: TextBlock = {
  text: '第一段',
  x: 0.1,
  y: 0.2,
  width: 0.3,
  height: 0.1,
};
const ocrResult: RecognitionResult = {
  sourceLanguage: 'zh',
  originalText: '第一段\n第二段',
  translatedText: null,
  blocks: [
    firstBlock,
    { text: '第二段', x: 0.2, y: 0.4, width: 0.4, height: 0.1 },
  ],
};
const quota: QuotaResult = {
  ocr: { limit: 20, remaining: 18 },
  translate: { limit: 10, remaining: 7 },
  resetsAt: '2026-07-23T16:00:00.000Z',
};

describe('RecognitionPanel', () => {
  it('shows loading without text actions and allows icon-only close', async () => {
    const onClose = vi.fn();
    const { container } = render(
      <RecognitionPanel
        state={{ status: 'loading', mode: 'ocr' }}
        quota={null}
        onClose={onClose}
        onRetry={vi.fn()}
        onCopy={vi.fn()}
        onTranslate={vi.fn()}
        onBlockHighlight={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('正在识别');
    expect(screen.queryByRole('button', { name: '复制文字' })).not.toBeInTheDocument();
    const close = screen.getByRole('button', { name: '关闭识别面板' });
    expect(close).toHaveAttribute('title', '关闭');
    expect(close).toHaveTextContent('');
    expect(close.querySelector('svg')).toHaveClass('lucide-x');
    expect(container.querySelector('.recognition-panel')).toBeInTheDocument();
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows OCR text, blocks, quota and normalized hover/focus highlights', async () => {
    const onCopy = vi.fn();
    const onTranslate = vi.fn();
    const onRetry = vi.fn();
    const onHighlight = vi.fn();
    render(
      <RecognitionPanel
        state={{ status: 'success', mode: 'ocr', result: ocrResult }}
        quota={quota}
        onClose={vi.fn()}
        onRetry={onRetry}
        onCopy={onCopy}
        onTranslate={onTranslate}
        onBlockHighlight={onHighlight}
      />,
    );

    expect(screen.getByLabelText('识别原文')).toHaveTextContent('第一段');
    expect(screen.getByText('OCR 18/20')).toBeInTheDocument();
    expect(screen.getByText('翻译 7/10')).toBeInTheDocument();
    expect(screen.getByText(quota.resetsAt)).toBeInTheDocument();

    const block = screen.getByText('第一段', { selector: '.recognition-panel__block' });
    fireEvent.mouseEnter(block);
    fireEvent.mouseLeave(block);
    fireEvent.focus(block);
    fireEvent.blur(block);
    expect(onHighlight).toHaveBeenNthCalledWith(1, firstBlock);
    expect(onHighlight).toHaveBeenNthCalledWith(2, null);
    expect(onHighlight).toHaveBeenNthCalledWith(3, firstBlock);
    expect(onHighlight).toHaveBeenNthCalledWith(4, null);

    const translate = screen.getByRole('button', { name: '翻译识别结果' });
    const copy = screen.getByRole('button', { name: '复制文字' });
    const retry = screen.getByRole('button', { name: '重试识别' });
    for (const button of [translate, copy, retry]) {
      expect(button).toHaveTextContent('');
      expect(button).toHaveAttribute('title');
    }
    await userEvent.click(translate);
    await userEvent.click(copy);
    await userEvent.click(retry);
    expect(onTranslate).toHaveBeenCalledOnce();
    expect(onCopy).toHaveBeenCalledWith(ocrResult.originalText);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows original and translated text and copies the translation', async () => {
    const onCopy = vi.fn();
    const result: RecognitionResult = {
      ...ocrResult,
      sourceLanguage: 'en',
      originalText: 'Hello',
      translatedText: '你好',
    };
    render(
      <RecognitionPanel
        state={{ status: 'success', mode: 'translate', result }}
        quota={quota}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onCopy={onCopy}
        onTranslate={vi.fn()}
        onBlockHighlight={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('翻译原文')).toHaveTextContent('Hello');
    expect(screen.getByLabelText('翻译结果')).toHaveTextContent('你好');
    expect(screen.queryByRole('button', { name: '翻译识别结果' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '复制文字' }));
    expect(onCopy).toHaveBeenCalledWith('你好');
  });

  it('shows only the safe error with icon-only retry and close actions', async () => {
    const onRetry = vi.fn();
    const onClose = vi.fn();
    render(
      <RecognitionPanel
        state={{
          status: 'error',
          mode: 'translate',
          message: 'The recognition service timed out.',
        }}
        quota={null}
        onClose={onClose}
        onRetry={onRetry}
        onCopy={vi.fn()}
        onTranslate={vi.fn()}
        onBlockHighlight={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The recognition service timed out.',
    );
    expect(screen.queryByRole('button', { name: '复制文字' })).not.toBeInTheDocument();
    const retry = screen.getByRole('button', { name: '重试翻译' });
    const close = screen.getByRole('button', { name: '关闭识别面板' });
    expect(retry.querySelector('svg')).toHaveClass('lucide-rotate-ccw');
    expect(close.querySelector('svg')).toHaveClass('lucide-x');
    await userEvent.click(retry);
    await userEvent.click(close);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
