use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::platform::{self, RawMonitorFrame};
use crate::region_observer::{Observation, RegionObserver, SAMPLE_INTERVAL};
use crate::scroll_controller::{LongCaptureSession, LongCaptureState, SessionError};
use crate::static_region_detector::detect_static_regions;
use crate::stitcher::{
    classify_scroll_direction, downscale_grayscale, ChunkedStitcher, MatchDirection, RgbaFrame,
};

#[derive(Clone, Copy, Debug, Deserialize)]
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
    warning: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureResult {
    png_bytes: Vec<u8>,
    partial: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureTermination {
    Cancelled,
    Partial,
    Completed,
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
        if let Some(restore) = self.restore_overlay.take() {
            restore();
        }
        if let Some(close) = self.close_controls.take() {
            close();
        }
    }
}

pub struct LongCaptureRuntime {
    active: AtomicBool,
    stop_requested: AtomicBool,
    cancel_requested: AtomicBool,
    progress: Mutex<LongCaptureProgress>,
}

impl Default for LongCaptureRuntime {
    fn default() -> Self {
        Self {
            active: AtomicBool::new(false),
            stop_requested: AtomicBool::new(false),
            cancel_requested: AtomicBool::new(false),
            progress: Mutex::new(LongCaptureProgress::default()),
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
        self.update(0, 0, "preparing", Vec::new(), false);
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
    ) {
        if let Ok(mut progress) = self.progress.lock() {
            *progress = LongCaptureProgress {
                frame_count,
                stitched_height,
                state,
                preview_png_bytes,
                warning,
            };
        }
    }

    pub fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::Release);
    }

    pub fn request_cancel(&self) {
        self.cancel_requested.store(true, Ordering::Release);
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

fn publish_progress(runtime: &LongCaptureRuntime, session: &LongCaptureSession, preview: &[u8]) {
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
    );
}

fn control_window_x(
    selection_x: i32,
    selection_width: i32,
    monitor_x: i32,
    monitor_width: i32,
    controls_width: i32,
) -> i32 {
    let right = selection_x + selection_width + 12;
    if right + controls_width <= monitor_x + monitor_width {
        right
    } else {
        (selection_x - controls_width - 12).max(monitor_x + 8)
    }
}

fn open_controls_window(app: &tauri::AppHandle, region: CaptureRegion) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("long-capture-controls") {
        let _ = existing.close();
    }
    let frames = platform::capture_monitors()?;
    let center_x = (region.x + region.width / 2.0).round() as i32;
    let center_y = (region.y + region.height / 2.0).round() as i32;
    let monitor = frames
        .iter()
        .find(|frame| {
            center_x >= frame.x
                && center_y >= frame.y
                && center_x < frame.x + frame.width as i32
                && center_y < frame.y + frame.height as i32
        })
        .ok_or_else(|| "cannot place long-capture controls outside the selection".to_string())?;
    let width = 148_i32;
    let height = 280_i32.min(monitor.height as i32 - 16).max(120);
    let x = control_window_x(
        region.x.round() as i32,
        region.width.round() as i32,
        monitor.x,
        monitor.width as i32,
        width,
    );
    let y = (region.y.round() as i32)
        .max(monitor.y + 8)
        .min(monitor.y + monitor.height as i32 - height - 8);
    WebviewWindowBuilder::new(
        app,
        "long-capture-controls",
        WebviewUrl::App("index.html?window=long-capture-controls".into()),
    )
    .title("长截图")
    .inner_size(width as f64, height as f64)
    .position(x as f64, y as f64)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .build()
    .map_err(|error| format!("failed to open long-capture controls: {error}"))?;
    Ok(())
}

