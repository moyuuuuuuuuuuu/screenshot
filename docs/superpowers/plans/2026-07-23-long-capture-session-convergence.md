# Long Capture Session Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manual long capture append only settled frames, terminate reliably through every control, reuse native helper windows without close animations, and always start the next screenshot with an empty selection.

**Architecture:** Keep the existing Rust capture and stitching pipeline, but insert a pure motion-cycle gate before matching and make `LongCaptureRuntime` the only owner of session identity and terminal actions. Expose one typed terminal command to React, publish monotonic progress revisions, and hide/reconfigure the preview and mask windows instead of closing them.

**Tech Stack:** Rust 2021, Tauri 2, Windows GDI capture, React 19, TypeScript 5.8, Vitest 3, Testing Library.

## Global Constraints

- Manual scrolling remains user-driven; the application must not inject wheel input.
- The black mask opacity remains `0.3` (`77 / 255`) and the selected region remains unobstructed.
- Only a settled frame may enter overlap matching; motion frames must never be appended.
- Every motion cycle may append at most one frame.
- Esc and the X icon cancel; Enter and the check icon finish and copy.
- The first terminal action wins and repeated actions are idempotent.
- Visible terminal feedback must begin within 500 ms.
- `scroll-capture-preview` and all four `scroll-mask-*` windows are hidden and reused, not closed during normal capture cleanup.
- Preview, edit, save, and clipboard output must come from the same native stitched PNG.
- The next screenshot after every terminal path starts with an empty selection.
- Diagnostic records must not contain screenshot pixels, OCR text, window body text, or clipboard data.
- Preserve the root-level `manual-finish-mask-test.html` manual test file.

---

## File Structure

- Create `apps/desktop/src-tauri/src/long_capture_cycle.rs`: pure, platform-independent gate that turns observer output into one settled candidate per motion cycle.
- Modify `apps/desktop/src-tauri/src/lib.rs`: export the cycle module.
- Modify `apps/desktop/src-tauri/src/long_capture.rs`: own session IDs, terminal arbitration, wakeable sampling, progress revisions, bounded diagnostics, settled-frame matching, result output, and idempotent cleanup.
- Modify `apps/desktop/src-tauri/src/preview_windows.rs`: create or reconfigure one reusable sidecar and keep existing reusable mask behavior.
- Modify `apps/desktop/src-tauri/src/main.rs`: route global Esc/Enter and Tauri commands through the unified native terminal API.
- Modify `apps/desktop/src/bridge/desktop-bridge.ts`: define progress identity and the typed terminal request contract.
- Modify `apps/desktop/src/bridge/tauri-desktop-bridge.ts`: invoke the unified terminal command and parse its response.
- Modify `apps/desktop/src/bridge/browser-desktop-bridge.ts`: implement the same interface for browser development.
- Modify `apps/desktop/src/components/ScrollCapturePreview.tsx`: use the current session ID, recover after rejected requests, and hide immediately after an accepted action.
- Modify `apps/desktop/src/components/ScreenshotEditor.tsx`: stop racing native cleanup with direct overlay closure.
- Modify `apps/desktop/src/App.tsx`: accept side changes when the preview window is reused.
- Modify colocated Rust tests plus `App.test.tsx`, `tauri-desktop-bridge.test.ts`, `ScrollCapturePreview.test.tsx`, and `ScreenshotEditor.test.tsx`.

---

### Task 1: Gate Matching Until One Settled Frame Per Motion Cycle

**Files:**
- Create: `apps/desktop/src-tauri/src/long_capture_cycle.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: `apps/desktop/src-tauri/src/long_capture_cycle.rs`

**Interfaces:**
- Consumes: `crate::region_observer::Observation`
- Produces: `StableFrameGate::observe(Observation) -> CycleDecision`
- Produces: `CycleDecision::{None, MotionStarted, StableCandidate}`

- [ ] **Step 1: Write the failing gate tests**

Create `apps/desktop/src-tauri/src/long_capture_cycle.rs` with the tests first:

```rust
use crate::region_observer::Observation;

#[cfg(test)]
mod tests {
    use super::{CycleDecision, StableFrameGate};
    use crate::region_observer::Observation;

    #[test]
    fn motion_frames_never_become_match_candidates() {
        let mut gate = StableFrameGate::default();
        assert_eq!(
            gate.observe(Observation::MotionStarted),
            CycleDecision::MotionStarted
        );
        assert_eq!(gate.observe(Observation::MotionFrame), CycleDecision::None);
        assert_eq!(gate.observe(Observation::Stabilizing), CycleDecision::None);
    }

    #[test]
    fn a_motion_cycle_yields_exactly_one_stable_candidate() {
        let mut gate = StableFrameGate::default();
        gate.observe(Observation::MotionStarted);
        gate.observe(Observation::MotionFrame);
        assert_eq!(
            gate.observe(Observation::StableFrame),
            CycleDecision::StableCandidate
        );
        assert_eq!(gate.observe(Observation::StableFrame), CycleDecision::None);
        assert_eq!(gate.observe(Observation::Unchanged), CycleDecision::None);
    }

