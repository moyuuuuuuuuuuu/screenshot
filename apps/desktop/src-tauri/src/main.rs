#[tauri::command]
fn platform_name() -> &'static str {
    "windows"
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![platform_name])
        .run(tauri::generate_context!())
        .expect("failed to run screenshot tool");
}
