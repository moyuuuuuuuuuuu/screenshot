use tauri::AppHandle;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

pub trait ShortcutRegistrar {
    fn register(&mut self, shortcut: &str) -> Result<(), String>;
    fn unregister(&mut self, shortcut: &str) -> Result<(), String>;
}

pub fn replace_shortcut(
    registrar: &mut impl ShortcutRegistrar,
    current: &str,
    candidate: &str,
) -> Result<(), String> {
    if current == candidate {
        return Ok(());
    }
    registrar.register(candidate)?;
    if let Err(error) = registrar.unregister(current) {
        let _ = registrar.unregister(candidate);
        return Err(error);
    }
    Ok(())
}

pub struct TauriShortcutRegistrar<'a>(pub &'a AppHandle);

impl ShortcutRegistrar for TauriShortcutRegistrar<'_> {
    fn register(&mut self, shortcut: &str) -> Result<(), String> {
        self.0
            .global_shortcut()
            .register(shortcut)
            .map_err(|error| error.to_string())
    }

    fn unregister(&mut self, shortcut: &str) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    struct FakeRegistrar {
        registered: HashSet<String>,
        rejected: String,
    }

    impl FakeRegistrar {
        fn with_registered(shortcut: &str) -> Self {
            Self {
                registered: HashSet::from([shortcut.to_string()]),
                rejected: "Ctrl+Alt+X".to_string(),
            }
        }
    }

    impl super::ShortcutRegistrar for FakeRegistrar {
        fn register(&mut self, shortcut: &str) -> Result<(), String> {
            if shortcut == self.rejected {
                return Err("shortcut unavailable".to_string());
            }
            self.registered.insert(shortcut.to_string());
            Ok(())
        }

        fn unregister(&mut self, shortcut: &str) -> Result<(), String> {
            self.registered.remove(shortcut);
            Ok(())
        }
    }

    #[test]
    fn failed_candidate_registration_keeps_the_current_shortcut() {
        let mut registrar = FakeRegistrar::with_registered("Alt+Shift+A");

        assert!(super::replace_shortcut(&mut registrar, "Alt+Shift+A", "Ctrl+Alt+X").is_err());
        assert!(registrar.registered.contains("Alt+Shift+A"));
    }
}
