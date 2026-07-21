# Desktop Editor Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a testable Tauri-ready React screenshot overlay with selection geometry, an undoable annotation model, Canvas rendering, a unified icon toolbar, and a mock desktop bridge.

**Architecture:** A Vite React app owns the overlay UI and delegates pure geometry, editor history, and rendering to framework-independent TypeScript modules. A typed `DesktopBridge` isolates the UI from Tauri so browser tests use an in-memory implementation and the later native plan can add Rust commands without rewriting the editor.

**Tech Stack:** Node.js 22, pnpm 10, TypeScript 5.8+, React 19, Vite 7, Vitest 3, Testing Library, Canvas 2D, Lucide React, Tauri 2 (configuration only in this phase)

## Global Constraints

- Windows 10/11 is the first supported runtime; platform access must remain behind `DesktopBridge`.
- The toolbar displays icons only: 20×20 SVG, 1.8px stroke, round caps/joins, and 36×36 hit targets.
- Rectangle, arrow, pen, text, and mosaic are in scope; scrolling capture, history gallery, pin-to-desktop, color picker, and numbered labels are out of scope.
- Editing, copying, and saving must not require a network connection.
- TypeScript uses strict mode; production source files must not use `any`.
- Each task is committed only after its focused tests and the full test suite pass.

---

## File Map

- `package.json`: workspace scripts and pinned package-manager declaration.
- `pnpm-workspace.yaml`: monorepo package discovery.
- `apps/desktop/package.json`: desktop webview dependencies and scripts.
- `apps/desktop/src/domain/geometry.ts`: points, rectangles, normalization, clamping, and selection handles.
- `apps/desktop/src/domain/annotations.ts`: annotation types and immutable constructors.
- `apps/desktop/src/domain/editor-history.ts`: undo/redo command history.
- `apps/desktop/src/render/render-annotations.ts`: Canvas rendering for all annotation kinds.
- `apps/desktop/src/bridge/desktop-bridge.ts`: platform-neutral clipboard/save contract.
- `apps/desktop/src/bridge/browser-desktop-bridge.ts`: development and test implementation.
- `apps/desktop/src/components/SelectionOverlay.tsx`: pointer-driven region selection.
- `apps/desktop/src/components/Toolbar.tsx`: icon-only tool actions.
- `apps/desktop/src/components/ScreenshotEditor.tsx`: overlay state orchestration.
- `apps/desktop/src/styles.css`: dark overlay and exact toolbar sizing.
- `apps/desktop/src-tauri/tauri.conf.json`: Tauri window metadata used by the native phase.

---

