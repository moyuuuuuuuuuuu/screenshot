import { describe, expect, it } from 'vitest';
import type { ResizeHandle } from './geometry';
import { moveSelection, resizeSelection } from './resize-selection';

const rect = { x: 20, y: 20, width: 100, height: 80 };
const bounds = { x: 0, y: 0, width: 300, height: 200 };

describe('resizeSelection', () => {
  it.each<[ResizeHandle, { x: number; y: number; width: number; height: number }]>([
    ['nw', { x: 30, y: 25, width: 90, height: 75 }],
    ['n', { x: 20, y: 25, width: 100, height: 75 }],
    ['ne', { x: 20, y: 25, width: 110, height: 75 }],
    ['e', { x: 20, y: 20, width: 110, height: 80 }],
    ['se', { x: 20, y: 20, width: 110, height: 85 }],
    ['s', { x: 20, y: 20, width: 100, height: 85 }],
    ['sw', { x: 30, y: 20, width: 90, height: 85 }],
    ['w', { x: 30, y: 20, width: 90, height: 80 }],
  ])('resizes the %s handle', (handle, expected) => {
    expect(resizeSelection(rect, handle, { x: 10, y: 5 }, bounds)).toEqual(expected);
  });

  it('enforces an eight-pixel minimum size', () => {
    expect(resizeSelection(rect, 'w', { x: 200, y: 0 }, bounds)).toEqual({
      x: 112,
      y: 20,
      width: 8,
      height: 80,
    });
  });

  it('supports negative virtual desktop bounds', () => {
    expect(
      resizeSelection(
        { x: -80, y: -40, width: 50, height: 40 },
        'nw',
        { x: -50, y: -50 },
        { x: -100, y: -50, width: 200, height: 100 },
      ),
    ).toEqual({ x: -100, y: -50, width: 70, height: 50 });
  });
});

describe('moveSelection', () => {
  it('moves within bounds', () => {
    expect(moveSelection(rect, { x: 15, y: -10 }, bounds)).toEqual({
      x: 35,
      y: 10,
      width: 100,
      height: 80,
    });
  });

  it('clamps the whole rectangle inside bounds', () => {
    expect(moveSelection(rect, { x: 500, y: 500 }, bounds)).toEqual({
      x: 200,
      y: 120,
      width: 100,
      height: 80,
    });
  });
});
