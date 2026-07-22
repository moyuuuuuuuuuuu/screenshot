use windows_sys::Win32::UI::WindowsAndMessaging::{
    SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
};

pub(crate) fn apply_capture_exclusion(
    hwnd: isize,
    set_affinity: impl FnOnce(isize, u32) -> bool,
) -> Result<(), String> {
    if hwnd == 0 {
        return Err("cannot exclude a window without a valid HWND".to_string());
    }
    if !set_affinity(hwnd, WDA_EXCLUDEFROMCAPTURE) {
        return Err("SetWindowDisplayAffinity failed".to_string());
    }
    Ok(())
}

pub fn exclude_window_from_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("failed to read screenshot window handle: {error}"))?;
    apply_capture_exclusion(hwnd.0 as isize, |raw, affinity| unsafe {
        SetWindowDisplayAffinity(raw as *mut core::ffi::c_void, affinity) != 0
    })
    .map_err(|error| {
        if error == "SetWindowDisplayAffinity failed" {
            format!("{error}: {}", std::io::Error::last_os_error())
        } else {
            error
        }
    })
}

#[cfg(test)]
mod tests {
    use super::apply_capture_exclusion;

    #[test]
    fn capture_exclusion_rejects_a_missing_window_handle() {
        let result = apply_capture_exclusion(0, |_, _| true);

        assert_eq!(
            result.unwrap_err(),
            "cannot exclude a window without a valid HWND"
        );
    }

    #[test]
    fn capture_exclusion_uses_the_windows_exclude_from_capture_affinity() {
        let mut observed = None;

        apply_capture_exclusion(42, |hwnd, affinity| {
            observed = Some((hwnd, affinity));
            true
        })
        .unwrap();

        assert_eq!(observed, Some((42, 0x11)));
    }

    #[test]
    fn capture_exclusion_reports_a_failed_native_call() {
        let result = apply_capture_exclusion(42, |_, _| false);

        assert_eq!(result.unwrap_err(), "SetWindowDisplayAffinity failed");
    }
}
