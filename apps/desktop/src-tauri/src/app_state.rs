use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::capture;

#[derive(Default)]
pub struct AppState {
    capture_in_progress: AtomicBool,
    session_id: AtomicU64,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureSessionPayload {
    session_id: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureReadyPayload {
    session_id: u64,
    frames: Vec<capture::MonitorFrame>,
}

pub fn emit_capture_session_reset(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let session_id = app.state::<AppState>().current_session_id();
    let _ = window.emit(
        "capture-session-reset",
        CaptureSessionPayload { session_id },
    );
}

pub fn request_capture(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let long_capture_active = app
        .state::<crate::long_capture::LongCaptureRuntime>()
        .is_active();
    let Some(session_id) = state.begin_capture_if_long_capture_idle(long_capture_active) else {
        return;
    };

    let Some(window) = app.get_webview_window("overlay") else {
        state.finish_capture();
        return;
    };
    let _ = crate::platform::restore_window_capture(&window);
    let _ = window.emit("capture-started", CaptureSessionPayload { session_id });
    if let Err(error) = window.hide() {
        state.finish_capture();
        let _ = window.emit("capture-error", format!("failed to hide overlay: {error}"));
        return;
    }

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        std::thread::sleep(Duration::from_millis(250));
        let result = capture::capture_desktop().await;
        let window = app_handle.get_webview_window("overlay");

        match (result, window) {
            (Ok(frames), Some(window)) => {
                let _ = window.emit("capture-ready", CaptureReadyPayload { session_id, frames });
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
    pub fn begin_capture(&self) -> Option<u64> {
        self.capture_in_progress
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
            .then(|| self.session_id.fetch_add(1, Ordering::AcqRel) + 1)
    }

    pub fn begin_capture_if_long_capture_idle(&self, long_capture_active: bool) -> Option<u64> {
        (!long_capture_active)
            .then(|| self.begin_capture())
            .flatten()
    }

    pub fn current_session_id(&self) -> u64 {
        self.session_id.load(Ordering::Acquire)
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

        assert_eq!(state.begin_capture(), Some(1));
        assert!(state.is_capturing());
        assert_eq!(state.begin_capture(), None);

        state.finish_capture();
        assert!(!state.is_capturing());
        assert_eq!(state.begin_capture(), Some(2));
    }

    #[test]
    fn rejects_capture_while_long_capture_is_active() {
        let state = AppState::default();

        assert_eq!(state.begin_capture_if_long_capture_idle(true), None);
        assert!(!state.is_capturing());
        assert_eq!(state.begin_capture_if_long_capture_idle(false), Some(1));
    }

    #[test]
    fn every_started_capture_gets_a_new_session_id() {
        let state = AppState::default();

        assert_eq!(state.begin_capture(), Some(1));
        state.finish_capture();
        assert_eq!(state.begin_capture(), Some(2));
        assert_eq!(state.current_session_id(), 2);
    }
}
