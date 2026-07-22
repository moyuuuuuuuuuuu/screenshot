# Long Capture Sidecar and Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manual long capture scroll through the selected application, replace the overlapping preview with an outside-only sidecar, reset cancelled sessions, and render the ordinary screenshot mask at exactly 0.3 alpha.

**Architecture:** Keep the full-screen overlay as the capture-session owner, but make it mouse-transparent and visually transparent during long capture. Move all interactive long-capture controls into a 120–172 physical-pixel sidecar that never intersects the selected rectangle. Give cancellation a dedicated reset path shared by native Escape and the frontend, and close the sidecar before hiding or restoring the overlay.

**Tech Stack:** Rust 2021, Tauri 2, React 19, TypeScript 5.8, CSS, Lucide React, Vitest, Cargo test/Clippy.

## Global Constraints

- Work directly on `main`, as explicitly approved by the user.
- Execute inline in this session; do not create worktrees or subagents.
- Use red-green-refactor for every behavior change and observe each focused test fail before production edits.
- Long capture remains manual; do not add automatic scrolling.
- The selected rectangle must receive the underlying application's mouse-wheel input.
- The long-capture sidecar must never intersect the selected rectangle.
- Sidecar desired width is 172 physical pixels; minimum width is 120 physical pixels.
- Ordinary screenshot mask alpha is exactly `0.3`; selected pixels remain unmasked.
- Long-capture presentation has no mask fill and retains only the selection border.
- Escape and Cancel discard output, reset the editor, and exit; Edit, Save, and Finish retain output.
- Keep the current 20 px Lucide icons with 1.8 px strokes.
- Do not change motion detection, overlap matching, or stitching thresholds.

---

### Task 1: Compute an Outside-Only Native Sidecar Layout

**Files:**
- Modify: `apps/desktop/src-tauri/src/preview_windows.rs`

**Interfaces:**
- Consumes: `ScreenRect { x, y, width, height }` in physical screen coordinates.
- Produces: `preview_window_layout(selection: ScreenRect, monitor: ScreenRect) -> Result<PreviewLayout, String>`.
- `PreviewLayout` continues to expose `x`, `y`, `width`, `height`, and `side`; it no longer exposes unused action offsets.
- Returns `Err("not enough space outside the selection for long-capture controls")` when neither side has 120 physical pixels.

- [ ] **Step 1: Replace the current layout expectations with non-intersection tests**

Add this helper inside the test module:

```rust
fn intersects(a: ScreenRect, b: ScreenRect) -> bool {
    a.x < b.x + b.width
        && a.x + a.width > b.x
        && a.y < b.y + b.height
        && a.y + a.height > b.y
}

fn layout_rect(layout: PreviewLayout) -> ScreenRect {
    ScreenRect {
        x: layout.x,
        y: layout.y,
        width: layout.width,
        height: layout.height,
    }
}
```

Test these exact behaviors:

```rust
#[test]
fn places_a_172_pixel_sidecar_to_the_right_without_overlapping() {
    let selection = ScreenRect { x: 100, y: 80, width: 500, height: 600 };
    let layout = preview_window_layout(
        selection,
        ScreenRect { x: 0, y: 0, width: 1920, height: 1080 },
    ).unwrap();
    assert_eq!(layout.side, PreviewSide::Right);
    assert_eq!(layout.x, 600);
    assert_eq!(layout.width, 172);
    assert!(!intersects(selection, layout_rect(layout)));
}

#[test]
fn falls_back_to_the_left_without_overlapping() {
    let selection = ScreenRect { x: 1650, y: 80, width: 250, height: 500 };
    let layout = preview_window_layout(
        selection,
        ScreenRect { x: 0, y: 0, width: 1920, height: 1080 },
    ).unwrap();
    assert_eq!(layout.side, PreviewSide::Left);
    assert_eq!(layout.x + layout.width, selection.x);
    assert!(!intersects(selection, layout_rect(layout)));
}

#[test]
fn narrows_to_available_space_down_to_120_pixels() {
    let selection = ScreenRect { x: 140, y: 80, width: 1740, height: 500 };
    let layout = preview_window_layout(
        selection,
        ScreenRect { x: 0, y: 0, width: 2048, height: 1080 },
    ).unwrap();
    assert_eq!(layout.side, PreviewSide::Right);
    assert_eq!(layout.width, 160);
    assert!(!intersects(selection, layout_rect(layout)));
}

#[test]
fn rejects_layout_when_both_sides_are_narrower_than_120_pixels() {
    let error = preview_window_layout(
        ScreenRect { x: 100, y: 80, width: 1720, height: 500 },
        ScreenRect { x: 0, y: 0, width: 1920, height: 1080 },
    ).unwrap_err();
    assert_eq!(error, "not enough space outside the selection for long-capture controls");
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml preview_windows
```