    #[test]
    fn a_new_motion_cycle_can_recover_after_a_failed_match() {
        let mut gate = StableFrameGate::default();
        gate.observe(Observation::MotionStarted);
        assert_eq!(
            gate.observe(Observation::StableFrame),
            CycleDecision::StableCandidate
        );
        assert_eq!(
            gate.observe(Observation::MotionStarted),
            CycleDecision::MotionStarted
        );
        assert_eq!(
            gate.observe(Observation::StableFrame),
            CycleDecision::StableCandidate
        );
    }
}
```

- [ ] **Step 2: Run the focused Rust test and verify it fails**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml long_capture_cycle
```

Expected: compilation fails because `CycleDecision` and `StableFrameGate` are not defined.

- [ ] **Step 3: Implement the minimal pure gate**

Add above the test module:

```rust
use crate::region_observer::Observation;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CycleDecision {
    None,
    MotionStarted,
    StableCandidate,
}

#[derive(Debug, Default)]
pub(crate) struct StableFrameGate {
    motion_active: bool,
}

impl StableFrameGate {
    pub(crate) fn observe(&mut self, observation: Observation) -> CycleDecision {
        match observation {
            Observation::MotionStarted => {
                self.motion_active = true;
                CycleDecision::MotionStarted
            }
            Observation::StableFrame if self.motion_active => {
                self.motion_active = false;
                CycleDecision::StableCandidate
            }
            Observation::MotionFrame
            | Observation::Stabilizing
            | Observation::StableFrame
            | Observation::Unchanged
            | Observation::IdleWaiting => CycleDecision::None,
        }
    }
}
```

Export it from `apps/desktop/src-tauri/src/lib.rs`:

```rust
mod long_capture_cycle;
```

- [ ] **Step 4: Run the focused tests and the existing observer tests**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml long_capture_cycle
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml region_observer
```

Expected: all selected tests pass; no platform window is created.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/long_capture_cycle.rs
git commit -m "test: gate long capture matching on stable frames"
```

---

### Task 2: Make Native Terminal Arbitration Session-Aware and Wakeable

**Files:**
- Modify: `apps/desktop/src-tauri/src/long_capture.rs:1-380`
- Test: `apps/desktop/src-tauri/src/long_capture.rs`

**Interfaces:**
- Produces: `LongCaptureRuntime::begin() -> Result<u64, String>`
- Produces: `LongCaptureRuntime::request_terminal(session_id: u64, action: LongCaptureAction) -> TerminalRequestOutcome`
- Produces: `LongCaptureRuntime::request_current(action: LongCaptureAction) -> TerminalRequestOutcome`
- Produces: `LongCaptureRuntime::wait_for_sample_or_terminal(Duration) -> bool`
- Produces serialized `TerminalRequestOutcome { session_id, action, status }`

- [ ] **Step 1: Add failing tests for session isolation, first-action wins, and wakeup**

Add to the `long_capture.rs` test module:

```rust
#[test]
fn terminal_request_accepts_only_the_active_session_and_first_action() {
    let runtime = super::LongCaptureRuntime::default();
    let session_id = runtime.begin().unwrap();

    let stale = runtime.request_terminal(session_id + 1, LongCaptureAction::Cancel);
    assert_eq!(stale.status, super::TerminalRequestStatus::Stale);

    let accepted = runtime.request_terminal(session_id, LongCaptureAction::Finish);
    assert_eq!(accepted.status, super::TerminalRequestStatus::Accepted);
    assert_eq!(accepted.action, LongCaptureAction::Finish);

    let duplicate = runtime.request_terminal(session_id, LongCaptureAction::Cancel);
    assert_eq!(
        duplicate.status,
        super::TerminalRequestStatus::AlreadyTerminating
    );
    assert_eq!(duplicate.action, LongCaptureAction::Finish);
}

#[test]
fn terminal_request_wakes_the_sampling_wait() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    let runtime = Arc::new(super::LongCaptureRuntime::default());
    let session_id = runtime.begin().unwrap();
    let waiter = Arc::clone(&runtime);
    let started = Instant::now();
    let thread = std::thread::spawn(move || {
        waiter.wait_for_sample_or_terminal(Duration::from_secs(2))
    });

    std::thread::sleep(Duration::from_millis(20));
    runtime.request_terminal(session_id, LongCaptureAction::Cancel);

    assert!(thread.join().unwrap());
    assert!(started.elapsed() < Duration::from_millis(500));
}

#[test]
fn finishing_an_old_session_does_not_clear_a_new_session() {
    let runtime = super::LongCaptureRuntime::default();
    let first = runtime.begin().unwrap();
    runtime.finish(first);
    let second = runtime.begin().unwrap();
    runtime.finish(first);
    assert!(runtime.is_active());
    assert_eq!(runtime.active_session_id(), second);
}
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml terminal_request
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml finishing_an_old_session
```

Expected: compilation fails because session-aware runtime methods and terminal response types do not exist.

- [ ] **Step 3: Add native response types and synchronization fields**

Change the runtime imports and types to:

```rust
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
    Condvar, Mutex,
};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalRequestStatus {
    Accepted,
    AlreadyTerminating,
    Stale,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRequestOutcome {
    session_id: u64,
    action: LongCaptureAction,
    status: TerminalRequestStatus,
}

pub struct LongCaptureRuntime {
    active: AtomicBool,
    next_session_id: AtomicU64,
    active_session_id: AtomicU64,
    stop_requested: AtomicBool,
    cancel_requested: AtomicBool,
    progress: Mutex<LongCaptureProgress>,
    action: AtomicU8,
    terminal_epoch: Mutex<u64>,
    terminal_changed: Condvar,
}
```

