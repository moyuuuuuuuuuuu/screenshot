use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Default)]
pub struct PinWindowState {
    next_id: AtomicU64,
    images: Mutex<HashMap<String, Vec<u8>>>,
}

impl PinWindowState {
    fn insert(&self, bytes: Vec<u8>) -> Result<String, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let label = format!("pin-{id}");
        self.images
            .lock()
            .map_err(|_| "pin image lock poisoned".to_string())?
            .insert(label.clone(), bytes);
        Ok(label)
    }

    fn image(&self, label: &str) -> Result<Vec<u8>, String> {
        self.images
            .lock()
            .map_err(|_| "pin image lock poisoned".to_string())?
            .get(label)
            .cloned()
            .ok_or_else(|| "pinned image not found".to_string())
    }

    fn remove(&self, label: &str) -> Result<(), String> {
        self.images
            .lock()
            .map_err(|_| "pin image lock poisoned".to_string())?
            .remove(label);
        Ok(())
    }
}

fn validate_png(bytes: &[u8]) -> Result<(), String> {
    png::Decoder::new(std::io::Cursor::new(bytes))
        .read_info()
        .map(|_| ())
        .map_err(|error| format!("invalid PNG: {error}"))
}

#[tauri::command]
pub fn pin_png(
    app: tauri::AppHandle,
    state: State<'_, PinWindowState>,
    png_bytes: Vec<u8>,
    bounds: PinBounds,
) -> Result<String, String> {
    validate_png(&png_bytes)?;
    let label = state.insert(png_bytes)?;
    let width = bounds.width.clamp(80.0, 1200.0);
    let height = bounds.height.clamp(60.0, 1000.0);
    let build = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("index.html?window=pin&label={label}").into()),
    )
    .title("钉图")
    .inner_size(width, height)
    .position(bounds.x, bounds.y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .shadow(true)
    .build();
    if let Err(error) = build {
        let _ = state.remove(&label);
        return Err(format!("failed to open pin window: {error}"));
    }
    Ok(label)
}

#[tauri::command]
pub fn get_pinned_png(state: State<'_, PinWindowState>, label: String) -> Result<Vec<u8>, String> {
    state.image(&label)
}

#[tauri::command]
pub fn close_pin_window(
    app: tauri::AppHandle,
    state: State<'_, PinWindowState>,
    label: String,
) -> Result<(), String> {
    state.remove(&label)?;
    if let Some(window) = app.get_webview_window(&label) {
        window
            .close()
            .map_err(|error| format!("failed to close pin window: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn start_window_dragging(window: tauri::Window) -> Result<(), String> {
    window
        .start_dragging()
        .map_err(|error| format!("failed to drag pin window: {error}"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ShareOutcome {
    CopiedFallback,
}

#[tauri::command]
pub fn share_png(png_bytes: Vec<u8>) -> Result<ShareOutcome, String> {
    crate::output::copy_png(png_bytes)?;
    Ok(ShareOutcome::CopiedFallback)
}

#[cfg(test)]
mod tests {
    use super::PinWindowState;

    #[test]
    fn allocates_unique_labels_and_releases_image_bytes_on_close() {
        let state = PinWindowState::default();
        let first = state.insert(vec![1, 2, 3]).expect("first pin");
        let second = state.insert(vec![4, 5, 6]).expect("second pin");

        assert_ne!(first, second);
        assert_eq!(state.image(&first).expect("stored image"), vec![1, 2, 3]);
        state.remove(&first).expect("cleanup");
        assert!(state.image(&first).is_err());
        assert_eq!(
            state.image(&second).expect("other pin remains"),
            vec![4, 5, 6]
        );
    }
}
