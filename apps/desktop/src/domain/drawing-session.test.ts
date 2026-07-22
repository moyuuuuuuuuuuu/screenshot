import { describe, expect, it } from 'vitest';
import {
  continueDrawing,
  finishDrawing,
  startDrawing,
} from './drawing-session';

describe('drawing session', () => {
  it('normalizes a reverse rectangle gesture', () => {
    const session = continueDrawing(
      startDrawing('rectangle', { x: 80, y: 60 }),
      { x: 20, y: 10 },
    );

    expect(finishDrawing(session, 'rect-1')).toMatchObject({
      id: 'rect-1',
      kind: 'rectangle',
      rect: { x: 20, y: 10, width: 60, height: 50 },
    });
  });

  it('normalizes an ellipse gesture with the WeChat drawing style', () => {
    const session = continueDrawing(
      startDrawing('ellipse', { x: 80, y: 60 }),
      { x: 20, y: 10 },
    );

    expect(finishDrawing(session, 'ellipse-1')).toEqual({
      id: 'ellipse-1',
      kind: 'ellipse',
      rect: { x: 20, y: 10, width: 60, height: 50 },
      stroke: '#ff4d4f',
      strokeWidth: 2,
    });
  });

  it('retains arrow direction from start to end', () => {
    const session = continueDrawing(
      startDrawing('arrow', { x: 80, y: 60 }),
      { x: 20, y: 10 },
    );

    expect(finishDrawing(session, 'arrow-1')).toMatchObject({
      id: 'arrow-1',
      kind: 'arrow',
      start: { x: 80, y: 60 },
      end: { x: 20, y: 10 },
    });
  });

  it.each(['pen', 'mosaic'] as const)(
    'retains ordered points for %s gestures',
    (tool) => {
      const session = continueDrawing(
        continueDrawing(startDrawing(tool, { x: 1, y: 2 }), { x: 3, y: 4 }),
        { x: 5, y: 6 },
      );

      expect(finishDrawing(session, `${tool}-1`)).toMatchObject({
        id: `${tool}-1`,
        kind: tool,
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 6 },
        ],
      });
    },
  );

  it.each(['rectangle', 'ellipse', 'arrow', 'pen', 'mosaic'] as const)(
    'discards zero-length %s gestures',
    (tool) => {
      expect(
        finishDrawing(startDrawing(tool, { x: 10, y: 10 }), 'empty-1'),
      ).toBeNull();
    },
  );

  it('defers text creation to the inline text editor', () => {
    const session = continueDrawing(
      startDrawing('text', { x: 10, y: 20 }),
      { x: 11, y: 21 },
    );

    expect(finishDrawing(session, 'text-1')).toBeNull();
  });

  it('uses the selected pen and mosaic widths', () => {
    const pen = continueDrawing(startDrawing('pen', { x: 1, y: 1 }), { x: 4, y: 4 });
    const mosaic = continueDrawing(startDrawing('mosaic', { x: 1, y: 1 }), { x: 4, y: 4 });

    expect(finishDrawing(pen, 'pen-width', { strokeWidth: 9 })).toMatchObject({ strokeWidth: 9 });
    expect(finishDrawing(mosaic, 'mosaic-width', { mosaicBrushWidth: 36 })).toMatchObject({ brushWidth: 36 });
  });
});
