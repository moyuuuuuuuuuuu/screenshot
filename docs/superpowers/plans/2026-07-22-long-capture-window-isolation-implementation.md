# Long Capture Window Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the screenshot tool from capturing its own windows, make Escape cancel and exit long capture, and restore the first-edition Lucide icon language.

**Architecture:** Add a Windows-only platform adapter around `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` and apply it to both Tauri windows before the first long-capture frame. Model cleanup disposition explicitly so cancellation hides the overlay while failures restore it. Keep the current toolbar layout and action contract, replacing only custom icon rendering with Lucide components.

**Tech Stack:** Rust 2021, Tauri 2, `windows-sys` 0.59, React 19, TypeScript 5.8, Lucide React, Vitest, Cargo test/Clippy.

## Global Constraints

- Work directly on `main`, as explicitly approved by the user.
- Use red-green-refactor for every behavior change; run each focused test and observe the expected failure before production edits.
- Screenshot overlay and preview remain visible and interactive but must not appear in GDI capture output.
- Escape and the cancel icon discard long-capture output and exit the screenshot overlay.
- Edit, Save, and Finish retain their current result-preserving meanings.
- Toolbar buttons keep the current action order and geometry; icons are 20 px Lucide components with a 1.8 px stroke.
- Do not modify overlap thresholds until a tool-free Windows capture proves a separate stitching defect.

---

### Task 1: Restore the First-Edition Lucide Icon Contract

**Files:**
- Modify: `apps/desktop/src/components/WechatToolbar.tsx`
- Modify: `apps/desktop/src/components/ScrollCapturePreview.tsx`
- Delete: `apps/desktop/src/components/icons/WechatIcons.tsx`
- Modify: `apps/desktop/src/components/WechatToolbar.test.tsx`
- Modify: `apps/desktop/src/components/ScrollCapturePreview.test.tsx`
- Modify: `apps/desktop/src/visual/wechat-reference-metrics.ts`
- Modify: `apps/desktop/src/visual/wechat-parity.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `lucide-react` icon components accepting `size` and `strokeWidth`.
- Produces: all screenshot toolbar and long-capture action icons with `width="20"`, `height="20"`, and `stroke-width="1.8"`; no imports from `WechatIcons.tsx`.

- [ ] **Step 1: Change the toolbar test to describe the first-edition icon contract**

Replace the custom `data-stroke` assertions with:

```tsx
expect(container.querySelectorAll('svg')).toHaveLength(labels.length);
for (const icon of container.querySelectorAll('svg')) {
  expect(icon).toHaveAttribute('width', '20');
  expect(icon).toHaveAttribute('height', '20');
  expect(icon).toHaveAttribute('stroke-width', '1.8');
  expect(icon).toHaveClass('lucide');
}
```

Update the visual metric expectation to `toolbar: { button: 28, icon: 20, gap: 2, radius: 8, stroke: 1.8 }` and assert the four long-capture action SVGs use the same attributes.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
pnpm --filter @screenshot/desktop exec vitest --run src/components/WechatToolbar.test.tsx src/components/ScrollCapturePreview.test.tsx src/visual/wechat-parity.test.tsx
```

Expected: FAIL because current custom icons have no `lucide` class and still render at 18 px / 1.6 stroke.

- [ ] **Step 3: Replace custom icons with Lucide components**

In `WechatToolbar.tsx`, import and map these components:

```tsx
import {
  ArrowUpRight, Check, Circle, Download, Grid2X2, ImageDown, Languages,
  MessageCircle, PenLine, Pin, Redo2, ScanText, Send, ShieldCheck,
  Square, Type, Undo2, X,
} from 'lucide-react';

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number }>;
// rectangle Square; ellipse Circle; emoji MessageCircle; arrow ArrowUpRight;
// pen PenLine; mosaic Grid2X2; text Type; privacy ShieldCheck;
// OCR ScanText; scrolling ImageDown; undo Undo2; save Download;
// pin Pin; share Send; cancel X; complete Check.
```

Render every toolbar and preview icon as:

```tsx
<Icon size={20} strokeWidth={1.8} aria-hidden="true" />
```

Remove the unused `Languages` and `Redo2` imports if the final action map does not consume them. Delete `WechatIcons.tsx`, update preview imports, change the CSS SVG size to 20 px, and update the golden metric values.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command.

Expected: all toolbar, preview, and parity tests PASS.

- [ ] **Step 5: Commit the icon restoration**

```powershell
git add apps/desktop/src/components apps/desktop/src/visual apps/desktop/src/styles.css
git commit -m "fix: restore first-edition screenshot icons"
```

---

### Task 2: Add a Tested Windows Capture-Exclusion Boundary

**Files:**
- Create: `apps/desktop/src-tauri/src/platform/windows/capture_exclusion.rs`
- Modify: `apps/desktop/src-tauri/src/platform/windows.rs`
- Modify: `apps/desktop/src-tauri/src/platform/mod.rs`

