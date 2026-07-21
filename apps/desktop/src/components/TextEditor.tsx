import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { Point } from '../domain/geometry';

export type TextEditorProps = Readonly<{
  position: Point;
  onCommit(text: string): void;
  onCancel(): void;
}>;

export function TextEditor({ position, onCommit, onCancel }: TextEditorProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }

    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    const text = event.currentTarget.value.trim();
    if (text.length > 0) {
      onCommit(text);
    } else {
      onCancel();
    }
  };

  return (
    <textarea
      ref={inputRef}
      autoFocus
      aria-label="输入标注文字"
      className="text-editor"
      onKeyDown={handleKeyDown}
      style={{ left: position.x, top: position.y }}
    />
  );
}