### Task 1: Workspace and Test Harness

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/vite.config.ts`
- Create: `apps/desktop/index.html`
- Create: `apps/desktop/src/main.tsx`
- Create: `apps/desktop/src/App.tsx`
- Create: `apps/desktop/src/test/setup.ts`
- Test: `apps/desktop/src/App.test.tsx`

**Interfaces:**
- Produces: `pnpm test`, `pnpm typecheck`, and `pnpm --filter @screenshot/desktop dev` commands.
- Produces: React root component `App(): JSX.Element`.

- [ ] **Step 1: Create workspace manifests and a failing smoke test**

```json
// package.json
{
  "name": "screenshot-tool",
  "private": true,
  "packageManager": "pnpm@10.13.1",
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - apps/*
  - packages/*
```

```tsx
// apps/desktop/src/App.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders the screenshot overlay', () => {
    render(<App />);
    expect(screen.getByLabelText('截图编辑器')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Install dependencies and verify the smoke test fails**

Run: `pnpm install && pnpm --filter @screenshot/desktop test -- --run`

Expected: FAIL because `./App` does not exist.

- [ ] **Step 3: Add Vite/Vitest configuration and minimal app**

```ts
// apps/desktop/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'] },
});
```

```tsx
// apps/desktop/src/App.tsx
export function App() {
  return <main aria-label="截图编辑器" />;
}
```

Add strict TypeScript settings (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) and Testing Library matchers in `src/test/setup.ts`.

- [ ] **Step 4: Run smoke test and typecheck**

Run: `pnpm --filter @screenshot/desktop test -- --run && pnpm typecheck`

Expected: one passing test and zero TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml apps/desktop
git commit -m "build: scaffold desktop editor workspace"
```

---

### Task 2: Selection Geometry

**Files:**
- Create: `apps/desktop/src/domain/geometry.ts`
- Test: `apps/desktop/src/domain/geometry.test.ts`

**Interfaces:**
- Produces: `Point`, `Rect`, `normalizeRect(start, end)`, `clampRect(rect, bounds)`, and `hitTestHandle(point, rect, radius)`.
- `Rect` fields are `x`, `y`, `width`, and `height`, all finite CSS-pixel numbers.

- [ ] **Step 1: Write failing geometry tests**

```ts
import { describe, expect, it } from 'vitest';
import { clampRect, hitTestHandle, normalizeRect } from './geometry';

describe('selection geometry', () => {
  it('normalizes a bottom-right to top-left drag', () => {
    expect(normalizeRect({ x: 80, y: 60 }, { x: 20, y: 10 })).toEqual({
      x: 20, y: 10, width: 60, height: 50,
    });
  });

  it('clamps a rectangle to virtual desktop bounds', () => {
    expect(clampRect({ x: -20, y: 10, width: 100, height: 80 }, { x: 0, y: 0, width: 60, height: 60 }))
      .toEqual({ x: 0, y: 10, width: 60, height: 50 });
  });

  it('detects the south-east resize handle', () => {
    expect(hitTestHandle({ x: 101, y: 79 }, { x: 20, y: 10, width: 80, height: 70 }, 6)).toBe('se');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @screenshot/desktop test -- --run src/domain/geometry.test.ts`

Expected: FAIL because `geometry.ts` does not exist.

- [ ] **Step 3: Implement pure geometry functions**

```ts
export type Point = Readonly<{ x: number; y: number }>;
export type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export function normalizeRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}
```

Implement `clampRect` by intersecting edges and `hitTestHandle` by checking the eight handle centers in nearest-first order.

- [ ] **Step 4: Run focused and full tests**

Run: `pnpm --filter @screenshot/desktop test -- --run src/domain/geometry.test.ts && pnpm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/domain/geometry.ts apps/desktop/src/domain/geometry.test.ts
git commit -m "feat: add screenshot selection geometry"
```

---

### Task 3: Annotation Model and Undo/Redo

**Files:**
- Create: `apps/desktop/src/domain/annotations.ts`
- Create: `apps/desktop/src/domain/editor-history.ts`
- Test: `apps/desktop/src/domain/editor-history.test.ts`

**Interfaces:**
- Consumes: `Point` and `Rect` from `domain/geometry.ts`.
- Produces: discriminated union `Annotation = RectangleAnnotation | ArrowAnnotation | PenAnnotation | TextAnnotation | MosaicAnnotation`.
- Produces: `EditorHistory.create()`, `execute(command)`, `undo()`, `redo()`, `present`, `canUndo`, and `canRedo`.

- [ ] **Step 1: Write failing history tests**

```ts
import { describe, expect, it } from 'vitest';
import { addAnnotation, createEditorHistory, redo, undo } from './editor-history';
import type { RectangleAnnotation } from './annotations';

const rectangle: RectangleAnnotation = {
  id: 'rect-1', kind: 'rectangle', rect: { x: 1, y: 2, width: 30, height: 20 },
  stroke: '#ff4d4f', strokeWidth: 2,
};

it('undoes and redoes annotation insertion', () => {
  const added = addAnnotation(createEditorHistory(), rectangle);
  expect(added.present).toEqual([rectangle]);
  expect(undo(added).present).toEqual([]);
  expect(redo(undo(added)).present).toEqual([rectangle]);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @screenshot/desktop test -- --run src/domain/editor-history.test.ts`

Expected: FAIL because the domain modules do not exist.

- [ ] **Step 3: Implement immutable annotation types and history**

```ts
export type EditorHistory = Readonly<{
  past: readonly (readonly Annotation[])[];
  present: readonly Annotation[];
  future: readonly (readonly Annotation[])[];
}>;

export function addAnnotation(history: EditorHistory, annotation: Annotation): EditorHistory {
  return {
    past: [...history.past, history.present],
    present: [...history.present, annotation],
    future: [],
  };
}
```

Define every annotation with a stable `id`; pen and mosaic store `readonly Point[]`; text stores `position`, `text`, `fontSize`, and `color`.

- [ ] **Step 4: Add tests for redo invalidation and empty undo/redo, then run all tests**

Run: `pnpm --filter @screenshot/desktop test -- --run src/domain/editor-history.test.ts && pnpm typecheck && pnpm test`

Expected: all history cases pass; zero type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/domain
git commit -m "feat: add undoable annotation model"
```

---

### Task 4: Canvas Annotation Renderer

**Files:**
- Create: `apps/desktop/src/render/render-annotations.ts`
- Create: `apps/desktop/src/render/mosaic.ts`
- Test: `apps/desktop/src/render/render-annotations.test.ts`

**Interfaces:**
- Consumes: `Annotation` and a source `CanvasImageSource`.
- Produces: `renderAnnotations(ctx: CanvasRenderingContext2D, source: CanvasImageSource, annotations: readonly Annotation[], size: {width:number;height:number}): void`.
- Produces: `pixelateRegion(ctx, source, points, brushWidth, blockSize)` used only by the renderer.

- [ ] **Step 1: Write failing renderer interaction tests**

```ts
it('renders the source before vector annotations', () => {
  const ctx = createMockContext();
  renderAnnotations(ctx, source, [rectangle], { width: 100, height: 80 });
  expect(ctx.calls[0]?.name).toBe('drawImage');
  expect(ctx.calls.map((call) => call.name)).toContain('strokeRect');
});
```

The mock context records method names and arguments; tests also assert arrowhead path operations, pen round caps, text font assignment, and mosaic offscreen sampling.

- [ ] **Step 2: Run renderer tests to verify failure**

Run: `pnpm --filter @screenshot/desktop test -- --run src/render/render-annotations.test.ts`

Expected: FAIL because `render-annotations.ts` does not exist.

- [ ] **Step 3: Implement source-first rendering and per-kind functions**

```ts
export function renderAnnotations(ctx, source, annotations, size): void {
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.drawImage(source, 0, 0, size.width, size.height);
  for (const annotation of annotations) {
    switch (annotation.kind) {
      case 'rectangle': renderRectangle(ctx, annotation); break;
      case 'arrow': renderArrow(ctx, annotation); break;
      case 'pen': renderPen(ctx, annotation); break;
      case 'text': renderText(ctx, annotation); break;
      case 'mosaic': renderMosaic(ctx, source, annotation); break;
    }
  }
}
```

Mosaic must sample the original source into an offscreen canvas, scale down with smoothing disabled, scale back up, clip to the brush path, and then composite it. It must never sample already-rendered annotations.

- [ ] **Step 4: Run renderer, full tests, and typecheck**

Run: `pnpm --filter @screenshot/desktop test -- --run src/render/render-annotations.test.ts && pnpm test && pnpm typecheck`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/render
git commit -m "feat: render screenshot annotations and mosaic"
```

---

### Task 5: Typed Desktop Bridge

**Files:**
- Create: `apps/desktop/src/bridge/desktop-bridge.ts`
- Create: `apps/desktop/src/bridge/browser-desktop-bridge.ts`
- Test: `apps/desktop/src/bridge/browser-desktop-bridge.test.ts`

**Interfaces:**
- Produces: `DesktopBridge.copyPng(blob: Blob): Promise<void>`, `savePng(blob: Blob, suggestedName: string): Promise<string | null>`, and `closeOverlay(): Promise<void>`.
- Produces: `createBrowserDesktopBridge(dependencies)` for tests and browser development.

- [ ] **Step 1: Write failing bridge tests**

```ts
it('downloads a PNG with the suggested filename', async () => {
  const clicked: string[] = [];
  const bridge = createBrowserDesktopBridge({
    writeClipboard: vi.fn(),
    download: (_blob, filename) => clicked.push(filename),
    close: vi.fn(),
  });
  await expect(bridge.savePng(new Blob(), '截图-20260721-182000.png')).resolves.toBe('截图-20260721-182000.png');
  expect(clicked).toEqual(['截图-20260721-182000.png']);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @screenshot/desktop test -- --run src/bridge/browser-desktop-bridge.test.ts`

Expected: FAIL because the bridge modules do not exist.

- [ ] **Step 3: Implement the contract and injected browser adapter**

```ts
export interface DesktopBridge {
  copyPng(blob: Blob): Promise<void>;
  savePng(blob: Blob, suggestedName: string): Promise<string | null>;
  closeOverlay(): Promise<void>;
}
```

The browser adapter delegates all side effects to injected functions so tests never use a real clipboard or download.

- [ ] **Step 4: Run focused and full validation**

Run: `pnpm --filter @screenshot/desktop test -- --run src/bridge/browser-desktop-bridge.test.ts && pnpm test && pnpm typecheck`

Expected: all checks pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/bridge
git commit -m "feat: isolate desktop output behind typed bridge"
```

---

### Task 6: Icon-Only Toolbar and Overlay Orchestration

**Files:**
- Create: `apps/desktop/src/components/Toolbar.tsx`
- Create: `apps/desktop/src/components/SelectionOverlay.tsx`
- Create: `apps/desktop/src/components/ScreenshotEditor.tsx`
- Create: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/App.tsx`
- Test: `apps/desktop/src/components/Toolbar.test.tsx`
- Test: `apps/desktop/src/components/ScreenshotEditor.test.tsx`

**Interfaces:**
- Consumes: geometry functions, editor history, renderer, and `DesktopBridge`.
- Produces: `Toolbar({activeTool, canUndo, canRedo, onAction})` with `Tool = 'rectangle' | 'arrow' | 'pen' | 'text' | 'mosaic'`.
- Produces: `ScreenshotEditor({sourceUrl, bridge})` and keyboard actions Enter, Escape, Ctrl+S, Ctrl+Z, Ctrl+Shift+Z.

- [ ] **Step 1: Write failing toolbar accessibility and sizing tests**

```tsx
it('renders icon-only actions with accessible names', () => {
  render(<Toolbar activeTool="rectangle" canUndo={false} canRedo={false} onAction={vi.fn()} />);
  expect(screen.getByRole('button', { name: '矩形' })).toHaveAttribute('title', '矩形');
  expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
  expect(screen.queryByText('矩形')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run component tests to verify failure**

Run: `pnpm --filter @screenshot/desktop test -- --run src/components`

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement toolbar with Lucide icons**

```tsx
const toolActions = [
  ['rectangle', Square, '矩形'], ['arrow', ArrowUpRight, '箭头'],
  ['pen', PenLine, '画笔'], ['text', Type, '文字'], ['mosaic', Grid2X2, '马赛克'],
] as const;

return <div className="toolbar" role="toolbar" aria-label="截图工具">
  {toolActions.map(([action, Icon, label]) => (
    <button key={action} className="toolbar__button" aria-label={label} title={label}
      aria-pressed={activeTool === action} onClick={() => onAction(action)}>
      <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
    </button>
  ))}
</div>;
```

CSS fixes every button at 36×36, SVG at 20×20, and applies round line caps/joins. Labels appear only through the native `title` tooltip after hover; no visible label element is rendered.

- [ ] **Step 4: Implement selection and editor orchestration**

`SelectionOverlay` uses pointer capture and `normalizeRect` while dragging. `ScreenshotEditor` owns selection, active tool, annotation history, Canvas refs, and bridge calls. It places the toolbar at the selection's lower-right and flips it above when `selection.bottom + 52 > viewport.height`.

- [ ] **Step 5: Add keyboard and failure-preservation tests**

```tsx
it('keeps editor state when clipboard output rejects', async () => {
  const bridge = bridgeRejectingCopy();
  render(<ScreenshotEditor sourceUrl="/fixture.png" bridge={bridge} />);
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent('复制失败');
  expect(screen.getByLabelText('截图编辑器')).toBeInTheDocument();
});
```

Run: `pnpm --filter @screenshot/desktop test -- --run src/components && pnpm test && pnpm typecheck`

Expected: toolbar, selection, keyboard, and output-failure tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src
git commit -m "feat: build icon-only screenshot editor overlay"
```

---

### Task 7: Tauri-Ready Configuration and Phase Verification

**Files:**
- Create: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/build.rs`
- Create: `apps/desktop/src-tauri/src/main.rs`
- Create: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `apps/desktop/package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: the Vite build at `apps/desktop/dist`.
- Produces: a transparent, undecorated, always-on-top `overlay` window configuration.
- Defers real capture, clipboard, save dialog, tray, and global shortcut commands to the Windows native integration plan.

- [ ] **Step 1: Add Tauri configuration with a compile-time smoke command**

```rust
#[tauri::command]
fn platform_name() -> &'static str {
    "windows"
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![platform_name])
        .run(tauri::generate_context!())
        .expect("failed to run screenshot tool");
}
```

The window config uses `decorations: false`, `transparent: true`, `alwaysOnTop: true`, `skipTaskbar: true`, and starts hidden.

- [ ] **Step 2: Document prerequisites and browser-development command**

README commands:

```bash
pnpm install
pnpm --filter @screenshot/desktop dev
pnpm test
pnpm typecheck
```

Document that Windows Tauri packaging additionally requires the Rust stable MSVC toolchain and WebView2; absence of Rust must not block browser editor tests.

- [ ] **Step 3: Run phase verification**

Run: `pnpm test && pnpm typecheck && pnpm --filter @screenshot/desktop build`

Expected: all tests pass, typecheck exits 0, and Vite produces `apps/desktop/dist/index.html`.

If a Rust MSVC toolchain is present, also run `pnpm --filter @screenshot/desktop tauri build --debug`; otherwise record the missing prerequisite and leave native compilation to the next plan.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri apps/desktop/package.json README.md
git commit -m "build: add Tauri-ready desktop configuration"
```

## Phase Completion Criteria

- Browser overlay supports region selection and icon-only annotation controls.
- All five annotation types have pure domain models and Canvas rendering paths.
- Undo/redo, copy, save, completion, cancellation, and keyboard behavior are test-covered.
- Platform side effects are isolated behind `DesktopBridge`.
- `pnpm test`, `pnpm typecheck`, and the Vite production build pass.
- The repository is ready for the next plan: Windows capture, DPI, clipboard, tray, and global shortcut integration.
