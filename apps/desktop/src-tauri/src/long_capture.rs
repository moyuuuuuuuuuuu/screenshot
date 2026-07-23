use std::sync::{
    atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
    Condvar, Mutex,
};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

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
    frame_count: u32,
    stitched_height: u32,
    state: &'static str,
    preview_png_bytes: Vec<u8>,
    navigator_png_bytes: Vec<u8>,
    accepted_bounds: Option<AcceptedBounds>,
    warning: bool,
    slow_scroll_warning: bool,
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

const PREVIEW_UPDATE_INTERVAL: Duration = Duration::from_millis(500);

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
        self.update(0, 0, "preparing", Vec::new(), false, 0);
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
        frame_count: u32,
        stitched_height: u32,
        state: &'static str,
        preview_png_bytes: Vec<u8>,
        warning: bool,
        width: u32,
    ) {
        if let Ok(mut progress) = self.progress.lock() {
            *progress = LongCaptureProgress {
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
    session: &LongCaptureSession,
    preview: &[u8],
    width: u32,
) {
    let warning = matches!(
        session.state(),
        LongCaptureState::PausedReverse | LongCaptureState::Warning
    );
    runtime.update(
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
    let before_height = stitcher.height();
    stitcher
        .append_with_static_regions(
            candidate,
            overlap_rows,
            static_regions.top_rows * 4,
            static_regions.bottom_rows * 4,
            static_regions.confidence,
            false,
        )
        .map_err(|error| format!("stitch failed: {error:?}"))?;
    Ok(stitcher.height().saturating_sub(before_height))
}

fn match_motion_candidate(
    session: &mut LongCaptureSession,
    stitcher: &mut ChunkedStitcher,
    accepted_tail: &RgbaFrame,
    candidate: &RgbaFrame,
) -> Result<bool, String> {
    if session.state() != LongCaptureState::Scrolling {
        session
            .motion_started()
            .map_err(|_| "invalid motion transition")?;
    }
    session
        .stable_frame_ready()
        .map_err(|_| "invalid candidate-frame transition")?;
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
            session
                .forward_matched(added_height)
                .map_err(|_| "invalid forward-match transition")?;
            Ok(true)
        }
        MatchDirection::Reverse => {
            session
                .reverse_detected()
                .map_err(|_| "invalid reverse-match transition")?;
            Ok(false)
        }
        MatchDirection::Unmatched => {
            session
                .unmatched()
                .map_err(|_| "invalid unmatched transition")?;
            Ok(false)
        }
    }
}

fn observation_requires_match(
    observation: Observation,
    latest_motion_frame_was_appended: bool,
) -> bool {
    matches!(
        observation,
        Observation::MotionStarted | Observation::MotionFrame
    ) || (observation == Observation::StableFrame && !latest_motion_frame_was_appended)
}

fn should_refresh_preview(
    observation: Observation,
    preview_dirty: bool,
    since_last_refresh: Duration,
) -> bool {
    preview_dirty
        && (observation == Observation::StableFrame
            || since_last_refresh >= PREVIEW_UPDATE_INTERVAL)
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

fn run_capture(
    runtime: &LongCaptureRuntime,
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
    let mut latest_motion_frame_was_appended = false;
    let mut preview_dirty = false;
    let mut last_preview_refresh = Duration::ZERO;
    publish_progress(runtime, &session, &preview_png, accepted_tail.width);

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
        if observation == Observation::MotionStarted {
            latest_motion_frame_was_appended = false;
        }
        if observation_requires_match(observation, latest_motion_frame_was_appended) {
            latest_motion_frame_was_appended =
                match_motion_candidate(&mut session, &mut stitcher, &accepted_tail, &candidate)?;
            if latest_motion_frame_was_appended {
                accepted_tail = candidate;
                observer.mark_appended(observed_at);
                preview_dirty = true;
            }
        }
        if should_refresh_preview(
            observation,
            preview_dirty,
            observed_at.saturating_sub(last_preview_refresh),
        ) {
            preview_png = encode_png(
                &stitcher
                    .preview()
                    .map_err(|error| format!("preview failed: {error:?}"))?,
            )?;
            preview_dirty = false;
            // Start the cooldown after compression finishes so expensive previews do not
            // immediately trigger another rebuild on the next sample.
            last_preview_refresh = started.elapsed();
        }
        if observation == Observation::StableFrame {
            latest_motion_frame_was_appended = false;
        }
        publish_progress(runtime, &session, &preview_png, accepted_tail.width);
        let _ = runtime.wait_for_sample_or_terminal(SAMPLE_INTERVAL);
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
            let capture_result = run_capture(&runtime, region);
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
        append_stable_candidate, cleanup_capture_windows, crop_region, finalize_capture_result,
        match_motion_candidate, observation_requires_match, overlay_cleanup,
        prepare_capture_windows, recover_from_cleanup_failure, resolve_capture_cleanup,
        run_cleanup_callbacks, should_refresh_preview, termination, CaptureCleanup, CaptureRegion,
        CaptureTermination, LongCaptureAction, OverlayCleanup,
    };
    use crate::platform::RawMonitorFrame;
    use crate::region_observer::{Observation, RegionObserver};
    use crate::scroll_controller::LongCaptureSession;
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
    fn continuous_motion_frames_are_stitched_before_scrolling_stops() {
        let first = document_frame(0, 700, 80);
        let frames = [
            document_frame(260, 700, 80),
            document_frame(520, 700, 80),
            document_frame(780, 700, 80),
        ];
        let mut session = LongCaptureSession::default();
        session.start().unwrap();
        session
            .accept_first_frame(first.height, std::time::Duration::ZERO)
            .unwrap();
        let mut stitcher = ChunkedStitcher::default();
        stitcher.append(first.clone(), 0).unwrap();
        let mut observer = RegionObserver::new(0.01);
        let first_gray = crate::stitcher::downscale_grayscale(&first, 8).unwrap();
        observer.observe(&first_gray.pixels, std::time::Duration::ZERO);
        let mut accepted_tail = first;
        let mut latest_motion_frame_was_appended = false;

        for (index, candidate) in frames.into_iter().enumerate() {
            let gray = crate::stitcher::downscale_grayscale(&candidate, 8).unwrap();
            let observation = observer.observe(
                &gray.pixels,
                std::time::Duration::from_millis((index as u64 + 1) * 120),
            );
            assert!(observation_requires_match(
                observation,
                latest_motion_frame_was_appended
            ));
            latest_motion_frame_was_appended =
                match_motion_candidate(&mut session, &mut stitcher, &accepted_tail, &candidate)
                    .unwrap();
            assert!(latest_motion_frame_was_appended);
            accepted_tail = candidate;
        }

        assert_eq!(session.frame_count(), 4);
        assert_eq!(session.stitched_height(), 1_480);
        assert_eq!(stitcher.finish().unwrap().height, 1_480);
    }

    #[test]
    fn preview_refresh_is_throttled_during_motion_but_forced_when_stable() {
        assert!(!should_refresh_preview(
            Observation::MotionFrame,
            true,
            std::time::Duration::from_millis(120),
        ));
        assert!(should_refresh_preview(
            Observation::MotionFrame,
            true,
            std::time::Duration::from_millis(500),
        ));
        assert!(should_refresh_preview(
            Observation::StableFrame,
            true,
            std::time::Duration::from_millis(120),
        ));
        assert!(!should_refresh_preview(
            Observation::StableFrame,
            false,
            std::time::Duration::from_secs(1),
        ));
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
