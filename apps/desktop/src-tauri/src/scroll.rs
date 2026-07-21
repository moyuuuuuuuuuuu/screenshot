use serde::Serialize;

use crate::platform;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollTarget {
    pub id: u64,
}

#[tauri::command]
pub fn track_scroll_target(x: i32, y: i32) -> Result<ScrollTarget, String> {
    Ok(ScrollTarget {
        id: platform::track_scroll_target(x, y)?,
    })
}

#[tauri::command]
pub fn send_scroll(target_id: u64, delta: i32) -> Result<(), String> {
    platform::send_scroll(target_id, delta)
}
