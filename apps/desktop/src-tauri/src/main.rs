use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[tauri::command]
fn platform_name() -> &'static str {
    std::env::consts::OS
}

fn main() {
    tauri::Builder::default()
        .manage(screenshot_tool::app_state::AppState::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        screenshot_tool::app_state::request_capture(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            screenshot_tool::tray::create_tray(app)?;
            if let Err(error) = app.global_shortcut().register("Alt+Shift+A") {
                rfd::MessageDialog::new()
                    .set_title("Screenshot shortcut unavailable")
                    .set_description(format!(
                        "Alt+Shift+A could not be registered. You can still capture from the tray menu.\n\n{error}"
                    ))
                    .set_level(rfd::MessageLevel::Error)
                    .show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platform_name,
            screenshot_tool::capture::capture_desktop,
            screenshot_tool::output::copy_png,
            screenshot_tool::output::save_png,
            screenshot_tool::output::close_overlay,
            screenshot_tool::scroll::track_scroll_target,
            screenshot_tool::scroll::send_scroll
        ])
        .run(tauri::generate_context!())
        .expect("failed to run screenshot tool");
}
