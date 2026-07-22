use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

#[tauri::command]
fn platform_name() -> &'static str {
    std::env::consts::OS
}

fn main() {
    tauri::Builder::default()
        .manage(screenshot_tool::app_state::AppState::default())
        .manage(screenshot_tool::long_capture::LongCaptureRuntime::default())
        .manage(screenshot_tool::settings::SettingsState::default())
        .manage(screenshot_tool::pin_window::PinWindowState::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if shortcut.matches(Modifiers::empty(), Code::Escape) {
                            app.state::<screenshot_tool::long_capture::LongCaptureRuntime>()
                                .request_stop();
                        } else {
                            screenshot_tool::app_state::request_capture(app);
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            screenshot_tool::tray::create_tray(app)?;
            let settings = screenshot_tool::settings::read_settings(app.handle())
                .unwrap_or_default();
            let shortcut = settings.shortcut.clone();
            let _ = app
                .state::<screenshot_tool::settings::SettingsState>()
                .replace(settings);
            let mut registrar = screenshot_tool::hotkey::TauriShortcutRegistrar(app.handle());
            if let Err(error) = screenshot_tool::hotkey::ShortcutRegistrar::register(
                &mut registrar,
                &shortcut,
            ) {
                rfd::MessageDialog::new()
                    .set_title("Screenshot shortcut unavailable")
                    .set_description(format!(
                        "{shortcut} could not be registered. You can still capture from the tray menu.\n\n{error}"
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
            screenshot_tool::long_capture::start_long_capture,
            screenshot_tool::long_capture::stop_long_capture,
            screenshot_tool::long_capture::edit_long_capture,
            screenshot_tool::long_capture::save_long_capture,
            screenshot_tool::long_capture::finish_long_capture,
            screenshot_tool::long_capture::cancel_long_capture,
            screenshot_tool::long_capture::long_capture_progress,
            screenshot_tool::settings::load_settings,
            screenshot_tool::settings::update_shortcut,
            screenshot_tool::settings::update_coze_config,
            screenshot_tool::pin_window::pin_png,
            screenshot_tool::pin_window::get_pinned_png,
            screenshot_tool::pin_window::close_pin_window,
            screenshot_tool::pin_window::start_window_dragging,
            screenshot_tool::pin_window::share_png
        ])
        .run(tauri::generate_context!())
        .expect("failed to run screenshot tool");
}
