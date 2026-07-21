use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;

use crate::platform::{self, RawMonitorFrame};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub png_base64: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VirtualDesktopBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn virtual_desktop_bounds(frames: &[RawMonitorFrame]) -> Option<VirtualDesktopBounds> {
    let first = frames.first()?;
    let mut left = i64::from(first.x);
    let mut top = i64::from(first.y);
    let mut right = left + i64::from(first.width);
    let mut bottom = top + i64::from(first.height);

    for frame in &frames[1..] {
        let frame_left = i64::from(frame.x);
        let frame_top = i64::from(frame.y);
        left = left.min(frame_left);
        top = top.min(frame_top);
        right = right.max(frame_left + i64::from(frame.width));
        bottom = bottom.max(frame_top + i64::from(frame.height));
    }

    Some(VirtualDesktopBounds {
        x: i32::try_from(left).ok()?,
        y: i32::try_from(top).ok()?,
        width: u32::try_from(right - left).ok()?,
        height: u32::try_from(bottom - top).ok()?,
    })
}

fn encode_png(frame: RawMonitorFrame) -> Result<MonitorFrame, String> {
    let expected_len = usize::try_from(frame.width)
        .ok()
        .zip(usize::try_from(frame.height).ok())
        .and_then(|(width, height)| width.checked_mul(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "monitor dimensions are too large".to_string())?;
    if frame.rgba.len() != expected_len {
        return Err("captured monitor buffer has an invalid length".to_string());
    }

    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, frame.width, frame.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("failed to encode monitor PNG header: {error}"))?;
        writer
            .write_image_data(&frame.rgba)
            .map_err(|error| format!("failed to encode monitor PNG pixels: {error}"))?;
    }

    Ok(MonitorFrame {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        scale_factor: frame.scale_factor,
        png_base64: STANDARD.encode(bytes),
    })
}

pub fn encode_monitor_frames(frames: Vec<RawMonitorFrame>) -> Result<Vec<MonitorFrame>, String> {
    virtual_desktop_bounds(&frames)
        .ok_or_else(|| "Windows did not report valid display monitor bounds".to_string())?;
    frames.into_iter().map(encode_png).collect()
}

#[tauri::command]
pub async fn capture_desktop() -> Result<Vec<MonitorFrame>, String> {
    encode_monitor_frames(platform::capture_monitors()?)
}
