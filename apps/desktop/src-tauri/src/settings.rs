use std::{fs, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

pub const DEFAULT_SHORTCUT: &str = "Alt+Shift+A";

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CozeConfig {
    pub token: String,
    pub workflow_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub shortcut: String,
    pub coze: CozeConfig,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_SHORTCUT.to_string(),
            coze: CozeConfig::default(),
        }
    }
}

#[derive(Default)]
pub struct SettingsState(Mutex<AppSettings>);

impl SettingsState {
    pub fn replace(&self, settings: AppSettings) -> Result<(), String> {
        *self.0.lock().map_err(|_| "settings lock poisoned")? = settings;
        Ok(())
    }

    pub fn snapshot(&self) -> Result<AppSettings, String> {
        self.0
            .lock()
            .map(|settings| settings.clone())
            .map_err(|_| "settings lock poisoned".to_string())
    }
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("settings.json"))
        .map_err(|error| error.to_string())
}

pub fn read_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let json = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&json).map_err(|error| error.to_string())
}

fn persist_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let parent = path.parent().ok_or("invalid settings path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let json = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn load_settings(state: State<'_, SettingsState>) -> Result<AppSettings, String> {
    state.snapshot()
}

#[tauri::command]
pub fn update_shortcut(
    app: AppHandle,
    state: State<'_, SettingsState>,
    shortcut: String,
) -> Result<AppSettings, String> {
    let candidate = shortcut.trim();
    if candidate.is_empty() || !candidate.contains('+') {
        return Err("请录制包含修饰键的快捷键".to_string());
    }
    let mut settings = state.snapshot()?;
    let mut registrar = crate::hotkey::TauriShortcutRegistrar(&app);
    crate::hotkey::replace_shortcut(&mut registrar, &settings.shortcut, candidate)?;
    settings.shortcut = candidate.to_string();
    persist_settings(&app, &settings)?;
    state.replace(settings.clone())?;
    Ok(settings)
}

#[tauri::command]
pub fn update_coze_config(
    app: AppHandle,
    state: State<'_, SettingsState>,
    config: CozeConfig,
) -> Result<AppSettings, String> {
    let mut settings = state.snapshot()?;
    settings.coze = config;
    persist_settings(&app, &settings)?;
    state.replace(settings.clone())?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    #[test]
    fn defaults_to_the_approved_shortcut_without_cloud_credentials() {
        let settings = super::AppSettings::default();

        assert_eq!(settings.shortcut, "Alt+Shift+A");
        assert!(settings.coze.token.is_empty());
        assert!(settings.coze.workflow_id.is_empty());
    }
}
