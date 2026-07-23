use std::cell::RefCell;

use crate::cloud_identity::{get_or_create_device_id, CredentialStore};

const GENERATED_ID: &str = "123e4567-e89b-42d3-a456-426614174000";

#[derive(Default)]
struct FakeCredentialStore {
    value: RefCell<Option<String>>,
    writes: RefCell<Vec<String>>,
}

impl FakeCredentialStore {
    fn containing(value: &str) -> Self {
        Self {
            value: RefCell::new(Some(value.to_string())),
            writes: RefCell::new(Vec::new()),
        }
    }
}

impl CredentialStore for FakeCredentialStore {
    fn read(&self) -> Result<Option<String>, String> {
        Ok(self.value.borrow().clone())
    }

    fn write(&self, value: &str) -> Result<(), String> {
        *self.value.borrow_mut() = Some(value.to_string());
        self.writes.borrow_mut().push(value.to_string());
        Ok(())
    }
}

#[test]
fn creates_and_persists_one_lowercase_v4_id_when_the_store_is_empty() {
    let store = FakeCredentialStore::default();

    let device_id =
        get_or_create_device_id(&store, || GENERATED_ID.to_string()).expect("device id");

    assert_eq!(device_id, GENERATED_ID);
    assert_eq!(store.value.borrow().as_deref(), Some(GENERATED_ID));
    assert_eq!(store.writes.borrow().as_slice(), [GENERATED_ID]);
}

#[test]
fn reuses_an_existing_lowercase_v4_id_without_writing_or_generating() {
    let store = FakeCredentialStore::containing(GENERATED_ID);

    let device_id = get_or_create_device_id(&store, || panic!("must not regenerate"))
        .expect("existing device id");

    assert_eq!(device_id, GENERATED_ID);
    assert!(store.writes.borrow().is_empty());
}

#[test]
fn replaces_invalid_or_noncanonical_values() {
    for invalid in [
        "not-a-uuid",
        "123E4567-E89B-42D3-A456-426614174000",
        "123e4567-e89b-12d3-a456-426614174000",
    ] {
        let store = FakeCredentialStore::containing(invalid);

        let device_id =
            get_or_create_device_id(&store, || GENERATED_ID.to_string()).expect("replacement");

        assert_eq!(device_id, GENERATED_ID);
        assert_eq!(store.writes.borrow().as_slice(), [GENERATED_ID]);
    }
}
