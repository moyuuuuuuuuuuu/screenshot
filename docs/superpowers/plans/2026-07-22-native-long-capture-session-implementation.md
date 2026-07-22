# Native Long Capture Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the full-screen overlay from the active long-capture input path, preserve the selection with four one-pixel border windows, make cancellation/session reset deterministic, and render the ordinary screenshot mask at exactly 0.3 alpha.

**Architecture:** Rust owns the long-capture window lifecycle and blocks ordinary captures until cleanup completes. During long capture the main overlay is hidden; an outside-only sidecar and four narrow, capture-excluded, mouse-transparent border windows are the only screenshot-tool windows. Native capture events carry monotonically increasing session IDs, while React ignores stale events and renders four non-overlapping mask rectangles.

**Tech Stack:** Rust 2021, Tauri 2, windows-sys, React 19, TypeScript 5.8, CSS, Vitest, Cargo test/Clippy.

## Global Constraints

- Work directly on `main`, as explicitly approved by the user.
- Execute inline in this session; do not create worktrees or subagents.
- Use red-green-refactor and observe every focused test fail before editing production code.
- Long capture remains manual; do not add automatic scrolling.
- Do not modify motion detection, overlap matching, stitching thresholds, OCR, translation, redaction, annotations, or toolbar icons.
- The selected rectangle must contain no screenshot-tool window while long capture is active.
- The sidecar and all four border windows must remain outside the selected rectangle.
- Escape and Cancel discard output, reset to `selection: null`, and exit once.
- Edit, Save, and Finish retain the existing output semantics.
- The overlay display affinity must be `WDA_NONE` outside temporary capture exclusion operations.
- Ordinary screenshot mask alpha is exactly `0.3`; mask rectangles must not overlap.

---

### Task 1: Symmetric Windows Capture Affinity

**Files:**
- Modify: `apps/desktop/src-tauri/src/platform/windows/capture_exclusion.rs`
- Modify: `apps/desktop/src-tauri/src/platform/windows.rs`
- Modify: `apps/desktop/src-tauri/src/platform/mod.rs`

**Interfaces:**
- Produces: `platform::exclude_window_from_capture(&WebviewWindow) -> Result<(), String>`.
- Produces: `platform::restore_window_capture(&WebviewWindow) -> Result<(), String>`.
- Internal helper: `apply_capture_affinity(hwnd: isize, affinity: u32, setter: impl FnOnce(isize, u32) -> bool)`.

- [ ] **Step 1: Write failing affinity tests**

Replace the hard-coded helper tests with explicit affinity assertions:

```rust
#[test]
fn exclusion_uses_exclude_from_capture() {
    let mut observed = None;
    apply_capture_affinity(42, WDA_EXCLUDEFROMCAPTURE, |hwnd, affinity| {
        observed = Some((hwnd, affinity));
        true
    }).unwrap();
    assert_eq!(observed, Some((42, 0x11)));
}

#[test]
fn restoration_uses_none() {
    let mut observed = None;
    apply_capture_affinity(42, WDA_NONE, |hwnd, affinity| {
        observed = Some((hwnd, affinity));
        true
    }).unwrap();
    assert_eq!(observed, Some((42, 0x0)));
}
```

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run: `cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml capture_exclusion`

Expected: FAIL because `apply_capture_affinity`, `WDA_NONE`, and `restore_window_capture` do not exist.

- [ ] **Step 3: Implement the symmetric API**

Use one HWND helper and two public operations:

```rust
fn set_window_capture_affinity(window: &tauri::WebviewWindow, affinity: u32) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| format!("failed to read screenshot window handle: {error}"))?;
    apply_capture_affinity(hwnd.0 as isize, affinity, |raw, value| unsafe {
        SetWindowDisplayAffinity(raw as *mut core::ffi::c_void, value) != 0
    })
}

pub fn exclude_window_from_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    set_window_capture_affinity(window, WDA_EXCLUDEFROMCAPTURE)
}

pub fn restore_window_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    set_window_capture_affinity(window, WDA_NONE)
}
```

Re-export `restore_window_capture` through `platform/windows.rs` and add a non-Windows fallback in `platform/mod.rs`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2.