fn run_capture(
    runtime: &LongCaptureRuntime,
    region: CaptureRegion,
) -> Result<LongCaptureResult, String> {
    let target_x = (region.x + region.width / 2.0).round() as i32;
    let target_y = (region.y + region.height / 2.0).round() as i32;
    let target = platform::locate_capture_target(target_x, target_y)?;
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
    publish_progress(runtime, &session, &preview_png);

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
        platform::validate_capture_target(target)?;

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
                let previous_gray = downscale_grayscale(&accepted_tail, 4)
                    .map_err(|error| format!("overlap preparation failed: {error:?}"))?;
                let next_gray = downscale_grayscale(&candidate, 4)
                    .map_err(|error| format!("overlap preparation failed: {error:?}"))?;
                let minimum = (previous_gray.height / 5)
                    .max(1)
                    .min(previous_gray.height.saturating_sub(1));
                match classify_scroll_direction(&previous_gray, &next_gray, minimum) {
                    MatchDirection::Forward { overlap_rows } => {
                        let overlap_rows =
                            (overlap_rows * 4).min(candidate.height.saturating_sub(1));
                        let static_regions =
                            detect_static_regions(&[previous_gray, next_gray], 2, 0.9, 2)
                                .unwrap_or_default();
                        stitcher
                            .append_with_static_regions(
                                candidate.clone(),
                                overlap_rows,
                                static_regions.top_rows * 4,
                                static_regions.bottom_rows * 4,
                                static_regions.confidence,
                                false,
                            )
                            .map_err(|error| format!("stitch failed: {error:?}"))?;
                        session
                            .forward_matched(candidate.height - overlap_rows)
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
                    MatchDirection::Unmatched => session
                        .unmatched()
                        .map_err(|_| "invalid unmatched transition")?,
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
        publish_progress(runtime, &session, &preview_png);
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
        let _cleanup = CaptureCleanup::new(
            move || {
                let _ = restore_window.set_ignore_cursor_events(false);
                let _ = restore_app.emit("long-capture-presentation", false);
                let _ = restore_window.show();
                let _ = restore_window.set_focus();
            },
            move || {
                if let Some(controls) = close_app.get_webview_window("long-capture-controls") {
                    let _ = controls.close();
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
        let escape_registered = app.global_shortcut().register("Escape").is_ok();
        app.emit("long-capture-presentation", true)
            .map_err(|error| format!("failed to enter capture presentation: {error}"))?;
        window
            .set_ignore_cursor_events(true)
            .map_err(|error| format!("failed to enable overlay pass-through: {error}"))?;
        open_controls_window(&app, region)?;
        std::thread::sleep(Duration::from_millis(150));
        let capture = run_capture(&runtime, region);
        if escape_registered {
            let _ = app.global_shortcut().unregister("Escape");
        }
        capture
    })();
    runtime.finish();
    result
}

#[tauri::command]
pub fn stop_long_capture(runtime: tauri::State<'_, LongCaptureRuntime>) {
    runtime.request_stop();
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
    use super::{crop_region, termination, CaptureCleanup, CaptureRegion, CaptureTermination};
    use crate::platform::RawMonitorFrame;
    use std::{cell::Cell, rc::Rc};

    #[test]
    fn cancel_discards_output_while_stop_keeps_it() {
        assert_eq!(termination(true, false, 3), CaptureTermination::Cancelled);
        assert_eq!(termination(false, true, 3), CaptureTermination::Partial);
        assert_eq!(termination(false, false, 3), CaptureTermination::Completed);
    }

    #[test]
    fn cleanup_restores_overlay_and_closes_controls_once() {
        let restored = Rc::new(Cell::new(0));
        let closed = Rc::new(Cell::new(0));
        {
            let restored_count = Rc::clone(&restored);
            let closed_count = Rc::clone(&closed);
            let _cleanup = CaptureCleanup::new(
                move || restored_count.set(restored_count.get() + 1),
                move || closed_count.set(closed_count.get() + 1),
            );
        }
        assert_eq!(restored.get(), 1);
        assert_eq!(closed.get(), 1);
    }

    #[test]
    fn controls_prefer_the_right_side_and_fall_back_to_the_left() {
        assert_eq!(super::control_window_x(100, 300, 0, 1920, 148), 412);
        assert_eq!(super::control_window_x(1800, 100, 0, 1920, 148), 1640);
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
