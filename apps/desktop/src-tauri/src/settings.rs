use std::{fs, path::Path, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

pub const DEFAULT_SHORTCUT: &str = "Alt+Shift+A";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_shortcut")]
    pub shortcut: String,
    #[serde(default)]
    pub cloud_privacy_acknowledged: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_SHORTCUT.to_string(),
            cloud_privacy_acknowledged: false,
        }
    }
}

fn default_shortcut() -> String {
    DEFAULT_SHORTCUT.to_string()
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
    read_settings_from_path(&path)
}

fn read_settings_from_path(path: &Path) -> Result<AppSettings, String> {
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let json = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let stored: serde_json::Value =
        serde_json::from_str(&json).map_err(|error| error.to_string())?;
    let settings: AppSettings =
        serde_json::from_value(stored.clone()).map_err(|error| error.to_string())?;
    let sanitized = serde_json::to_value(&settings).map_err(|error| error.to_string())?;
    if stored != sanitized {
        persist_settings_to_path(path, &settings)?;
    }
    Ok(settings)
}

fn persist_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    persist_settings_to_path(&path, settings)
}

fn persist_settings_to_path(path: &Path, settings: &AppSettings) -> Result<(), String> {
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
pub fn update_cloud_privacy_acknowledgement(
    app: AppHandle,
    state: State<'_, SettingsState>,
    acknowledged: bool,
) -> Result<AppSettings, String> {
    let mut settings = state.snapshot()?;
    settings.cloud_privacy_acknowledged = acknowledged;
    persist_settings(&app, &settings)?;
    state.replace(settings.clone())?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use std::fs;

    #[test]
    fn defaults_to_the_approved_shortcut_without_cloud_acknowledgement() {
        let settings = super::AppSettings::default();

        assert_eq!(settings.shortcut, "Alt+Shift+A");
        assert!(!settings.cloud_privacy_acknowledged);
    }

    #[test]
    fn sanitizes_and_rewrites_legacy_coze_settings_without_losing_the_shortcut() {
        let path = temporary_settings_path("legacy");
        fs::write(
            &path,
            r#"{
  "shortcut": "Ctrl+Alt+X",
  "coze": {
    "token": "legacy-sensitive-token",
    "workflowId": "legacy-sensitive-workflow"
  }
}"#,
        )
        .expect("legacy settings");

        let settings = super::read_settings_from_path(&path).expect("sanitized settings");
        let rewritten = fs::read_to_string(&path).expect("rewritten settings");
        let rewritten_json: serde_json::Value =
            serde_json::from_str(&rewritten).expect("valid rewritten JSON");

        assert_eq!(settings.shortcut, "Ctrl+Alt+X");
        assert!(!settings.cloud_privacy_acknowledged);
        assert_eq!(
            rewritten_json,
            serde_json::json!({
                "shortcut": "Ctrl+Alt+X",
                "cloudPrivacyAcknowledged": false,
            })
        );
        assert!(!rewritten.contains("legacy-sensitive-token"));
        assert!(!rewritten.contains("legacy-sensitive-workflow"));
        assert!(!rewritten.contains("coze"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn defaults_a_missing_acknowledgement_and_persists_updates() {
        let path = temporary_settings_path("privacy");
        fs::write(&path, r#"{"shortcut":"Alt+Shift+A"}"#).expect("settings");

        let mut settings = super::read_settings_from_path(&path).expect("defaulted settings");
        assert!(!settings.cloud_privacy_acknowledged);
        settings.cloud_privacy_acknowledged = true;
        super::persist_settings_to_path(&path, &settings).expect("persisted acknowledgement");

        let reloaded = super::read_settings_from_path(&path).expect("reloaded settings");
        assert!(reloaded.cloud_privacy_acknowledged);
        let _ = fs::remove_file(path);
    }

    fn temporary_settings_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "screenshot-tool-d4-{label}-{}.json",
            uuid::Uuid::new_v4()
        ))
    }
}
