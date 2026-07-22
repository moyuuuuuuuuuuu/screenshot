# Manual Scrolling Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace simulated automatic scrolling with a WeChat-style workflow where the user scrolls the target window and the tool observes, stitches, previews, and completes the long screenshot.

**Architecture:** Keep the existing Rust stitcher and desktop bridge boundary, but replace the scroll-sending loop with a platform-independent visual observer and manual-capture state machine. During capture, the full-screen overlay becomes visually transparent and input-transparent while a separate interactive Tauri control window shows a live thumbnail plus icon-only stop/cancel actions.

**Tech Stack:** Rust stable MSVC, Tauri 2, Windows APIs, React 19, TypeScript strict mode, Canvas/PNG, Vitest, Rust unit tests

## Global Constraints

- Work directly on `main`, as explicitly requested by the user; do not create a worktree or feature branch.
- Use TDD for every behavior change: observe the focused failing test before implementation.
- Do not send synthetic wheel input or depend on webpage DOM/UI Automation scroll ranges.
- Observe the selected region every 120ms; require about 200ms of visual stability before accepting a full-resolution frame.
- Enable the 2-second idle completion timer only after at least one frame has been successfully appended.
- Upward scrolling pauses appends and never deletes already stitched pixels.
- Preserve the limits of 200 accepted frames, 60,000 output pixels, and 120 seconds.
- The control surface is icon-only: 20×20 SVG, 1.8px stroke, 36×36 hit targets.
- Always restore overlay input, close the control window, and retain recoverable partial output on every termination path.
- Keep all captured pixels local unless the user later explicitly invokes OCR or translation.

---

## File Structure

- Create `apps/desktop/src-tauri/src/region_observer.rs`: pure sampling state machine for change, stability, and idle completion.
- Rewrite `apps/desktop/src-tauri/src/scroll_controller.rs`: manual-capture lifecycle without `scroll_sent`.
- Modify `apps/desktop/src-tauri/src/stitcher.rs`: classify forward, reverse, and unmatched overlap against the accepted tail.
- Rewrite `apps/desktop/src-tauri/src/long_capture.rs`: observe user-driven frames, publish thumbnail progress, and perform unconditional cleanup.
- Modify `apps/desktop/src-tauri/src/platform/mod.rs` and `platform/windows.rs`: locate the target below the overlay and validate target lifetime; remove scroll-input exports.
- Delete `apps/desktop/src-tauri/src/platform/windows/scroll.rs` and `apps/desktop/src-tauri/src/scroll.rs`: simulated input is no longer part of the product.
- Modify `apps/desktop/src-tauri/src/main.rs` and `lib.rs`: register manual-capture commands/modules only.
- Create `apps/desktop/src/components/LongCaptureControls.tsx`: side thumbnail and stop/cancel icon controls.
- Modify `apps/desktop/src/App.tsx`: render the control-window route separately from the overlay editor.
- Modify `apps/desktop/src/components/ScreenshotEditor.tsx` and `styles.css`: enter/leave transparent pass-through presentation.
- Modify desktop bridge files/tests: add cancel semantics and expanded progress states/thumbnail.

---

### Task 1: Visual Region Observer

**Files:**
- Create: `apps/desktop/src-tauri/src/region_observer.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: downscaled grayscale byte slices and monotonic `Duration` timestamps.
- Produces:

```rust
pub const SAMPLE_INTERVAL: Duration = Duration::from_millis(120);
pub const STABLE_FOR: Duration = Duration::from_millis(200);
pub const COMPLETE_AFTER: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Observation { Unchanged, MotionStarted, Stabilizing, StableFrame, IdleComplete }

