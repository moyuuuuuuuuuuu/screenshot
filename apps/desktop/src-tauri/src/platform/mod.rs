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

#[cfg(not(windows))]
pub fn capture_monitors() -> Result<Vec<RawMonitorFrame>, String> {
    Err("desktop capture is currently supported only on Windows".to_string())
}
