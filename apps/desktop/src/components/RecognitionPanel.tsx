import {
  Copy,
  Languages,
  RotateCcw,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useRef } from 'react';

import type {
  QuotaResult,
  RecognitionResult,
  TextBlock,
} from '../cloud/cloud-client';

export type RecognitionPanelState =
  | Readonly<{ status: 'loading'; mode: 'ocr' | 'translate' }>
  | Readonly<{
      status: 'success';
      mode: 'ocr' | 'translate';
      result: RecognitionResult;
    }>
  | Readonly<{
      status: 'error';
      mode: 'ocr' | 'translate';
      message: string;
    }>;

type RecognitionPanelProps = Readonly<{
  state: RecognitionPanelState;
  quota: QuotaResult | null;
  onClose(): void;
  onRetry(): void;
  onCopy(text: string): void;
  onTranslate(): void;
  onBlockHighlight(block: TextBlock | null): void;
}>;

export function RecognitionPanel({
  state,
  quota,
  onClose,
  onRetry,
  onCopy,
  onTranslate,
  onBlockHighlight,
}: RecognitionPanelProps) {
  const translatedText = state.status === 'success'
    ? state.result.translatedText
    : null;
  const copyText = state.status === 'success'
    ? translatedText ?? state.result.originalText
    : '';

  return (
    <aside className="recognition-panel" aria-label="识别结果">
      <header className="recognition-panel__header">
        <strong>{state.mode === 'ocr' ? '文字识别' : '翻译'}</strong>
        <div className="recognition-panel__actions">
          {state.status === 'success' && state.mode === 'ocr' ? (
            <ActionButton
              label="翻译识别结果"
              title="翻译"
              icon={Languages}
              onClick={onTranslate}
            />
          ) : null}
          {state.status === 'success' ? (
            <ActionButton
              label="复制文字"
              title="复制"
              icon={Copy}
              onClick={() => onCopy(copyText)}
            />
          ) : null}
          {state.status !== 'loading' ? (
            <ActionButton
              label={state.mode === 'ocr' ? '重试识别' : '重试翻译'}
              title="重试"
              icon={RotateCcw}
              onClick={onRetry}
            />
          ) : null}
          <ActionButton
            label="关闭识别面板"
            title="关闭"
            icon={X}
            onClick={onClose}
          />
        </div>
      </header>

      {state.status === 'loading' ? (
        <div className="recognition-panel__loading" role="status">
          {state.mode === 'ocr' ? '正在识别…' : '正在翻译…'}
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="recognition-panel__error" role="alert">
          {state.message}
        </div>
      ) : null}

      {state.status === 'success' && state.mode === 'ocr' ? (
        <OcrContent
          result={state.result}
          onBlockHighlight={onBlockHighlight}
        />
      ) : null}

      {state.status === 'success' && state.mode === 'translate' ? (
        <TranslationContent result={state.result} />
      ) : null}

      {quota ? <QuotaStatus quota={quota} /> : null}
    </aside>
  );
}

function OcrContent({
  result,
  onBlockHighlight,
}: Readonly<{
  result: RecognitionResult;
  onBlockHighlight(block: TextBlock | null): void;
}>) {
  return (
    <div className="recognition-panel__content">
      <pre aria-label="识别原文">{result.originalText}</pre>
      {result.blocks.length > 0 ? (
        <ul className="recognition-panel__blocks" aria-label="识别文字块">
          {result.blocks.map((block, index) => (
            <HighlightableBlock
              key={`${index}-${block.x}-${block.y}`}
              block={block}
              onBlockHighlight={onBlockHighlight}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function HighlightableBlock({
  block,
  onBlockHighlight,
}: Readonly<{
  block: TextBlock;
  onBlockHighlight(block: TextBlock | null): void;
}>) {
  const hovered = useRef(false);
  const focused = useRef(false);
  const notify = () => {
    onBlockHighlight(hovered.current || focused.current ? block : null);
  };

  return (
    <li
      className="recognition-panel__block"
      tabIndex={0}
      onMouseEnter={() => {
        hovered.current = true;
        notify();
      }}
      onMouseLeave={() => {
        hovered.current = false;
        notify();
      }}
      onFocus={() => {
        focused.current = true;
        notify();
      }}
      onBlur={() => {
        focused.current = false;
        notify();
      }}
    >
      {block.text}
    </li>
  );
}

function TranslationContent({ result }: Readonly<{ result: RecognitionResult }>) {
  return (
    <div className="recognition-panel__translation">
      <section aria-label="翻译原文">
        <span>原文</span>
        <pre>{result.originalText}</pre>
      </section>
      <section aria-label="翻译结果">
        <span>译文</span>
        <pre>{result.translatedText ?? ''}</pre>
      </section>
    </div>
  );
}

function QuotaStatus({ quota }: Readonly<{ quota: QuotaResult }>) {
  return (
    <footer className="recognition-panel__quota" aria-label="云服务额度">
      <span>OCR {quota.ocr.remaining}/{quota.ocr.limit}</span>
      <span>翻译 {quota.translate.remaining}/{quota.translate.limit}</span>
      <span>重置 <time dateTime={quota.resetsAt}>{quota.resetsAt}</time></span>
    </footer>
  );
}

function ActionButton({
  label,
  title,
  icon: Icon,
  onClick,
}: Readonly<{
  label: string;
  title: string;
  icon: LucideIcon;
  onClick(): void;
}>) {
  return (
    <button
      type="button"
      className="recognition-panel__action"
      aria-label={label}
      title={title}
      onClick={onClick}
    >
      <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}