Expected: FAIL because the current layout starts at `selection.x`, spans `selection.width + 172`, and returns `PreviewLayout` instead of `Result`.

- [ ] **Step 3: Implement the outside-only layout**

Replace `preview_window_layout` with logic equivalent to:

```rust
pub(crate) fn preview_window_layout(
    selection: ScreenRect,
    monitor: ScreenRect,
) -> Result<PreviewLayout, String> {
    const DESIRED_WIDTH: i32 = 172;
    const MIN_WIDTH: i32 = 120;
    const MARGIN: i32 = 8;

    let monitor_left = monitor.x + MARGIN;
    let monitor_right = monitor.x + monitor.width - MARGIN;
    let selection_left = selection.x;
    let selection_right = selection.x + selection.width;
    let left_space = (selection_left - monitor_left).max(0);
    let right_space = (monitor_right - selection_right).max(0);

    let side = if right_space >= DESIRED_WIDTH {
        PreviewSide::Right
    } else if left_space >= DESIRED_WIDTH {
        PreviewSide::Left
    } else if right_space >= left_space {
        PreviewSide::Right
    } else {
        PreviewSide::Left
    };
    let available = match side {
        PreviewSide::Left => left_space,
        PreviewSide::Right => right_space,
    };
    if available < MIN_WIDTH {
        return Err("not enough space outside the selection for long-capture controls".to_string());
    }
    let width = available.min(DESIRED_WIDTH);
    let x = match side {
        PreviewSide::Left => selection_left - width,
        PreviewSide::Right => selection_right,
    };
    let height = selection.height.min(monitor.height - MARGIN * 2).max(160);
    let y = selection.y.clamp(
        monitor.y + MARGIN,
        monitor.y + monitor.height - height - MARGIN,
    );
    Ok(PreviewLayout { x, y, width, height, side })
}
```

Remove `actions_right` and `actions_bottom`. In `open_preview_window`, call `preview_window_layout(selection, monitor)?`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command.

Expected: all `preview_windows` tests PASS.

- [ ] **Step 5: Commit the native layout**

```bash
git add apps/desktop/src-tauri/src/preview_windows.rs
git commit -m "fix: keep long capture controls outside selection"
```

---

### Task 2: Render the Preview as a Narrow Sidecar

**Files:**
- Modify: `apps/desktop/src/components/ScrollCapturePreview.tsx`
- Modify: `apps/desktop/src/components/ScrollCapturePreview.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: existing `LongCaptureProgress.previewPngBytes` and `navigatorPngBytes`.
- Produces: `.scroll-sidecar` with `.scroll-sidecar__preview`, `.scroll-sidecar__navigator`, optional warning, and `.scroll-sidecar__actions`.
- Must not produce `.scroll-preview__stage`, the element that currently fills the selected area.

- [ ] **Step 1: Write a failing component contract test**

Replace the existing layout test assertions with:

```tsx
expect(await screen.findByRole('img', { name: '累计长截图预览' }))
  .toHaveClass('scroll-sidecar__preview');
expect(screen.getByRole('img', { name: '长截图导航' }))
  .toHaveClass('scroll-sidecar__navigator');
expect(screen.getByRole('toolbar', { name: '长截图操作' }))
  .toHaveClass('scroll-sidecar__actions');
expect(document.querySelector('.scroll-preview__stage')).not.toBeInTheDocument();
expect(document.querySelector('.scroll-sidecar')).toHaveAttribute('data-side', 'right');
```

Keep the four action click assertions and 20 px / 1.8 stroke icon assertions.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @screenshot/desktop exec vitest --run src/components/ScrollCapturePreview.test.tsx
```

Expected: FAIL because the current component renders `.scroll-preview`, `.scroll-preview__stage`, and the old class names.

- [ ] **Step 3: Implement sidecar-only markup**

Render this structure while preserving the polling and action callbacks:

