type ToolOptionsProps = Readonly<{
  tool: 'pen' | 'mosaic';
  width: number;
  onWidthChange?(width: number): void;
}>;

export function ToolOptions({ tool, width, onWidthChange }: ToolOptionsProps) {
  const label = tool === 'pen' ? '画笔' : '马赛克';
  return (
    <div className="wechat-tool-options" role="group" aria-label={`${label}选项`}>
      <span className="wechat-tool-options__color" aria-hidden="true" />
      <input
        type="range"
        aria-label={`${label}粗细`}
        min={tool === 'pen' ? 2 : 8}
        max={tool === 'pen' ? 16 : 48}
        value={width}
        onChange={(event) => onWidthChange?.(Number(event.currentTarget.value))}
      />
    </div>
  );
}
