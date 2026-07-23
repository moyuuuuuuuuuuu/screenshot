use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
    Condvar, Mutex,
};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::long_capture_cycle::{CycleDecision, StableFrameGate};
use crate::platform::{self, RawMonitorFrame};
use crate::preview_windows::{
    deactivate_capture_mask_windows, open_capture_mask_windows, open_preview_window, ScreenRect,
};
use crate::region_observer::{Observation, RegionObserver, SAMPLE_INTERVAL};
use crate::scroll_controller::{LongCaptureSession, LongCaptureState, SessionError};
use crate::static_region_detector::detect_static_regions;
use crate::stitcher::{
    downscale_grayscale, match_vertical_scroll, ChunkedStitcher, MatchDirection, RgbaFrame,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl CaptureRegion {
    fn to_physical(self, origin_x: i32, origin_y: i32, scale_factor: f64) -> Self {
        Self {
            x: f64::from(origin_x) + self.x * scale_factor,
            y: f64::from(origin_y) + self.y * scale_factor,
            width: self.width * scale_factor,
            height: self.height * scale_factor,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureProgress {
    session_id: u64,
    revision: u64,
    frame_count: u32,
    stitched_height: u32,
    state: &'static str,
    preview_png_bytes: Vec<u8>,
    navigator_png_bytes: Vec<u8>,
    accepted_bounds: Option<AcceptedBounds>,
    warning: bool,
    slow_scroll_warning: bool,
}

#[allow(dead_code)]
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

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AcceptedBounds {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LongCaptureAction {
    None,
    Edit,
    Save,
    Cancel,
    Finish,
}

impl LongCaptureAction {
    fn code(self) -> u8 {
        self as u8
    }
    fn from_code(code: u8) -> Self {
        match code {
            1 => Self::Edit,
            2 => Self::Save,
            3 => Self::Cancel,
            4 => Self::Finish,
            _ => Self::None,
        }
    }
}

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureResult {
    png_bytes: Vec<u8>,
    partial: bool,
    action: LongCaptureAction,
    clipboard_error: Option<String>,
    cleanup_error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureTermination {
    Cancelled,
    Partial,
    Completed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OverlayCleanup {
    Restore,
    Hide,
}

fn overlay_cleanup(cancel_requested: bool) -> OverlayCleanup {
    if cancel_requested {
        OverlayCleanup::Hide
    } else {
        OverlayCleanup::Restore
    }
}

fn termination(cancel: bool, stop: bool, accepted_frames: u32) -> CaptureTermination {
    if cancel || accepted_frames == 0 {
        CaptureTermination::Cancelled
    } else if stop {
        CaptureTermination::Partial
    } else {
        CaptureTermination::Completed
    }
}

fn finalize_capture_result(
    png_bytes: Vec<u8>,
    partial: bool,
    action: LongCaptureAction,
    copy_png: impl FnOnce(&[u8]) -> Result<(), String>,
) -> Result<LongCaptureResult, String> {
    let (action, clipboard_error) = if action == LongCaptureAction::Finish {
        match copy_png(&png_bytes) {
            Ok(()) => (LongCaptureAction::Finish, None),
            Err(error) => (LongCaptureAction::Edit, Some(error)),
        }
    } else {
        (action, None)
    };
    Ok(LongCaptureResult {
        png_bytes,
        partial,
        action,
        clipboard_error,
        cleanup_error: None,
    })
}

fn recover_from_cleanup_failure(mut result: LongCaptureResult, error: String) -> LongCaptureResult {
    result.action = LongCaptureAction::Edit;
    result.cleanup_error = Some(error);
    result
}

fn resolve_capture_cleanup(
    capture_result: Result<LongCaptureResult, String>,
    cleanup_result: Result<(), String>,
) -> Result<LongCaptureResult, String> {
    match (capture_result, cleanup_result) {
        (Ok(result), Ok(())) => Ok(result),
        (Ok(result), Err(error)) => Ok(recover_from_cleanup_failure(result, error)),
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup_error)) => Err(format!("{error}; cleanup: {cleanup_error}")),
    }
}

fn restore_overlay_for_cleanup_diagnostic(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    diagnostic: &str,
) -> Result<(), String> {
    let mut errors = Vec::new();
    if let Err(error) = platform::restore_window_capture(window) {
        errors.push(error);
    }
    if let Err(error) = app.emit("long-capture-presentation", false) {
        errors.push(format!(
            "failed to restore long capture presentation: {error}"
        ));
    }
    if let Err(error) = window.set_ignore_cursor_events(false) {
        errors.push(format!("failed to restore overlay input: {error}"));
    }
    if let Err(error) = window.show() {
        errors.push(format!("failed to show diagnostic overlay: {error}"));
    }
    if let Err(error) = window.set_focus() {
        errors.push(format!("failed to focus diagnostic overlay: {error}"));
    }
    if let Err(error) = window.emit("capture-error", diagnostic) {
        errors.push(format!("failed to emit cleanup diagnostic: {error}"));
    }
    finish_cleanup_errors(errors)
}

fn finish_cleanup_errors(errors: Vec<String>) -> Result<(), String> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

struct CaptureCleanup<Restore, Close>
where
    Restore: FnOnce() -> Result<(), String>,
    Close: FnOnce() -> Result<(), String>,
{
    restore_overlay: Option<Restore>,
    close_controls: Option<Close>,
}

impl<Restore, Close> CaptureCleanup<Restore, Close>
where
    Restore: FnOnce() -> Result<(), String>,
    Close: FnOnce() -> Result<(), String>,
{
    fn new(restore_overlay: Restore, close_controls: Close) -> Self {
        Self {
            restore_overlay: Some(restore_overlay),
            close_controls: Some(close_controls),
        }
    }

    fn complete(mut self) -> Result<(), String> {
        let mut errors = Vec::new();
        if let Some(close) = self.close_controls.take() {
            if let Err(error) = close() {
                errors.push(error);
            }
        }
        if let Some(restore) = self.restore_overlay.take() {
            if let Err(error) = restore() {
                errors.push(error);
            }
        }
        finish_cleanup_errors(errors)
    }
}

impl<Restore, Close> Drop for CaptureCleanup<Restore, Close>
where
    Restore: FnOnce() -> Result<(), String>,
    Close: FnOnce() -> Result<(), String>,
{
    fn drop(&mut self) {
        if let Some(close) = self.close_controls.take() {
            let _ = close();
        }
        if let Some(restore) = self.restore_overlay.take() {
            let _ = restore();
        }
    }
}

pub struct LongCaptureRuntime {
    active: AtomicBool,
    next_session_id: AtomicU64,
    active_session_id: AtomicU64,
    stop_requested: AtomicBool,
    cancel_requested: AtomicBool,
    progress: Mutex<LongCaptureProgress>,
    diagnostics: Mutex<VecDeque<LongCaptureDiagnostic>>,
    action: AtomicU8,
    session_transition: Mutex<()>,
    terminal_epoch: Mutex<u64>,
    terminal_changed: Condvar,
}

impl Default for LongCaptureRuntime {
    fn default() -> Self {
        Self {
            active: AtomicBool::new(false),
            next_session_id: AtomicU64::new(0),
            active_session_id: AtomicU64::new(0),
            stop_requested: AtomicBool::new(false),
            cancel_requested: AtomicBool::new(false),
            progress: Mutex::new(LongCaptureProgress::default()),
            diagnostics: Mutex::new(VecDeque::new()),
            action: AtomicU8::new(LongCaptureAction::None.code()),
            session_transition: Mutex::new(()),
            terminal_epoch: Mutex::new(0),
            terminal_changed: Condvar::new(),
        }
    }
}

impl LongCaptureRuntime {
    fn begin(&self) -> Result<u64, String> {
        let _transition = self
            .session_transition
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "a long capture is already running".to_string())?;
        let session_id = self.next_session_id.fetch_add(1, Ordering::AcqRel) + 1;
        self.active_session_id.store(session_id, Ordering::Release);
        self.stop_requested.store(false, Ordering::Release);
        self.cancel_requested.store(false, Ordering::Release);
        self.action
            .store(LongCaptureAction::None.code(), Ordering::Release);
        self.update(session_id, 0, 0, 0, "preparing", Vec::new(), false, 0);
        Ok(session_id)
    }

    fn finish(&self, session_id: u64) {
        let _transition = self
            .session_transition
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.active_session_id.load(Ordering::Acquire) == session_id {
            self.active.store(false, Ordering::Release);
        }
    }

    fn active_session_id(&self) -> u64 {
        self.active_session_id.load(Ordering::Acquire)
    }

    fn update(
        &self,
        session_id: u64,
        revision: u64,
        frame_count: u32,
        stitched_height: u32,
        state: &'static str,
        preview_png_bytes: Vec<u8>,
        warning: bool,
        width: u32,
    ) {
        if let Ok(mut progress) = self.progress.lock() {
            *progress = LongCaptureProgress {
                session_id,
                revision,
                frame_count,
                stitched_height,
                state,
                navigator_png_bytes: preview_png_bytes.clone(),
                accepted_bounds: (width > 0).then_some(AcceptedBounds {
                    x: 0,
                    y: 0,
                    width,
                    height: stitched_height,
                }),
                preview_png_bytes,
                warning,
                slow_scroll_warning: warning,
            };
        }
    }

    fn record_diagnostic(&self, event: LongCaptureDiagnostic) {
        if let Ok(mut events) = self.diagnostics.lock() {
            if events.len() == 64 {
                events.pop_front();
            }
            events.push_back(event);
        }
    }

    pub fn request_terminal(
        &self,
        session_id: u64,
        requested: LongCaptureAction,
    ) -> TerminalRequestOutcome {
        let _transition = self
            .session_transition
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !self.is_active() || self.active_session_id() != session_id {
            return TerminalRequestOutcome {
                session_id,
                action: requested,
                status: TerminalRequestStatus::Stale,
            };
        }
        let accepted = self
            .action
            .compare_exchange(
                LongCaptureAction::None.code(),
                requested.code(),
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok();
        let action = if accepted {
            requested
        } else {
            self.requested_action()
        };
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
        let Ok((epoch, _)) = self
            .terminal_changed
            .wait_timeout_while(epoch, duration, |current| {
                *current == initial && self.requested_action() == LongCaptureAction::None
            })
        else {
            return false;
        };
        *epoch != initial || self.requested_action() != LongCaptureAction::None
    }

    pub fn request_cancel(&self) {
        self.request_current(LongCaptureAction::Cancel);
    }

    pub fn is_cancel_requested(&self) -> bool {
        self.cancel_requested.load(Ordering::Acquire)
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub fn request_edit(&self) {
        self.request_current(LongCaptureAction::Edit);
    }
    pub fn request_save(&self) {
        self.request_current(LongCaptureAction::Save);
    }
    pub fn request_finish(&self) {
        self.request_current(LongCaptureAction::Finish);
    }
    fn requested_action(&self) -> LongCaptureAction {
        LongCaptureAction::from_code(self.action.load(Ordering::Acquire))
    }
}

fn crop_region(frames: Vec<RawMonitorFrame>, region: CaptureRegion) -> Result<RgbaFrame, String> {
    let x = region.x.round() as i32;
    let y = region.y.round() as i32;
    let width = region.width.round() as u32;
    let height = region.height.round() as u32;
    if width == 0 || height == 0 {
        return Err("long capture region is empty".to_string());
    }
    let right = i64::from(x) + i64::from(width);
    let bottom = i64::from(y) + i64::from(height);
    let monitor = frames
        .into_iter()
        .find(|frame| {
            i64::from(x) >= i64::from(frame.x)
                && i64::from(y) >= i64::from(frame.y)
                && right <= i64::from(frame.x) + i64::from(frame.width)
                && bottom <= i64::from(frame.y) + i64::from(frame.height)
        })
        .ok_or_else(|| "long capture selection must fit within one monitor".to_string())?;
    let offset_x = u32::try_from(x - monitor.x).map_err(|_| "invalid capture x coordinate")?;
    let offset_y = u32::try_from(y - monitor.y).map_err(|_| "invalid capture y coordinate")?;
    let source_stride = monitor.width as usize * 4;
    let row_bytes = width as usize * 4;
    let mut pixels = Vec::with_capacity(row_bytes * height as usize);
    for row in 0..height {
        let start = (offset_y + row) as usize * source_stride + offset_x as usize * 4;
        pixels.extend_from_slice(&monitor.rgba[start..start + row_bytes]);
    }
    Ok(RgbaFrame {
        width,
        height,
        pixels,
    })
}

fn encode_png(frame: &RgbaFrame) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, frame.width, frame.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer
            .write_image_data(&frame.pixels)
            .map_err(|error| error.to_string())?;
    }
    Ok(bytes)
}

fn session_state_name(state: LongCaptureState) -> &'static str {
    match state {
        LongCaptureState::Preparing => "preparing",
        LongCaptureState::Observing => "observing",
        LongCaptureState::Scrolling => "scrolling",
        LongCaptureState::Matching => "matching",
        LongCaptureState::PausedReverse => "pausedReverse",
        LongCaptureState::Warning => "warning",
        LongCaptureState::Completed => "completed",
        LongCaptureState::Partial => "partial",
        LongCaptureState::Cancelled => "cancelled",
        LongCaptureState::Failed => "failed",
        LongCaptureState::Idle | LongCaptureState::Stabilizing => "observing",
    }
}

fn publish_progress(
    runtime: &LongCaptureRuntime,
    session_id: u64,
    revision: u64,
    session: &LongCaptureSession,
    preview: &[u8],
    width: u32,
) {
    let warning = matches!(
        session.state(),
        LongCaptureState::PausedReverse | LongCaptureState::Warning
    );
    runtime.update(
        session_id,
        revision,
        session.frame_count(),
        session.stitched_height(),
        session_state_name(session.state()),
        preview.to_vec(),
        warning,
        width,
    );
}

fn append_matched_candidate(
    stitcher: &mut ChunkedStitcher,
    accepted_tail: &RgbaFrame,
    candidate: RgbaFrame,
    overlap_rows: u32,
) -> Result<u32, String> {
    let previous_gray = downscale_grayscale(accepted_tail, 4)
        .map_err(|error| format!("overlap preparation failed: {error:?}"))?;
    let next_gray = downscale_grayscale(&candidate, 4)
        .map_err(|error| format!("overlap preparation failed: {error:?}"))?;
    let static_regions =
        detect_static_regions(&[previous_gray, next_gray], 2, 0.9, 2).unwrap_or_default();
    let top_static_rows = static_regions.top_rows.saturating_mul(4);
    let bottom_static_rows = static_regions.bottom_rows.saturating_mul(4);
    let before_preview_height = stitcher
        .preview()
        .map_err(|error| format!("preview preparation failed: {error:?}"))?
        .height;
    let uses_static_regions = static_regions.confidence >= 0.9
        && top_static_rows.saturating_add(bottom_static_rows) < candidate.height;
    let projected_preview_height = if uses_static_regions {
        let content_start = overlap_rows.max(top_static_rows);
        let content_end = candidate.height - bottom_static_rows;
        let content_rows = content_end.saturating_sub(content_start);
        if content_rows == 0 {
            return Ok(0);
        }
        let existing_footer_rows = before_preview_height.saturating_sub(stitcher.height());
        let next_footer_rows = if bottom_static_rows > 0 {
            bottom_static_rows
        } else {
            existing_footer_rows
        };
        stitcher
            .height()
            .saturating_add(content_rows)
            .saturating_add(next_footer_rows)
    } else {
        before_preview_height.saturating_add(candidate.height.saturating_sub(overlap_rows))
    };
    if projected_preview_height <= before_preview_height {
        return Ok(0);
    }
    stitcher
        .append_with_static_regions(
            candidate,
            overlap_rows,
            top_static_rows,
            bottom_static_rows,
            static_regions.confidence,
            false,
        )
        .map_err(|error| format!("stitch failed: {error:?}"))?;
    let after_preview_height = stitcher
        .preview()
        .map_err(|error| format!("preview failed: {error:?}"))?
        .height;
    Ok(after_preview_height.saturating_sub(before_preview_height))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MatchMotionOutcome {
    appended: bool,
    direction: &'static str,
    overlap_rows: Option<u32>,
    added_height: Option<u32>,
}

fn match_motion_candidate(
    session: &mut LongCaptureSession,
    stitcher: &mut ChunkedStitcher,
    accepted_tail: &RgbaFrame,
    candidate: &RgbaFrame,
) -> Result<MatchMotionOutcome, String> {
    if session.state() != LongCaptureState::Scrolling {
        session
            .motion_started()
            .map_err(|_| "invalid motion transition")?;
    }
    session
        .stable_frame_ready()
        .map_err(|_| "invalid candidate-frame transition")?;
    if accepted_tail.width == candidate.width
        && accepted_tail.height == candidate.height
        && accepted_tail.pixels == candidate.pixels
    {
        session
            .unchanged()
            .map_err(|_| "invalid unchanged transition")?;
        return Ok(MatchMotionOutcome {
            appended: false,
            direction: "unchanged",
            overlap_rows: None,
            added_height: Some(0),
        });
    }
    match match_vertical_scroll(accepted_tail, candidate)
        .map_err(|error| format!("candidate-frame match failed: {error:?}"))?
    {
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
    }
}

#[cfg(test)]
fn append_stable_candidate(
    stitcher: &mut ChunkedStitcher,
    accepted_tail: &RgbaFrame,
    candidate: RgbaFrame,
) -> Result<Option<u32>, String> {
    match match_vertical_scroll(accepted_tail, &candidate)
        .map_err(|error| format!("stable-frame match failed: {error:?}"))?
    {
        MatchDirection::Forward { overlap_rows } => append_matched_candidate(
            stitcher,
            accepted_tail,
            candidate,
            overlap_rows.min(accepted_tail.height.saturating_sub(1)),
        )
        .map(Some),
        MatchDirection::Reverse | MatchDirection::Unmatched => Ok(None),
    }
}

fn prepare_capture_windows<M, P>(
    open_and_exclude_masks: impl FnOnce() -> Result<M, String>,
    open_and_exclude_preview: impl FnOnce() -> Result<P, String>,
    hide_overlay: impl FnOnce() -> Result<(), String>,
) -> Result<(M, P), String> {
    let masks = open_and_exclude_masks()?;
    let preview = open_and_exclude_preview()?;
    hide_overlay()?;
    Ok((masks, preview))
}

fn cleanup_capture_windows(
    reusable_labels: &[&str],
    ephemeral_labels: &[&str],
    mut hide: impl FnMut(&str) -> Result<(), String>,
    mut close: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for label in reusable_labels.iter().chain(ephemeral_labels) {
        if let Err(error) = hide(label) {
            errors.push(error);
        }
    }
    for label in ephemeral_labels {
        if let Err(error) = close(label) {
            errors.push(error);
        }
    }
    finish_cleanup_errors(errors)
}

#[cfg(test)]
fn run_cleanup_callbacks(
    cancelled: bool,
    close_temporary: impl FnOnce(),
    restore_affinity: impl FnOnce(),
    reset_session: impl FnOnce(),
    restore_editor: impl FnOnce(),
) {
    close_temporary();
    restore_affinity();
    if cancelled {
        reset_session();
    } else {
        restore_editor();
    }
}

fn capture_monitor_rect(
    app: &tauri::AppHandle,
    region: CaptureRegion,
) -> Result<ScreenRect, String> {
    let center_x = (region.x + region.width / 2.0).round() as i32;
    let center_y = (region.y + region.height / 2.0).round() as i32;
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("failed to read monitor layout: {error}"))?;
    let monitor = monitors
        .into_iter()
        .find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            center_x >= position.x
                && center_y >= position.y
                && center_x < position.x + size.width as i32
                && center_y < position.y + size.height as i32
        })
        .ok_or_else(|| "cannot place long-capture controls outside the selection".to_string())?;
    let position = monitor.position();
    let size = monitor.size();
    Ok(ScreenRect {
        x: position.x,
        y: position.y,
        width: size.width as i32,
        height: size.height as i32,
    })
}

fn open_controls_window(
    app: &tauri::AppHandle,
    region: CaptureRegion,
    monitor: ScreenRect,
) -> Result<tauri::WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window("scroll-capture-preview") {
        let _ = existing.hide();
        let _ = existing.close();
    }
    open_preview_window(
        app,
        ScreenRect {
            x: region.x.round() as i32,
            y: region.y.round() as i32,
            width: region.width.round() as i32,
            height: region.height.round() as i32,
        },
        monitor,
    )
}