```tsx
<main className="scroll-sidecar" data-side={side}>
  <div className="scroll-sidecar__preview-wrap">
    {preview ? <img className="scroll-sidecar__preview" src={preview} alt="累计长截图预览" /> : null}
    <span className="scroll-sidecar__prompt">滚动页面截取更多内容</span>
  </div>
  <div className="scroll-sidecar__navigator-wrap">
    {navigator ? <img className="scroll-sidecar__navigator" src={navigator} alt="长截图导航" /> : null}
  </div>
  {progress?.slowScrollWarning
    ? <div className="scroll-sidecar__warning" role="status">请慢一点滚动</div>
    : null}
  <div className="scroll-sidecar__actions" role="toolbar" aria-label="长截图操作">
    {/* existing four icon buttons */}
  </div>
</main>
```

Replace the old scroll-preview CSS with a full-window vertical sidecar:

```css
.scroll-sidecar { position: relative; display: grid; width: 100vw; height: 100vh; grid-template-rows: minmax(0, 1fr) minmax(72px, 30%) auto; gap: 6px; padding: 6px; overflow: hidden; border: 1px solid rgba(7, 193, 96, .75); border-radius: 6px; background: rgba(25, 25, 25, .86); }
.scroll-sidecar__preview-wrap, .scroll-sidecar__navigator-wrap { position: relative; min-height: 0; overflow: hidden; border-radius: 4px; background: #fff; }
.scroll-sidecar__preview, .scroll-sidecar__navigator { display: block; width: 100%; height: 100%; object-fit: contain; object-position: center bottom; }
.scroll-sidecar__prompt { position: absolute; left: 50%; bottom: 6px; transform: translateX(-50%); padding: 4px 6px; border-radius: 4px; background: rgba(25,25,25,.72); color: #fff; font-size: 11px; white-space: nowrap; }
.scroll-sidecar__actions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
.scroll-sidecar__actions button { display: grid; min-width: 0; height: 34px; padding: 7px; place-items: center; border: 0; border-radius: 6px; background: #fff; color: #42464a; cursor: pointer; }
.scroll-sidecar__actions button:last-child { color: #07c160; }
.scroll-sidecar__actions svg { width: 20px; height: 20px; }
@media (max-width: 149px) { .scroll-sidecar__actions { grid-template-columns: repeat(2, 36px); justify-content: center; } }
```

Move the current warning styling to `.scroll-sidecar__warning`.

- [ ] **Step 4: Run focused frontend tests and verify GREEN**

Run:

```bash
pnpm --filter @screenshot/desktop exec vitest --run src/components/ScrollCapturePreview.test.tsx src/visual/wechat-parity.test.tsx
```

Expected: both files PASS; the visual parity test still sees four Lucide icons at 20 px / 1.8 stroke.

- [ ] **Step 5: Commit the sidecar UI**

```bash
git add apps/desktop/src/components/ScrollCapturePreview.tsx apps/desktop/src/components/ScrollCapturePreview.test.tsx apps/desktop/src/styles.css
git commit -m "fix: render long capture as an outside sidecar"
```

---

### Task 3: Make the Screenshot Mask a Single 0.3 Layer

**Files:**
- Modify: `apps/desktop/src/components/SelectionOverlay.tsx`
- Modify: `apps/desktop/src/components/SelectionOverlay.test.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/visual/wechat-reference-metrics.ts`
- Modify: `apps/desktop/src/visual/wechat-parity.test.tsx`

**Interfaces:**
- Produces: `.selection-surface--has-selection` whenever a non-empty selection exists.
- Visual metric: `overlayMaskAlpha: 0.3`.
- No selection: full surface has `rgba(0, 0, 0, 0.3)`.
- With selection: surface background is transparent and the selection-box outside shadow is `rgba(0, 0, 0, 0.3)`.

- [ ] **Step 1: Write failing class and visual metric tests**

In `SelectionOverlay.test.tsx`, assert the rendered surface has the new class:

```tsx
expect(screen.getByTestId('selection-surface'))
  .toHaveClass('selection-surface--has-selection');
```

Add a no-selection render and assert it does not have that class. Extend `wechatReferenceMetrics` and its parity expectation with:

```ts
overlayMaskAlpha: 0.3,
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @screenshot/desktop exec vitest --run src/components/SelectionOverlay.test.tsx src/visual/wechat-parity.test.tsx
```

Expected: FAIL because the class and metric do not exist.

