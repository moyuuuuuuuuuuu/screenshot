import { useRef } from 'react';
import type { Point, Rect } from '../domain/geometry';
import { normalizeRect } from '../domain/geometry';

type SelectionOverlayProps = Readonly<{
  selection: Rect | null;
  onSelectionChange(selection: Rect): void;
}>;

export function SelectionOverlay({
  selection,
  onSelectionChange,
}: SelectionOverlayProps) {
  const dragStart = useRef<Point | null>(null);

  return (
    <div
      className="selection-surface"
      data-testid="selection-surface"
      onPointerDown={(event) => {
        dragStart.current = { x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onSelectionChange(normalizeRect(dragStart.current, dragStart.current));
      }}
      onPointerMove={(event) => {
        if (!dragStart.current) return;
        onSelectionChange(
          normalizeRect(dragStart.current, {
            x: event.clientX,
            y: event.clientY,
          }),
        );
      }}
      onPointerUp={(event) => {
        if (!dragStart.current) return;
        onSelectionChange(
          normalizeRect(dragStart.current, {
            x: event.clientX,
            y: event.clientY,
          }),
        );
        dragStart.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
    >
      {selection && selection.width > 0 && selection.height > 0 ? (
        <div
          className="selection-box"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
          }}
        >
          <output className="selection-size">
            {Math.round(selection.width)} × {Math.round(selection.height)}
          </output>
          {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((handle) => (
            <span key={handle} className={`selection-handle selection-handle--${handle}`} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
