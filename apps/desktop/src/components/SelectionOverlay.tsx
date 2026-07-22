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
      className={`selection-surface${locked ? ' selection-surface--locked' : ''}`}
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
      {hasSelection && selection ? (
        <>
          <div
            className="selection-mask"
            data-mask-side="top"
            style={{
              left: bounds.x,
              top: bounds.y,
              width: bounds.width,
              height: Math.max(0, selection.y - bounds.y),
            }}
          />
          <div
            className="selection-mask"
            data-mask-side="right"
            style={{
              left: selection.x + selection.width,
              top: selection.y,
              width: Math.max(0, bounds.x + bounds.width - selection.x - selection.width),
              height: selection.height,
            }}
          />
          <div
            className="selection-mask"
            data-mask-side="bottom"
            style={{
              left: bounds.x,
              top: selection.y + selection.height,
              width: bounds.width,
              height: Math.max(0, bounds.y + bounds.height - selection.y - selection.height),
            }}
          />
          <div
            className="selection-mask"
            data-mask-side="left"
            style={{
              left: bounds.x,
              top: selection.y,
              width: Math.max(0, selection.x - bounds.x),
              height: selection.height,
            }}
          />
        </>
      ) : (
        <div className="selection-mask selection-mask--full" />
      )}
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
