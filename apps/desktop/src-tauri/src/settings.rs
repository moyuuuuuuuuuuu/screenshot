use std::{
    fmt,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

pub const DEFAULT_SHORTCUT: &str = "Alt+Shift+A";
pub const SETTINGS_LOAD_ERROR_MESSAGE: &str = "Stored settings could not be sanitized safely.";

#[derive(Debug)]
pub struct SettingsLoadError;

impl fmt::Display for SettingsLoadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(SETTINGS_LOAD_ERROR_MESSAGE)
    }
}

impl std::error::Error for SettingsLoadError {}

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

    fn update(
        &self,
        mutation: impl FnOnce(&AppSettings) -> Result<AppSettings, String>,
    ) -> Result<AppSettings, String> {
        let mut settings = self.0.lock().map_err(|_| "settings lock poisoned")?;
        let next = mutation(&settings)?;
        *settings = next.clone();
        Ok(next)
    }
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("settings.json"))
        .map_err(|error| error.to_string())
}

pub fn read_settings(app: &AppHandle) -> Result<AppSettings, SettingsLoadError> {
    let path = settings_path(app).map_err(|_| SettingsLoadError)?;
    read_settings_from_path(&path)
}

trait SettingsStorage {
    fn exists(&self) -> bool;
    fn read(&self) -> Result<String, String>;
    fn write(&self, settings: &AppSettings) -> Result<(), String>;
}

struct FileSettingsStorage<'a>(&'a Path);

impl SettingsStorage for FileSettingsStorage<'_> {
    fn exists(&self) -> bool {
        self.0.exists()
    }

    fn read(&self) -> Result<String, String> {
        fs::read_to_string(self.0).map_err(|error| error.to_string())
    }

    fn write(&self, settings: &AppSettings) -> Result<(), String> {
        persist_settings_to_path(self.0, settings)
    }
}

fn read_settings_from_path(path: &Path) -> Result<AppSettings, SettingsLoadError> {
    load_settings_from_storage(&FileSettingsStorage(path))
}

fn load_settings_from_storage(
    storage: &impl SettingsStorage,
) -> Result<AppSettings, SettingsLoadError> {
    if !storage.exists() {
        return Ok(AppSettings::default());
    }
    let json = storage.read().map_err(|_| SettingsLoadError)?;
    let stored: serde_json::Value = serde_json::from_str(&json).map_err(|_| SettingsLoadError)?;
    let settings: AppSettings =
        serde_json::from_value(stored.clone()).map_err(|_| SettingsLoadError)?;
    let sanitized = serde_json::to_value(&settings).map_err(|_| SettingsLoadError)?;
    if stored != sanitized {
        storage.write(&settings).map_err(|_| SettingsLoadError)?;
    }
    Ok(settings)
}

fn persist_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    persist_settings_to_path(&path, settings)
}

fn persist_settings_to_path(path: &Path, settings: &AppSettings) -> Result<(), String> {
    persist_settings_to_path_with_replacer(path, settings, replace_settings_file)
}

