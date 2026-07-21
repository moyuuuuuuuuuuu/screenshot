import type { Annotation } from './annotations';

export type EditorHistory = Readonly<{
  past: readonly (readonly Annotation[])[];
  present: readonly Annotation[];
  future: readonly (readonly Annotation[])[];
}>;

export function createEditorHistory(): EditorHistory {
  return { past: [], present: [], future: [] };
}

function commit(
  history: EditorHistory,
  next: readonly Annotation[],
): EditorHistory {
  return {
    past: [...history.past, history.present],
    present: next,
    future: [],
  };
}

export function addAnnotation(
  history: EditorHistory,
  annotation: Annotation,
): EditorHistory {
  return commit(history, [...history.present, annotation]);
}

export function replaceAnnotation(
  history: EditorHistory,
  annotation: Annotation,
): EditorHistory {
  const index = history.present.findIndex((item) => item.id === annotation.id);
  if (index < 0) {
    return history;
  }

  return commit(
    history,
    history.present.map((item) =>
      item.id === annotation.id ? annotation : item,
    ),
  );
}

export function removeAnnotation(
  history: EditorHistory,
  annotationId: string,
): EditorHistory {
  if (!history.present.some((item) => item.id === annotationId)) {
    return history;
  }

  return commit(
    history,
    history.present.filter((item) => item.id !== annotationId),
  );
}

export function undo(history: EditorHistory): EditorHistory {
  const previous = history.past.at(-1);
  if (!previous) {
    return history;
  }

  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: EditorHistory): EditorHistory {
  const next = history.future[0];
  if (!next) {
    return history;
  }

  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}
