use windows_sys::Win32::{
    Foundation::POINT,
    UI::WindowsAndMessaging::{IsWindow, WindowFromPoint},
};

use crate::platform::CaptureTargetId;

pub fn locate_capture_target(x: i32, y: i32) -> Result<CaptureTargetId, String> {
    let window = unsafe { WindowFromPoint(POINT { x, y }) };
    CaptureTargetId::new(window as usize as u64)
        .map_err(|_| "no window exists beneath the selected point".to_string())
}

pub fn validate_capture_target(target: CaptureTargetId) -> Result<(), String> {
    let window = target.get() as usize as *mut core::ffi::c_void;
    if unsafe { IsWindow(window) } == 0 {
        return Err("the capture target window no longer exists".to_string());
    }
    Ok(())
}
