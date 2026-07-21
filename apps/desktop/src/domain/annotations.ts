import type { Point, Rect } from './geometry';

type AnnotationBase = Readonly<{
  id: string;
}>;

export type RectangleAnnotation = AnnotationBase &
  Readonly<{
    kind: 'rectangle';
    rect: Rect;
    stroke: string;
    strokeWidth: number;
  }>;

export type ArrowAnnotation = AnnotationBase &
  Readonly<{
    kind: 'arrow';
    start: Point;
    end: Point;
    stroke: string;
    strokeWidth: number;
  }>;

export type PenAnnotation = AnnotationBase &
  Readonly<{
    kind: 'pen';
    points: readonly Point[];
    stroke: string;
    strokeWidth: number;
  }>;

export type TextAnnotation = AnnotationBase &
  Readonly<{
    kind: 'text';
    position: Point;
    text: string;
    fontSize: number;
    color: string;
  }>;

export type MosaicAnnotation = AnnotationBase &
  Readonly<{
    kind: 'mosaic';
    points: readonly Point[];
    brushWidth: number;
    blockSize: number;
  }>;

export type Annotation =
  | RectangleAnnotation
  | ArrowAnnotation
  | PenAnnotation
  | TextAnnotation
  | MosaicAnnotation;
