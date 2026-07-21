use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::frame_stability::{FrameStabilitySampler, StabilityObservation};
use crate::platform::{self, RawMonitorFrame};
use crate::scroll_controller::{LongCaptureSession, LongCaptureState, SessionError};
use crate::static_region_detector::detect_static_regions;
use crate::stitcher::{downscale_grayscale, find_vertical_overlap, ChunkedStitcher, RgbaFrame};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureProgress {
    frame_count: u32,
    stitched_height: u32,
    state: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LongCaptureResult {
    png_bytes: Vec<u8>,
    partial: bool,
}

pub struct LongCaptureRuntime {
    active: AtomicBool,
    stop_requested: AtomicBool,
    progress: Mutex<LongCaptureProgress>,
}

impl Default for LongCaptureRuntime {
    fn default() -> Self {
        Self {
            active: AtomicBool::new(false),
            stop_requested: AtomicBool::new(false),
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
        self.update(0, 0, "preparing");
        Ok(())
    }

    fn finish(&self) {
        self.active.store(false, Ordering::Release);
    }

    fn update(&self, frame_count: u32, stitched_height: u32, state: &'static str) {
        if let Ok(mut progress) = self.progress.lock() {
            *progress = LongCaptureProgress {
                frame_count,
                stitched_height,
                state,
            };
        }
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

fn encode_png(frame: RgbaFrame) -> Result<Vec<u8>, String> {
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

fn wait_for_stable_frame(
    runtime: &LongCaptureRuntime,
    region: CaptureRegion,
) -> Result<RgbaFrame, String> {
    let mut sampler = FrameStabilitySampler::new(2, 0.01);
    for _ in 0..20 {
        if runtime.stop_requested.load(Ordering::Acquire) {
            return Err("long capture stopped".to_string());
        }
        let frame = crop_region(platform::capture_monitors()?, region)?;
        let gray = downscale_grayscale(&frame, 8)
            .map_err(|error| format!("stability sampling failed: {error:?}"))?;
        if matches!(
            sampler.observe(&gray.pixels),
            Ok(StabilityObservation::Stable { .. })
        ) {
            return Ok(frame);
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    Err("scrolling content did not become stable".to_string())
}

fn run_capture(
    runtime: &LongCaptureRuntime,
    region: CaptureRegion,
) -> Result<LongCaptureResult, String> {
    let target_x = (region.x + region.width / 2.0).round() as i32;
    let target_y = (region.y + region.height / 2.0).round() as i32;
    let target = platform::track_scroll_target(target_x, target_y)?;
    let started = Instant::now();
    let mut session = LongCaptureSession::default();
    let mut stitcher = ChunkedStitcher::default();
    let mut previous: Option<RgbaFrame> = None;
    let mut pending_frame: Option<RgbaFrame> = None;
    session
        .start()
        .map_err(|_| "failed to start long capture session")?;

    loop {
        if runtime.stop_requested.load(Ordering::Acquire) {
            session.request_stop();
            break;
        }
        match session.begin_capture(started.elapsed()) {
            Ok(()) => {}
            Err(SessionError::ResourceLimit) => break,
            Err(SessionError::InvalidTransition) => {
                return Err("invalid capture transition".to_string())
            }
        }
        runtime.update(
            session.frame_count(),
            session.stitched_height(),
            "capturing",
        );
        let frame = match pending_frame.take() {
            Some(frame) => frame,
            None => crop_region(platform::capture_monitors()?, region)?,
        };
        session
            .frame_captured(frame.height)
            .map_err(|_| "invalid capture transition")?;

        if let Some(previous_frame) = previous.as_ref() {
            runtime.update(session.frame_count(), session.stitched_height(), "matching");
            if previous_frame.pixels == frame.pixels {
                session
                    .match_completed(0)
                    .map_err(|_| "invalid match transition")?;
            } else {
                let previous_gray = downscale_grayscale(previous_frame, 4)
                    .map_err(|error| format!("overlap preparation failed: {error:?}"))?;
                let next_gray = downscale_grayscale(&frame, 4)
                    .map_err(|error| format!("overlap preparation failed: {error:?}"))?;
                let maximum = previous_gray.height.saturating_sub(1);
                let minimum = (previous_gray.height / 5).max(1).min(maximum);
                let overlap = match find_vertical_overlap(
                    &previous_gray,
                    &next_gray,
                    minimum,
                    maximum,
                    2.0,
                    0.75,
                ) {
                    Ok(overlap) => overlap,
                    Err(_) => {
                        session.fail();
                        break;
                    }
                };
                let overlap_rows = (overlap.overlap_rows * 4).min(frame.height.saturating_sub(1));
                let static_regions = detect_static_regions(&[previous_gray, next_gray], 2, 0.9, 2)
                    .unwrap_or_default();
                stitcher
                    .append_with_static_regions(
                        frame.clone(),
                        overlap_rows,
                        static_regions.top_rows * 4,
                        static_regions.bottom_rows * 4,
                        static_regions.confidence,
                        false,
                    )
                    .map_err(|error| format!("stitch failed: {error:?}"))?;
                session
                    .match_completed(frame.height - overlap_rows)
                    .map_err(|_| "invalid match transition")?;
            }
        } else {
            stitcher
                .append(frame.clone(), 0)
                .map_err(|error| format!("stitch failed: {error:?}"))?;
        }
        previous = Some(frame);
        runtime.update(
            session.frame_count(),
            session.stitched_height(),
            "scrolling",
        );
        if matches!(
            session.state(),
            LongCaptureState::Completed | LongCaptureState::Partial
        ) {
            break;
        }
        session
            .scroll_sent()
            .map_err(|_| "invalid scroll transition")?;
        if platform::send_scroll(target, -480).is_err() {
            session.fail();
            break;
        }
        runtime.update(
            session.frame_count(),
            session.stitched_height(),
            "stabilizing",
        );
        match wait_for_stable_frame(runtime, region) {
            Ok(frame) => pending_frame = Some(frame),
            Err(_) => {
                session.fail();
                break;
            }
        }
    }

    let partial = matches!(
        session.state(),
        LongCaptureState::Partial | LongCaptureState::Failed
    );
    Ok(LongCaptureResult {
        png_bytes: encode_png(
            stitcher
                .finish()
                .map_err(|error| format!("finish failed: {error:?}"))?,
        )?,
        partial,
    })
}

#[tauri::command]
pub async fn start_long_capture(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, LongCaptureRuntime>,
    region: CaptureRegion,
) -> Result<LongCaptureResult, String> {
    runtime.begin()?;
    let Some(window) = app.get_webview_window("overlay") else {
        runtime.finish();
        return Err("overlay window is unavailable".to_string());
    };
    let result = (|| {
        window
            .hide()
            .map_err(|error| format!("failed to hide overlay: {error}"))?;
        std::thread::sleep(Duration::from_millis(80));
        run_capture(&runtime, region)
    })();
    let _ = window.show();
    let _ = window.set_focus();
    runtime.finish();
    result
}

#[tauri::command]
pub fn stop_long_capture(runtime: tauri::State<'_, LongCaptureRuntime>) {
    runtime.stop_requested.store(true, Ordering::Release);
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
    use super::{crop_region, CaptureRegion};
    use crate::platform::RawMonitorFrame;

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
}