Initialize the new fields in `Default` with zero atomics, `Mutex::new(0)`, and `Condvar::new()`.

- [ ] **Step 4: Implement session-aware begin, finish, arbitration, and wakeup**

Replace the current terminal methods with:

```rust
fn begin(&self) -> Result<u64, String> {
    self.active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "a long capture is already running".to_string())?;
    let session_id = self.next_session_id.fetch_add(1, Ordering::AcqRel) + 1;
    self.active_session_id.store(session_id, Ordering::Release);
    self.stop_requested.store(false, Ordering::Release);
    self.cancel_requested.store(false, Ordering::Release);
    self.action.store(LongCaptureAction::None.code(), Ordering::Release);
    self.update(session_id, 0, 0, 0, "preparing", Vec::new(), false, 0);
    Ok(session_id)
}

fn finish(&self, session_id: u64) {
    if self.active_session_id.load(Ordering::Acquire) == session_id {
        self.active.store(false, Ordering::Release);
    }
}

fn active_session_id(&self) -> u64 {
    self.active_session_id.load(Ordering::Acquire)
}

pub fn request_terminal(
    &self,
    session_id: u64,
    requested: LongCaptureAction,
) -> TerminalRequestOutcome {
    if !self.is_active() || self.active_session_id() != session_id {
        return TerminalRequestOutcome {
            session_id,
            action: requested,
            status: TerminalRequestStatus::Stale,
        };
    }
    let accepted = self.action.compare_exchange(
        LongCaptureAction::None.code(),
        requested.code(),
        Ordering::AcqRel,
        Ordering::Acquire,
    ).is_ok();
    let action = if accepted { requested } else { self.requested_action() };
    if accepted {
        if action == LongCaptureAction::Cancel {
            self.cancel_requested.store(true, Ordering::Release);
        } else {
            self.stop_requested.store(true, Ordering::Release);
        }
        if let Ok(mut epoch) = self.terminal_epoch.lock() {
            *epoch = epoch.saturating_add(1);
        }
        self.terminal_changed.notify_all();
    }
    TerminalRequestOutcome {
        session_id,
        action,
        status: if accepted {
            TerminalRequestStatus::Accepted
        } else {
            TerminalRequestStatus::AlreadyTerminating
        },
    }
}

pub fn request_current(&self, action: LongCaptureAction) -> TerminalRequestOutcome {
    self.request_terminal(self.active_session_id(), action)
}

fn wait_for_sample_or_terminal(&self, duration: Duration) -> bool {
    if self.requested_action() != LongCaptureAction::None {
        return true;
    }
    let Ok(epoch) = self.terminal_epoch.lock() else {
        return false;
    };
    let initial = *epoch;
    let Ok((epoch, _)) = self.terminal_changed.wait_timeout_while(
        epoch,
        duration,
        |current| *current == initial && self.requested_action() == LongCaptureAction::None,
    ) else {
        return false;
    };
    *epoch != initial || self.requested_action() != LongCaptureAction::None
}
```

Keep `request_cancel()` and `request_finish()` as thin global-shortcut adapters that call `request_current`.

- [ ] **Step 5: Run runtime tests**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml long_capture::tests
```

Expected: all `long_capture::tests` pass, including wakeup under 500 ms.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/long_capture.rs
git commit -m "feat: coordinate long capture terminal actions"
```

---

### Task 3: Integrate Settled-Frame Matching, Monotonic Progress, and Safe Diagnostics

**Files:**
- Modify: `apps/desktop/src-tauri/src/long_capture.rs:44-760`
- Modify: `apps/desktop/src-tauri/src/region_observer.rs:80-145`
- Test: `apps/desktop/src-tauri/src/long_capture.rs`
- Test: `apps/desktop/src-tauri/src/region_observer.rs`

**Interfaces:**
- Consumes: `StableFrameGate::observe`
- Produces progress fields `session_id: u64` and `revision: u64`
- Produces: `LongCaptureRuntime::record_diagnostic(LongCaptureDiagnostic)`
- Produces: `match_motion_candidate(...) -> Result<MatchMotionOutcome, String>`
- Produces: `RegionObserver::last_difference() -> f64`

- [ ] **Step 1: Write failing integration-policy tests**

Replace the old `observation_requires_match` and preview-throttle tests with:

