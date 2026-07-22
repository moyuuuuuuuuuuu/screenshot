use windows_sys::Win32::UI::WindowsAndMessaging::{
    SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
};

pub(crate) fn apply_capture_affinity(
    hwnd: isize,
    affinity: u32,
    set_affinity: impl FnOnce(isize, u32) -> bool,
) -> Result<(), String> {
    if hwnd == 0 {
        return Err("cannot exclude a window without a valid HWND".to_string());
    }
    if !set_affinity(hwnd, affinity) {
        return Err("SetWindowDisplayAffinity failed".to_string());
    }
    Ok(())
}

fn set_window_capture_affinity(
    window: &tauri::WebviewWindow,
    affinity: u32,
) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("failed to read screenshot window handle: {error}"))?;
    apply_capture_affinity(hwnd.0 as isize, affinity, |raw, value| unsafe {
        SetWindowDisplayAffinity(raw as *mut core::ffi::c_void, value) != 0
    })
    .map_err(|error| {
        if error == "SetWindowDisplayAffinity failed" {
            format!("{error}: {}", std::io::Error::last_os_error())
        } else {
            error
        }
    })
}

pub fn exclude_window_from_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    set_window_capture_affinity(window, WDA_EXCLUDEFROMCAPTURE)
}

pub fn restore_window_capture(window: &tauri::WebviewWindow) -> Result<(), String> {
    set_window_capture_affinity(window, WDA_NONE)
}

#[cfg(test)]
mod tests {
    use super::{apply_capture_affinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};

    #[test]
    fn capture_exclusion_rejects_a_missing_window_handle() {
        let result = apply_capture_affinity(0, WDA_EXCLUDEFROMCAPTURE, |_, _| true);

        assert_eq!(
            result.unwrap_err(),
            "cannot exclude a window without a valid HWND"
        );
    }

    #[test]
    fn exclusion_uses_exclude_from_capture() {
        let mut observed = None;

        apply_capture_affinity(42, WDA_EXCLUDEFROMCAPTURE, |hwnd, affinity| {
            observed = Some((hwnd, affinity));
            true
        })
        .unwrap();

        assert_eq!(observed, Some((42, 0x11)));
    }

    #[test]
    fn restoration_uses_none() {
        let mut observed = None;

        apply_capture_affinity(42, WDA_NONE, |hwnd, affinity| {
            observed = Some((hwnd, affinity));
            true
        })
        .unwrap();

        assert_eq!(observed, Some((42, 0x0)));
    }

    #[test]
    fn capture_affinity_reports_a_failed_native_call() {
        let result = apply_capture_affinity(42, WDA_EXCLUDEFROMCAPTURE, |_, _| false);

        assert_eq!(result.unwrap_err(), "SetWindowDisplayAffinity failed");
    }
}
