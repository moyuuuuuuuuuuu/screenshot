import {
  ArrowUpRight, Blocks, Check, Circle, GalleryVerticalEnd, Languages, PenLine, Pin, Save,
  Send, Smile, Square, Type, Undo2, X,
  type LucideIcon,
} from 'lucide-react';
import { ToolOptions } from './ToolOptions';

export type WechatToolbarAction =
  | 'rectangle' | 'ellipse' | 'emoji' | 'arrow' | 'pen' | 'mosaic' | 'text'
  | 'ocr' | 'long-capture' | 'undo' | 'save' | 'pin' | 'share'
  | 'cancel' | 'complete';

type ActionDefinition = Readonly<{
  action: WechatToolbarAction;
  label: string;
  icon: LucideIcon;
  separatorBefore?: boolean;
  tone?: 'danger' | 'success';
}>;

const actions: readonly ActionDefinition[] = [
  { action: 'rectangle', label: '矩形', icon: Square },
  { action: 'ellipse', label: '圆形', icon: Circle },
  { action: 'emoji', label: '表情', icon: Smile },
  { action: 'arrow', label: '箭头', icon: ArrowUpRight },
  { action: 'pen', label: '画笔', icon: PenLine },
  { action: 'mosaic', label: '马赛克', icon: Blocks },
  { action: 'text', label: '文字', icon: Type },
  { action: 'ocr', label: '文字识别', icon: Languages, separatorBefore: true },
  { action: 'long-capture', label: '滚动截图', icon: GalleryVerticalEnd },
  { action: 'undo', label: '撤销', icon: Undo2, separatorBefore: true },
  { action: 'save', label: '保存', icon: Save },
  { action: 'pin', label: '钉住', icon: Pin },
  { action: 'share', label: '转发', icon: Send },
  { action: 'cancel', label: '取消', icon: X, tone: 'danger' },
  { action: 'complete', label: '完成', icon: Check, tone: 'success' },
];

type WechatToolbarProps = Readonly<{
  activeAction: WechatToolbarAction;
  canUndo: boolean;
  drawingWidth?: number;
  onDrawingWidthChange?(width: number): void;
  onAction(action: WechatToolbarAction): void;
}>;

export function WechatToolbar({
  activeAction,
  canUndo,
  drawingWidth = activeAction === 'mosaic' ? 20 : 4,
  onDrawingWidthChange,
  onAction,
}: WechatToolbarProps) {
  return (
    <div className="wechat-toolbar-wrap">
      <div className="wechat-toolbar" role="toolbar" aria-label="截图工具">
        {actions.map(({ action, label, icon: Icon, separatorBefore, tone }) => (
          <span className="wechat-toolbar__item" key={action}>
            {separatorBefore ? <span className="wechat-toolbar__separator" aria-hidden="true" /> : null}
            <button
              type="button"
              className={`wechat-toolbar__button${tone ? ` wechat-toolbar__button--${tone}` : ''}`}
              aria-label={label}
              title={label}
              aria-pressed={activeAction === action}
              disabled={action === 'undo' && !canUndo}
              onClick={() => onAction(action)}
            >
              <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      {activeAction === 'pen' || activeAction === 'mosaic' ? (
        <ToolOptions
          tool={activeAction}
          width={drawingWidth}
          {...(onDrawingWidthChange ? { onWidthChange: onDrawingWidthChange } : {})}
        />
      ) : null}
    </div>
  );
}