pub struct RegionObserver { /* private state */ }
impl RegionObserver {
    pub fn new(change_threshold: f64) -> Self;
    pub fn observe(&mut self, pixels: &[u8], now: Duration) -> Observation;
    pub fn mark_appended(&mut self, now: Duration);
}
```

- [ ] **Step 1: Add failing observer tests**

Add `#[cfg(test)]` tests in `region_observer.rs` proving no auto-completion before an append, motion resets idle time, 200ms stability emits one `StableFrame`, and 2 seconds after an append emits `IdleComplete`:

```rust
#[test]
fn idle_completion_requires_an_appended_frame() {
    let mut observer = RegionObserver::new(0.01);
    assert_eq!(observer.observe(&[0; 16], Duration::ZERO), Observation::Unchanged);
    assert_ne!(observer.observe(&[0; 16], COMPLETE_AFTER), Observation::IdleComplete);
    observer.mark_appended(Duration::ZERO);
    assert_eq!(observer.observe(&[0; 16], COMPLETE_AFTER), Observation::IdleComplete);
}
```

- [ ] **Step 2: Run the focused Rust test and confirm red**

Run from a VS x64 developer prompt:

```powershell
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml region_observer
```

Expected: compilation fails because `RegionObserver` and `Observation` are not implemented.

- [ ] **Step 3: Implement the observer minimally**

Store the previous sample, motion start/stable timestamps, last append timestamp, and a `stable_emitted` flag. Compute normalized byte difference as the number of bytes whose absolute delta is greater than 3 divided by sample length. Return `MotionStarted` on the first changed sample, `Stabilizing` until `STABLE_FOR`, exactly one `StableFrame` after stability, and `IdleComplete` only when `mark_appended` has been called and no later motion reset the timer.

- [ ] **Step 4: Run focused tests green**

```powershell
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml region_observer
```

Expected: all `region_observer` tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/region_observer.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: observe manual scrolling changes"
```

---

### Task 2: Manual Session and Scroll Direction Classification

**Files:**
- Modify: `apps/desktop/src-tauri/src/scroll_controller.rs`
- Modify: `apps/desktop/src-tauri/src/stitcher.rs`

**Interfaces:**
- Consumes: stable full-resolution frames and elapsed session duration.
- Produces:

```rust
pub enum LongCaptureState {
    Idle, Preparing, Observing, Scrolling, Stabilizing, Matching,
    PausedReverse, Warning, Completed, Partial, Failed, Cancelled,
}

pub enum MatchDirection {
    Forward { overlap_rows: u32 },
    Reverse,
    Unmatched,
}

pub fn classify_scroll_direction(
    accepted_tail: &GrayFrame,
    candidate: &GrayFrame,
    minimum_overlap: u32,
) -> MatchDirection;
```

- [ ] **Step 1: Replace automatic-scroll tests with failing manual transitions**

Remove tests calling `scroll_sent`. Add tests proving: first frame enters `Observing`; `motion_started` enters `Scrolling`; `stable_frame_ready` enters `Matching`; a forward match returns to `Observing`; reverse enters `PausedReverse`; a later forward tail match resumes; unmatched enters `Warning`; manual stop after one frame produces `Partial`; explicit complete produces `Completed`.

```rust
#[test]
fn reverse_scroll_pauses_until_the_tail_matches_again() {
    let mut session = session_with_first_frame(800);
    session.motion_started().unwrap();
    session.stable_frame_ready().unwrap();
    session.reverse_detected().unwrap();
    assert_eq!(session.state(), LongCaptureState::PausedReverse);
    session.tail_recovered().unwrap();
    assert_eq!(session.state(), LongCaptureState::Observing);
}
```

- [ ] **Step 2: Run focused tests and confirm red**

```powershell
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml scroll_controller stitcher
```

Expected: compile failures for the new manual transition and direction APIs.

- [ ] **Step 3: Implement manual transitions and bidirectional classification**

Reuse `find_vertical_overlap` for the forward candidate. Build a vertically reversed comparison by searching the candidate tail against the accepted-tail head; return `Reverse` only when its confidence is at least 0.08 higher than the forward result. Return `Unmatched` when neither direction meets the existing 0.75 confidence floor. Do not mutate the stitcher for `Reverse` or `Unmatched`.

- [ ] **Step 4: Verify the focused suite**

```powershell
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml scroll_controller stitcher
```

Expected: manual lifecycle, limits, normal stitching, static regions, variable steps, reverse pause, and unmatched recovery tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/scroll_controller.rs apps/desktop/src-tauri/src/stitcher.rs
git commit -m "feat: classify user-driven scroll frames"
```