**Interfaces:**
- Produces: `platform::exclude_window_from_capture(window: &tauri::WebviewWindow) -> Result<(), String>`.
- Windows implementation: obtain `window.hwnd()`, call `SetWindowDisplayAffinity(hwnd.0, WDA_EXCLUDEFROMCAPTURE)`, and report `std::io::Error::last_os_error()` on zero return.
- Non-Windows implementation: return `"window capture exclusion is currently supported only on Windows"`.

- [ ] **Step 1: Write the failing platform policy test**

Keep Win32 invocation behind a testable function:

```rust
pub(crate) fn apply_capture_exclusion(
    hwnd: isize,
    set_affinity: impl FnOnce(isize, u32) -> bool,
) -> Result<(), String> {
    if hwnd == 0 {
        return Err("cannot exclude a window without a valid HWND".to_string());
    }
    if !set_affinity(hwnd, WDA_EXCLUDEFROMCAPTURE) {
        return Err("SetWindowDisplayAffinity failed".to_string());
    }
    Ok(())
}
```

Add tests proving a zero HWND fails, the adapter receives `0x11` (`WDA_EXCLUDEFROMCAPTURE`), and a false Win32 result fails.

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run:

```powershell
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml capture_exclusion
```

Expected: FAIL because `capture_exclusion` and `apply_capture_exclusion` do not exist.

- [ ] **Step 3: Implement the platform adapter**

Create the policy function above, then add the real adapter:

```rust
pub fn exclude_window_from_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("failed to read screenshot window handle: {error}"))?;
    apply_capture_exclusion(hwnd.0 as isize, |raw, affinity| {
        unsafe { SetWindowDisplayAffinity(raw as HWND, affinity) != 0 }
    })
    .map_err(|error| {
        format!("{error}: {}", std::io::Error::last_os_error())
    })
}
```

Re-export through `windows.rs` and `platform/mod.rs`, including the explicit non-Windows fallback.

- [ ] **Step 4: Run the focused Rust test and verify GREEN**

Run the Step 2 command.

Expected: capture-exclusion tests PASS.

- [ ] **Step 5: Commit the platform boundary**

```powershell
git add apps/desktop/src-tauri/src/platform
git commit -m "feat: exclude screenshot windows from capture"
```

---

### Task 3: Apply Exclusion Before the First Long-Capture Frame

**Files:**
- Modify: `apps/desktop/src-tauri/src/preview_windows.rs`
- Modify: `apps/desktop/src-tauri/src/long_capture.rs`

**Interfaces:**
- Consumes: `platform::exclude_window_from_capture(&WebviewWindow)` from Task 2.
- Changes: `open_preview_window(...) -> Result<tauri::WebviewWindow, String>` and `open_controls_window(...) -> Result<tauri::WebviewWindow, String>`.
- Produces: orchestration that excludes overlay and preview before calling `run_capture`.

- [ ] **Step 1: Write a failing ordering test**

Extract a small policy helper in `long_capture.rs`:

```rust
fn prepare_capture_windows(
    exclude_overlay: impl FnOnce() -> Result<(), String>,
    open_and_exclude_preview: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    exclude_overlay()?;
    open_and_exclude_preview()?;
    Ok(())
}
```

Test with a shared event vector that successful preparation records `overlay`, then `preview`; if overlay exclusion fails, preview is never opened.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml prepare_capture_windows
```

Expected: FAIL because the preparation helper does not exist.

- [ ] **Step 3: Implement exclusion ordering in orchestration**

Return the built preview window from `open_preview_window` and `open_controls_window`. In `start_long_capture`, call:

```rust
prepare_capture_windows(
    || platform::exclude_window_from_capture(&window),
    || {
        let preview = open_controls_window(&app, region)?;
        platform::exclude_window_from_capture(&preview)
    },
)?;
std::thread::sleep(Duration::from_millis(150));
let capture = run_capture(&runtime, region);
```

Do not sample any monitor frame before both calls succeed.

- [ ] **Step 4: Run focused and complete Rust tests**

Run:

```powershell
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml prepare_capture_windows
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: focused test and the complete Rust suite PASS.

- [ ] **Step 5: Commit orchestration changes**

```powershell
git add apps/desktop/src-tauri/src/preview_windows.rs apps/desktop/src-tauri/src/long_capture.rs
git commit -m "fix: isolate long capture from its preview"
```

---

### Task 4: Make Escape Cancel and Exit the Screenshot Tool

**Files:**
- Modify: `apps/desktop/src-tauri/src/long_capture.rs`
- Modify: `apps/desktop/src-tauri/src/main.rs`
- Modify: `apps/desktop/src/components/ScreenshotEditor.tsx`
- Modify: `apps/desktop/src/components/ScreenshotEditor.test.tsx`

