import type { Annotation } from './annotations';
import type { Point } from './geometry';
import { normalizeRect } from './geometry';

export type Tool = 'rectangle' | 'ellipse' | 'emoji' | 'arrow' | 'pen' | 'text' | 'mosaic';

export type DrawingSession = Readonly<{
  tool: Tool;
  start: Point;
  points: readonly Point[];
}>;

export type DrawingStyle = Readonly<{
  strokeWidth?: number;
  mosaicBrushWidth?: number;
}>;

export function startDrawing(tool: Tool, point: Point): DrawingSession {
  return { tool, start: point, points: [point] };
}

export function continueDrawing(
  session: DrawingSession,
  point: Point,
): DrawingSession {
  return { ...session, points: [...session.points, point] };
}

function hasMovement(session: DrawingSession): boolean {
  const last = session.points.at(-1);
  return Boolean(
    last && Math.hypot(last.x - session.start.x, last.y - session.start.y) > 0,
  );
}

export function finishDrawing(
  session: DrawingSession,
  id: string,
  style: DrawingStyle = {},
): Annotation | null {
  const end = session.points.at(-1);
  if (!end || !hasMovement(session) || session.tool === 'text' || session.tool === 'emoji') {
    return null;
  }

  switch (session.tool) {
    case 'rectangle':
      return {
        id,
        kind: 'rectangle',
        rect: normalizeRect(session.start, end),
        stroke: '#ff4d4f',
        strokeWidth: style.strokeWidth ?? 2,
      };
    case 'ellipse':
      return {
        id,
        kind: 'ellipse',
        rect: normalizeRect(session.start, end),
        stroke: '#ff4d4f',
        strokeWidth: style.strokeWidth ?? 2,
      };
    case 'arrow':
      return {
        id,
        kind: 'arrow',
        start: session.start,
        end,
        stroke: '#ff4d4f',
        strokeWidth: style.strokeWidth ?? 3,
      };
    case 'pen':
      return {
        id,
        kind: 'pen',
        points: session.points,
        stroke: '#ff4d4f',
        strokeWidth: style.strokeWidth ?? 4,
      };
    case 'mosaic':
      return {
        id,
        kind: 'mosaic',
        points: session.points,
        brushWidth: style.mosaicBrushWidth ?? 20,
        blockSize: 10,
      };
  }
}