- [ ] **Step 3: Implement the single-layer mask**

Build the surface class as:

```tsx
const hasSelection = Boolean(selection && selection.width > 0 && selection.height > 0);
className={`selection-surface${locked ? ' selection-surface--locked' : ''}${hasSelection ? ' selection-surface--has-selection' : ''}`}
```

Use these mask declarations:

```css
.selection-surface { cursor: crosshair; background: rgba(0, 0, 0, 0.3); touch-action: none; }
.selection-surface--has-selection { background: transparent; }
.selection-box { box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.3); }
```

This ensures exactly one 0.3 layer is visible at every outside pixel.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command.

Expected: both test files PASS.

- [ ] **Step 5: Commit the mask behavior**

```bash
git add apps/desktop/src/components/SelectionOverlay.tsx apps/desktop/src/components/SelectionOverlay.test.tsx apps/desktop/src/styles.css apps/desktop/src/visual
git commit -m "fix: set screenshot mask opacity to 0.3"
```

---

### Task 4: Reset the Frontend Session When Long Capture Is Cancelled

**Files:**
- Modify: `apps/desktop/src/domain/capture-session.ts`
- Modify: `apps/desktop/src/domain/capture-session.test.ts`
- Modify: `apps/desktop/src/components/ScreenshotEditor.tsx`
- Modify: `apps/desktop/src/components/ScreenshotEditor.test.tsx`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.test.tsx`

**Interfaces:**
- Produces: `CaptureAction` variant `{ type: 'sessionReset' }`.
- `sessionReset` returns `initialCaptureSession(state.sourceUrl)`.
- Consumes native event `capture-session-reset`; App clears `sourceUrl` and increments `session`.
- Frontend cancellation is guarded by `longCaptureCancelInFlight` so duplicate Escape delivery invokes cancel and close once.

- [ ] **Step 1: Write the failing reducer test**

Replace the existing “restores annotation state” cancellation expectation with:

```ts
it('clears selection and scroll output when a capture session is reset', () => {
  const scrolling = captureSessionReducer(annotatingSession(), { type: 'scrollStarted' });
  expect(captureSessionReducer(scrolling, { type: 'sessionReset' })).toMatchObject({
    mode: 'selecting',
    selection: null,
    scrollResult: null,
    service: null,
  });
});
```

- [ ] **Step 2: Run the reducer test and verify RED**

Run:

```bash
pnpm --filter @screenshot/desktop exec vitest --run src/domain/capture-session.test.ts
```

Expected: TypeScript/test failure because `sessionReset` is not a valid action.

- [ ] **Step 3: Implement the reducer action**

Add the union member and reducer branch:

```ts
| Readonly<{ type: 'sessionReset' }>

case 'sessionReset':
  return initialCaptureSession(state.sourceUrl);
```

Keep `scrollCancelled` for recoverable startup errors that return to the current selection.

- [ ] **Step 4: Run the reducer test and verify GREEN**

Run the Step 2 command.

Expected: reducer tests PASS.

- [ ] **Step 5: Write failing editor and App reset tests**

Extend the existing Esc test to send Escape twice and assert:

```tsx
await userEvent.keyboard('{Escape}{Escape}');
expect(bridge.cancelLongCapture).toHaveBeenCalledOnce();
expect(bridge.closeOverlay).toHaveBeenCalledOnce();
expect(screen.getByLabelText('截图编辑器')).toHaveAttribute('data-capture-mode', 'selecting');
expect(screen.queryByTestId('selection-box')).not.toBeInTheDocument();
```

In `App.test.tsx`, create a selection through pointer events, emit the reset event, and assert the old selection is removed:

```tsx
act(() => tauriListeners.get('capture-session-reset')?.({ payload: undefined }));
expect(screen.queryByTestId('selection-box')).not.toBeInTheDocument();
expect(screen.getByLabelText('截图编辑器')).toHaveAttribute('data-capture-mode', 'selecting');
```

- [ ] **Step 6: Run the focused tests and verify RED**

Run:

```bash
pnpm --filter @screenshot/desktop exec vitest --run src/components/ScreenshotEditor.test.tsx src/App.test.tsx
```

Expected: FAIL because cancellation preserves the selection, duplicate Escape is not guarded, and App does not listen for `capture-session-reset`.

- [ ] **Step 7: Implement idempotent editor reset and App event handling**

Add:

```tsx
const longCaptureCancelInFlight = useRef(false);

