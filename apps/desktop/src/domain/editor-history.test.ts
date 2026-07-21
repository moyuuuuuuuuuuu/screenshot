import { describe, expect, it } from 'vitest';
import type { RectangleAnnotation } from './annotations';
import {
  addAnnotation,
  createEditorHistory,
  redo,
  removeAnnotation,
  replaceAnnotation,
  undo,
} from './editor-history';

const rectangle: RectangleAnnotation = {
  id: 'rect-1',
  kind: 'rectangle',
  rect: { x: 1, y: 2, width: 30, height: 20 },
  stroke: '#ff4d4f',
  strokeWidth: 2,
};

describe('editor history', () => {
  it('undoes and redoes annotation insertion', () => {
    const added = addAnnotation(createEditorHistory(), rectangle);

    expect(added.present).toEqual([rectangle]);
    expect(undo(added).present).toEqual([]);
    expect(redo(undo(added)).present).toEqual([rectangle]);
  });

  it('invalidates redo after a new edit', () => {
    const undone = undo(addAnnotation(createEditorHistory(), rectangle));
    const replacement = { ...rectangle, id: 'rect-2' };
    const branched = addAnnotation(undone, replacement);

    expect(branched.future).toEqual([]);
    expect(redo(branched)).toBe(branched);
  });

  it('replaces and removes annotations through undoable edits', () => {
    const added = addAnnotation(createEditorHistory(), rectangle);
    const moved = { ...rectangle, rect: { ...rectangle.rect, x: 20 } };
    const replaced = replaceAnnotation(added, moved);
    const removed = removeAnnotation(replaced, rectangle.id);

    expect(replaced.present).toEqual([moved]);
    expect(removed.present).toEqual([]);
    expect(undo(removed).present).toEqual([moved]);
  });

  it('keeps identity when undo or redo is unavailable', () => {
    const initial = createEditorHistory();

    expect(undo(initial)).toBe(initial);
    expect(redo(initial)).toBe(initial);
  });
});
