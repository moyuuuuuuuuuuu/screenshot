export type Point = Readonly<{ x: number; y: number }>;

export type Rect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type ResizeHandle =
  | 'nw'
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w';

export function normalizeRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function clampRect(rect: Rect, bounds: Rect): Rect {
  const left = Math.min(
    Math.max(rect.x, bounds.x),
    bounds.x + bounds.width,
  );
  const top = Math.min(
    Math.max(rect.y, bounds.y),
    bounds.y + bounds.height,
  );
  const right = Math.max(
    Math.min(rect.x + rect.width, bounds.x + bounds.width),
    bounds.x,
  );
  const bottom = Math.max(
    Math.min(rect.y + rect.height, bounds.y + bounds.height),
    bounds.y,
  );

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function hitTestHandle(
  point: Point,
  rect: Rect,
  radius: number,
): ResizeHandle | null {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const handles: readonly [ResizeHandle, Point][] = [
    ['nw', { x: rect.x, y: rect.y }],
    ['n', { x: centerX, y: rect.y }],
    ['ne', { x: right, y: rect.y }],
    ['e', { x: right, y: centerY }],
    ['se', { x: right, y: bottom }],
    ['s', { x: centerX, y: bottom }],
    ['sw', { x: rect.x, y: bottom }],
    ['w', { x: rect.x, y: centerY }],
  ];

  let nearest: { handle: ResizeHandle; distance: number } | null = null;

  for (const [handle, center] of handles) {
    const distance = Math.hypot(point.x - center.x, point.y - center.y);
    if (distance <= radius && (!nearest || distance < nearest.distance)) {
      nearest = { handle, distance };
    }
  }

  return nearest?.handle ?? null;
}
