use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::capture::{encode_monitor_frames, virtual_desktop_bounds, VirtualDesktopBounds};
use crate::platform::RawMonitorFrame;

fn frame(x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> RawMonitorFrame {
    RawMonitorFrame {
        x,
        y,
        width,
        height,
        scale_factor,
        rgba: vec![0; width as usize * height as usize * 4],
    }
}

#[test]
fn bounds_include_monitors_left_of_and_above_primary() {
    let frames = vec![
        frame(0, 0, 1920, 1080, 1.0),
        frame(-1280, 100, 1280, 1024, 1.0),
        frame(0, -900, 1600, 900, 1.0),
    ];

    assert_eq!(
        virtual_desktop_bounds(&frames),
        Some(VirtualDesktopBounds {
            x: -1280,
            y: -900,
            width: 3200,
            height: 2024,
        })
    );
}

#[test]
fn encoded_frames_preserve_each_monitor_scale_factor() {
    let encoded = encode_monitor_frames(vec![
        frame(0, 0, 1, 1, 1.0),
        frame(1920, 0, 1, 1, 1.5),
        frame(3200, 0, 1, 1, 2.0),
    ])
    .expect("frames should encode");

    assert_eq!(
        encoded
            .iter()
            .map(|monitor| monitor.scale_factor)
            .collect::<Vec<_>>(),
        vec![1.0, 1.5, 2.0]
    );
}

#[test]
fn monitor_pixels_are_encoded_as_png() {
    let encoded = encode_monitor_frames(vec![frame(-10, -20, 1, 1, 1.25)])
        .expect("frame should encode");
    let bytes = STANDARD
        .decode(&encoded[0].png_base64)
        .expect("base64 should decode");

    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(encoded[0].x, -10);
    assert_eq!(encoded[0].y, -20);
}

#[test]
fn invalid_pixel_buffer_is_rejected() {
    let mut invalid = frame(0, 0, 2, 2, 1.0);
    invalid.rgba.pop();

    assert_eq!(
        encode_monitor_frames(vec![invalid]).unwrap_err(),
        "captured monitor buffer has an invalid length"
    );
}