const resetEditorSession = useCallback(() => {
  dispatchCapture({ type: 'sessionReset' });
  setHistory(createEditorHistory());
  setActiveTool('rectangle');
  setTextPosition(null);
  setError(null);
  setServiceResult(null);
  setToast(null);
  setDrawingPreview(null);
  setLongCaptureBounds(null);
  setLongCaptureProgress(null);
  drawingSession.current = null;
  longCaptureSource.current = null;
  serviceSource.current = null;
  if (generatedSourceUrl.current) {
    URL.revokeObjectURL(generatedSourceUrl.current);
    generatedSourceUrl.current = null;
  }
}, []);
```

Update cancellation:

```tsx
const cancelLongCaptureAndClose = useCallback(async () => {
  if (longCaptureCancelInFlight.current) return;
  longCaptureCancelInFlight.current = true;
  longCaptureCancelled.current = true;
  resetEditorSession();
  try {
    await bridge.cancelLongCapture();
  } finally {
    await bridge.closeOverlay();
  }
}, [bridge, resetEditorSession]);
```

At the beginning of a new long capture, set `longCaptureCancelInFlight.current = false`. In App's effect, listen for `capture-session-reset` with the same clearing behavior as `capture-started`:

```tsx
void listen('capture-session-reset', () => {
  setCaptureError(null);
  setSourceUrl('');
  setSession((current) => current + 1);
}).then(retainUnlisten).catch(() => undefined);
```

Keep repeated Escape on the guarded path while cancellation is in flight:

```tsx
if (event.key === 'Escape') {
  if (longCaptureProgress || longCaptureCancelInFlight.current) {
    void cancelLongCaptureAndClose();
  } else {
    void bridge.closeOverlay();
  }
}
```

- [ ] **Step 8: Run focused frontend tests and verify GREEN**

Run the Step 6 command, then:

```bash
pnpm --filter @screenshot/desktop typecheck
```

Expected: focused tests and typecheck PASS.

- [ ] **Step 9: Commit the frontend reset**

```bash
git add apps/desktop/src/domain/capture-session.ts apps/desktop/src/domain/capture-session.test.ts apps/desktop/src/components/ScreenshotEditor.tsx apps/desktop/src/components/ScreenshotEditor.test.tsx apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx
git commit -m "fix: reset cancelled screenshot sessions"
```

---

### Task 5: Make Native Cleanup Close the Sidecar First

**Files:**
- Modify: `apps/desktop/src-tauri/src/long_capture.rs`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- `CaptureCleanup::drop` closes controls before restoring or hiding the overlay.
- Native cancellation emits `capture-session-reset` exactly once before the overlay remains hidden.
- Long-capture presentation keeps only `.selection-box` visible and transparent to input.

- [ ] **Step 1: Write failing cleanup-order and reset-disposition tests**

Replace the cleanup test with an ordered event assertion:

```rust
#[test]
fn cleanup_closes_controls_before_touching_the_overlay() {
    let events = Rc::new(std::cell::RefCell::new(Vec::new()));
    {
        let restore_events = Rc::clone(&events);
        let close_events = Rc::clone(&events);
        let _cleanup = CaptureCleanup::new(
            move || restore_events.borrow_mut().push("overlay"),
            move || close_events.borrow_mut().push("controls"),
        );
    }
    assert_eq!(*events.borrow(), vec!["controls", "overlay"]);
}
```

Keep `overlay_cleanup(false) == Restore` and `overlay_cleanup(true) == Hide`.

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run:

```bash
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml cleanup_
```

Expected: FAIL with actual order `["overlay", "controls"]`.

- [ ] **Step 3: Implement sidecar-first, cancellation-aware cleanup**

Reverse the two calls in `Drop`:

```rust
if let Some(close) = self.close_controls.take() {
    close();
}
if let Some(restore) = self.restore_overlay.take() {
    restore();
}
```

In the overlay cleanup closure, compute cancellation once. For cancellation, hide first, emit `capture-session-reset`, remove presentation mode, then restore non-interactive window state without showing it:

```rust
let cancelled = restore_app
    .state::<LongCaptureRuntime>()
    .is_cancel_requested();