fn persist_settings_to_path_with_replacer(
    path: &Path,
    settings: &AppSettings,
    replacer: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid settings path")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let json = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".settings-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(json.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        replacer(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_settings_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temporary, destination).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn replace_settings_file(temporary: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let temporary_wide = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let moved = unsafe {
        MoveFileExW(
            temporary_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
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
    let mut registrar = crate::hotkey::TauriShortcutRegistrar(&app);
    update_shortcut_transaction(&state, &mut registrar, candidate, |settings| {
        persist_settings(&app, settings)
    })
}

fn update_shortcut_transaction(
    state: &SettingsState,
    registrar: &mut impl crate::hotkey::ShortcutRegistrar,
    candidate: &str,
    persist: impl FnOnce(&AppSettings) -> Result<(), String>,
) -> Result<AppSettings, String> {
    state.update(|settings| {
        let current = settings.shortcut.clone();
        let mut next = settings.clone();
        crate::hotkey::replace_shortcut(registrar, &current, candidate)?;
        next.shortcut = candidate.to_string();
        if let Err(persist_error) = persist(&next) {
            if crate::hotkey::replace_shortcut(registrar, candidate, &current).is_err() {
                return Err("快捷键保存失败，且无法恢复原快捷键，请重启应用后重试".to_string());
            }
            return Err(persist_error);
        }
        Ok(next)
    })
}

#[tauri::command]
pub fn update_cloud_privacy_acknowledgement(
    app: AppHandle,
    state: State<'_, SettingsState>,
    acknowledged: bool,
) -> Result<AppSettings, String> {
    state.update(|settings| {
        let mut next = settings.clone();
        next.cloud_privacy_acknowledged = acknowledged;
        persist_settings(&app, &next)?;
        Ok(next)
    })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::collections::HashSet;
    use std::fs;
    use std::sync::{Arc, Barrier};
    use std::thread;

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

    struct RewriteFailingStorage {
        rewrite_attempted: Cell<bool>,
    }

    impl super::SettingsStorage for RewriteFailingStorage {
        fn exists(&self) -> bool {
            true
        }

        fn read(&self) -> Result<String, String> {
            Ok(r#"{
  "shortcut": "Ctrl+Alt+X",
  "coze": {
    "token": "legacy-sensitive-token",
    "workflowId": "legacy-sensitive-workflow"
  }
}"#
            .to_string())
        }

        fn write(&self, _settings: &super::AppSettings) -> Result<(), String> {
            self.rewrite_attempted.set(true);
            Err("write failed for legacy-sensitive-token / legacy-sensitive-workflow".to_string())
        }
    }

    #[test]
    fn rewrite_failure_is_fail_closed_with_a_fixed_safe_startup_error() {
        let storage = RewriteFailingStorage {
            rewrite_attempted: Cell::new(false),
        };

        let error = super::load_settings_from_storage(&storage)
            .expect_err("startup must stop when legacy credentials cannot be removed");
        let message = error.to_string();

        assert!(storage.rewrite_attempted.get());
        assert_eq!(message, super::SETTINGS_LOAD_ERROR_MESSAGE);
        assert!(!message.contains("legacy-sensitive-token"));
        assert!(!message.contains("legacy-sensitive-workflow"));
    }

    #[test]
    fn concurrent_field_updates_merge_instead_of_overwriting_each_other() {
        let state = Arc::new(super::SettingsState::default());
        let start = Arc::new(Barrier::new(3));

        let shortcut_state = Arc::clone(&state);
        let shortcut_start = Arc::clone(&start);
        let shortcut = thread::spawn(move || {
            shortcut_start.wait();
            shortcut_state.update(|current| {
                let mut next = current.clone();
                next.shortcut = "Ctrl+Alt+X".to_string();
                Ok(next)
            })
        });

        let privacy_state = Arc::clone(&state);
        let privacy_start = Arc::clone(&start);
        let privacy = thread::spawn(move || {
            privacy_start.wait();
            privacy_state.update(|current| {
                let mut next = current.clone();
                next.cloud_privacy_acknowledged = true;
                Ok(next)
            })
        });

        start.wait();
        shortcut
            .join()
            .expect("shortcut thread")
            .expect("shortcut update");
        privacy
            .join()
            .expect("privacy thread")
            .expect("privacy update");

        let final_settings = state.snapshot().expect("settings snapshot");
        assert_eq!(final_settings.shortcut, "Ctrl+Alt+X");
        assert!(final_settings.cloud_privacy_acknowledged);
    }

    struct FakeShortcutRegistrar {
        registered: HashSet<String>,
    }

    impl crate::hotkey::ShortcutRegistrar for FakeShortcutRegistrar {
        fn register(&mut self, shortcut: &str) -> Result<(), String> {
            self.registered.insert(shortcut.to_string());
            Ok(())
        }

        fn unregister(&mut self, shortcut: &str) -> Result<(), String> {
            self.registered.remove(shortcut);
            Ok(())
        }
    }

    #[test]
    fn shortcut_persistence_failure_restores_the_registered_and_stored_shortcut() {
        let state = super::SettingsState::default();
        let mut registrar = FakeShortcutRegistrar {
            registered: HashSet::from(["Alt+Shift+A".to_string()]),
        };

        let result =
            super::update_shortcut_transaction(&state, &mut registrar, "Ctrl+Alt+X", |_| {
                Err("disk write failed".to_string())
            });

        assert!(result.is_err());
        assert_eq!(
            state.snapshot().expect("settings snapshot").shortcut,
            "Alt+Shift+A"
        );
        assert_eq!(
            registrar.registered,
            HashSet::from(["Alt+Shift+A".to_string()])
        );
    }

    #[test]
    fn failed_atomic_replacement_leaves_the_previous_settings_file_intact() {
        let path = temporary_settings_path("atomic-replace-failure");
        fs::write(
            &path,
            r#"{"shortcut":"Alt+Shift+A","cloudPrivacyAcknowledged":true}"#,
        )
        .expect("existing settings");
        let next = super::AppSettings {
            shortcut: "Ctrl+Alt+X".to_string(),
            cloud_privacy_acknowledged: true,
        };

        let result = super::persist_settings_to_path_with_replacer(
            &path,
            &next,
            |temporary, destination| {
                let staged = fs::read_to_string(temporary).expect("staged settings");
                assert!(staged.contains("Ctrl+Alt+X"));
                assert_eq!(destination, path);
                Err("atomic replacement failed".to_string())
            },
        );

        assert!(result.is_err());
        let preserved = fs::read_to_string(&path).expect("preserved settings");
        assert!(preserved.contains("Alt+Shift+A"));
        assert!(!preserved.contains("Ctrl+Alt+X"));
        let _ = fs::remove_file(path);
    }

    fn temporary_settings_path(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "screenshot-tool-d4-{label}-{}.json",
            uuid::Uuid::new_v4()
        ))
    }
}
