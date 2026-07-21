import type { Point } from '../domain/geometry';

function strokePath(
  context: CanvasRenderingContext2D,
  points: readonly Point[],
): void {
  const first = points[0];
  if (!first) return;

  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of points.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.stroke();
}

export function pixelateRegion(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  points: readonly Point[],
  brushWidth: number,
  blockSize: number,
  size: Readonly<{ width: number; height: number }>,
): void {
  if (points.length === 0 || size.width <= 0 || size.height <= 0) return;

  const safeBlockSize = Math.max(1, Math.round(blockSize));
  const lowWidth = Math.max(1, Math.ceil(size.width / safeBlockSize));
  const lowHeight = Math.max(1, Math.ceil(size.height / safeBlockSize));
  const lowResolution = document.createElement('canvas');
  lowResolution.width = lowWidth;
  lowResolution.height = lowHeight;
  const lowContext = lowResolution.getContext('2d');

  const pixelated = document.createElement('canvas');
  pixelated.width = size.width;
  pixelated.height = size.height;
  const pixelContext = pixelated.getContext('2d');

  if (!lowContext || !pixelContext) return;

  lowContext.imageSmoothingEnabled = true;
  lowContext.drawImage(source, 0, 0, lowWidth, lowHeight);
  pixelContext.imageSmoothingEnabled = false;
  pixelContext.drawImage(
    lowResolution,
    0,
    0,
    lowWidth,
    lowHeight,
    0,
    0,
    size.width,
    size.height,
  );

  pixelContext.globalCompositeOperation = 'destination-in';
  pixelContext.strokeStyle = '#000';
  pixelContext.lineWidth = brushWidth;
  pixelContext.lineCap = 'round';
  pixelContext.lineJoin = 'round';
  strokePath(pixelContext, points);
  pixelContext.globalCompositeOperation = 'source-over';

  context.drawImage(pixelated, 0, 0);
}
