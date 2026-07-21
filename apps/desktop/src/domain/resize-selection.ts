import type { Point, Rect, ResizeHandle } from './geometry';

const MIN_SELECTION_SIZE = 8;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function resizeSelection(
  rect: Rect,
  handle: ResizeHandle,
  delta: Point,
  bounds: Rect,
): Rect {
  const boundsRight = bounds.x + bounds.width;
  const boundsBottom = bounds.y + bounds.height;
  const originalRight = rect.x + rect.width;
  const originalBottom = rect.y + rect.height;
  let left = rect.x;
  let top = rect.y;
  let right = originalRight;
  let bottom = originalBottom;

  if (handle.includes('w')) {
    left = clamp(rect.x + delta.x, bounds.x, originalRight - MIN_SELECTION_SIZE);
  }
  if (handle.includes('e')) {
    right = clamp(originalRight + delta.x, rect.x + MIN_SELECTION_SIZE, boundsRight);
  }
  if (handle.includes('n')) {
    top = clamp(rect.y + delta.y, bounds.y, originalBottom - MIN_SELECTION_SIZE);
  }
  if (handle.includes('s')) {
    bottom = clamp(originalBottom + delta.y, rect.y + MIN_SELECTION_SIZE, boundsBottom);
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function moveSelection(rect: Rect, delta: Point, bounds: Rect): Rect {
  const maximumX = bounds.x + bounds.width - rect.width;
  const maximumY = bounds.y + bounds.height - rect.height;
  return {
    x: clamp(rect.x + delta.x, bounds.x, maximumX),
    y: clamp(rect.y + delta.y, bounds.y, maximumY),
    width: rect.width,
    height: rect.height,
  };
}
