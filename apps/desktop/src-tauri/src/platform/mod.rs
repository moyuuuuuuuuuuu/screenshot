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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CaptureTargetId(u64);

impl CaptureTargetId {
    pub fn new(value: u64) -> Result<Self, String> {
        (value != 0)
            .then_some(Self(value))
            .ok_or_else(|| "capture target id must be non-zero".to_string())
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

#[cfg(windows)]
pub fn capture_monitors() -> Result<Vec<RawMonitorFrame>, String> {
    windows::capture_monitors()
}

#[cfg(windows)]
pub fn locate_capture_target(x: i32, y: i32) -> Result<CaptureTargetId, String> {
    windows::locate_capture_target(x, y)
}

#[cfg(not(windows))]
pub fn locate_capture_target(_x: i32, _y: i32) -> Result<CaptureTargetId, String> {
    Err("capture target tracking is currently supported only on Windows".to_string())
}

#[cfg(windows)]
pub fn validate_capture_target(target: CaptureTargetId) -> Result<(), String> {
    windows::validate_capture_target(target)
}

#[cfg(windows)]
pub fn exclude_window_from_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    windows::exclude_window_from_capture(window)
}

#[cfg(windows)]
pub fn restore_window_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    windows::restore_window_capture(window)
}

#[cfg(not(windows))]
pub fn exclude_window_from_capture(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Err("window capture exclusion is currently supported only on Windows".to_string())
}

#[cfg(not(windows))]
pub fn restore_window_capture(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Err("window capture affinity is currently supported only on Windows".to_string())
}

#[cfg(not(windows))]
pub fn validate_capture_target(_target: CaptureTargetId) -> Result<(), String> {
    Err("capture target validation is currently supported only on Windows".to_string())
}

#[cfg(not(windows))]
pub fn capture_monitors() -> Result<Vec<RawMonitorFrame>, String> {
    Err("desktop capture is currently supported only on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::CaptureTargetId;

    #[test]
    fn capture_target_ids_must_be_non_zero() {
        assert!(CaptureTargetId::new(0).is_err());
        assert_eq!(CaptureTargetId::new(42).unwrap().get(), 42);
    }
}
