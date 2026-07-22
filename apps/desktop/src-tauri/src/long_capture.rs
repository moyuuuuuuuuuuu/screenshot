use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::platform::{self, RawMonitorFrame};
use crate::preview_windows::{open_capture_mask_windows, open_preview_window, ScreenRect};
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureResult {
    png_bytes: Vec<u8>,
    partial: bool,
    action: LongCaptureAction,
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

struct CaptureCleanup<Restore, Close>
where
    Restore: FnOnce(),
    Close: FnOnce(),
{
    restore_overlay: Option<Restore>,
    close_controls: Option<Close>,
}

impl<Restore, Close> CaptureCleanup<Restore, Close>
where
    Restore: FnOnce(),
    Close: FnOnce(),
{
    fn new(restore_overlay: Restore, close_controls: Close) -> Self {
        Self {
            restore_overlay: Some(restore_overlay),
            close_controls: Some(close_controls),
        }
    }
}

impl<Restore, Close> Drop for CaptureCleanup<Restore, Close>
where
    Restore: FnOnce(),
    Close: FnOnce(),
{
    fn drop(&mut self) {
        if let Some(close) = self.close_controls.take() {
            close();
        }
        if let Some(restore) = self.restore_overlay.take() {
            restore();
        }
    }
}

pub struct LongCaptureRuntime {
    active: AtomicBool,
    stop_requested: AtomicBool,
    cancel_requested: AtomicBool,
    progress: Mutex<LongCaptureProgress>,
    action: AtomicU8,
}

impl Default for LongCaptureRuntime {
    fn default() -> Self {
        Self {
            active: AtomicBool::new(false),
            stop_requested: AtomicBool::new(false),
            cancel_requested: AtomicBool::new(false),
            progress: Mutex::new(LongCaptureProgress::default()),
            action: AtomicU8::new(LongCaptureAction::None.code()),
        }
    }
}

impl LongCaptureRuntime {
    fn begin(&self) -> Result<(), String> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "a long capture is already running".to_string())?;
        self.stop_requested.store(false, Ordering::Release);
        self.cancel_requested.store(false, Ordering::Release);
        self.action
            .store(LongCaptureAction::None.code(), Ordering::Release);
        self.update(0, 0, "preparing", Vec::new(), false, 0);
        Ok(())
    }

    fn finish(&self) {
        self.active.store(false, Ordering::Release);
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

    pub fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::Release);
    }

    pub fn request_cancel(&self) {
        self.action
            .store(LongCaptureAction::Cancel.code(), Ordering::Release);
        self.cancel_requested.store(true, Ordering::Release);
    }

    pub fn is_cancel_requested(&self) -> bool {
        self.cancel_requested.load(Ordering::Acquire)
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub fn request_edit(&self) {
        self.action
            .store(LongCaptureAction::Edit.code(), Ordering::Release);
        self.request_stop();
    }
    pub fn request_save(&self) {
        self.action
            .store(LongCaptureAction::Save.code(), Ordering::Release);
        self.request_stop();
    }
    pub fn request_finish(&self) {
        self.action
            .store(LongCaptureAction::Finish.code(), Ordering::Release);
        self.request_stop();
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
    let static_regions = detect_static_regions(&[previous_gray, next_gray], 2, 0.9, 2)
        .unwrap_or_default();
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

fn prepare_capture_windows(
    open_and_exclude_masks: impl FnOnce() -> Result<(), String>,
    open_and_exclude_preview: impl FnOnce() -> Result<(), String>,
    hide_overlay: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    open_and_exclude_masks()?;
    open_and_exclude_preview()?;
    hide_overlay()?;
    Ok(())
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
        match observer.observe(&candidate_gray.pixels, started.elapsed()) {
            Observation::MotionStarted => {
                session
                    .motion_started()
                    .map_err(|_| "invalid motion transition")?;
            }
            Observation::StableFrame => {
                session
                    .stable_frame_ready()
                    .map_err(|_| "invalid stable-frame transition")?;
                match match_vertical_scroll(&accepted_tail, &candidate)
                    .map_err(|error| format!("stable-frame match failed: {error:?}"))?
                {
                    MatchDirection::Forward { overlap_rows } => {
                        let added_height = append_matched_candidate(
                            &mut stitcher,
                            &accepted_tail,
                            candidate.clone(),
                            overlap_rows.min(candidate.height.saturating_sub(1)),
                        )?;
                        session
                            .forward_matched(added_height)
                            .map_err(|_| "invalid forward-match transition")?;
                        accepted_tail = candidate;
                        preview_png = encode_png(
                            &stitcher
                                .preview()
                                .map_err(|error| format!("preview failed: {error:?}"))?,
                        )?;
                        observer.mark_appended(started.elapsed());
                    }
                    MatchDirection::Reverse => session
                        .reverse_detected()
                        .map_err(|_| "invalid reverse-match transition")?,
                    MatchDirection::Unmatched => {
                        session
                            .unmatched()
                            .map_err(|_| "invalid unmatched transition")?
                    }
                }
            }
            Observation::IdleComplete => {
                session
                    .complete()
                    .map_err(|_| "invalid completion transition")?;
                break;
            }
            Observation::Unchanged | Observation::Stabilizing => {}
        }
        publish_progress(runtime, &session, &preview_png, accepted_tail.width);
        std::thread::sleep(SAMPLE_INTERVAL);
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
    Ok(LongCaptureResult {
        png_bytes: encode_png(&output)?,
        partial: outcome == CaptureTermination::Partial,
        action: match runtime.requested_action() {
            LongCaptureAction::Save => LongCaptureAction::Save,
            LongCaptureAction::Finish => LongCaptureAction::Finish,
            _ => LongCaptureAction::Edit,
        },
    })
}

#[tauri::command]
pub async fn start_long_capture(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, LongCaptureRuntime>,
    region: CaptureRegion,
) -> Result<LongCaptureResult, String> {
    runtime.begin()?;
    let result = (|| {
        let window = app
            .get_webview_window("overlay")
            .ok_or_else(|| "overlay window is unavailable".to_string())?;
        let restore_window = window.clone();
        let restore_app = app.clone();
        let close_app = app.clone();
        let unregister_app = app.clone();
        let escape_registered = app.global_shortcut().register("Escape").is_ok();
        let _cleanup = CaptureCleanup::new(
            move || match overlay_cleanup(
                restore_app
                    .state::<LongCaptureRuntime>()
                    .is_cancel_requested(),
            ) {
                OverlayCleanup::Restore => {
                    let _ = platform::restore_window_capture(&restore_window);
                    let _ = restore_app.emit("long-capture-presentation", false);
                    let _ = restore_window.set_ignore_cursor_events(false);
                    let _ = restore_window.show();
                    let _ = restore_window.set_focus();
                }
                OverlayCleanup::Hide => {
                    let _ = platform::restore_window_capture(&restore_window);
                    let _ = restore_window.set_ignore_cursor_events(false);
                    crate::app_state::emit_capture_session_reset(&restore_app, &restore_window);
                    let _ = restore_app.emit("long-capture-presentation", false);
                    let _ = restore_window.hide();
                }
            },
            move || {
                for label in [
                    "scroll-capture-preview",
                    "scroll-mask-top",
                    "scroll-mask-right",
                    "scroll-mask-bottom",
                    "scroll-mask-left",
                ] {
                    if let Some(window) = close_app.get_webview_window(label) {
                        let _ = window.close();
                    }
                }
                if escape_registered {
                    let _ = unregister_app.global_shortcut().unregister("Escape");
                }
            },
        );
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
        prepare_capture_windows(
            || {
                let masks = open_capture_mask_windows(&app, selection, monitor)?;
                for mask in &masks {
                    if let Err(error) = platform::exclude_window_from_capture(mask) {
                        for mask in masks {
                            let _ = mask.close();
                        }
                        return Err(error);
                    }
                }
                Ok(())
            },
            || {
                let preview = open_controls_window(&app, region, monitor)?;
                platform::exclude_window_from_capture(&preview)
            },
            || {
                window
                    .hide()
                    .map_err(|error| format!("failed to hide overlay for long capture: {error}"))
            },
        )?;
        std::thread::sleep(Duration::from_millis(150));
        run_capture(&runtime, region)
    })();
    runtime.finish();
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
        append_stable_candidate, crop_region, overlay_cleanup, prepare_capture_windows,
        run_cleanup_callbacks, termination, CaptureCleanup, CaptureRegion, CaptureTermination,
        OverlayCleanup,
    };
    use crate::platform::RawMonitorFrame;
    use crate::stitcher::{ChunkedStitcher, RgbaFrame};
    use std::{cell::RefCell, rc::Rc};

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
    fn edit_save_cancel_and_finish_are_distinct_runtime_actions() {
        let runtime = super::LongCaptureRuntime::default();
        runtime.request_edit();
        assert_eq!(runtime.requested_action(), super::LongCaptureAction::Edit);
        runtime.request_save();
        assert_eq!(runtime.requested_action(), super::LongCaptureAction::Save);
        runtime.request_cancel();
        assert_eq!(runtime.requested_action(), super::LongCaptureAction::Cancel);
        runtime.request_finish();
        assert_eq!(runtime.requested_action(), super::LongCaptureAction::Finish);
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
    fn preparation_does_not_open_preview_when_mask_creation_fails() {
        let events = Rc::new(std::cell::RefCell::new(Vec::new()));
        let mask_events = events.clone();
        let preview_events = events.clone();
        let overlay_events = events.clone();

        let result = prepare_capture_windows(
            || {
                mask_events.borrow_mut().push("masks");
                Err("mask creation failed".to_string())
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
                move || restore_events.borrow_mut().push("overlay"),
                move || close_events.borrow_mut().push("controls"),
            );
        }
        assert_eq!(*events.borrow(), vec!["controls", "overlay"]);
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