```rust
#[test]
fn only_a_stable_candidate_invokes_matching_once_per_cycle() {
    use crate::long_capture_cycle::{CycleDecision, StableFrameGate};

    let mut gate = StableFrameGate::default();
    let observations = [
        Observation::MotionStarted,
        Observation::MotionFrame,
        Observation::Stabilizing,
        Observation::StableFrame,
        Observation::StableFrame,
    ];
    let decisions = observations.map(|value| gate.observe(value));
    assert_eq!(
        decisions,
        [
            CycleDecision::MotionStarted,
            CycleDecision::None,
            CycleDecision::None,
            CycleDecision::StableCandidate,
            CycleDecision::None,
        ]
    );
}

#[test]
fn progress_revision_changes_only_after_an_accepted_append() {
    let runtime = super::LongCaptureRuntime::default();
    let session_id = runtime.begin().unwrap();
    runtime.update(session_id, 0, 1, 800, "observing", vec![1], false, 400);
    let first = runtime.progress.lock().unwrap().clone();
    runtime.update(session_id, 0, 1, 800, "scrolling", vec![1], false, 400);
    let moving = runtime.progress.lock().unwrap().clone();
    runtime.update(session_id, 1, 2, 1_200, "observing", vec![2], false, 400);
    let appended = runtime.progress.lock().unwrap().clone();

    assert_eq!(first.revision, moving.revision);
    assert_eq!(appended.revision, first.revision + 1);
    assert_eq!(appended.session_id, session_id);
}

#[test]
fn diagnostic_buffer_is_bounded_and_contains_no_pixel_payload() {
    let runtime = super::LongCaptureRuntime::default();
    for revision in 0..80 {
        runtime.record_diagnostic(super::LongCaptureDiagnostic {
            revision,
            state: "observing",
            observed_at_millis: revision,
            change_ratio_micros: 0,
            match_direction: "none",
            overlap_rows: None,
            added_height: None,
        });
    }
    let diagnostics = runtime.diagnostics.lock().unwrap();
    assert_eq!(diagnostics.len(), 64);
    assert_eq!(diagnostics.front().unwrap().revision, 16);
}
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml progress_revision
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml diagnostic_buffer
```

Expected: compilation fails because progress identity and diagnostics are absent.

- [ ] **Step 3: Add progress identity and bounded metadata diagnostics**

Extend `LongCaptureProgress`:

```rust
session_id: u64,
revision: u64,
```

Add to the runtime:

```rust
use std::collections::VecDeque;

#[derive(Clone, Copy, Debug)]
struct LongCaptureDiagnostic {
    revision: u64,
    state: &'static str,
    observed_at_millis: u64,
    change_ratio_micros: u32,
    match_direction: &'static str,
    overlap_rows: Option<u32>,
    added_height: Option<u32>,
}

diagnostics: Mutex<VecDeque<LongCaptureDiagnostic>>,
```

Implement:

```rust
fn record_diagnostic(&self, event: LongCaptureDiagnostic) {
    if let Ok(mut events) = self.diagnostics.lock() {
        if events.len() == 64 {
            events.pop_front();
        }
        events.push_back(event);
    }
}
```

Update `LongCaptureRuntime::update` and `publish_progress` to receive `session_id` and `revision`. Never place PNG bytes or recognized text in `LongCaptureDiagnostic`.

- [ ] **Step 4: Expose the observer's latest numeric change ratio**

Add `last_difference: f64` to `RegionObserver`, initialize it to `0.0`, and calculate it before deciding whether the frame changed:

```rust
let difference = self
    .previous
    .as_deref()
    .map_or(0.0, |previous| sample_difference(previous, pixels));
self.last_difference = difference;
let changed = difference > self.change_threshold;
```

Expose only the numeric value:

```rust
pub fn last_difference(&self) -> f64 {
    self.last_difference
}
```

Add a test that observes `[0; 16]`, then `[255; 16]`, and asserts `last_difference() == 1.0`. This records no pixels.

- [ ] **Step 5: Return structured, pixel-free match metadata**

Define:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MatchMotionOutcome {
    appended: bool,
    direction: &'static str,
    overlap_rows: Option<u32>,
    added_height: Option<u32>,
}
```

Change `match_motion_candidate` to return:

```rust
MatchDirection::Forward { overlap_rows } => {
    let added_height = append_matched_candidate(
        stitcher,
        accepted_tail,
        candidate.clone(),
        overlap_rows.min(candidate.height.saturating_sub(1)),
    )?;
    if added_height == 0 {
        session
            .unmatched()
            .map_err(|_| "invalid zero-shift transition")?;
        return Ok(MatchMotionOutcome {
            appended: false,
            direction: "unchanged",
            overlap_rows: Some(overlap_rows),
            added_height: Some(0),
        });
    }
    session
        .forward_matched(added_height)
        .map_err(|_| "invalid forward-match transition")?;
    Ok(MatchMotionOutcome {
        appended: true,
        direction: "forward",
        overlap_rows: Some(overlap_rows),
        added_height: Some(added_height),
    })
}
MatchDirection::Reverse => {
    session
        .reverse_detected()
        .map_err(|_| "invalid reverse-match transition")?;
    Ok(MatchMotionOutcome {
        appended: false,
        direction: "reverse",
        overlap_rows: None,
        added_height: None,
    })
}
MatchDirection::Unmatched => {
    session
        .unmatched()
        .map_err(|_| "invalid unmatched transition")?;
    Ok(MatchMotionOutcome {
        appended: false,
        direction: "unmatched",
        overlap_rows: None,
        added_height: None,
    })
}
```

- [ ] **Step 6: Replace motion-frame matching with settled-frame matching**

In `run_capture`, replace `latest_motion_frame_was_appended` and `observation_requires_match` with:

```rust
let mut gate = StableFrameGate::default();
let mut revision = 0_u64;

