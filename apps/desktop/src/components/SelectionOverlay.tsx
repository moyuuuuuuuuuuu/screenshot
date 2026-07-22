import { useRef } from 'react';
import type { PointerEvent } from 'react';
import type { Point, Rect, ResizeHandle } from '../domain/geometry';
import { normalizeRect } from '../domain/geometry';
import { moveSelection, resizeSelection } from '../domain/resize-selection';

type SelectionOverlayProps = Readonly<{
  selection: Rect | null;
  bounds: Rect;
  locked?: boolean;
  onSelectionChange(selection: Rect): void;
}>;

type SelectionDrag = Readonly<{
  start: Point;
  initial: Rect;
  mode: 'move' | ResizeHandle;
}>;

export function SelectionOverlay({
  selection,
  bounds,
  locked = false,
  onSelectionChange,
}: SelectionOverlayProps) {
  const dragStart = useRef<Point | null>(null);
  const selectionDrag = useRef<SelectionDrag | null>(null);
  const hasSelection = Boolean(selection && selection.width > 0 && selection.height > 0);

  const updateExistingSelection = (event: PointerEvent<HTMLElement>) => {
    const drag = selectionDrag.current;
    if (!drag) return;
    const delta = { x: event.clientX - drag.start.x, y: event.clientY - drag.start.y };
    onSelectionChange(
      drag.mode === 'move'
        ? moveSelection(drag.initial, delta, bounds)
        : resizeSelection(drag.initial, drag.mode, delta, bounds),
    );
  };

  const beginExistingSelectionDrag = (
    event: PointerEvent<HTMLElement>,
    mode: 'move' | ResizeHandle,
  ) => {
    if (!selection) return;
    event.stopPropagation();
    selectionDrag.current = {
      start: { x: event.clientX, y: event.clientY },
      initial: selection,
      mode,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const endExistingSelectionDrag = (event: PointerEvent<HTMLElement>) => {
    if (!selectionDrag.current) return;
    event.stopPropagation();
    updateExistingSelection(event);
    selectionDrag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <div
      className={`selection-surface${locked ? ' selection-surface--locked' : ''}${hasSelection ? ' selection-surface--has-selection' : ''}`}
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
          data-testid="selection-box"
          style={{
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
          }}
        >
          <output
            className="selection-size"
            data-testid="selection-move-handle"
            data-placement="adaptive"
            title="拖动选区"
            onPointerDown={(event) => beginExistingSelectionDrag(event, 'move')}
            onPointerMove={updateExistingSelection}
            onPointerUp={endExistingSelectionDrag}
          >
            {Math.round(selection.width)} × {Math.round(selection.height)}
          </output>
          {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((handle) => (
            <span
              key={handle}
              className={`selection-handle selection-handle--${handle}`}
              data-tone="wechat-green"
              data-testid={`selection-handle-${handle}`}
              onPointerDown={(event) => beginExistingSelectionDrag(event, handle)}
              onPointerMove={updateExistingSelection}
              onPointerUp={endExistingSelectionDrag}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
