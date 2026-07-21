import { describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../domain/annotations';
import { renderAnnotations } from './render-annotations';

function createMockContext() {
  const calls: string[] = [];
  const method = (name: string) =>
    vi.fn(() => {
      calls.push(name);
    });
  const context = {
    calls,
    clearRect: method('clearRect'),
    drawImage: method('drawImage'),
    strokeRect: method('strokeRect'),
    beginPath: method('beginPath'),
    moveTo: method('moveTo'),
    lineTo: method('lineTo'),
    stroke: method('stroke'),
    fillText: method('fillText'),
    save: method('save'),
    restore: method('restore'),
    clip: method('clip'),
    closePath: method('closePath'),
    lineCap: 'butt',
    lineJoin: 'miter',
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
    font: '',
    imageSmoothingEnabled: true,
    globalCompositeOperation: 'source-over',
  };
  return context;
}

const source = {} as CanvasImageSource;

describe('renderAnnotations', () => {
  it('renders the source before vector annotations', () => {
    const context = createMockContext();
    const annotations: readonly Annotation[] = [
      {
        id: 'rect-1',
        kind: 'rectangle',
        rect: { x: 5, y: 6, width: 40, height: 30 },
        stroke: '#ff4d4f',
        strokeWidth: 2,
      },
    ];

    renderAnnotations(
      context as unknown as CanvasRenderingContext2D,
      source,
      annotations,
      { width: 100, height: 80 },
    );

    expect(context.calls.slice(0, 2)).toEqual(['clearRect', 'drawImage']);
    expect(context.strokeRect).toHaveBeenCalledWith(5, 6, 40, 30);
    expect(context.lineCap).toBe('round');
    expect(context.lineJoin).toBe('round');
  });

  it('renders arrow, pen, and text annotations', () => {
    const context = createMockContext();
    const annotations: readonly Annotation[] = [
      {
        id: 'arrow-1', kind: 'arrow', start: { x: 2, y: 3 }, end: { x: 30, y: 20 },
        stroke: '#fff', strokeWidth: 3,
      },
      {
        id: 'pen-1', kind: 'pen', points: [{ x: 1, y: 1 }, { x: 4, y: 5 }],
        stroke: '#fff', strokeWidth: 4,
      },
      {
        id: 'text-1', kind: 'text', position: { x: 8, y: 9 }, text: 'Hello',
        fontSize: 18, color: '#fff',
      },
    ];

    renderAnnotations(
      context as unknown as CanvasRenderingContext2D,
      source,
      annotations,
      { width: 100, height: 80 },
    );

    expect(context.stroke).toHaveBeenCalledTimes(2);
    expect(context.fillText).toHaveBeenCalledWith('Hello', 8, 9);
    expect(context.font).toBe('18px system-ui, sans-serif');
  });

  it('pixelates mosaic strokes from the original source', () => {
    const context = createMockContext();
    const sampleContext = createMockContext();
    const pixelContext = createMockContext();
    const canvases = [sampleContext, pixelContext].map((offscreenContext) => ({
      width: 0,
      height: 0,
      getContext: () => offscreenContext,
    }));
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockImplementation(((tagName: string) => {
        if (tagName === 'canvas') {
          const canvas = canvases.shift();
          if (!canvas) throw new Error('Unexpected canvas allocation');
          return canvas;
        }
        return document.createElement(tagName);
      }) as typeof document.createElement);

    renderAnnotations(
      context as unknown as CanvasRenderingContext2D,
      source,
      [{
        id: 'mosaic-1', kind: 'mosaic', points: [{ x: 10, y: 10 }, { x: 30, y: 30 }],
        brushWidth: 18, blockSize: 8,
      }],
      { width: 100, height: 80 },
    );

    expect(sampleContext.drawImage).toHaveBeenCalledWith(source, 0, 0, 13, 10);
    expect(pixelContext.drawImage).toHaveBeenCalled();
    expect(pixelContext.stroke).toHaveBeenCalledOnce();
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    createElement.mockRestore();
  });
});