// Inside the loop, after observer.observe:
match gate.observe(observation) {
    CycleDecision::MotionStarted => {
        session
            .motion_started()
            .map_err(|_| "invalid motion transition")?;
    }
    CycleDecision::StableCandidate => {
        let settled = crop_region(platform::capture_monitors()?, region)?;
        let outcome = match_motion_candidate(
            &mut session,
            &mut stitcher,
            &accepted_tail,
            &settled,
        )?;
        if outcome.appended {
            accepted_tail = settled;
            observer.mark_appended(observed_at);
            preview_png = encode_png(
                &stitcher
                    .preview()
                    .map_err(|error| format!("preview failed: {error:?}"))?,
            )?;
            revision = revision.saturating_add(1);
        }
        runtime.record_diagnostic(LongCaptureDiagnostic {
            revision,
            state: session_state_name(session.state()),
            observed_at_millis: observed_at.as_millis() as u64,
            change_ratio_micros: (observer.last_difference() * 1_000_000.0) as u32,
            match_direction: outcome.direction,
            overlap_rows: outcome.overlap_rows,
            added_height: outcome.added_height,
        });
    }
    CycleDecision::None => {}
}
publish_progress(
    runtime,
    session_id,
    revision,
    &session,
    &preview_png,
    accepted_tail.width,
);
```

Delete `observation_requires_match`, `should_refresh_preview`, `PREVIEW_UPDATE_INTERVAL`, `latest_motion_frame_was_appended`, `preview_dirty`, and `last_preview_refresh`. Replace the final `std::thread::sleep(SAMPLE_INTERVAL)` with:

```rust
if runtime.wait_for_sample_or_terminal(SAMPLE_INTERVAL) {
    continue;
}
```

Pass `session_id` into `run_capture`, and call `runtime.finish(session_id)` from `start_long_capture`.

- [ ] **Step 7: Test zero-height and recovery behavior**

Update existing `match_motion_candidate` assertions to inspect `outcome.appended`. Add a synthetic-frame test asserting that duplicate stable frames return `direction == "unchanged"` and do not increase `frame_count` or `stitched_height`. Retain the existing warning recovery test proving a later `MotionStarted -> StableFrame` cycle can append.

- [ ] **Step 8: Update the observer test name to reflect its responsibility**

Rename `continuous_motion_exposes_intermediate_frames_for_stitching` to `continuous_motion_reports_motion_without_claiming_stability`. Keep its assertions on `MotionStarted` and `MotionFrame`; matching responsibility now belongs exclusively to `StableFrameGate`.

- [ ] **Step 9: Run Rust tests**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: every Rust unit test passes and synthetic multi-screen frames increase stitched height only after `StableFrame`.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src-tauri/src/long_capture.rs apps/desktop/src-tauri/src/region_observer.rs
git commit -m "fix: stitch long capture after scrolling settles"
```

---

### Task 4: Hide and Reuse the Sidecar and Mask Windows

**Files:**
- Modify: `apps/desktop/src-tauri/src/preview_windows.rs:20-360`
- Modify: `apps/desktop/src-tauri/src/long_capture.rs:560-950`
- Modify: `apps/desktop/src/App.tsx:20-125`
- Test: `apps/desktop/src-tauri/src/preview_windows.rs`
- Test: `apps/desktop/src-tauri/src/long_capture.rs`
- Test: `apps/desktop/src/App.test.tsx`

**Interfaces:**
- Produces: `PreviewWindowUpdate { side: &'static str }`
- Produces event: `scroll-preview-layout`
- Preserves reusable labels: `scroll-capture-preview`, `scroll-mask-top`, `scroll-mask-right`, `scroll-mask-bottom`, `scroll-mask-left`

- [ ] **Step 1: Write failing Rust lifecycle tests**

Add pure lifecycle tests:

```rust
#[test]
fn existing_preview_window_is_reused_instead_of_recreated() {
    assert_eq!(
        preview_window_operation(true),
        PreviewWindowOperation::Reuse
    );
    assert_eq!(
        preview_window_operation(false),
        PreviewWindowOperation::Create
    );
}

#[test]
fn cleanup_hides_all_long_capture_windows_without_closing_any() {
    let hidden = RefCell::new(Vec::new());
    cleanup_capture_windows(
        &[
            "scroll-capture-preview",
            "scroll-mask-top",
            "scroll-mask-right",
            "scroll-mask-bottom",
            "scroll-mask-left",
        ],
        |label| {
            hidden.borrow_mut().push(label.to_string());
            Ok(())
        },
    ).unwrap();
    assert_eq!(hidden.borrow().len(), 5);
}
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml existing_preview_window
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml cleanup_hides_all
```

Expected: the preview lifecycle helper is undefined and current cleanup closes the sidecar.

- [ ] **Step 3: Implement reusable sidecar configuration**

Add:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PreviewWindowOperation {
    Reuse,
    Create,
}

