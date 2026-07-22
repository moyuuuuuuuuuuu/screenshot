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
struct PreviewWindowPolicy {
    focused: bool,
    focusable: bool,
}

fn preview_window_policy() -> PreviewWindowPolicy {
    PreviewWindowPolicy {
        focused: false,
        focusable: false,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MaskEdge {
    Top,
    Right,
    Bottom,
    Left,
}

impl MaskEdge {
    fn as_str(self) -> &'static str {
        match self {
            Self::Top => "top",
            Self::Right => "right",
            Self::Bottom => "bottom",
            Self::Left => "left",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MaskLayout {
    pub label: &'static str,
    pub rect: ScreenRect,
    pub edge: MaskEdge,
    pub edge_start: i32,
    pub edge_length: i32,
}

pub(crate) fn mask_window_layouts(
    selection: ScreenRect,
    monitor: ScreenRect,
) -> Vec<MaskLayout> {
    let monitor_right = monitor.x + monitor.width;
    let monitor_bottom = monitor.y + monitor.height;
    let selection_right = selection.x + selection.width;
    let selection_bottom = selection.y + selection.height;
    let horizontal_edge_start = selection.x - monitor.x;
    [
        MaskLayout {
            label: "scroll-mask-top",
            rect: ScreenRect {
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: selection.y - monitor.y,
            },
            edge: MaskEdge::Bottom,
            edge_start: horizontal_edge_start,
            edge_length: selection.width,
        },
        MaskLayout {
            label: "scroll-mask-right",
            rect: ScreenRect {
                x: selection_right,
                y: selection.y,
                width: monitor_right - selection_right,
                height: selection.height,
            },
            edge: MaskEdge::Left,
            edge_start: 0,
            edge_length: selection.height,
        },
        MaskLayout {
            label: "scroll-mask-bottom",
            rect: ScreenRect {
                x: monitor.x,
                y: selection_bottom,
                width: monitor.width,
                height: monitor_bottom - selection_bottom,
            },
            edge: MaskEdge::Top,
            edge_start: horizontal_edge_start,
            edge_length: selection.width,
        },
        MaskLayout {
            label: "scroll-mask-left",
            rect: ScreenRect {
                x: monitor.x,
                y: selection.y,
                width: selection.x - monitor.x,
                height: selection.height,
            },
            edge: MaskEdge::Right,
            edge_start: 0,
            edge_length: selection.height,
        },
    ]
    .into_iter()
    .filter(|layout| layout.rect.width > 0 && layout.rect.height > 0)
    .collect()
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
    let policy = preview_window_policy();
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
    .focused(policy.focused)
    .focusable(policy.focusable)
    .build()
    .map_err(|error| format!("failed to open scroll preview: {error}"))
}

pub(crate) fn open_capture_mask_windows(
    app: &tauri::AppHandle,
    selection: ScreenRect,
    monitor: ScreenRect,
) -> Result<Vec<tauri::WebviewWindow>, String> {
    let mut windows = Vec::with_capacity(4);
    for layout in mask_window_layouts(selection, monitor) {
        if let Some(existing) = tauri::Manager::get_webview_window(app, layout.label) {
            let _ = existing.close();
        }
        let result = (|| {
            let window = WebviewWindowBuilder::new(
                app,
                layout.label,
                WebviewUrl::App(
                    format!(
                        "index.html?window=scroll-mask&edge={}&edgeStart={}&edgeLength={}",
                        layout.edge.as_str(),
                        layout.edge_start,
                        layout.edge_length,
                    )
                    .into(),
                ),
            )
            .title("")
            .inner_size(layout.rect.width as f64, layout.rect.height as f64)
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
                    layout.rect.width as u32,
                    layout.rect.height as u32,
                ))
                .map_err(|error| format!("failed to size {}: {error}", layout.label))?;
            window
                .set_ignore_cursor_events(false)
                .map_err(|error| format!("failed to block input for {}: {error}", layout.label))?;
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
        mask_window_layouts, preview_window_layout, preview_window_policy, PreviewLayout,
        PreviewSide, ScreenRect,
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

    fn area(rect: ScreenRect) -> i64 {
        i64::from(rect.width) * i64::from(rect.height)
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
    fn mask_windows_cover_monitor_without_entering_selection() {
        let monitor = ScreenRect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let selection = ScreenRect {
            x: 500,
            y: 300,
            width: 1000,
            height: 700,
        };
        let masks = mask_window_layouts(selection, monitor);

        assert_eq!(
            masks.iter().map(|mask| mask.rect).collect::<Vec<_>>(),
            vec![
                ScreenRect {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 300,
                },
                ScreenRect {
                    x: 1500,
                    y: 300,
                    width: 420,
                    height: 700,
                },
                ScreenRect {
                    x: 0,
                    y: 1000,
                    width: 1920,
                    height: 80,
                },
                ScreenRect {
                    x: 0,
                    y: 300,
                    width: 500,
                    height: 700,
                },
            ]
        );
        assert!(masks
            .iter()
            .all(|mask| !intersects(selection, mask.rect)));
        assert_eq!(
            masks.iter().map(|mask| area(mask.rect)).sum::<i64>(),
            area(monitor) - area(selection)
        );
    }

    #[test]
    fn mask_windows_omit_zero_sized_edges() {
        let monitor = ScreenRect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let selection = ScreenRect {
            x: -1920,
            y: 0,
            width: 1200,
            height: 1080,
        };

        let masks = mask_window_layouts(selection, monitor);

        assert_eq!(masks.len(), 1);
        assert_eq!(masks[0].label, "scroll-mask-right");
        assert_eq!(masks[0].rect.width, 720);
        assert!(masks.iter().all(|mask| mask.rect.width > 0 && mask.rect.height > 0));
    }

    #[test]
    fn sidecar_does_not_take_focus_when_created() {
        let policy = preview_window_policy();

        assert!(!policy.focused);
        assert!(!policy.focusable);
    }
}
