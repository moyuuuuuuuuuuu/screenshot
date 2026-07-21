use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{Emitter, Manager};

use crate::capture;

#[derive(Default)]
pub struct AppState {
    capture_in_progress: AtomicBool,
}

pub fn request_capture(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if !state.begin_capture() {
        return;
    }

    let Some(window) = app.get_webview_window("overlay") else {
        state.finish_capture();
        return;
    };
    if let Err(error) = window.hide() {
        state.finish_capture();
        let _ = window.emit("capture-error", format!("failed to hide overlay: {error}"));
        return;
    }

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        std::thread::sleep(Duration::from_millis(80));
        let result = capture::capture_desktop().await;
        let window = app_handle.get_webview_window("overlay");

        match (result, window) {
            (Ok(frames), Some(window)) => {
                let _ = window.emit("capture-ready", frames);
                let _ = window.show();
                let _ = window.set_focus();
            }
            (Err(error), Some(window)) => {
                let _ = window.emit("capture-error", error);
                let _ = window.show();
                let _ = window.set_focus();
            }
            (_, None) => {}
        }

        app_handle.state::<AppState>().finish_capture();
    });
}

impl AppState {
    pub fn begin_capture(&self) -> bool {
        self.capture_in_progress
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn finish_capture(&self) {
        self.capture_in_progress.store(false, Ordering::Release);
    }

    #[cfg(test)]
    fn is_capturing(&self) -> bool {
        self.capture_in_progress.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::AppState;

    #[test]
    fn rejects_a_second_capture_until_the_first_finishes() {
        let state = AppState::default();

        assert!(state.begin_capture());
        assert!(state.is_capturing());
        assert!(!state.begin_capture());

        state.finish_capture();
        assert!(!state.is_capturing());
        assert!(state.begin_capture());
    }
}
