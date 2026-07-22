use windows_sys::Win32::{
    Foundation::POINT,
    UI::WindowsAndMessaging::{
        GetAncestor, IsWindow, SetForegroundWindow, WindowFromPoint, GA_ROOT,
    },
};

use crate::platform::CaptureTargetId;

pub fn locate_capture_target(x: i32, y: i32) -> Result<CaptureTargetId, String> {
    let child = unsafe { WindowFromPoint(POINT { x, y }) };
    let window = unsafe { GetAncestor(child, GA_ROOT) };
    CaptureTargetId::new(window as usize as u64)
        .map_err(|_| "no window exists beneath the selected point".to_string())
}

pub(crate) fn apply_target_focus(
    window: u64,
    set_foreground: impl FnOnce(u64) -> bool,
) -> Result<(), String> {
    if window == 0 {
        return Err("cannot focus a missing capture target".to_string());
    }
    if !set_foreground(window) {
        return Err("SetForegroundWindow failed".to_string());
    }
    Ok(())
}

pub fn focus_capture_target(target: CaptureTargetId) -> Result<(), String> {
    apply_target_focus(target.get(), |window| unsafe {
        SetForegroundWindow(window as usize as *mut core::ffi::c_void) != 0
    })
    .map_err(|error| {
        if error == "SetForegroundWindow failed" {
            format!("{error}: {}", std::io::Error::last_os_error())
        } else {
            error
        }
    })
}

pub fn validate_capture_target(target: CaptureTargetId) -> Result<(), String> {
    let window = target.get() as usize as *mut core::ffi::c_void;
    if unsafe { IsWindow(window) } == 0 {
        return Err("the capture target window no longer exists".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::apply_target_focus;

    #[test]
    fn target_focus_uses_the_capture_window_handle() {
        let mut observed = None;

        apply_target_focus(42, |window| {
            observed = Some(window);
            true
        })
        .unwrap();

        assert_eq!(observed, Some(42));
    }

    #[test]
    fn target_focus_rejects_a_missing_handle() {
        let error = apply_target_focus(0, |_| true).unwrap_err();

        assert_eq!(error, "cannot focus a missing capture target");
    }
}
