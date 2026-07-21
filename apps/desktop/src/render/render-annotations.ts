import type {
  Annotation,
  ArrowAnnotation,
  PenAnnotation,
  RectangleAnnotation,
  TextAnnotation,
} from '../domain/annotations';
import { pixelateRegion } from './mosaic';

type RenderSize = Readonly<{ width: number; height: number }>;

function configureStroke(
  context: CanvasRenderingContext2D,
  stroke: string,
  strokeWidth: number,
): void {
  context.strokeStyle = stroke;
  context.lineWidth = strokeWidth;
  context.lineCap = 'round';
  context.lineJoin = 'round';
}

function renderRectangle(
  context: CanvasRenderingContext2D,
  annotation: RectangleAnnotation,
): void {
  configureStroke(context, annotation.stroke, annotation.strokeWidth);
  context.strokeRect(
    annotation.rect.x,
    annotation.rect.y,
    annotation.rect.width,
    annotation.rect.height,
  );
}

function renderArrow(
  context: CanvasRenderingContext2D,
  annotation: ArrowAnnotation,
): void {
  configureStroke(context, annotation.stroke, annotation.strokeWidth);
  const angle = Math.atan2(
    annotation.end.y - annotation.start.y,
    annotation.end.x - annotation.start.x,
  );
  const headLength = Math.max(10, annotation.strokeWidth * 4);

  context.beginPath();
  context.moveTo(annotation.start.x, annotation.start.y);
  context.lineTo(annotation.end.x, annotation.end.y);
  context.lineTo(
    annotation.end.x - headLength * Math.cos(angle - Math.PI / 6),
    annotation.end.y - headLength * Math.sin(angle - Math.PI / 6),
  );
  context.moveTo(annotation.end.x, annotation.end.y);
  context.lineTo(
    annotation.end.x - headLength * Math.cos(angle + Math.PI / 6),
    annotation.end.y - headLength * Math.sin(angle + Math.PI / 6),
  );
  context.stroke();
}

function renderPen(
  context: CanvasRenderingContext2D,
  annotation: PenAnnotation,
): void {
  const first = annotation.points[0];
  if (!first) return;

  configureStroke(context, annotation.stroke, annotation.strokeWidth);
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of annotation.points.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.stroke();
}

function renderText(
  context: CanvasRenderingContext2D,
  annotation: TextAnnotation,
): void {
  context.fillStyle = annotation.color;
  context.font = `${annotation.fontSize}px system-ui, sans-serif`;
  context.fillText(
    annotation.text,
    annotation.position.x,
    annotation.position.y,
  );
}

export function renderAnnotations(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  annotations: readonly Annotation[],
  size: RenderSize,
): void {
  context.clearRect(0, 0, size.width, size.height);
  context.drawImage(source, 0, 0, size.width, size.height);

  for (const annotation of annotations) {
    context.save();
    switch (annotation.kind) {
      case 'rectangle':
        renderRectangle(context, annotation);
        break;
      case 'arrow':
        renderArrow(context, annotation);
        break;
      case 'pen':
        renderPen(context, annotation);
        break;
      case 'text':
        renderText(context, annotation);
        break;
      case 'mosaic':
        pixelateRegion(
          context,
          source,
          annotation.points,
          annotation.brushWidth,
          annotation.blockSize,
          size,
        );
        break;
    }
    context.restore();
  }
}