if cancelled {
    let _ = restore_window.hide();
    let _ = restore_app.emit("capture-session-reset", ());
    let _ = restore_app.emit("long-capture-presentation", false);
    let _ = restore_window.set_ignore_cursor_events(false);
} else {
    let _ = restore_app.emit("long-capture-presentation", false);
    let _ = restore_window.set_ignore_cursor_events(false);
    let _ = restore_window.show();
    let _ = restore_window.set_focus();
}
```

The controls closure continues to close `scroll-capture-preview` and unregister global Escape.

- [ ] **Step 4: Preserve only the live selection border during long capture**

Replace the current rule that hides the entire editor with:

```css
.long-capture-presentation .screenshot-editor { background: transparent; }
.long-capture-presentation .screenshot-source,
.long-capture-presentation .annotation-canvas,
.long-capture-presentation .toolbar-positioner,
.long-capture-presentation .selection-size,
.long-capture-presentation .selection-handle,
.long-capture-presentation .editor-alert,
.long-capture-presentation .service-busy,
.long-capture-presentation .service-result,
.long-capture-presentation .editor-toast { visibility: hidden; }
.long-capture-presentation .selection-surface { background: transparent; pointer-events: none; }
.long-capture-presentation .selection-box { border-color: #07c160; box-shadow: none; }
```

The native window remains `set_ignore_cursor_events(true)`, so wheel input reaches the selected application.

- [ ] **Step 5: Run focused and full native verification**

Run:

```bash
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml cleanup_
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: cleanup order passes, all Rust tests pass, fmt exits 0, and Clippy reports no warnings.

- [ ] **Step 6: Commit native cleanup and live presentation**

```bash
git add apps/desktop/src-tauri/src/long_capture.rs apps/desktop/src/styles.css
git commit -m "fix: clean up long capture without overlay flicker"
```

---

### Task 6: Full Verification and Windows Acceptance Build

**Files:**
- Modify: `docs/superpowers/plans/2026-07-22-wechat-parity-acceptance.md`

**Interfaces:**
- Produces: debug executable `apps/desktop/src-tauri/target/debug/screenshot-tool.exe` and an acceptance record for the three reported regressions plus mask opacity.

- [ ] **Step 1: Run the complete frontend suite**

```bash
pnpm --filter @screenshot/desktop test -- --run
pnpm --filter @screenshot/desktop typecheck
pnpm --filter @screenshot/desktop build
```

Expected: all Vitest files pass, typecheck exits 0, and Vite build exits 0.

- [ ] **Step 2: Run the complete Rust quality gate**

```bash
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: fmt exits 0, Clippy reports no warnings, and all Rust tests pass.

- [ ] **Step 3: Build the Windows debug executable**

```bash
pnpm --filter @screenshot/desktop tauri:build --debug --no-bundle
```

Expected: `apps/desktop/src-tauri/target/debug/screenshot-tool.exe` is produced successfully.

- [ ] **Step 4: Record acceptance evidence**

Add a dated section to `docs/superpowers/plans/2026-07-22-wechat-parity-acceptance.md` recording:

```markdown
### 2026-07-22 sidecar and session-reset verification

- Sidecar never intersects selection: Pass (Rust layout tests); Pending Windows physical-pixel check.
- Manual wheel reaches target application: Pending Windows runtime check.
- Escape closes sidecar before overlay and discards output: Pass (Rust/React tests); Pending Windows flicker check.
- Next shortcut starts without the old selection: Pass (React/App tests); Pending Windows runtime check.
- Ordinary outside mask uses one `0.3` layer and selected pixels stay clear: Pass (component/visual metric tests); Pending visual check.
- Stitching thresholds unchanged: Pass (diff review).
```

List the exact commands and pass counts from Steps 1–3.

- [ ] **Step 5: Check the final diff and commit evidence**

```bash
git diff --check
git status --short
git add docs/superpowers/plans/2026-07-22-wechat-parity-acceptance.md
git commit -m "docs: record long capture sidecar acceptance"
```

Expected: no whitespace errors and only intentional changes are committed.

- [ ] **Step 6: Launch the debug build for user verification**

```powershell
Start-Process -FilePath 'E:\dnmp\www\screenshot\apps\desktop\src-tauri\target\debug\screenshot-tool.exe'
Get-Process screenshot-tool | Select-Object Id, ProcessName, Path
```

Expected: one `screenshot-tool` process points to the new debug executable. Ask the user to verify manual scrolling, Esc cleanup, the next fresh selection, and mask opacity.
