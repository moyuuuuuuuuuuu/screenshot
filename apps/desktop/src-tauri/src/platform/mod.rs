#[cfg(windows)]
mod windows;

#[derive(Clone, Debug, PartialEq)]
pub struct RawMonitorFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub rgba: Vec<u8>,
}

#[cfg(windows)]
pub fn capture_monitors() -> Result<Vec<RawMonitorFrame>, String> {
    windows::capture_monitors()
}

#[cfg(windows)]
pub fn track_scroll_target(x: i32, y: i32) -> Result<u64, String> {
    windows::track_scroll_target(x, y)
}

#[cfg(not(windows))]
pub fn track_scroll_target(_x: i32, _y: i32) -> Result<u64, String> {
    Err("scroll target tracking is currently supported only on Windows".to_string())
}

#[cfg(windows)]
pub fn send_scroll(target_id: u64, delta: i32) -> Result<(), String> {
    windows::send_scroll(target_id, delta)
}

#[cfg(not(windows))]
pub fn send_scroll(_target_id: u64, _delta: i32) -> Result<(), String> {
    Err("scroll input is currently supported only on Windows".to_string())
}

#[cfg(not(windows))]
pub fn capture_monitors() -> Result<Vec<RawMonitorFrame>, String> {
    Err("desktop capture is currently supported only on Windows".to_string())
}
