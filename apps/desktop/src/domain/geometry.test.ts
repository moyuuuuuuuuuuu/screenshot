import { describe, expect, it } from 'vitest';
import { clampRect, hitTestHandle, normalizeRect } from './geometry';

describe('selection geometry', () => {
  it('normalizes a bottom-right to top-left drag', () => {
    expect(normalizeRect({ x: 80, y: 60 }, { x: 20, y: 10 })).toEqual({
      x: 20,
      y: 10,
      width: 60,
      height: 50,
    });
  });

  it('clamps a rectangle to virtual desktop bounds', () => {
    expect(
      clampRect(
        { x: -20, y: 10, width: 100, height: 80 },
        { x: 0, y: 0, width: 60, height: 60 },
      ),
    ).toEqual({ x: 0, y: 10, width: 60, height: 50 });
  });

  it('returns an empty rectangle when there is no intersection', () => {
    expect(
      clampRect(
        { x: 100, y: 100, width: 10, height: 10 },
        { x: 0, y: 0, width: 60, height: 60 },
      ),
    ).toEqual({ x: 60, y: 60, width: 0, height: 0 });
  });

  it('detects the south-east resize handle', () => {
    expect(
      hitTestHandle(
        { x: 101, y: 79 },
        { x: 20, y: 10, width: 80, height: 70 },
        6,
      ),
    ).toBe('se');
  });

  it('returns null away from every resize handle', () => {
    expect(
      hitTestHandle(
        { x: 60, y: 40 },
        { x: 20, y: 10, width: 80, height: 70 },
        6,
      ),
    ).toBeNull();
  });
});
