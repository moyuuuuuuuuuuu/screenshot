use windows_sys::Win32::{
    Foundation::POINT,
    UI::WindowsAndMessaging::{
        GetAncestor, IsWindow, PostMessageW, SetForegroundWindow, WindowFromPoint, GA_ROOT,
        WM_MOUSEWHEEL,
    },
};

pub fn track_scroll_target(x: i32, y: i32) -> Result<u64, String> {
    let child = unsafe { WindowFromPoint(POINT { x, y }) };
    if child.is_null() {
        return Err("no window exists beneath the selected point".to_string());
    }
    let root = unsafe { GetAncestor(child, GA_ROOT) };
    let target = if root.is_null() { child } else { root };
    Ok(target as usize as u64)
}

pub fn send_scroll(target_id: u64, delta: i32) -> Result<(), String> {
    let target = target_id as usize as *mut core::ffi::c_void;
    if target.is_null() || unsafe { IsWindow(target) } == 0 {
        return Err("the scroll target window no longer exists".to_string());
    }
    if delta == 0 || delta < i32::from(i16::MIN) || delta > i32::from(i16::MAX) {
        return Err("scroll delta must fit a non-zero signed 16-bit value".to_string());
    }

    unsafe {
        SetForegroundWindow(target);
    }
    let wheel_delta = (delta as i16 as u16 as usize) << 16;
    if unsafe { PostMessageW(target, WM_MOUSEWHEEL, wheel_delta, 0) } == 0 {
        return Err("failed to send wheel input to the target window".to_string());
    }
    Ok(())
}
