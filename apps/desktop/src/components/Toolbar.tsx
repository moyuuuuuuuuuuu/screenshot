import {
  ArrowUpRight,
  Check,
  Copy,
  Grid2X2,
  Languages,
  PenLine,
  Redo2,
  Save,
  ScanText,
  Square,
  Type,
  Undo2,
  X,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

export type Tool = 'rectangle' | 'arrow' | 'pen' | 'text' | 'mosaic';
export type ToolbarAction =
  | Tool
  | 'undo'
  | 'redo'
  | 'ocr'
  | 'translate'
  | 'copy'
  | 'save'
  | 'complete'
  | 'cancel';

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

type ToolbarProps = Readonly<{
  activeTool: Tool;
  canUndo: boolean;
  canRedo: boolean;
  onAction(action: ToolbarAction): void;
}>;

const drawingActions: readonly [Tool, Icon, string][] = [
  ['rectangle', Square, '矩形'],
  ['arrow', ArrowUpRight, '箭头'],
  ['pen', PenLine, '画笔'],
  ['text', Type, '文字'],
  ['mosaic', Grid2X2, '马赛克'],
];

type IconButtonProps = Readonly<{
  action: ToolbarAction;
  label: string;
  icon: Icon;
  onAction(action: ToolbarAction): void;
  pressed?: boolean;
  disabled?: boolean;
  tone?: 'accent' | 'success' | 'danger';
}>;

function IconButton({
  action,
  label,
  icon: IconComponent,
  onAction,
  pressed,
  disabled = false,
  tone,
}: IconButtonProps) {
  const className = ['toolbar__button', tone && `toolbar__button--${tone}`]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={() => onAction(action)}
    >
      <IconComponent size={20} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}

export function Toolbar({
  activeTool,
  canUndo,
  canRedo,
  onAction,
}: ToolbarProps) {
  return (
    <div className="toolbar" role="toolbar" aria-label="截图工具">
      {drawingActions.map(([action, icon, label]) => (
        <IconButton
          key={action}
          action={action}
          icon={icon}
          label={label}
          pressed={activeTool === action}
          onAction={onAction}
        />
      ))}
      <span className="toolbar__separator" aria-hidden="true" />
      <IconButton action="undo" icon={Undo2} label="撤销" disabled={!canUndo} onAction={onAction} />
      <IconButton action="redo" icon={Redo2} label="重做" disabled={!canRedo} onAction={onAction} />
      <span className="toolbar__separator" aria-hidden="true" />
      <IconButton action="ocr" icon={ScanText} label="OCR" tone="accent" onAction={onAction} />
      <IconButton action="translate" icon={Languages} label="翻译" tone="accent" onAction={onAction} />
      <span className="toolbar__separator" aria-hidden="true" />
      <IconButton action="copy" icon={Copy} label="复制" onAction={onAction} />
      <IconButton action="save" icon={Save} label="保存" onAction={onAction} />
      <IconButton action="complete" icon={Check} label="完成" tone="success" onAction={onAction} />
      <IconButton action="cancel" icon={X} label="取消" tone="danger" onAction={onAction} />
    </div>
  );
}