Expected: all capture-exclusion tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/platform
git commit -m "fix: restore screenshot window capture affinity"
```

---

### Task 2: Outside-Only Border Window Geometry and Rendering

**Files:**
- Modify: `apps/desktop/src-tauri/src/preview_windows.rs`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Produces: `border_window_layouts(selection: ScreenRect) -> [BorderLayout; 4]`.
- Produces: `open_capture_border_windows(app: &AppHandle, selection: ScreenRect) -> Result<Vec<WebviewWindow>, String>`.
- Border labels: `scroll-border-top`, `scroll-border-right`, `scroll-border-bottom`, `scroll-border-left`.
- Border URL: `index.html?window=scroll-border`.

- [ ] **Step 1: Write failing Rust geometry tests**

Add tests proving one-pixel outside geometry:

```rust
#[test]
fn border_windows_surround_without_entering_selection() {
    let selection = ScreenRect { x: 100, y: 80, width: 500, height: 600 };
    let borders = border_window_layouts(selection);
    assert_eq!(borders[0].rect, ScreenRect { x: 100, y: 79, width: 500, height: 1 });
    assert_eq!(borders[1].rect, ScreenRect { x: 600, y: 80, width: 1, height: 600 });
    assert_eq!(borders[2].rect, ScreenRect { x: 100, y: 680, width: 500, height: 1 });
    assert_eq!(borders[3].rect, ScreenRect { x: 99, y: 80, width: 1, height: 600 });
    assert!(borders.iter().all(|border| !intersects(selection, border.rect)));
}
```

- [ ] **Step 2: Write a failing React border-window test**

Render `App` with `window.location.search = '?window=scroll-border'` and assert:

```tsx
expect(container.querySelector('.scroll-capture-border')).toBeInTheDocument();
expect(screen.queryByLabelText('截图编辑器')).not.toBeInTheDocument();
```

- [ ] **Step 3: Run both focused tests and verify RED**

Run:

```bash
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml preview_windows
pnpm --filter @screenshot/desktop exec vitest --run src/App.test.tsx
```

Expected: FAIL because the geometry helper and border-window rendering branch do not exist.

- [ ] **Step 4: Implement physical border windows**

Add `BorderLayout { label: &'static str, rect: ScreenRect }`, calculate the four rectangles shown in Step 1, and build one transparent WebView per layout. After building, apply exact physical position/size, call `set_ignore_cursor_events(true)`, and return every successfully created window. If any build fails, close already-created windows before returning the error.

Use this frontend branch before the normal editor branch:

```tsx
const borderWindow = windowKind === 'scroll-border';
if (borderWindow) return <div className="scroll-capture-border" aria-hidden="true" />;
```

Add:

```css
.scroll-capture-border { width: 100vw; height: 100vh; background: #07c160; }
```

- [ ] **Step 5: Run both focused tests and verify GREEN**

Run the commands from Step 3.

Expected: all preview-window and App tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/preview_windows.rs apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx apps/desktop/src/styles.css
git commit -m "feat: render long capture with outside border windows"
```

---

### Task 3: Native Long-Capture Window Lifecycle

**Files:**
- Modify: `apps/desktop/src-tauri/src/long_capture.rs`
- Modify: `apps/desktop/src-tauri/src/app_state.rs`
- Modify: `apps/desktop/src-tauri/src/main.rs`

**Interfaces:**
- `LongCaptureRuntime::is_active(&self) -> bool` gates ordinary capture requests.
- `prepare_capture_windows` opens/excludes the sidecar and four borders before hiding `overlay`.
- `CaptureCleanup` closes all temporary windows, restores overlay affinity/input state, then restores or resets the editor according to termination.

- [ ] **Step 1: Write failing lifecycle tests**

Add pure callback tests with an event vector:

```rust
#[test]
fn preparation_finishes_temporary_windows_before_hiding_overlay() {
    let events = Rc::new(RefCell::new(Vec::new()));
    prepare_capture_windows(
        || { events.borrow_mut().push("preview"); Ok(()) },
        || { events.borrow_mut().push("borders"); Ok(()) },
        || { events.borrow_mut().push("hide-overlay"); Ok(()) },
    ).unwrap();
    assert_eq!(*events.borrow(), vec!["preview", "borders", "hide-overlay"]);
}

#[test]
fn cancelled_cleanup_closes_temporary_windows_before_reset() {
    let events = Rc::new(RefCell::new(Vec::new()));
    run_cleanup_callbacks(
        true,
        || events.borrow_mut().push("close-temporary"),
        || events.borrow_mut().push("restore-affinity"),
        || events.borrow_mut().push("reset-session"),
        || events.borrow_mut().push("restore-editor"),
    );
    assert_eq!(*events.borrow(), vec!["close-temporary", "restore-affinity", "reset-session"]);
}
```

In `app_state.rs`, test that a capture gate rejects requests while a supplied long-capture-active predicate is true.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml long_capture
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml app_state
```

Expected: FAIL because the new preparation signature, cleanup helper, and active gate do not exist.

- [ ] **Step 3: Implement the lifecycle**

Change long-capture preparation to:

1. Convert the selection to physical coordinates.
2. Open and capture-exclude the sidecar.
3. Open, capture-exclude, and mouse-pass through all four borders.
4. Hide `overlay`; do not enable full-screen pass-through or emit `long-capture-presentation`.
5. Wait 150 ms and start `run_capture`.

Cleanup must close labels `scroll-capture-preview` and all four `scroll-border-*`, defensively call `restore_window_capture(&overlay)`, and set overlay cursor handling to normal. On cancellation, emit `capture-session-reset` before leaving the overlay hidden. On successful Edit, restore/show/focus the overlay. Expose `is_active` and make `app_state::request_capture` return immediately while it is true.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the commands from Step 2.

Expected: all focused lifecycle and app-state tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/long_capture.rs apps/desktop/src-tauri/src/app_state.rs apps/desktop/src-tauri/src/main.rs
git commit -m "fix: centralize long capture window cleanup"
```

---

### Task 4: Numbered Screenshot Sessions and Stale-Event Rejection

**Files:**
- Modify: `apps/desktop/src-tauri/src/app_state.rs`
- Modify: `apps/desktop/src-tauri/src/long_capture.rs`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.test.tsx`

**Interfaces:**
- Native event payloads use `{ sessionId: number }` for `capture-started` and `capture-session-reset`.
- `capture-ready` uses `{ sessionId: number, frames: MonitorFrame[] }`.
- `AppState::current_session_id() -> u64` returns the latest started ordinary capture.

- [ ] **Step 1: Write failing native session counter tests**

```rust
#[test]
fn every_started_capture_gets_a_new_session_id() {
    let state = AppState::default();
    assert_eq!(state.begin_capture().unwrap(), 1);
    state.finish_capture();
    assert_eq!(state.begin_capture().unwrap(), 2);
    assert_eq!(state.current_session_id(), 2);
}
```

- [ ] **Step 2: Write failing React stale-event tests**

Drive listeners with payloads in this order:

```tsx
captureStarted({ sessionId: 2 });
captureReady({ sessionId: 2, frames: [{ pngBase64: 'new' }] });
captureReady({ sessionId: 1, frames: [{ pngBase64: 'old' }] });
expect(source).toHaveAttribute('src', 'data:image/png;base64,new');
```

Also select an area, send `capture-session-reset` for session 1, and assert session 2's current editor remains unchanged; send reset for session 2 and assert the selection is cleared.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml app_state
pnpm --filter @screenshot/desktop exec vitest --run src/App.test.tsx
```

Expected: FAIL because events do not carry session IDs and React does not filter stale payloads.

- [ ] **Step 4: Implement numbered events**

Use `AtomicU64` in `AppState`. Return the new ID from `begin_capture`, include it in started/ready/error-reset payloads, and expose the current ID to long-capture cancellation. In React keep `latestSessionId` in a ref; ignore payloads with a smaller ID and only increment the editor `key` for accepted start/reset events.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the commands from Step 3.

Expected: all session-counter and App tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/app_state.rs apps/desktop/src-tauri/src/long_capture.rs apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx
git commit -m "fix: isolate screenshot sessions by id"
```

---

### Task 5: Exact Non-Overlapping 0.3 Screenshot Mask

**Files:**
- Modify: `apps/desktop/src/components/SelectionOverlay.tsx`
- Modify: `apps/desktop/src/components/SelectionOverlay.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- With no selection: one `.selection-mask--full` element.
- With a selection: four elements with `data-mask-side="top|right|bottom|left"`.
- Every mask uses `background: rgba(0, 0, 0, 0.3)` and mask rectangles never overlap.

- [ ] **Step 1: Write the failing mask contract test**

For bounds `300 x 200` and selection `{ x: 20, y: 30, width: 100, height: 80 }`, assert exact styles:

```tsx
expect(mask('top')).toHaveStyle({ left: 0, top: 0, width: 300, height: 30 });
expect(mask('right')).toHaveStyle({ left: 120, top: 30, width: 180, height: 80 });
expect(mask('bottom')).toHaveStyle({ left: 0, top: 110, width: 300, height: 90 });
expect(mask('left')).toHaveStyle({ left: 0, top: 30, width: 20, height: 80 });
expect(document.querySelectorAll('.selection-mask')).toHaveLength(4);
```

With `selection={null}`, assert one `.selection-mask--full` and zero side masks.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @screenshot/desktop exec vitest --run src/components/SelectionOverlay.test.tsx`

Expected: FAIL because masking still uses the surface background and a `9999px` box shadow.

- [ ] **Step 3: Render four masks and remove layered CSS**

Render the exact rectangles from Step 1 as absolutely positioned sibling elements inside `.selection-surface`. Give masks `pointer-events: none`. Remove the background from `.selection-surface`, remove `.selection-surface--has-selection`, and remove the `box-shadow` from `.selection-box`.

Use:

```css
.selection-mask { position: absolute; background: rgba(0, 0, 0, 0.3); pointer-events: none; }
.selection-mask--full { inset: 0; }
.selection-box { box-shadow: none; }
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2.

Expected: all SelectionOverlay tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/SelectionOverlay.tsx apps/desktop/src/components/SelectionOverlay.test.tsx apps/desktop/src/styles.css
git commit -m "fix: render screenshot mask at exact opacity"
```

---

### Task 6: Full Verification and Windows Acceptance

**Files:**
- Modify only if verification exposes an in-scope defect.

**Interfaces:**
- Produces a debug executable at `apps/desktop/src-tauri/target/debug/screenshot-tool.exe`.

- [ ] **Step 1: Run the full automated suite**

Run:

```bash
pnpm --filter @screenshot/desktop test -- --run
pnpm --filter @screenshot/desktop typecheck
pnpm --filter @screenshot/desktop build
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm --filter @screenshot/desktop tauri build --debug --no-bundle
```

Expected: every command exits 0.

- [ ] **Step 2: Restart the debug executable**

Stop only the running `screenshot-tool.exe` process, then start the newly built executable from the exact target path. Confirm one process remains running.

- [ ] **Step 3: Perform three Windows interaction cycles**

For each cycle:

1. Invoke `Alt+Shift+A` and draw a fresh selection over a scrollable page.
2. Enter long capture and enumerate screenshot-tool top-level windows.
3. Assert `overlay` is hidden; sidecar plus four border windows are visible.
4. At the selection center, assert `WindowFromPoint` resolves to a different process.
5. Send wheel input and compare before/after pixels to prove the underlying page moved.
6. Press Esc; assert sidecar/borders close, overlay remains hidden, and overlay affinity is `0x0`.
7. Invoke `Alt+Shift+A`; assert no toolbar/selection exists before a new drag.

- [ ] **Step 4: Verify mask pixels**

Capture source and displayed overlay pixels at one point inside and one point outside the selection. Confirm the inside point equals the source and the outside RGB channels equal source channels multiplied by `0.7` within compositor rounding tolerance of 2.

- [ ] **Step 5: Commit any verification-only fix, otherwise record clean status**

If no source changes were needed, do not create an empty commit. Report the exact automated commands and all three interaction-cycle results.
