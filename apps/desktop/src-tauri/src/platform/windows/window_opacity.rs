use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA,
    WS_EX_LAYERED,
};

pub(crate) fn apply_layered_opacity(
    hwnd: isize,
    alpha: u8,
    get_style: impl FnOnce(isize) -> isize,
    set_style: impl FnOnce(isize, isize) -> bool,
    set_alpha: impl FnOnce(isize, u8) -> bool,
) -> Result<(), String> {
    if hwnd == 0 {
        return Err("cannot set opacity without a valid HWND".to_string());
    }
    let layered_style = get_style(hwnd) | WS_EX_LAYERED as isize;
    if !set_style(hwnd, layered_style) {
        return Err("failed to enable layered window opacity".to_string());
    }
    if !set_alpha(hwnd, alpha) {
        return Err("SetLayeredWindowAttributes failed".to_string());
    }
    Ok(())
}

pub fn set_window_opacity(window: &tauri::WebviewWindow, alpha: u8) -> Result<(), String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("failed to read mask window handle: {error}"))?;
    apply_layered_opacity(
        hwnd.0 as isize,
        alpha,
        |raw| unsafe { GetWindowLongPtrW(raw as *mut core::ffi::c_void, GWL_EXSTYLE) },
        |raw, style| unsafe {
            SetWindowLongPtrW(raw as *mut core::ffi::c_void, GWL_EXSTYLE, style);
            GetWindowLongPtrW(raw as *mut core::ffi::c_void, GWL_EXSTYLE) & WS_EX_LAYERED as isize
                != 0
        },
        |raw, value| unsafe {
            SetLayeredWindowAttributes(raw as *mut core::ffi::c_void, 0, value, LWA_ALPHA) != 0
        },
    )
    .map_err(|error| {
        if error.ends_with("failed") || error.contains("failed to") {
            format!("{error}: {}", std::io::Error::last_os_error())
        } else {
            error
        }
    })
}

#[cfg(test)]
mod tests {
    use super::apply_layered_opacity;

    #[test]
    fn opacity_adds_layered_style_and_applies_requested_alpha() {
        let mut observed_style = None;
        let mut observed_alpha = None;

        apply_layered_opacity(
            42,
            77,
            |_| 0x100,
            |_, style| {
                observed_style = Some(style);
                true
            },
            |_, alpha| {
                observed_alpha = Some(alpha);
                true
            },
        )
        .unwrap();

        assert_eq!(observed_style, Some(0x80100));
        assert_eq!(observed_alpha, Some(77));
    }

    #[test]
    fn opacity_rejects_a_missing_window_handle() {
        let result = apply_layered_opacity(0, 77, |_| 0, |_, _| true, |_, _| true);

        assert_eq!(
            result.unwrap_err(),
            "cannot set opacity without a valid HWND"
        );
    }
}
