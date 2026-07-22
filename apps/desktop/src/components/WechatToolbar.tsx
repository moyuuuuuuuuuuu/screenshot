import type { ComponentType, SVGProps } from 'react';
import {
  ArrowIcon, CancelIcon, CompleteIcon, EllipseIcon, EmojiIcon, MosaicIcon,
  OcrIcon, PenIcon, PinIcon, PrivacyIcon, RectangleIcon, SaveIcon, ScrollIcon,
  ShareIcon, TextIcon, UndoIcon,
} from './icons/WechatIcons';
import { ToolOptions } from './ToolOptions';

export type WechatToolbarAction =
  | 'rectangle' | 'ellipse' | 'emoji' | 'arrow' | 'pen' | 'mosaic' | 'text'
  | 'privacy' | 'ocr' | 'long-capture' | 'undo' | 'save' | 'pin' | 'share'
  | 'cancel' | 'complete';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
type ActionDefinition = Readonly<{
  action: WechatToolbarAction;
  label: string;
  icon: Icon;
  separatorBefore?: boolean;
  tone?: 'danger' | 'success';
}>;

const actions: readonly ActionDefinition[] = [
  { action: 'rectangle', label: '矩形', icon: RectangleIcon },
  { action: 'ellipse', label: '圆形', icon: EllipseIcon },
  { action: 'emoji', label: '表情', icon: EmojiIcon },
  { action: 'arrow', label: '箭头', icon: ArrowIcon },
  { action: 'pen', label: '画笔', icon: PenIcon },
  { action: 'mosaic', label: '马赛克', icon: MosaicIcon },
  { action: 'text', label: '文字', icon: TextIcon },
  { action: 'privacy', label: '隐私工具', icon: PrivacyIcon, separatorBefore: true },
  { action: 'ocr', label: '文字识别', icon: OcrIcon },
  { action: 'long-capture', label: '滚动截图', icon: ScrollIcon },
  { action: 'undo', label: '撤销', icon: UndoIcon, separatorBefore: true },
  { action: 'save', label: '保存', icon: SaveIcon },
  { action: 'pin', label: '钉住', icon: PinIcon },
  { action: 'share', label: '转发', icon: ShareIcon },
  { action: 'cancel', label: '取消', icon: CancelIcon, tone: 'danger' },
  { action: 'complete', label: '完成', icon: CompleteIcon, tone: 'success' },
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
              <Icon />
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