---

### Task 3: Native Manual Capture Runtime and Cleanup

**Files:**
- Modify: `apps/desktop/src-tauri/src/long_capture.rs`
- Modify: `apps/desktop/src-tauri/src/platform/mod.rs`
- Modify: `apps/desktop/src-tauri/src/platform/windows.rs`
- Delete: `apps/desktop/src-tauri/src/platform/windows/scroll.rs`
- Delete: `apps/desktop/src-tauri/src/scroll.rs`
- Modify: `apps/desktop/src-tauri/src/main.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `RegionObserver`, `classify_scroll_direction`, existing monitor capture/crop and `ChunkedStitcher`.
- Produces:

```rust
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureProgress {
    frame_count: u32,
    stitched_height: u32,
    state: &'static str,
    preview_png_bytes: Vec<u8>,
    warning: bool,
}

#[tauri::command]
pub async fn start_long_capture(/* existing args */) -> Result<LongCaptureResult, String>;
#[tauri::command]
pub fn stop_long_capture(runtime: tauri::State<'_, LongCaptureRuntime>);
#[tauri::command]
pub fn cancel_long_capture(runtime: tauri::State<'_, LongCaptureRuntime>);
```

- [ ] **Step 1: Add failing runtime cleanup and target tests**

Extract a pure `CaptureTermination` decision and test stop vs cancel. Add a platform-independent target ID validation test. Add a cleanup guard test using injected callbacks to prove every success/error/cancel path invokes `disable_pass_through` and `close_controls` once.

```rust
#[test]
fn cancel_discards_output_while_stop_keeps_it() {
    assert_eq!(termination(true, false, 3), CaptureTermination::Cancelled);
    assert_eq!(termination(false, true, 3), CaptureTermination::Partial);
}
```

- [ ] **Step 2: Run the focused runtime test and confirm red**

```powershell
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml long_capture
```

Expected: missing cancel/cleanup/manual observation APIs.

- [ ] **Step 3: Replace the simulated-scroll loop**

Implement this loop shape in `run_capture`:

```rust
loop {
    let preview = crop_region(platform::capture_monitors()?, region)?;
    let gray = downscale_grayscale(&preview, 8)?;
    match observer.observe(&gray.pixels, started.elapsed()) {
        Observation::MotionStarted => session.motion_started()?,
        Observation::StableFrame => accept_candidate(&mut session, &mut stitcher, preview)?,
        Observation::IdleComplete => { session.complete()?; break; }
        Observation::Unchanged | Observation::Stabilizing => {}
    }
    if runtime.cancel_requested() || runtime.stop_requested() || session.limit_reached(started.elapsed()) { break; }
    std::thread::sleep(SAMPLE_INTERVAL);
}
```

Map internal errors to strings explicitly rather than using `?` directly where types differ. Generate a maximum 120px-wide PNG preview only after a successful append, not on every 120ms sample.

- [ ] **Step 4: Implement target-below-overlay and unconditional window cleanup**

On Windows, enumerate visible top-level windows at the selection center, skip the overlay HWND/current process, and retain the first candidate as the target. Before observing, signal the frontend to enter manual mode, create/show `long-capture-controls`, then call `overlay.set_ignore_cursor_events(true)`. Use a scope guard or one cleanup function for all exits:

```rust
fn cleanup(app: &tauri::AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.set_ignore_cursor_events(false);
        let _ = overlay.emit("long-capture-ended", ());
    }
    if let Some(controls) = app.get_webview_window("long-capture-controls") {
        let _ = controls.close();
    }
}
```

Remove `send_scroll`, `track_scroll_target`, their commands, module exports, and the Windows scroll source file.

- [ ] **Step 5: Run Rust tests and Clippy**

```powershell
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
```

Expected: all Rust tests pass and Clippy exits 0 with no warnings.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src
git commit -m "feat: capture user-driven scrolling"
```

---

### Task 4: Side Preview Control Window and Desktop Bridge

**Files:**
- Create: `apps/desktop/src/components/LongCaptureControls.tsx`
- Create: `apps/desktop/src/components/LongCaptureControls.test.tsx`
- Modify: `apps/desktop/src/bridge/desktop-bridge.ts`
- Modify: `apps/desktop/src/bridge/tauri-desktop-bridge.ts`
- Modify: `apps/desktop/src/bridge/tauri-desktop-bridge.test.ts`
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/App.test.tsx`
- Modify: `apps/desktop/src/components/ScreenshotEditor.tsx`
- Modify: `apps/desktop/src/components/ScreenshotEditor.test.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: native progress polling, `stop_long_capture`, `cancel_long_capture`, overlay lifecycle events.
- Produces:

```ts
export type LongCaptureProgress = Readonly<{
  frameCount: number;
  stitchedHeight: number;
  state: 'preparing' | 'observing' | 'scrolling' | 'stabilizing' |
    'matching' | 'pausedReverse' | 'warning';
  previewPngBytes: readonly number[];
  warning: boolean;
}>;

export type LongCaptureControlsProps = Readonly<{
  progress: LongCaptureProgress;
  onStop(): void;
  onCancel(): void;
}>;
```

- [ ] **Step 1: Write failing bridge and control component tests**

Test that progress accepts `pausedReverse`, preview bytes and warning; `cancelLongCapture` invokes `cancel_long_capture`; controls render only an image and two 36×36 icon buttons with accessible names `完成长截图` and `取消长截图`; warning changes the preview accessible description.

```tsx
it('offers icon-only stop and cancel actions', async () => {
  render(<LongCaptureControls progress={progress} onStop={onStop} onCancel={onCancel} />);
  await userEvent.click(screen.getByRole('button', { name: '完成长截图' }));
  await userEvent.click(screen.getByRole('button', { name: '取消长截图' }));
  expect(onStop).toHaveBeenCalledOnce();
  expect(onCancel).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run focused JS tests and confirm red**

```powershell
pnpm --dir apps/desktop exec vitest run src/bridge/tauri-desktop-bridge.test.ts src/components/LongCaptureControls.test.tsx src/App.test.tsx src/components/ScreenshotEditor.test.tsx
```

Expected: missing component, cancel API, new progress state, and route behavior failures.

- [ ] **Step 3: Implement bridge types and icon-only controls**

Use Lucide `Square` for stop, `X` for cancel, and `TriangleAlert` over the thumbnail warning state. Revoke the previous preview object URL whenever new preview bytes arrive and on unmount. Do not render frame count or height as visible text; expose them through `aria-label` and `title`.

- [ ] **Step 4: Route the second Tauri window**

Select by query parameter before rendering the editor:

```tsx
const isLongCaptureControls = new URLSearchParams(window.location.search).get('window') === 'long-capture-controls';
return isLongCaptureControls
  ? <LongCaptureControlsHost bridge={desktopBridge} />
  : <ScreenshotEditor key={session} sourceUrl={sourceUrl} bridge={desktopBridge} />;
```

The host polls `long_capture_progress` every 120ms and invokes stop/cancel through the bridge. The overlay listens for `long-capture-started`/`long-capture-ended`, toggles `screenshot-editor--manual-capture`, hides the frozen screenshot/canvas/dimming, and keeps only the selection outline visible. Remove the old bottom text progress panel.

- [ ] **Step 5: Verify focused and full frontend suites**

```powershell
pnpm --dir apps/desktop exec vitest run src/bridge/tauri-desktop-bridge.test.ts src/components/LongCaptureControls.test.tsx src/App.test.tsx src/components/ScreenshotEditor.test.tsx
pnpm test -- --run
pnpm typecheck
pnpm --filter @screenshot/desktop build
```

Expected: focused tests and the full suite pass; strict typecheck and Vite production build exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src
git commit -m "feat: add manual capture side preview"
```

---

### Task 5: Native Integration, Regression Removal, and Windows Acceptance

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `apps/desktop/src/tauri-config.test.ts`
- Modify: `docs/superpowers/plans/2026-07-21-project-continuation-roadmap.md`
- Create: `docs/manual-scrolling-capture-checklist.md`

**Interfaces:**
- Consumes: completed Tasks 1–4.
- Produces: a debug Windows executable and recorded acceptance results.

- [ ] **Step 1: Add a failing configuration regression test**

Assert the main window remains transparent/fullscreen and there is no statically configured duplicate controls window; controls are created per capture. Assert source no longer contains registered `send_scroll` or `track_scroll_target` commands:

```ts
expect(mainSource).not.toContain('send_scroll');
expect(mainSource).not.toContain('track_scroll_target');
```

- [ ] **Step 2: Run the regression test red before removing remaining legacy references**

```powershell
pnpm --dir apps/desktop exec vitest run src/tauri-config.test.ts
```

Expected: FAIL if any simulated-scroll command or old progress configuration remains.

- [ ] **Step 3: Remove all legacy automatic-scroll references**

Run:

```powershell
rg "send_scroll|track_scroll_target|scroll_sent|RetrySmallerStep" apps/desktop/src apps/desktop/src-tauri/src
```

Expected after cleanup: no matches. Update the continuation roadmap so Phase C says manual scrolling/visual observation and points to this plan; do not mark Windows acceptance complete yet.

- [ ] **Step 4: Run the full automated verification suite**

From the repository root in a VS x64 developer prompt:

```powershell
pnpm test -- --run
pnpm typecheck
pnpm --filter @screenshot/desktop build
cargo test -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy -j 1 --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
set CARGO_BUILD_JOBS=1
pnpm --filter @screenshot/desktop tauri:build --debug --no-bundle
```

Expected: all commands exit 0; debug executable exists at `apps/desktop/src-tauri/target/debug/screenshot-tool.exe`.

- [ ] **Step 5: Execute and record Windows manual acceptance**

In `docs/manual-scrolling-capture-checklist.md`, record pass/fail and evidence for:

```text
Edge/Chrome: wheel, Page Down, scrollbar drag
File Explorer, Windows Settings, one Electron application
Forward scroll, 1-second pause, 2-second completion
Reverse scroll pause and forward-tail recovery
Fixed header/footer and floating control
Manual stop retains output; cancel restores original capture
Overlay accepts input again after every success/error/cancel path
```

- [ ] **Step 6: Commit implementation acceptance**

```bash
git add apps/desktop/src-tauri/tauri.conf.json apps/desktop/src/tauri-config.test.ts docs
git commit -m "test: verify manual scrolling capture"
```

---

## Completion Gate

- [ ] No synthetic scrolling code or command remains.
- [ ] Frontend and Rust full suites, strict typecheck, Clippy, Vite build, and Tauri debug build all pass.
- [ ] Main overlay is click-through only during manual capture and always recovers.
- [ ] Side preview is icon-only and stays outside captured pixels.
- [ ] Manual forward scrolling stitches, reverse scrolling pauses, and forward-tail recovery resumes.
- [ ] Idle completion cannot fire before one appended frame.
- [ ] Windows acceptance results are recorded before Phase C is marked complete.
