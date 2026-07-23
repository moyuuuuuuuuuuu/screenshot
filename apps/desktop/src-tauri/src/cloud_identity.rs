use std::sync::Mutex;

use keyring::{Entry, Error as KeyringError};
use tauri::State;
use uuid::Uuid;

const CREDENTIAL_SERVICE: &str = "com.screenshot-tool.cloud-device";
const CREDENTIAL_USER: &str = "anonymous-device-id";

pub trait CredentialStore {
    fn read(&self) -> Result<Option<String>, String>;
    fn write(&self, value: &str) -> Result<(), String>;
}

pub fn get_or_create_device_id(
    store: &impl CredentialStore,
    generate: impl FnOnce() -> String,
) -> Result<String, String> {
    if let Some(existing) = store.read()? {
        if is_lowercase_uuid_v4(&existing) {
            return Ok(existing);
        }
    }

    let generated = generate();
    if !is_lowercase_uuid_v4(&generated) {
        return Err("device ID generator returned an invalid UUID".to_string());
    }
    store.write(&generated)?;
    Ok(generated)
}

#[derive(Default)]
pub struct CloudIdentityState(Mutex<()>);

struct KeyringCredentialStore {
    entry: Entry,
}

impl KeyringCredentialStore {
    fn new() -> Result<Self, String> {
        Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_USER)
            .map(|entry| Self { entry })
            .map_err(|_| "credential store is unavailable".to_string())
    }
}

impl CredentialStore for KeyringCredentialStore {
    fn read(&self) -> Result<Option<String>, String> {
        match self.entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(_) => Err("credential store read failed".to_string()),
        }
    }

    fn write(&self, value: &str) -> Result<(), String> {
        self.entry
            .set_password(value)
            .map_err(|_| "credential store write failed".to_string())
    }
}

#[tauri::command]
pub fn get_cloud_device_id(state: State<'_, CloudIdentityState>) -> Result<String, String> {
    let _guard = state
        .0
        .lock()
        .map_err(|_| "credential store lock poisoned".to_string())?;
    let store = KeyringCredentialStore::new()?;
    get_or_create_device_id(&store, || Uuid::new_v4().to_string())
}

fn is_lowercase_uuid_v4(value: &str) -> bool {
    Uuid::parse_str(value)
        .map(|uuid| uuid.get_version_num() == 4 && uuid.to_string() == value)
        .unwrap_or(false)
}
