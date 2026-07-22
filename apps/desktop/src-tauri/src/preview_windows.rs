use tauri::{PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PreviewSide {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PreviewLayout {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub side: PreviewSide,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BorderLayout {
    pub label: &'static str,
    pub rect: ScreenRect,
}

pub(crate) fn border_window_layouts(selection: ScreenRect) -> [BorderLayout; 4] {
    [
        BorderLayout {
            label: "scroll-border-top",
            rect: ScreenRect {
                x: selection.x,
                y: selection.y - 1,
                width: selection.width,
                height: 1,
            },
        },
        BorderLayout {
            label: "scroll-border-right",
            rect: ScreenRect {
                x: selection.x + selection.width,
                y: selection.y,
                width: 1,
                height: selection.height,
            },
        },
        BorderLayout {
            label: "scroll-border-bottom",
            rect: ScreenRect {
                x: selection.x,
                y: selection.y + selection.height,
                width: selection.width,
                height: 1,
            },
        },
        BorderLayout {
            label: "scroll-border-left",
            rect: ScreenRect {
                x: selection.x - 1,
                y: selection.y,
                width: 1,
                height: selection.height,
            },
        },
    ]
}

pub(crate) fn preview_window_layout(
    selection: ScreenRect,
    monitor: ScreenRect,
) -> Result<PreviewLayout, String> {
    const DESIRED_WIDTH: i32 = 172;
    const MIN_WIDTH: i32 = 120;
    const MARGIN: i32 = 8;
    let monitor_left = monitor.x + MARGIN;
    let monitor_right = monitor.x + monitor.width - MARGIN;
    let selection_left = selection.x;
    let selection_right = selection.x + selection.width;
    let left_space = (selection_left - monitor_left).max(0);
    let right_space = (monitor_right - selection_right).max(0);

    let side = if right_space >= DESIRED_WIDTH {
        PreviewSide::Right
    } else if left_space >= DESIRED_WIDTH {
        PreviewSide::Left
    } else if right_space >= left_space {
        PreviewSide::Right
    } else {
        PreviewSide::Left
    };
    let available = match side {
        PreviewSide::Left => left_space,
        PreviewSide::Right => right_space,
    };
    if available < MIN_WIDTH {
        return Err("not enough space outside the selection for long-capture controls".to_string());
    }
    let width = available.min(DESIRED_WIDTH);
    let x = match side {
        PreviewSide::Left => selection_left - width,
        PreviewSide::Right => selection_right,
    };
    let height = selection.height.min(monitor.height - MARGIN * 2).max(160);
    Ok(PreviewLayout {
        x,
        y: selection.y.clamp(
            monitor.y + MARGIN,
            monitor.y + monitor.height - height - MARGIN,
        ),
        width,
        height,
        side,
    })
}

pub(crate) fn open_preview_window(
    app: &tauri::AppHandle,
    selection: ScreenRect,
    monitor: ScreenRect,
) -> Result<tauri::WebviewWindow, String> {
    if let Some(existing) = tauri::Manager::get_webview_window(app, "scroll-capture-preview") {
        let _ = existing.close();
    }
    let layout = preview_window_layout(selection, monitor)?;
    let side = match layout.side {
        PreviewSide::Left => "left",
        PreviewSide::Right => "right",
    };
    WebviewWindowBuilder::new(
        app,
        "scroll-capture-preview",
        WebviewUrl::App(format!("index.html?window=scroll-capture-preview&side={side}").into()),
    )
    .title("长截图")
    .inner_size(layout.width as f64, layout.height as f64)
    .position(layout.x as f64, layout.y as f64)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .build()
    .map_err(|error| format!("failed to open scroll preview: {error}"))
}

pub(crate) fn open_capture_border_windows(
    app: &tauri::AppHandle,
    selection: ScreenRect,
) -> Result<Vec<tauri::WebviewWindow>, String> {
    let mut windows = Vec::with_capacity(4);
    for layout in border_window_layouts(selection) {
        if let Some(existing) = tauri::Manager::get_webview_window(app, layout.label) {
            let _ = existing.close();
        }
        let result = (|| {
            let window = WebviewWindowBuilder::new(
                app,
                layout.label,
                WebviewUrl::App("index.html?window=scroll-border".into()),
            )
            .title("")
            .inner_size(
                layout.rect.width.max(1) as f64,
                layout.rect.height.max(1) as f64,
            )
            .position(layout.rect.x as f64, layout.rect.y as f64)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .focused(false)
            .focusable(false)
            .build()
            .map_err(|error| format!("failed to open {}: {error}", layout.label))?;
            window
                .set_position(PhysicalPosition::new(layout.rect.x, layout.rect.y))
                .map_err(|error| format!("failed to position {}: {error}", layout.label))?;
            window
                .set_size(PhysicalSize::new(
                    layout.rect.width.max(1) as u32,
                    layout.rect.height.max(1) as u32,
                ))
                .map_err(|error| format!("failed to size {}: {error}", layout.label))?;
            window
                .set_ignore_cursor_events(true)
                .map_err(|error| format!("failed to pass through {}: {error}", layout.label))?;
            Ok(window)
        })();
        match result {
            Ok(window) => windows.push(window),
            Err(error) => {
                for window in windows {
                    let _ = window.close();
                }
                return Err(error);
            }
        }
    }
    Ok(windows)
}

#[cfg(test)]
mod tests {
    use super::{
        border_window_layouts, preview_window_layout, PreviewLayout, PreviewSide, ScreenRect,
    };

    fn intersects(a: ScreenRect, b: ScreenRect) -> bool {
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    }

    fn layout_rect(layout: PreviewLayout) -> ScreenRect {
        ScreenRect {
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
        }
    }

    #[test]
    fn places_a_172_pixel_sidecar_to_the_right_without_overlapping() {
        let selection = ScreenRect {
            x: 100,
            y: 80,
            width: 500,
            height: 600,
        };
        let layout = preview_window_layout(
            selection,
            ScreenRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        )
        .unwrap();
        assert_eq!(layout.side, PreviewSide::Right);
        assert_eq!(layout.x, 600);
        assert_eq!(layout.width, 172);
        assert!(!intersects(selection, layout_rect(layout)));
    }

    #[test]
    fn falls_back_to_the_left_without_overlapping() {
        let selection = ScreenRect {
            x: 1650,
            y: 80,
            width: 250,
            height: 500,
        };
        let layout = preview_window_layout(
            selection,
            ScreenRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        )
        .unwrap();
        assert_eq!(layout.side, PreviewSide::Left);
        assert_eq!(layout.x + layout.width, selection.x);
        assert!(!intersects(selection, layout_rect(layout)));
    }

    #[test]
    fn narrows_to_available_space_down_to_120_pixels() {
        let selection = ScreenRect {
            x: 140,
            y: 80,
            width: 1740,
            height: 500,
        };
        let layout = preview_window_layout(
            selection,
            ScreenRect {
                x: 0,
                y: 0,
                width: 2048,
                height: 1080,
            },
        )
        .unwrap();
        assert_eq!(layout.side, PreviewSide::Right);
        assert_eq!(layout.width, 160);
        assert!(!intersects(selection, layout_rect(layout)));
    }

    #[test]
    fn rejects_layout_when_both_sides_are_narrower_than_120_pixels() {
        let error = preview_window_layout(
            ScreenRect {
                x: 100,
                y: 80,
                width: 1720,
                height: 500,
            },
            ScreenRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        )
        .unwrap_err();
        assert_eq!(
            error,
            "not enough space outside the selection for long-capture controls"
        );
    }

    #[test]
    fn border_windows_surround_without_entering_selection() {
        let selection = ScreenRect {
            x: 100,
            y: 80,
            width: 500,
            height: 600,
        };
        let borders = border_window_layouts(selection);

        assert_eq!(
            borders[0].rect,
            ScreenRect {
                x: 100,
                y: 79,
                width: 500,
                height: 1,
            }
        );
        assert_eq!(
            borders[1].rect,
            ScreenRect {
                x: 600,
                y: 80,
                width: 1,
                height: 600,
            }
        );
        assert_eq!(
            borders[2].rect,
            ScreenRect {
                x: 100,
                y: 680,
                width: 500,
                height: 1,
            }
        );
        assert_eq!(
            borders[3].rect,
            ScreenRect {
                x: 99,
                y: 80,
                width: 1,
                height: 600,
            }
        );
        assert!(borders
            .iter()
            .all(|border| !intersects(selection, border.rect)));
    }
}
