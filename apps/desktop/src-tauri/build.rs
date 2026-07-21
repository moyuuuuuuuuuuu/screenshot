fn main() {
    let host = std::env::var("HOST").unwrap_or_default();
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("windows") && !host.contains("windows") {
        return;
    }
    tauri_build::build()
}
