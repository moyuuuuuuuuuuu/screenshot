use std::{ffi::c_void, mem::size_of, ptr};

use windows_sys::Win32::{
    Foundation::{BOOL, LPARAM, RECT},
    Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
        EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject,
        BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, HMONITOR,
        MONITORINFO, SRCCOPY,
    },
    UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI},
};

use super::RawMonitorFrame;

mod capture_exclusion;
mod target;
pub use capture_exclusion::exclude_window_from_capture;
pub use target::{locate_capture_target, validate_capture_target};

#[derive(Clone, Copy)]
struct MonitorDescriptor {
    rect: RECT,
    scale_factor: f64,
}

unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _monitor_dc: HDC,
    _monitor_rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let monitors = &mut *(data as *mut Vec<MonitorDescriptor>);
    let mut info: MONITORINFO = std::mem::zeroed();
    info.cbSize = size_of::<MONITORINFO>() as u32;
    if GetMonitorInfoW(monitor, &mut info) == 0 {
        return 1;
    }

    let mut dpi_x = 96_u32;
    let mut dpi_y = 96_u32;
    if GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) < 0 {
        dpi_x = 96;
    }
    monitors.push(MonitorDescriptor {
        rect: info.rcMonitor,
        scale_factor: f64::from(dpi_x) / 96.0,
    });
    1
}

fn enumerate_monitors() -> Result<Vec<MonitorDescriptor>, String> {
    let mut monitors = Vec::new();
    let result = unsafe {
        EnumDisplayMonitors(
            ptr::null_mut(),
            ptr::null(),
            Some(collect_monitor),
            &mut monitors as *mut Vec<MonitorDescriptor> as LPARAM,
        )
    };
    if result == 0 {
        return Err("EnumDisplayMonitors failed".to_string());
    }
    if monitors.is_empty() {
        return Err("Windows did not report any display monitors".to_string());
    }
    Ok(monitors)
}

struct CaptureResources {
    screen_dc: HDC,
    memory_dc: HDC,
    bitmap: HBITMAP,
    previous_object: HGDIOBJ,
}

impl Drop for CaptureResources {
    fn drop(&mut self) {
        unsafe {
            if !self.previous_object.is_null() {
                SelectObject(self.memory_dc, self.previous_object);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.memory_dc.is_null() {
                DeleteDC(self.memory_dc);
            }
            if !self.screen_dc.is_null() {
                ReleaseDC(ptr::null_mut(), self.screen_dc);
            }
        }
    }
}

fn capture_monitor(monitor: MonitorDescriptor) -> Result<RawMonitorFrame, String> {
    let width_i32 = monitor.rect.right - monitor.rect.left;
    let height_i32 = monitor.rect.bottom - monitor.rect.top;
    let width = u32::try_from(width_i32).map_err(|_| "monitor width is invalid".to_string())?;
    let height = u32::try_from(height_i32).map_err(|_| "monitor height is invalid".to_string())?;
    let buffer_len = usize::try_from(width)
        .ok()
        .zip(usize::try_from(height).ok())
        .and_then(|(width, height)| width.checked_mul(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "monitor dimensions are too large".to_string())?;

    let screen_dc = unsafe { GetDC(ptr::null_mut()) };
    if screen_dc.is_null() {
        return Err("GetDC failed".to_string());
    }
    let memory_dc = unsafe { CreateCompatibleDC(screen_dc) };
    if memory_dc.is_null() {
        unsafe { ReleaseDC(ptr::null_mut(), screen_dc) };
        return Err("CreateCompatibleDC failed".to_string());
    }
    let bitmap = unsafe { CreateCompatibleBitmap(screen_dc, width_i32, height_i32) };
    if bitmap.is_null() {
        unsafe {
            DeleteDC(memory_dc);
            ReleaseDC(ptr::null_mut(), screen_dc);
        }
        return Err("CreateCompatibleBitmap failed".to_string());
    }
    let previous_object = unsafe { SelectObject(memory_dc, bitmap) };
    let resources = CaptureResources {
        screen_dc,
        memory_dc,
        bitmap,
        previous_object,
    };

    let copied = unsafe {
        BitBlt(
            resources.memory_dc,
            0,
            0,
            width_i32,
            height_i32,
            resources.screen_dc,
            monitor.rect.left,
            monitor.rect.top,
            SRCCOPY | CAPTUREBLT,
        )
    };
    if copied == 0 {
        return Err("BitBlt failed while capturing a monitor".to_string());
    }

    let mut bitmap_info: BITMAPINFO = unsafe { std::mem::zeroed() };
    bitmap_info.bmiHeader = BITMAPINFOHEADER {
        biSize: size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width_i32,
        biHeight: -height_i32,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: 0,
        ..unsafe { std::mem::zeroed() }
    };
    let mut bgra = vec![0_u8; buffer_len];
    let scan_lines = unsafe {
        GetDIBits(
            resources.memory_dc,
            resources.bitmap,
            0,
            height,
            bgra.as_mut_ptr().cast::<c_void>(),
            &mut bitmap_info,
            DIB_RGB_COLORS,
        )
    };
    if scan_lines != height_i32 {
        return Err("GetDIBits returned an incomplete monitor frame".to_string());
    }

    for pixel in bgra.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }

    Ok(RawMonitorFrame {
        x: monitor.rect.left,
        y: monitor.rect.top,
        width,
        height,
        scale_factor: monitor.scale_factor,
        rgba: bgra,
    })
}

pub fn capture_monitors() -> Result<Vec<RawMonitorFrame>, String> {
    enumerate_monitors()?
        .into_iter()
        .map(capture_monitor)
        .collect()
}
