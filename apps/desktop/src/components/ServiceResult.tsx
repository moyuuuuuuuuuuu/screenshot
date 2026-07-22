import { Languages } from 'lucide-react';

type ServiceResultProps = Readonly<{
  title: string;
  text: string;
  onTranslate?(targetLanguage: string): void;
  onClose(): void;
}>;

export function ServiceResult({ title, text, onTranslate, onClose }: ServiceResultProps) {
  return (
    <aside className="service-result" aria-label={title}>
      <header>
        <strong>{title}</strong>
        <button type="button" aria-label="关闭服务结果" onClick={onClose}>×</button>
      </header>
      <textarea aria-label="服务结果" value={text} readOnly />
      {onTranslate ? (
        <button type="button" aria-label="翻译为中文" onClick={() => onTranslate('zh-CN')}>
          <Languages size={20} strokeWidth={1.8} aria-hidden="true" />
          翻译为中文
        </button>
      ) : null}
    </aside>
  );
}