enum ObservedCycleDecision<'a> {
    None,
    MotionStarted,
    StableCandidate(&'a RgbaFrame),
}

fn observe_capture_cycle<'a>(
    gate: &mut StableFrameGate,
    observation: Observation,
    observed_frame: &'a RgbaFrame,
) -> ObservedCycleDecision<'a> {
    match gate.observe(observation) {
        CycleDecision::None => ObservedCycleDecision::None,
        CycleDecision::MotionStarted => ObservedCycleDecision::MotionStarted,
        CycleDecision::StableCandidate => ObservedCycleDecision::StableCandidate(observed_frame),
    }
}

fn run_capture(
    runtime: &LongCaptureRuntime,
    session_id: u64,
    region: CaptureRegion,
) -> Result<LongCaptureResult, String> {
    let target_x = (region.x + region.width / 2.0).round() as i32;
    let target_y = (region.y + region.height / 2.0).round() as i32;
    let target = platform::locate_capture_target(target_x, target_y)?;
    platform::focus_capture_target(target)?;
    let started = Instant::now();
    let mut session = LongCaptureSession::default();
    let mut observer = RegionObserver::new(0.01);
    let mut stitcher = ChunkedStitcher::default();
    session
        .start()
        .map_err(|_| "failed to start long capture session")?;

    let first = crop_region(platform::capture_monitors()?, region)?;
    let first_gray = downscale_grayscale(&first, 8)
        .map_err(|error| format!("observation preparation failed: {error:?}"))?;
    observer.observe(&first_gray.pixels, Duration::ZERO);
    stitcher
        .append(first.clone(), 0)
        .map_err(|error| format!("stitch failed: {error:?}"))?;
    session
        .accept_first_frame(first.height, started.elapsed())
        .map_err(|_| "failed to accept first long-capture frame")?;
    let mut accepted_tail = first;
    let mut preview_png = encode_png(&accepted_tail)?;
    let mut gate = StableFrameGate::default();
    let mut revision = 0_u64;
    publish_progress(
        runtime,
        session_id,
        revision,
        &session,
        &preview_png,
        accepted_tail.width,
    );

    loop {
        if runtime.cancel_requested.load(Ordering::Acquire) {
            session.request_stop();
            break;
        }
        if runtime.stop_requested.load(Ordering::Acquire) {
            session.request_stop();
            break;
        }
        if let Err(SessionError::ResourceLimit) = session.check_limits(started.elapsed()) {
            break;
        }
        if platform::validate_capture_target(target).is_err() {
            session.fail();
            break;
        }

        let candidate = crop_region(platform::capture_monitors()?, region)?;
        let candidate_gray = downscale_grayscale(&candidate, 8)
            .map_err(|error| format!("observation preparation failed: {error:?}"))?;
        let observed_at = started.elapsed();
        let observation = observer.observe(&candidate_gray.pixels, observed_at);
        match observe_capture_cycle(&mut gate, observation, &candidate) {
            ObservedCycleDecision::MotionStarted => {
                session
                    .motion_started()
                    .map_err(|_| "invalid motion transition")?;
            }
            ObservedCycleDecision::StableCandidate(settled) => {
                let outcome =
                    match_motion_candidate(&mut session, &mut stitcher, &accepted_tail, settled)?;
                if outcome.appended {
                    accepted_tail = candidate;
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
            ObservedCycleDecision::None => {}
        }
        publish_progress(
            runtime,
            session_id,
            revision,
            &session,
            &preview_png,
            accepted_tail.width,
        );
        if runtime.wait_for_sample_or_terminal(SAMPLE_INTERVAL) {
            continue;
        }
    }

    let outcome = termination(
        runtime.cancel_requested.load(Ordering::Acquire),
        runtime.stop_requested.load(Ordering::Acquire)
            || matches!(session.state(), LongCaptureState::Partial),
        session.frame_count(),
    );
    if outcome == CaptureTermination::Cancelled {
        return Err("long capture cancelled".to_string());
    }
    let output = stitcher
        .finish()
        .map_err(|error| format!("finish failed: {error:?}"))?;
    let action = match runtime.requested_action() {
        LongCaptureAction::Save => LongCaptureAction::Save,
        LongCaptureAction::Finish => LongCaptureAction::Finish,
        _ => LongCaptureAction::Edit,
    };
    finalize_capture_result(
        encode_png(&output)?,
        outcome == CaptureTermination::Partial,
        action,
        |png| crate::output::copy_png(png.to_vec()),
    )
}

#[tauri::command]
pub async fn start_long_capture(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, LongCaptureRuntime>,
    region: CaptureRegion,
) -> Result<LongCaptureResult, String> {
    let session_id = runtime.begin()?;
    let result = (|| {
        let window = app
            .get_webview_window("overlay")
            .ok_or_else(|| "overlay window is unavailable".to_string())?;
        let restore_window = window.clone();
        let restore_app = app.clone();
        let close_app = app.clone();
        let unregister_app = app.clone();
        let escape_registered = app.global_shortcut().register("Escape").is_ok();
        let enter_registered = app.global_shortcut().register("Enter").is_ok();
        let cleanup = CaptureCleanup::new(
            move || {
                let mut errors = Vec::new();
                match overlay_cleanup(
                    restore_app
                        .state::<LongCaptureRuntime>()
                        .is_cancel_requested(),
                ) {
                    OverlayCleanup::Restore => {
                        if let Err(error) = platform::restore_window_capture(&restore_window) {
                            errors.push(error);
                        }
                        if let Err(error) = restore_app.emit("long-capture-presentation", false) {
                            errors.push(format!(
                                "failed to restore long capture presentation: {error}"
                            ));
                        }
                        if let Err(error) = restore_window.set_ignore_cursor_events(false) {
                            errors.push(format!("failed to restore overlay input: {error}"));
                        }
                        if let Err(error) = restore_window.show() {
                            errors.push(format!("failed to show overlay: {error}"));
                        }
                        if let Err(error) = restore_window.set_focus() {
                            errors.push(format!("failed to focus overlay: {error}"));
                        }
                    }
                    OverlayCleanup::Hide => {
                        if let Err(error) = platform::restore_window_capture(&restore_window) {
                            errors.push(error);
                        }
                        if let Err(error) = restore_window.set_ignore_cursor_events(false) {
                            errors.push(format!("failed to restore overlay input: {error}"));
                        }
                        crate::app_state::emit_capture_session_reset(&restore_app, &restore_window);
                        if let Err(error) = restore_app.emit("long-capture-presentation", false) {
                            errors.push(format!(
                                "failed to clear long capture presentation: {error}"
                            ));
                        }
                        if let Err(error) = restore_window.hide() {
                            errors.push(format!("failed to hide overlay: {error}"));
                        }
                    }
                }
                finish_cleanup_errors(errors)
            },
            move || {
                let mut errors = Vec::new();
                if let Err(error) = deactivate_capture_mask_windows(&close_app) {
                    errors.push(format!("failed to deactivate long capture masks: {error}"));
                }
                if let Err(error) = cleanup_capture_windows(
                    &[],
                    &["scroll-capture-preview"],
                    |label| {
                        let Some(window) = close_app.get_webview_window(label) else {
                            return Ok(());
                        };
                        window
                            .hide()
                            .map_err(|error| format!("failed to hide {label}: {error}"))
                    },
                    |label| {
                        let Some(window) = close_app.get_webview_window(label) else {
                            return Ok(());
                        };
                        window
                            .close()
                            .map_err(|error| format!("failed to close {label}: {error}"))
                    },
                ) {
                    errors.push(error);
                }
                if escape_registered {
                    if let Err(error) = unregister_app.global_shortcut().unregister("Escape") {
                        errors.push(format!("failed to unregister Escape: {error}"));
                    }
                }
                if enter_registered {
                    if let Err(error) = unregister_app.global_shortcut().unregister("Enter") {
                        errors.push(format!("failed to unregister Enter: {error}"));
                    }
                }
                let result = finish_cleanup_errors(errors);
                if let Err(error) = &result {
                    let _ = close_app.emit("capture-error", error);
                }
                result
            },
        );
        let capture_result: Result<LongCaptureResult, String> = (|| {
            let origin = window
                .outer_position()
                .map_err(|error| format!("failed to read overlay position: {error}"))?;
            let scale_factor = window
                .scale_factor()
                .map_err(|error| format!("failed to read overlay scale factor: {error}"))?;
            let region = region.to_physical(origin.x, origin.y, scale_factor);
            let selection = ScreenRect {
                x: region.x.round() as i32,
                y: region.y.round() as i32,
                width: region.width.round() as i32,
                height: region.height.round() as i32,
            };
            let monitor = capture_monitor_rect(&app, region)?;
            let capture_windows = prepare_capture_windows(
                || {
                    let masks = open_capture_mask_windows(&app, selection, monitor)?;
                    for mask in &masks {
                        if let Err(error) = platform::exclude_window_from_capture(mask) {
                            for mask in &masks {
                                let _ = mask.hide();
                            }
                            return Err(error);
                        }
                    }
                    for mask in &masks {
                        mask.show()
                            .map_err(|error| format!("failed to show capture mask: {error}"))?;
                    }
                    Ok(masks)
                },
                || {
                    let preview = open_controls_window(&app, region, monitor)?;
                    platform::exclude_window_from_capture(&preview)?;
                    Ok(preview)
                },
                || {
                    window.hide().map_err(|error| {
                        format!("failed to hide overlay for long capture: {error}")
                    })
                },
            )?;
            std::thread::sleep(Duration::from_millis(150));
            let capture_result = run_capture(&runtime, session_id, region);
            drop(capture_windows);
            capture_result
        })();
        let mut cleanup_result = cleanup.complete();
        if matches!(&capture_result, Err(error) if error == "long capture cancelled") {
            if let Err(cleanup_error) = &cleanup_result {
                let diagnostic = format!("long capture cancelled; cleanup: {cleanup_error}");
                if let Err(restore_error) =
                    restore_overlay_for_cleanup_diagnostic(&app, &window, &diagnostic)
                {
                    cleanup_result = Err(format!(
                        "{cleanup_error}; diagnostic overlay: {restore_error}"
                    ));
                }
            }
        }
        resolve_capture_cleanup(capture_result, cleanup_result)
    })();
    runtime.finish(session_id);
    result
}

#[tauri::command]
pub fn stop_long_capture(runtime: tauri::State<'_, LongCaptureRuntime>) {
    runtime.request_finish();
}

#[tauri::command]
pub fn edit_long_capture(runtime: tauri::State<'_, LongCaptureRuntime>) {
    runtime.request_edit();
}

#[tauri::command]
pub fn save_long_capture(runtime: tauri::State<'_, LongCaptureRuntime>) {
    runtime.request_save();
}

#[tauri::command]
pub fn finish_long_capture(runtime: tauri::State<'_, LongCaptureRuntime>) {
    runtime.request_finish();
}

#[tauri::command]
pub fn cancel_long_capture(runtime: tauri::State<'_, LongCaptureRuntime>) {
    runtime.request_cancel();
}

#[tauri::command]
pub fn long_capture_progress(runtime: tauri::State<'_, LongCaptureRuntime>) -> LongCaptureProgress {
    runtime
        .progress
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        append_matched_candidate, append_stable_candidate, cleanup_capture_windows, crop_region,
        finalize_capture_result, match_motion_candidate, overlay_cleanup, prepare_capture_windows,
        recover_from_cleanup_failure, resolve_capture_cleanup, run_cleanup_callbacks, termination,
        CaptureCleanup, CaptureRegion, CaptureTermination, LongCaptureAction, OverlayCleanup,
    };
    use crate::platform::RawMonitorFrame;
    use crate::region_observer::Observation;
    use crate::scroll_controller::{LongCaptureSession, LongCaptureState};
    use crate::stitcher::{ChunkedStitcher, RgbaFrame};
    use std::{cell::Cell, cell::RefCell, rc::Rc};

    struct DropProbe(Rc<Cell<u32>>);

    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.set(self.0.get() + 1);
        }
    }

    fn document_frame(start_row: u32, height: u32, width: u32) -> RgbaFrame {
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
        for y in start_row..start_row + height {
            for x in 0..width {
                let mut value = u64::from(y)
                    .wrapping_mul(0x9e37_79b9_7f4a_7c15)
                    .wrapping_add(u64::from(x).wrapping_mul(0xbf58_476d_1ce4_e5b9));
                value ^= value >> 30;
                value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
                value ^= value >> 27;
                let value = (value ^ (value >> 31)) as u8;
                pixels.extend_from_slice(&[
                    value,
                    value.wrapping_add((x % 97) as u8),
                    value.wrapping_add((y % 89) as u8),
                    255,
                ]);
            }
        }
        RgbaFrame {
            width,
            height,
            pixels,
        }
    }

    fn document_frame_with_static_footer(
        start_row: u32,
        height: u32,
        width: u32,
        footer_rows: u32,
    ) -> RgbaFrame {
        let mut frame = document_frame(start_row, height, width);
        for y in height - footer_rows..height {
            for x in 0..width {
                let offset = ((y * width + x) * 4) as usize;
                let value = (x as u8).wrapping_mul(37).wrapping_add(19);
                frame.pixels[offset..offset + 4].copy_from_slice(&[
                    value,
                    value.wrapping_add(41),
                    value.wrapping_add(83),
                    255,
                ]);
            }
        }
        frame
    }

    #[test]
    fn accepted_candidate_grows_preview_and_final_output() {
        let first = document_frame(0, 700, 80);
        let next = document_frame(260, 700, 80);
        let mut stitcher = ChunkedStitcher::default();
        stitcher.append(first.clone(), 0).unwrap();

        let added = append_stable_candidate(&mut stitcher, &first, next).unwrap();

        assert_eq!(added, Some(260));
        assert_eq!(stitcher.preview().unwrap().height, 960);
        assert_eq!(stitcher.finish().unwrap().height, 960);
    }

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
    fn stable_candidate_keeps_the_observed_frame_identity() {
        use crate::long_capture_cycle::StableFrameGate;

        let moving = document_frame(100, 700, 80);
        let observed_stable = document_frame(260, 700, 80);
        let mut gate = StableFrameGate::default();
        assert!(matches!(
            super::observe_capture_cycle(&mut gate, Observation::MotionStarted, &moving),
            super::ObservedCycleDecision::MotionStarted
        ));

        let decision =
            super::observe_capture_cycle(&mut gate, Observation::StableFrame, &observed_stable);
        let super::ObservedCycleDecision::StableCandidate(candidate) = decision else {
            panic!("expected the observed stable frame");
        };

        assert!(std::ptr::eq(candidate, &observed_stable));
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

    #[test]
    fn synthetic_frames_increase_height_only_after_stable_frame() {
        use crate::long_capture_cycle::{CycleDecision, StableFrameGate};

        let first = document_frame(0, 700, 80);
        let candidate = document_frame(260, 700, 80);
        let mut session = LongCaptureSession::default();
        session.start().unwrap();
        session
            .accept_first_frame(first.height, std::time::Duration::ZERO)
            .unwrap();
        let mut stitcher = ChunkedStitcher::default();
        stitcher.append(first.clone(), 0).unwrap();
        let mut gate = StableFrameGate::default();

        assert_eq!(
            gate.observe(Observation::MotionStarted),
            CycleDecision::MotionStarted
        );
        session.motion_started().unwrap();
        for observation in [Observation::MotionFrame, Observation::Stabilizing] {
            assert_eq!(gate.observe(observation), CycleDecision::None);
            assert_eq!(session.frame_count(), 1);
            assert_eq!(session.stitched_height(), 700);
        }
        assert_eq!(
            gate.observe(Observation::StableFrame),
            CycleDecision::StableCandidate
        );
        let outcome =
            match_motion_candidate(&mut session, &mut stitcher, &first, &candidate).unwrap();

        assert!(outcome.appended);
        assert_eq!(session.frame_count(), 2);
        assert_eq!(session.stitched_height(), 960);
        assert_eq!(stitcher.finish().unwrap().height, 960);
    }

    #[test]
    fn duplicate_stable_frame_is_unchanged_without_progress() {
        let frame = document_frame(0, 700, 80);
        let mut session = LongCaptureSession::default();
        session.start().unwrap();
        session
            .accept_first_frame(frame.height, std::time::Duration::ZERO)
            .unwrap();
        session.motion_started().unwrap();
        let mut stitcher = ChunkedStitcher::default();
        stitcher.append(frame.clone(), 0).unwrap();

        let outcome = match_motion_candidate(&mut session, &mut stitcher, &frame, &frame).unwrap();

        assert!(!outcome.appended);
        assert_eq!(outcome.direction, "unchanged");
        assert_eq!(session.frame_count(), 1);
        assert_eq!(session.stitched_height(), 700);
    }

    #[test]
    fn low_texture_duplicate_is_unchanged_without_warning() {
        let frame = RgbaFrame {
            width: 80,
            height: 700,
            pixels: [64, 64, 64, 255].repeat(80 * 700),
        };
        let mut session = LongCaptureSession::default();
        session.start().unwrap();
        session
            .accept_first_frame(frame.height, std::time::Duration::ZERO)
            .unwrap();
        session.motion_started().unwrap();
        let mut stitcher = ChunkedStitcher::default();
        stitcher.append(frame.clone(), 0).unwrap();

        let outcome = match_motion_candidate(&mut session, &mut stitcher, &frame, &frame).unwrap();

        assert!(!outcome.appended);
        assert_eq!(outcome.direction, "unchanged");
        assert_eq!(session.state(), LongCaptureState::Observing);
        assert_eq!(session.frame_count(), 1);
        assert_eq!(session.stitched_height(), 700);
    }

    #[test]
    fn zero_content_candidate_with_static_footer_does_not_mutate_stitcher() {
        let first = document_frame_with_static_footer(0, 700, 80, 40);
        let candidate = document_frame_with_static_footer(260, 700, 80, 40);
        let mut stitcher = ChunkedStitcher::default();
        stitcher.append(first.clone(), 0).unwrap();
        let before = stitcher.preview().unwrap();

        let added = append_matched_candidate(&mut stitcher, &first, candidate, 660).unwrap();

        assert_eq!(added, 0);
        assert_eq!(stitcher.preview().unwrap(), before);
        assert_eq!(stitcher.finish().unwrap(), before);
    }

    #[test]
    fn static_footer_append_keeps_session_preview_and_final_heights_equal() {
        let first = document_frame_with_static_footer(0, 700, 80, 40);
        let candidate = document_frame_with_static_footer(260, 700, 80, 40);
        let mut session = LongCaptureSession::default();
        session.start().unwrap();
        session
            .accept_first_frame(first.height, std::time::Duration::ZERO)
            .unwrap();
        session.motion_started().unwrap();
        let mut stitcher = ChunkedStitcher::default();
        stitcher.append(first.clone(), 0).unwrap();

        let outcome =
            match_motion_candidate(&mut session, &mut stitcher, &first, &candidate).unwrap();
        let preview = stitcher.preview().unwrap();
        let session_height = session.stitched_height();
        let final_frame = stitcher.finish().unwrap();

        assert!(outcome.appended);
        assert_eq!(session_height, preview.height);
        assert_eq!(session_height, final_frame.height);
        assert_eq!(preview, final_frame);
    }

    #[test]
    fn edit_save_cancel_and_finish_are_distinct_runtime_actions() {
        for (request, expected) in [
            (
                super::LongCaptureRuntime::request_edit as fn(&super::LongCaptureRuntime),
                super::LongCaptureAction::Edit,
            ),
            (
                super::LongCaptureRuntime::request_save as fn(&super::LongCaptureRuntime),
                super::LongCaptureAction::Save,
            ),
            (
                super::LongCaptureRuntime::request_cancel as fn(&super::LongCaptureRuntime),
                super::LongCaptureAction::Cancel,
            ),
            (
                super::LongCaptureRuntime::request_finish as fn(&super::LongCaptureRuntime),
                super::LongCaptureAction::Finish,
            ),
        ] {
            let runtime = super::LongCaptureRuntime::default();
            runtime.begin().unwrap();
            request(&runtime);
            assert_eq!(runtime.requested_action(), expected);
        }
    }

    #[test]
    fn first_terminal_action_wins_when_finish_precedes_cancel() {
        let runtime = super::LongCaptureRuntime::default();
        runtime.begin().unwrap();

        runtime.request_finish();
        runtime.request_cancel();

        assert_eq!(runtime.requested_action(), LongCaptureAction::Finish);
        assert!(!runtime.is_cancel_requested());
        assert!(runtime
            .stop_requested
            .load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn first_terminal_action_wins_when_cancel_precedes_finish() {
        let runtime = super::LongCaptureRuntime::default();
        runtime.begin().unwrap();

        runtime.request_cancel();
        runtime.request_finish();

        assert_eq!(runtime.requested_action(), LongCaptureAction::Cancel);
        assert!(runtime.is_cancel_requested());
    }

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
        let thread =
            std::thread::spawn(move || waiter.wait_for_sample_or_terminal(Duration::from_secs(2)));

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

    #[test]
    fn old_session_terminal_request_cannot_mutate_a_new_session() {
        use std::sync::{mpsc, Arc};

        let runtime = Arc::new(super::LongCaptureRuntime::default());
        let first = runtime.begin().unwrap();
        let requester = Arc::clone(&runtime);
        let (release, wait) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            wait.recv().unwrap();
            requester.request_terminal(first, LongCaptureAction::Cancel)
        });

        runtime.finish(first);
        let second = runtime.begin().unwrap();
        release.send(()).unwrap();

        let stale = thread.join().unwrap();
        assert_eq!(stale.status, super::TerminalRequestStatus::Stale);
        assert_eq!(runtime.requested_action(), LongCaptureAction::None);

        let accepted = runtime.request_terminal(second, LongCaptureAction::Finish);
        assert_eq!(accepted.status, super::TerminalRequestStatus::Accepted);
        assert_eq!(runtime.requested_action(), LongCaptureAction::Finish);
    }

    #[test]
    fn finish_copies_the_final_png_before_returning_success() {
        let copied = Rc::new(RefCell::new(Vec::new()));
        let copied_bytes = Rc::clone(&copied);
        let result = finalize_capture_result(
            vec![137, 80, 78, 71],
            false,
            LongCaptureAction::Finish,
            move |png| {
                *copied_bytes.borrow_mut() = png.to_vec();
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(*copied.borrow(), vec![137, 80, 78, 71]);
        assert_eq!(result.action, LongCaptureAction::Finish);
    }

    #[test]
    fn finish_copy_failure_preserves_the_long_image_for_retry() {
        let result = finalize_capture_result(
            vec![137, 80, 78, 71],
            false,
            LongCaptureAction::Finish,
            |_| Err("clipboard busy".to_string()),
        )
        .unwrap();

        assert_eq!(result.png_bytes, vec![137, 80, 78, 71]);
        assert_eq!(result.action, LongCaptureAction::Edit);
        assert_eq!(result.clipboard_error.as_deref(), Some("clipboard busy"));
    }

    #[test]
    fn edit_does_not_write_the_clipboard() {
        let copy_calls = Rc::new(Cell::new(0));
        let calls = Rc::clone(&copy_calls);
        finalize_capture_result(
            vec![137, 80, 78, 71],
            false,
            LongCaptureAction::Edit,
            move |_| {
                calls.set(calls.get() + 1);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(copy_calls.get(), 0);
    }

    #[test]
    fn preparation_finishes_temporary_windows_before_hiding_overlay() {
        let events = Rc::new(std::cell::RefCell::new(Vec::new()));
        let mask_events = events.clone();
        let preview_events = events.clone();
        let overlay_events = events.clone();

        prepare_capture_windows(
            || {
                mask_events.borrow_mut().push("masks");
                Ok(())
            },
            || {
                preview_events.borrow_mut().push("preview");
                Ok(())
            },
            || {
                overlay_events.borrow_mut().push("hide-overlay");
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(*events.borrow(), vec!["masks", "preview", "hide-overlay"]);
    }

    #[test]
    fn preparation_returns_temporary_windows_to_keep_them_alive() {
        let drops = Rc::new(Cell::new(0));
        let mask_drop = drops.clone();
        let preview_drop = drops.clone();

        let retained = prepare_capture_windows(
            || Ok(DropProbe(mask_drop)),
            || Ok(DropProbe(preview_drop)),
            || Ok(()),
        )
        .unwrap();

        assert_eq!(drops.get(), 0);
        drop(retained);
        assert_eq!(drops.get(), 2);
    }

    #[test]
    fn preparation_does_not_open_preview_when_mask_creation_fails() {
        let events = Rc::new(std::cell::RefCell::new(Vec::new()));
        let mask_events = events.clone();
        let preview_events = events.clone();
        let overlay_events = events.clone();

        let result = prepare_capture_windows(
            || {
                mask_events.borrow_mut().push("masks");
                Err::<(), String>("mask creation failed".to_string())
            },
            || {
                preview_events.borrow_mut().push("preview");
                Ok(())
            },
            || {
                overlay_events.borrow_mut().push("hide-overlay");
                Ok(())
            },
        );

        assert_eq!(result.unwrap_err(), "mask creation failed");
        assert_eq!(*events.borrow(), vec!["masks"]);
    }

    #[test]
    fn cancel_discards_output_while_stop_keeps_it() {
        assert_eq!(termination(true, false, 3), CaptureTermination::Cancelled);
        assert_eq!(termination(false, true, 3), CaptureTermination::Partial);
        assert_eq!(termination(false, false, 3), CaptureTermination::Completed);
    }

    #[test]
    fn cleanup_closes_controls_before_touching_the_overlay() {
        let events = Rc::new(RefCell::new(Vec::new()));
        {
            let restore_events = Rc::clone(&events);
            let close_events = Rc::clone(&events);
            let _cleanup = CaptureCleanup::new(
                move || {
                    restore_events.borrow_mut().push("overlay");
                    Ok(())
                },
                move || {
                    close_events.borrow_mut().push("controls");
                    Ok(())
                },
            );
        }
        assert_eq!(*events.borrow(), vec!["controls", "overlay"]);
    }

    #[test]
    fn explicit_cleanup_reports_failures_after_attempting_every_step() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let restore_events = Rc::clone(&events);
        let close_events = Rc::clone(&events);
        let cleanup = CaptureCleanup::new(
            move || {
                restore_events.borrow_mut().push("overlay");
                Err("overlay restore failed".to_string())
            },
            move || {
                close_events.borrow_mut().push("controls");
                Err("mask hide failed".to_string())
            },
        );

        let error = cleanup.complete().unwrap_err();

        assert_eq!(*events.borrow(), vec!["controls", "overlay"]);
        assert_eq!(error, "mask hide failed; overlay restore failed");
    }

    #[test]
    fn cleanup_failure_preserves_the_png_and_returns_to_editing() {
        let result = finalize_capture_result(
            vec![137, 80, 78, 71],
            false,
            LongCaptureAction::Finish,
            |_| Ok(()),
        )
        .unwrap();

        let recovered = recover_from_cleanup_failure(result, "mask hide failed".to_string());

        assert_eq!(recovered.png_bytes, vec![137, 80, 78, 71]);
        assert_eq!(recovered.action, LongCaptureAction::Edit);
        assert_eq!(recovered.cleanup_error.as_deref(), Some("mask hide failed"));
    }

    #[test]
    fn preparation_and_cleanup_failures_are_both_returned() {
        let result = resolve_capture_cleanup(
            Err("preview exclusion failed".to_string()),
            Err("mask hide failed".to_string()),
        );

        assert_eq!(
            result.err().unwrap(),
            "preview exclusion failed; cleanup: mask hide failed"
        );
    }

    #[test]
    fn cleanup_hides_all_masks_without_closing_them() {
        let events = RefCell::new(Vec::new());
        cleanup_capture_windows(
            &["scroll-mask-top", "scroll-mask-right"],
            &["scroll-capture-preview"],
            |label| {
                events.borrow_mut().push(format!("hide:{label}"));
                Ok(())
            },
            |label| {
                events.borrow_mut().push(format!("close:{label}"));
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(
            events.into_inner(),
            vec![
                "hide:scroll-mask-top",
                "hide:scroll-mask-right",
                "hide:scroll-capture-preview",
                "close:scroll-capture-preview",
            ]
        );
    }

    #[test]
    fn cancelled_cleanup_closes_temporary_windows_before_reset() {
        let events = Rc::new(RefCell::new(Vec::new()));
        let close_events = Rc::clone(&events);
        let affinity_events = Rc::clone(&events);
        let reset_events = Rc::clone(&events);
        let restore_events = Rc::clone(&events);

        run_cleanup_callbacks(
            true,
            move || close_events.borrow_mut().push("close-temporary"),
            move || affinity_events.borrow_mut().push("restore-affinity"),
            move || reset_events.borrow_mut().push("reset-session"),
            move || restore_events.borrow_mut().push("restore-editor"),
        );

        assert_eq!(
            *events.borrow(),
            vec!["close-temporary", "restore-affinity", "reset-session"]
        );
    }

    #[test]
    fn overlay_cleanup_restores_unless_cancel_was_requested() {
        assert_eq!(overlay_cleanup(false), OverlayCleanup::Restore);
        assert_eq!(overlay_cleanup(true), OverlayCleanup::Hide);
    }

    #[test]
    fn runtime_exposes_cancel_request_for_cleanup() {
        let runtime = super::LongCaptureRuntime::default();
        runtime.begin().unwrap();

        assert!(!runtime.is_cancel_requested());
        runtime.request_cancel();

        assert!(runtime.is_cancel_requested());
    }

    #[test]
    fn crops_the_selected_pixels_from_a_monitor() {
        let pixels = (0..24_u8).collect();
        let frame = RawMonitorFrame {
            x: 10,
            y: 20,
            width: 3,
            height: 2,
            scale_factor: 1.0,
            rgba: pixels,
        };
        let crop = crop_region(
            vec![frame],
            CaptureRegion {
                x: 11.0,
                y: 20.0,
                width: 2.0,
                height: 2.0,
            },
        )
        .unwrap();
        assert_eq!(crop.width, 2);
        assert_eq!(crop.height, 2);
        assert_eq!(
            crop.pixels,
            vec![4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23]
        );
    }

    #[test]
    fn converts_logical_selection_to_physical_screen_coordinates() {
        let region = CaptureRegion {
            x: 100.0,
            y: 80.0,
            width: 400.0,
            height: 300.0,
        }
        .to_physical(-1920, 40, 1.25);

        assert_eq!(region.x, -1795.0);
        assert_eq!(region.y, 140.0);
        assert_eq!(region.width, 500.0);
        assert_eq!(region.height, 375.0);
    }
}
