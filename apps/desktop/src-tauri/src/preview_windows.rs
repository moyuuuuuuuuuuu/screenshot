use tauri::{WebviewUrl, WebviewWindowBuilder};

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
    pub actions_right: i32,
    pub actions_bottom: i32,
}

pub(crate) fn preview_window_layout(selection: ScreenRect, monitor: ScreenRect) -> PreviewLayout {
    const EXTRA: i32 = 172;
    const MARGIN: i32 = 8;
    let monitor_right = monitor.x + monitor.width;
    let use_right = selection.x + selection.width + EXTRA + MARGIN <= monitor_right;
    let side = if use_right {
        PreviewSide::Right
    } else {
        PreviewSide::Left
    };
    let desired_x = if use_right {
        selection.x
    } else {
        selection.x - EXTRA
    };
    let width = (selection.width + EXTRA)
        .min(monitor.width - MARGIN * 2)
        .max(240);
    let height = selection.height.min(monitor.height - MARGIN * 2).max(160);
    PreviewLayout {
        x: desired_x.clamp(monitor.x + MARGIN, monitor_right - width - MARGIN),
        y: selection.y.clamp(
            monitor.y + MARGIN,
            monitor.y + monitor.height - height - MARGIN,
        ),
        width,
        height,
        side,
        actions_right: 8,
        actions_bottom: 8,
    }
}

pub(crate) fn open_preview_window(
    app: &tauri::AppHandle,
    selection: ScreenRect,
    monitor: ScreenRect,
) -> Result<tauri::WebviewWindow, String> {
    if let Some(existing) = tauri::Manager::get_webview_window(app, "scroll-capture-preview") {
        let _ = existing.close();
    }
    let layout = preview_window_layout(selection, monitor);
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

#[cfg(test)]
mod tests {
    use super::{preview_window_layout, PreviewSide, ScreenRect};

    #[test]
    fn places_preview_and_navigator_on_the_right_when_space_is_available() {
        let layout = preview_window_layout(
            ScreenRect {
                x: 100,
                y: 80,
                width: 500,
                height: 600,
            },
            ScreenRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        );
        assert_eq!(layout.side, PreviewSide::Right);
        assert_eq!(layout.x, 100);
        assert!(layout.width > 500);
        assert_eq!(layout.actions_right, 8);
        assert_eq!(layout.actions_bottom, 8);
    }

    #[test]
    fn falls_back_left_and_clamps_top_near_monitor_edges() {
        let layout = preview_window_layout(
            ScreenRect {
                x: 1650,
                y: -20,
                width: 250,
                height: 500,
            },
            ScreenRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
        );
        assert_eq!(layout.side, PreviewSide::Left);
        assert_eq!(layout.y, 8);
        assert!(layout.x >= 0);
    }
}
