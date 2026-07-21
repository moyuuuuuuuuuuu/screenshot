use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

use crate::app_state::request_capture;

pub fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let capture = MenuItem::with_id(app, "capture", "Capture", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&capture, &settings, &quit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".to_string()))?;

    let tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Screenshot Tool")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "capture" => request_capture(app),
            "settings" => {
                if let Some(window) = app.get_webview_window("overlay") {
                    let _ = window.emit("settings-requested", ());
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                request_capture(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(tray);
    Ok(())
}