fn preview_window_operation(exists: bool) -> PreviewWindowOperation {
    if exists {
        PreviewWindowOperation::Reuse
    } else {
        PreviewWindowOperation::Create
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewWindowUpdate {
    side: &'static str,
}
```

Refactor `open_preview_window` so an existing window is repositioned and resized with `set_position` and `set_size`, receives `scroll-preview-layout`, and is shown. Only build a new WebView when no existing label exists. Remove both existing `hide(); close();` pairs from `open_preview_window` and `open_controls_window`.

- [ ] **Step 4: Make normal cleanup hide-only**

Change `cleanup_capture_windows` to accept only a reusable-label slice and a `hide` callback. Remove its ephemeral-label slice and `close` callback from the function signature so normal cleanup cannot close a helper window. In `CaptureCleanup`, deactivate masks and hide `scroll-capture-preview`; retain per-step error aggregation. Remove `drop(capture_windows)` as a lifecycle signal because dropping a Tauri handle must not determine window visibility.

- [ ] **Step 5: Make the reused App side responsive**

In `App.tsx`, add:

```tsx
type ScrollPreviewLayout = Readonly<{ side: 'left' | 'right' }>;

const [previewSide, setPreviewSide] = useState<'left' | 'right'>(() =>
  windowParameters.get('side') === 'left' ? 'left' : 'right'
);
```

When `controlWindow` is true, listen for `scroll-preview-layout` and call `setPreviewSide(event.payload.side)`. Render:

```tsx
if (controlWindow) {
  return <ScrollCapturePreview bridge={desktopBridge} side={previewSide} />;
}
```

Add an `App.test.tsx` test that dispatches `scroll-preview-layout` and expects `data-side` to change from `right` to `left`.

- [ ] **Step 6: Run lifecycle and App tests**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml preview_windows
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml cleanup
npm --prefix apps/desktop test -- --run src/App.test.tsx
```

Expected: all selected tests pass; no normal cleanup test records a close operation.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/preview_windows.rs apps/desktop/src-tauri/src/long_capture.rs apps/desktop/src/App.tsx apps/desktop/src/App.test.tsx
git commit -m "fix: reuse long capture helper windows"
```

---

### Task 5: Expose One Typed Terminal Command Through the Desktop Bridge

**Files:**
- Modify: `apps/desktop/src-tauri/src/long_capture.rs:950-990`
- Modify: `apps/desktop/src-tauri/src/main.rs:14-76`
- Modify: `apps/desktop/src/bridge/desktop-bridge.ts:1-48`
- Modify: `apps/desktop/src/bridge/tauri-desktop-bridge.ts:1-125`
- Modify: `apps/desktop/src/bridge/browser-desktop-bridge.ts:25-45`
- Test: `apps/desktop/src/bridge/tauri-desktop-bridge.test.ts`

**Interfaces:**
- Produces Tauri command: `request_long_capture_terminal(session_id: u64, action: LongCaptureAction) -> TerminalRequestOutcome`
- Produces TypeScript: `requestLongCaptureTerminal(sessionId, action) -> Promise<LongCaptureTerminalOutcome>`
- Removes bridge use of `stopLongCapture`, `editLongCapture`, `saveLongCapture`, `finishLongCapture`, and `cancelLongCapture`

- [ ] **Step 1: Write failing bridge contract tests**

Add to `tauri-desktop-bridge.test.ts`:

```ts
it('submits a session-scoped long capture terminal action', async () => {
  const invoke = vi.fn().mockResolvedValue({
    sessionId: 17,
    action: 'finish',
    status: 'accepted',
  });
  const bridge = createTauriDesktopBridge(invoke);

  await expect(bridge.requestLongCaptureTerminal(17, 'finish')).resolves.toEqual({
    sessionId: 17,
    action: 'finish',
    status: 'accepted',
  });
  expect(invoke).toHaveBeenCalledWith('request_long_capture_terminal', {
    sessionId: 17,
    action: 'finish',
  });
});

it('rejects an invalid terminal response', async () => {
  const bridge = createTauriDesktopBridge(
    vi.fn().mockResolvedValue({ sessionId: 17, action: 'finish', status: 'unknown' }),
  );
  await expect(bridge.requestLongCaptureTerminal(17, 'finish'))
    .rejects.toThrow('invalid long capture terminal response');
});
```

Update progress fixtures to include `sessionId` and `revision`.

- [ ] **Step 2: Run bridge tests and verify they fail**

Run:

```bash
npm --prefix apps/desktop test -- --run src/bridge/tauri-desktop-bridge.test.ts
```

Expected: TypeScript compilation fails because the unified bridge method and progress fields do not exist.

- [ ] **Step 3: Define the TypeScript contract**

Add to `desktop-bridge.ts`:

```ts
export type LongCaptureTerminalAction = 'edit' | 'save' | 'cancel' | 'finish';
export type LongCaptureTerminalOutcome = Readonly<{
  sessionId: number;
  action: LongCaptureTerminalAction;
  status: 'accepted' | 'alreadyTerminating' | 'stale';
}>;
```

Add `sessionId: number` and `revision: number` to `LongCaptureProgress`. Replace the five separate terminal methods on `DesktopBridge` with:

```ts
requestLongCaptureTerminal(
  sessionId: number,
  action: LongCaptureTerminalAction,
): Promise<LongCaptureTerminalOutcome>;
```

- [ ] **Step 4: Implement and validate the bridge**

In `tauri-desktop-bridge.ts`, validate integer positive session IDs, supported actions, and the three statuses. Invoke:

```ts
async requestLongCaptureTerminal(sessionId, action) {
  const value = await invoke('request_long_capture_terminal', { sessionId, action });
  if (!value || typeof value !== 'object') {
    throw new Error('invalid long capture terminal response');
  }
  const outcome = value as Record<string, unknown>;
  if (
    outcome.sessionId !== sessionId
    || !['edit', 'save', 'cancel', 'finish'].includes(outcome.action as string)
    || !['accepted', 'alreadyTerminating', 'stale'].includes(outcome.status as string)
  ) {
    throw new Error('invalid long capture terminal response');
  }
  return outcome as LongCaptureTerminalOutcome;
}
```

Mirror the method in `browser-desktop-bridge.ts` with an `accepted` response for local browser rendering.

- [ ] **Step 5: Consolidate native commands and global shortcuts**

Add:

```rust
#[tauri::command]
pub fn request_long_capture_terminal(
    runtime: tauri::State<'_, LongCaptureRuntime>,
    session_id: u64,
    action: LongCaptureAction,
) -> TerminalRequestOutcome {
    runtime.request_terminal(session_id, action)
}
```

Register this one command in `main.rs` and remove the five separate terminal commands from `generate_handler!`. Keep global Esc and Enter routed through `request_current(LongCaptureAction::Cancel)` and `request_current(LongCaptureAction::Finish)` because global shortcuts act on the current native session.

- [ ] **Step 6: Run bridge, type, and Rust command tests**

Run:

```bash
npm --prefix apps/desktop test -- --run src/bridge/tauri-desktop-bridge.test.ts
npm --prefix apps/desktop run typecheck
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml long_capture::tests
```

Expected: all selected tests and type checking pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/long_capture.rs apps/desktop/src-tauri/src/main.rs apps/desktop/src/bridge/desktop-bridge.ts apps/desktop/src/bridge/tauri-desktop-bridge.ts apps/desktop/src/bridge/browser-desktop-bridge.ts apps/desktop/src/bridge/tauri-desktop-bridge.test.ts
git commit -m "refactor: unify long capture terminal requests"
```

---

### Task 6: Make Sidecar and Overlay Terminal Behavior Reliable

**Files:**
- Modify: `apps/desktop/src/components/ScrollCapturePreview.tsx:1-65`
- Modify: `apps/desktop/src/components/ScreenshotEditor.tsx:334-445,650-705`
- Modify: `apps/desktop/src/components/ScrollCapturePreview.test.tsx`
- Modify: `apps/desktop/src/components/ScreenshotEditor.test.tsx`
- Modify: desktop test bridge fixtures in `apps/desktop/src/**/*.test.tsx`

**Interfaces:**
- Consumes: `requestLongCaptureTerminal(sessionId, action)`
- Consumes: `LongCaptureProgress.sessionId`
- Preserves native result actions: `edit`, `save`, `finish`

- [ ] **Step 1: Write failing sidecar behavior tests**

Replace the current permanent-disable test with:

```tsx
it('submits the current session and hides after an accepted terminal action', async () => {
  const desktop = bridge();
  desktop.requestLongCaptureTerminal = vi.fn().mockResolvedValue({
    sessionId: 17,
    action: 'finish',
    status: 'accepted',
  });
  const { container } = render(<ScrollCapturePreview bridge={desktop} side="right" />);

  await userEvent.click(await screen.findByRole('button', { name: '完成长截图' }));

  expect(desktop.requestLongCaptureTerminal).toHaveBeenCalledWith(17, 'finish');
  expect(container.querySelector('.scroll-sidecar')).toHaveAttribute('data-terminating', 'true');
});

it('restores all actions when a terminal request fails', async () => {
  const desktop = bridge();
  desktop.requestLongCaptureTerminal = vi.fn().mockRejectedValue(new Error('invoke failed'));
  render(<ScrollCapturePreview bridge={desktop} side="right" />);

  await userEvent.click(await screen.findByRole('button', { name: '取消长截图' }));

  for (const button of screen.getAllByRole('button')) {
    expect(button).toBeEnabled();
  }
});

it('does not send a terminal action before progress identifies the session', () => {
  const desktop = bridge();
  desktop.getLongCaptureProgress = vi.fn().mockResolvedValue({
    ...progressFixture,
    sessionId: 0,
  });
  render(<ScrollCapturePreview bridge={desktop} side="right" />);
  expect(screen.getAllByRole('button').every((button) => button.hasAttribute('disabled')))
    .toBe(true);
});
```

Use `sessionId: 17` and `revision: 3` in the normal progress fixture.

- [ ] **Step 2: Write a failing editor test for native-owned cancellation**

Update the Esc test so the bridge returns an accepted cancel response and assert:

```tsx
expect(bridge.requestLongCaptureTerminal).toHaveBeenCalledWith(17, 'cancel');
expect(bridge.closeOverlay).not.toHaveBeenCalled();
expect(screen.getByLabelText('截图编辑器'))
  .toHaveAttribute('data-capture-mode', 'selecting');
expect(screen.queryByTestId('selection-box')).not.toBeInTheDocument();
```

This test locks in that native cleanup, not a competing front-end `closeOverlay`, owns long-capture exit.

- [ ] **Step 3: Run component tests and verify they fail**

Run:

```bash
npm --prefix apps/desktop test -- --run src/components/ScrollCapturePreview.test.tsx src/components/ScreenshotEditor.test.tsx
```

Expected: tests fail because components still call separate bridge methods and the editor closes the overlay directly.

- [ ] **Step 4: Implement recoverable sidecar submission**

Replace `submittedRef` with an async status:

```tsx
const [terminating, setTerminating] = useState(false);

const submit = async (action: LongCaptureTerminalAction) => {
  const sessionId = progress?.sessionId ?? 0;
  if (!sessionId || terminating) return;
  setTerminating(true);
  try {
    const result = await bridge.requestLongCaptureTerminal(sessionId, action);
    if (result.status === 'stale') setTerminating(false);
  } catch {
    setTerminating(false);
  }
};
```

Map icons to action names rather than bound methods. Disable while `sessionId === 0` or `terminating`. Add `data-terminating={terminating}` to the root so accepted actions receive immediate visual feedback while native code hides the window.

- [ ] **Step 5: Remove the overlay-close race**

Track the latest native long-capture session ID in `ScreenshotEditor`. During Esc:

```tsx
const sessionId = longCaptureProgress?.sessionId ?? 0;
if (sessionId > 0) {
  resetEditorSession();
  void bridge.requestLongCaptureTerminal(sessionId, 'cancel').catch((error) => {
    setError(`长截图退出失败：${errorMessage(error)}`);
  });
  return;
}
```

Delete `longCaptureCancelInFlight`, `longCaptureCancelled`, and `cancelLongCaptureAndClose`. Do not call `closeOverlay` from this branch. The native `start_long_capture` completion and session reset event remain authoritative.

When initializing progress before the first native poll, use:

```ts
sessionId: 0,
revision: 0,
```

- [ ] **Step 6: Update test bridge fixtures mechanically**

Replace fixture methods `stopLongCapture`, `editLongCapture`, `saveLongCapture`, `finishLongCapture`, and `cancelLongCapture` with:

```ts
requestLongCaptureTerminal: vi.fn().mockResolvedValue({
  sessionId: 1,
  action: 'cancel',
  status: 'accepted',
}),
```

Give every `LongCaptureProgress` fixture explicit `sessionId` and `revision` values. Do not loosen `DesktopBridge` with optional methods or `any`.

- [ ] **Step 7: Run all desktop tests and type checking**

Run:

```bash
npm --prefix apps/desktop test -- --run
npm --prefix apps/desktop run typecheck
```

Expected: the complete desktop test suite passes and TypeScript reports no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/components/ScrollCapturePreview.tsx apps/desktop/src/components/ScrollCapturePreview.test.tsx apps/desktop/src/components/ScreenshotEditor.tsx apps/desktop/src/components/ScreenshotEditor.test.tsx apps/desktop/src
git commit -m "fix: make long capture controls reliably terminate"
```

---

### Task 7: Full Verification and Windows Acceptance Handoff

**Files:**
- Modify if results change: `docs/superpowers/plans/2026-07-21-project-continuation-roadmap.md`
- Preserve: `manual-finish-mask-test.html`

**Interfaces:**
- Consumes all implementation tasks
- Produces a clean, reviewable main-branch verification point

- [ ] **Step 1: Format and run all automated checks**

Run:

```bash
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm --prefix apps/desktop test -- --run
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run build
```

Expected: every command exits with code 0. Record the exact Rust and desktop test totals in the handoff.

- [ ] **Step 2: Build the Windows debug application**

Run from Windows PowerShell:

```powershell
Set-Location E:\dnmp\www\screenshot
npm --prefix apps/desktop run tauri -- build --debug --no-bundle
```

Expected: `apps\desktop\src-tauri\target\debug\screenshot-tool.exe` is produced successfully.

- [ ] **Step 3: Run the four-application manual matrix**

For Chrome or Edge, WeChat, File Explorer, and Windows Settings:

1. Start a fresh screenshot with `Alt+Shift+A`.
2. Select a scrollable region and enter long capture.
3. Scroll three screens, pausing after each scroll.
4. Confirm `frameCount > 1` and `stitchedHeight > selection height`.
5. Finish once with Enter and once with the check icon; paste and compare dimensions.
6. Cancel once with Esc and once with X.
7. Confirm every terminal action hides visible helper windows within 500 ms.
8. Confirm there are no black shrinking windows.
9. Start another screenshot and confirm the selection is empty.

Use `manual-finish-mask-test.html` as an additional deterministic page; do not move or delete it.

- [ ] **Step 4: Update the continuation roadmap with evidence**

Only after the matrix passes, mark long capture accepted and include:

```markdown
- Stable-frame manual long capture: accepted on Chrome/Edge, WeChat, File Explorer, and Settings.
- Terminal paths: Enter, check, Esc, and X passed three consecutive rounds.
- Helper window lifecycle: hide/reuse confirmed; no black close animation observed.
- Output parity: preview, clipboard, edit, and save dimensions matched.
```

If a matrix item fails, leave it open and record the application, terminal route, observed frame count, stitched height, and diagnostic metadata without storing captured pixels.

- [ ] **Step 5: Commit verification documentation when changed**

```bash
git add docs/superpowers/plans/2026-07-21-project-continuation-roadmap.md
git commit -m "docs: record long capture acceptance"
```

Skip this commit when the roadmap content is unchanged.

- [ ] **Step 6: Confirm repository state**

Run:

```bash
git status --short
git log -8 --oneline
```

Expected: no uncommitted implementation files remain. Do not push; wait for the user to request GitHub Desktop.