**Interfaces:**
- Consumes: `LongCaptureRuntime::request_cancel()` and `output::close_overlay` behavior.
- Produces: `LongCaptureRuntime::is_cancel_requested() -> bool`; cleanup disposition `Restore` or `Hide`; Escape invokes cancellation and hides the overlay.

- [ ] **Step 1: Change the React Escape test to the approved behavior**

Rename the test to `Esc cancels long capture and exits the overlay`, then assert:

```tsx
await userEvent.keyboard('{Escape}');
expect(bridge.cancelLongCapture).toHaveBeenCalledOnce();
expect(bridge.stopLongCapture).not.toHaveBeenCalled();
expect(bridge.closeOverlay).toHaveBeenCalledOnce();
finishCapture?.({ png: new Blob(['discarded']), partial: true, action: 'edit' });
expect(container.querySelector('img[src="blob:long-capture"]')).not.toBeInTheDocument();
```

- [ ] **Step 2: Add failing Rust cleanup-disposition tests**

Replace unconditional cleanup restoration with:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OverlayCleanup { Restore, Hide }

fn overlay_cleanup(cancel_requested: bool) -> OverlayCleanup {
    if cancel_requested { OverlayCleanup::Hide } else { OverlayCleanup::Restore }
}
```

Test both outcomes and test that `request_cancel()` makes `is_cancel_requested()` true.

- [ ] **Step 3: Run focused frontend and Rust tests and verify RED**

Run:

```powershell
pnpm --filter @screenshot/desktop exec vitest --run src/components/ScreenshotEditor.test.tsx
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml overlay_cleanup
```

Expected: frontend FAILS because Escape calls stop and leaves the overlay open; Rust FAILS because cleanup disposition does not exist.

- [ ] **Step 4: Implement cancellation and hide cleanup**

In the React key handler:

```tsx
if (longCaptureProgress) {
  void bridge.cancelLongCapture().finally(() => bridge.closeOverlay());
} else {
  void bridge.closeOverlay();
}
```

In the global shortcut handler, replace `request_stop()` with `request_cancel()`. Add `is_cancel_requested`, use it when the long-capture cleanup closure runs, and call `window.hide()` for cancel versus emit/show/focus for normal completion or failure. Always close the preview and unregister Escape.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 3 commands.

Expected: focused frontend and Rust tests PASS.

- [ ] **Step 6: Commit Escape behavior**

```powershell
git add apps/desktop/src-tauri/src/long_capture.rs apps/desktop/src-tauri/src/main.rs apps/desktop/src/components/ScreenshotEditor.tsx apps/desktop/src/components/ScreenshotEditor.test.tsx
git commit -m "fix: cancel and exit long capture with Escape"
```

---

### Task 5: Full Verification and Windows Reproduction Pass

**Files:**
- Modify: `docs/superpowers/plans/2026-07-22-wechat-parity-acceptance.md`
- Modify: `README.md` only if Escape wording needs clarification.

**Interfaces:**
- Consumes: completed Tasks 1–4.
- Produces: fresh build evidence and an acceptance record tied to the supplied video sequence.

- [ ] **Step 1: Run all automated verification**

```powershell
pnpm --filter @screenshot/desktop test -- --run
pnpm --filter @screenshot/desktop typecheck
pnpm --filter @screenshot/desktop build
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @screenshot/desktop tauri:build --debug --no-bundle
```

Expected: every command exits 0 with no failed tests or Clippy warnings.

- [ ] **Step 2: Repeat the supplied Windows reproduction**

Run `apps/desktop/src-tauri/target/debug/screenshot-tool.exe`, then:

1. Open a visibly scrollable Chrome or Edge page.
2. Press `Alt+Shift+A`, select the scrollable content, and start long capture.
3. Verify the overlay, green border, annotations, preview, prompt, and action buttons never appear in accumulated preview pixels.
4. Scroll down with the mouse wheel and verify the preview grows from page content only.
5. Press Escape and verify both screenshot windows disappear, no partial image opens, and `Alt+Shift+A` immediately starts a new capture.
6. Repeat once using the cancel icon and once using Finish to verify their distinct discard/preserve meanings.

- [ ] **Step 3: Record measured results without claiming untested parity**

In the acceptance record, add dated Pass/Fail rows for self-capture isolation, wheel growth, Escape exit, cancel discard, Finish preserve, and first-edition icon metrics. Leave touchpad and configured Coze rows pending unless actually exercised.

- [ ] **Step 4: Check the final diff and commit acceptance evidence**

```powershell
git diff --check
git status --short
git add docs/superpowers/plans/2026-07-22-wechat-parity-acceptance.md README.md
git commit -m "docs: record long capture isolation acceptance"
```

Do not push; when the user requests a push, open GitHub Desktop as previously agreed.
