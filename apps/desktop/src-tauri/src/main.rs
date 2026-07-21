#[tauri::command]
fn platform_name() -> &'static str {
    std::env::consts::OS
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            platform_name,
            screenshot_tool::capture::capture_desktop,
            screenshot_tool::output::copy_png,
            screenshot_tool::output::save_png,
            screenshot_tool::output::close_overlay
        ])
        .run(tauri::generate_context!())
        .expect("failed to run screenshot tool");
}
