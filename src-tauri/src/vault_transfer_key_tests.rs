//! Isolated synthetic vaults only. No application config or real credentials.
use super::*;

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("yuncang-transfer-key-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn path(&self) -> std::path::PathBuf { self.0.join("vault.enc") }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // This freshly allocated UUID test directory is the sole cleanup scope.
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn runtime() -> VaultRuntime {
    VaultRuntime {
        plaintext: false,
        unlocked: true,
        data: Some(VaultData::default()),
        key: Some(derive_key("test-password", &[1; SALT_BYTES])),
        salt: Some(vec![1; SALT_BYTES]),
        recovery_key: Some(derive_key("test-recovery", &[2; SALT_BYTES])),
        recovery_salt: Some(vec![2; SALT_BYTES]),
    }
}
fn reopen(path: &Path, password: &str) -> VaultRuntime {
    let payload = unlock_with_passphrase(path, password).unwrap();
    VaultRuntime {
        plaintext: false,
        unlocked: true, data: Some(payload.data), key: Some(payload.key), salt: Some(payload.salt),
        recovery_key: None, recovery_salt: payload.recovery_salt,
    }
}

#[test]
fn old_vault_data_is_accepted_and_master_key_debug_is_redacted() {
    let data: VaultData = serde_json::from_str(r#"{"profiles":[]}"#).unwrap();
    assert!(data.transfer_master_key.is_none());
    assert_eq!(serde_json::to_string(&data).unwrap(), r#"{"profiles":[]}"#);
    let secret = TransferMasterKey([19; KEY_BYTES]);
    assert_eq!(format!("{secret:?}"), "TransferMasterKey([REDACTED])");
    assert!(serde_json::from_str::<TransferMasterKey>("[1,2]").is_err());
}

#[test]
fn stable_key_is_durable_encrypted_and_reused_without_rewriting() {
    let fixture = Fixture::new();
    let path = fixture.path();
    let mut live = runtime();
    let key = ensure_transfer_master_key(&path, &mut live, None).unwrap();
    let encrypted = fs::read(&path).unwrap();
    let text = String::from_utf8_lossy(&encrypted);
    assert!(!text.contains("transfer_master_key"));
    assert!(!text.contains(&encode_base64(&key)));
    assert!(matches!(read_vault_file(&path).unwrap(), VaultFileDisk::V4(_)));
    let mut reopened = reopen(&path, "test-password");
    assert_eq!(existing_transfer_master_key(&reopened).unwrap(), Some(key));
    assert_eq!(ensure_transfer_master_key(&path, &mut reopened, None).unwrap(), key);
    assert_eq!(fs::read(&path).unwrap(), encrypted);
    let recovered = unlock_with_recovery_key(&path, "test-recovery").unwrap();
    let recovery_runtime = VaultRuntime { unlocked:true, data:Some(recovered.data), ..Default::default() };
    assert_eq!(existing_transfer_master_key(&recovery_runtime).unwrap(), Some(key));
}

#[test]
fn password_rotation_and_recovery_keep_identical_transfer_identity() {
    let fixture = Fixture::new(); let path = fixture.path(); let mut live = runtime();
    let key = ensure_transfer_master_key(&path, &mut live, None).unwrap();
    // Match VaultChangePassphrase: clone the data and change only envelope keys.
    let recovered = unlock_with_recovery_key(&path, "test-recovery").unwrap();
    let mut rotated = VaultRuntime { plaintext:false, unlocked:true, data:Some(recovered.data),
        key:Some(derive_key("rotated-password", &[3; SALT_BYTES])), salt:Some(vec![3; SALT_BYTES]),
        recovery_key:Some(derive_key("rotated-recovery", &[4; SALT_BYTES])), recovery_salt:Some(vec![4; SALT_BYTES]) };
    save_vault(&path, &rotated).unwrap();
    assert_eq!(existing_transfer_master_key(&reopen(&path, "rotated-password")).unwrap(), Some(key));
    assert!(unlock_with_passphrase(&path, "test-password").is_err());
    assert!(unlock_with_recovery_key(&path, "test-recovery").is_err());
    rotated.recovery_key = None;
    save_vault(&path, &rotated).unwrap();
    let recovered = unlock_with_recovery_key(&path, "rotated-recovery").unwrap();
    assert_eq!(recovered.data.transfer_master_key.unwrap().0, key);
}

#[test]
fn legacy_recovery_migration_is_authorized_then_committed_atomically() {
    let fixture = Fixture::new(); let path = fixture.path(); let mut live = runtime();
    save_vault(&path, &live).unwrap(); let original = fs::read(&path).unwrap();
    live.recovery_key = None;
    assert!(ensure_transfer_master_key(&path, &mut live, None).is_err());
    assert!(ensure_transfer_master_key(&path, &mut live, Some("wrong")).is_err());
    assert!(existing_transfer_master_key(&live).unwrap().is_none());
    assert!(live.recovery_key.is_none());
    assert_eq!(fs::read(&path).unwrap(), original);
    let key = ensure_transfer_master_key(&path, &mut live, Some("test-recovery")).unwrap();
    assert_eq!(unlock_with_recovery_key(&path, "test-recovery").unwrap().data.transfer_master_key.unwrap().0, key);
    let backups: Vec<_> = fs::read_dir(&fixture.0).unwrap().filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".bak")).collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(fs::read(backups[0].path()).unwrap(), original);
}

#[test]
fn failed_disk_write_does_not_publish_memory_key_or_modify_existing_files() {
    let fixture = Fixture::new(); let blocking_file = fixture.0.join("blocking-file");
    fs::write(&blocking_file, b"untouched").unwrap();
    let mut live = runtime(); let original_key = live.key;
    assert!(ensure_transfer_master_key(&blocking_file.join("vault.enc"), &mut live, None).is_err());
    assert_eq!(existing_transfer_master_key(&live).unwrap(), None);
    assert_eq!(live.key, original_key);
    assert_eq!(fs::read(&blocking_file).unwrap(), b"untouched");
}

#[test]
fn locked_and_unpersistable_recovery_vaults_cannot_mint_ephemeral_identities() {
    let fixture = Fixture::new(); let path = fixture.path(); let mut live = runtime();
    live.key = None;
    assert!(ensure_transfer_master_key(&path, &mut live, None).is_err());
    assert!(live.data.as_ref().unwrap().transfer_master_key.is_none());
    assert!(!path.exists());
    let mut locked = VaultRuntime::default();
    assert!(existing_transfer_master_key(&locked).is_err());
    assert!(ensure_transfer_master_key(&path, &mut locked, None).is_err());
}
