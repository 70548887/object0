//! Vault file (de)serialization, passphrase/recovery unlock, save, and the
//! profile-info + unlocked/writable guards.

use super::*;

/// Random transfer encryption identity, carried only inside encrypted VaultData.
/// Unlike the passphrase-derived vault key, this must survive password changes.
#[derive(Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct TransferMasterKey([u8; KEY_BYTES]);

impl std::fmt::Debug for TransferMasterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TransferMasterKey([REDACTED])")
    }
}

impl Drop for TransferMasterKey {
    fn drop(&mut self) { self.0.fill(0); }
}

/// Return the existing durable identity without requiring a writable vault.
/// This also works after recovery-key unlock. Never derive it from vault.key.
pub(crate) fn existing_transfer_master_key(vault: &VaultRuntime) -> Result<Option<[u8; KEY_BYTES]>, String> {
    ensure_unlocked(vault)?;
    Ok(vault.data.as_ref().and_then(|data| data.transfer_master_key.as_ref()).map(|key| key.0))
}

/// Lazily migrate a writable legacy vault, transactionally. Call while holding
/// the vault mutex; do not start a transfer until this succeeds. The caller must
/// clear the returned temporary key when its checkpoint store is dropped.
/// No jobs/RPC integration is implied by this storage-only foundation.
pub(crate) fn ensure_transfer_master_key(
    path: &Path, vault: &mut VaultRuntime, migration_recovery_key: Option<&str>,
) -> Result<[u8; KEY_BYTES], String> {
    if let Some(key) = existing_transfer_master_key(vault)? { return Ok(key); }
    ensure_writable(vault)?;
    let mut candidate = vault.clone();
    if path.exists() {
        authorize_qiniu_migration_recovery(path, &mut candidate, migration_recovery_key)?;
    }
    let mut key = random_bytes::<KEY_BYTES>();
    candidate.data.as_mut().ok_or_else(|| "Vault is locked".to_string())?
        .transfer_master_key = Some(TransferMasterKey(key));
    if let Err(error) = save_vault(path, &candidate) {
        key.fill(0);
        return Err(error);
    }
    *vault = candidate;
    Ok(key)
}

pub(crate) fn read_vault_file(path: &Path) -> Result<VaultFileDisk, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    let value: Value =
        serde_json::from_str(&raw).map_err(|err| format!("Invalid vault JSON: {err}"))?;
    let version = value
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Vault missing version field".to_string())?;

    match version {
        1 => serde_json::from_value::<VaultFileV1>(value)
            .map(VaultFileDisk::V1)
            .map_err(|err| format!("Invalid V1 vault format: {err}")),
        2 => serde_json::from_value::<VaultFileV2>(value)
            .map(VaultFileDisk::V2)
            .map_err(|err| format!("Invalid V2 vault format: {err}")),
        3 => serde_json::from_value::<VaultFileV3>(value)
            .map(VaultFileDisk::V3)
            .map_err(|err| format!("Invalid V3 vault format: {err}")),
        4 => serde_json::from_value::<VaultFileV3>(value)
            .map(VaultFileDisk::V4)
            .map_err(|err| format!("Invalid V4 vault format: {err}")),
        _ => Err(format!("Unsupported vault version: {version}")),
    }
}

pub(crate) fn unlock_with_passphrase(path: &Path, passphrase: &str) -> Result<UnlockPayload, String> {
    let file = read_vault_file(path)?;

    match file {
        VaultFileDisk::V1(v1) => {
            let salt = decode_base64(&v1.salt)?;
            let iv = decode_base64(&v1.iv)?;
            let mut ciphertext = decode_base64(&v1.data)?;
            let auth_tag = decode_base64(&v1.auth_tag)?;
            ciphertext.extend(auth_tag);

            let key = derive_key(passphrase, &salt);
            let plaintext = decrypt_payload(&key, &iv, &ciphertext)?;
            let data: VaultData = serde_json::from_slice(&plaintext)
                .map_err(|err| format!("Invalid decrypted vault payload: {err}"))?;

            Ok(UnlockPayload {
                data,
                key,
                salt,
                has_recovery_key: false,
                recovery_salt: None,
                needs_rewrite: v1.version < CURRENT_VAULT_VERSION,
            })
        }
        VaultFileDisk::V2(v2) => {
            let salt = decode_base64(&v2.salt)?;
            let iv = decode_base64(&v2.iv)?;
            let ciphertext = decode_base64(&v2.data)?;
            let key = derive_key(passphrase, &salt);
            let plaintext = decrypt_payload(&key, &iv, &ciphertext)?;
            let data: VaultData = serde_json::from_slice(&plaintext)
                .map_err(|err| format!("Invalid decrypted vault payload: {err}"))?;

            Ok(UnlockPayload {
                data,
                key,
                salt,
                has_recovery_key: false,
                recovery_salt: None,
                needs_rewrite: v2.version < CURRENT_VAULT_VERSION,
            })
        }
        VaultFileDisk::V3(v3) | VaultFileDisk::V4(v3) => {
            let salt = decode_base64(&v3.salt)?;
            let iv = decode_base64(&v3.iv)?;
            let ciphertext = decode_base64(&v3.data)?;
            let key = derive_key(passphrase, &salt);
            let plaintext = decrypt_payload(&key, &iv, &ciphertext)?;
            let data: VaultData = serde_json::from_slice(&plaintext)
                .map_err(|err| format!("Invalid decrypted vault payload: {err}"))?;

            let recovery_salt = if let Some(recovery) = &v3.recovery {
                Some(decode_base64(&recovery.salt)?)
            } else {
                None
            };

            Ok(UnlockPayload {
                data,
                key,
                salt,
                has_recovery_key: v3.recovery.is_some(),
                recovery_salt,
                needs_rewrite: false,
            })
        }
    }
}

pub(crate) fn unlock_with_recovery_key(
    path: &Path,
    recovery_key_plain: &str,
) -> Result<RecoveryUnlockPayload, String> {
    let (file, is_v4) = match read_vault_file(path)? {
        VaultFileDisk::V3(v3) => (v3, false),
        VaultFileDisk::V4(v4) => (v4, true),
        _ => return Err("Vault has no recovery key configured".to_string()),
    };

    let recovery = file
        .recovery
        .as_ref()
        .ok_or_else(|| "Vault has no recovery key configured".to_string())?;

    let recovery_salt = decode_base64(&recovery.salt)?;
    let recovery_iv = decode_base64(&recovery.iv)?;
    let recovery_ciphertext = decode_base64(&recovery.data)?;
    let recovery_key = derive_key(recovery_key_plain, &recovery_salt);
    let recovered = decrypt_payload(&recovery_key, &recovery_iv, &recovery_ciphertext)
        .map_err(|_| "Invalid recovery key".to_string())?;
    let plaintext = if is_v4 {
        if file.recovery_mode.as_deref() != Some("wrapped-vault-key-v1") || recovered.len() != KEY_BYTES {
            return Err("Invalid V4 recovery format".to_string());
        }
        let mut vault_key = [0_u8; KEY_BYTES];
        vault_key.copy_from_slice(&recovered);
        let iv = decode_base64(&file.iv)?;
        let data = decode_base64(&file.data)?;
        let result = decrypt_payload(&vault_key, &iv, &data);
        vault_key.fill(0);
        result?
    } else {
        recovered
    };
    let data: VaultData = serde_json::from_slice(&plaintext)
        .map_err(|err| format!("Invalid decrypted vault payload: {err}"))?;
    let salt = decode_base64(&file.salt)?;

    Ok(RecoveryUnlockPayload {
        data,
        salt,
        recovery_salt,
        recovery_key,
    })
}

pub(crate) fn save_vault(path: &Path, vault: &VaultRuntime) -> Result<(), String> {
    if vault.plaintext {return plaintext_accounts::save(path,vault);}
    if plaintext_accounts::is_path(path){return Err("账号存储模式已变化，请重新打开程序 / Account storage mode changed; reopen the app".into())}
    let data = vault
        .data
        .as_ref()
        .ok_or_else(|| "Cannot save: vault is locked".to_string())?;
    let key = vault
        .key
        .as_ref()
        .ok_or_else(|| "Cannot save: vault has no passphrase key".to_string())?;
    let salt = vault
        .salt
        .as_ref()
        .ok_or_else(|| "Cannot save: vault has no salt".to_string())?;

    let plaintext =
        serde_json::to_vec(data).map_err(|err| format!("Failed to serialize vault data: {err}"))?;
    let (iv, ciphertext) = encrypt_payload(key, &plaintext)?;

    let has_qiniu = data.profiles.iter().any(|profile| profile.provider == S3Provider::Qiniu);
    let previous = if path.exists() { Some(read_vault_file(path)?) } else { None };
    let needs_v4 = has_qiniu || data.transfer_master_key.is_some();
    let is_v4 = needs_v4 || matches!(previous, Some(VaultFileDisk::V4(_)));
    let mut file = VaultFileV3 {
        version: if is_v4 { 4 } else { CURRENT_VAULT_VERSION },
        salt: encode_base64(salt),
        iv: encode_base64(&iv),
        data: encode_base64(&ciphertext),
        recovery: None,
        recovery_mode: None,
    };

    if let (Some(recovery_key), Some(recovery_salt)) = (&vault.recovery_key, &vault.recovery_salt) {
        let recovery_contents: &[u8] = if is_v4 { key } else { &plaintext };
        let (recovery_iv, recovery_ciphertext) = encrypt_payload(recovery_key, recovery_contents)?;
        file.recovery = Some(VaultRecoveryBlob {
            salt: encode_base64(recovery_salt),
            iv: encode_base64(&recovery_iv),
            data: encode_base64(&recovery_ciphertext),
        });
        if is_v4 { file.recovery_mode = Some("wrapped-vault-key-v1".to_string()); }
    } else if vault.recovery_salt.is_some() {
        match &previous {
            Some(VaultFileDisk::V4(existing)) if existing.recovery_mode.as_deref() == Some("wrapped-vault-key-v1") && existing.salt == file.salt => {
                file.recovery = existing.recovery.clone();
                file.recovery_mode = existing.recovery_mode.clone();
            }
            Some(VaultFileDisk::V3(existing)) if !is_v4 => file.recovery = existing.recovery.clone(),
            _ => return Err("首次保存七牛账号需要验证现有恢复密钥，以确保密码库可完整恢复".to_string()),
        }
    }

    ensure_parent_dir(path)?;
    let serialized = serde_json::to_string_pretty(&file)
        .map_err(|err| format!("Failed to serialize vault file: {err}"))?;
    // The previous application cannot deserialize a Qiniu provider. Preserve
    // the original encrypted vault before the first version-4 write, and fail
    // closed if a verified backup cannot be made.
    if needs_v4 && path.exists() && !matches!(previous, Some(VaultFileDisk::V4(_))) {
        backup_before_qiniu(path)?;
    }
    write_atomic(path, serialized.as_bytes())
}

#[cfg(test)]
#[path = "vault_transfer_key_tests.rs"]
mod transfer_key_tests;

/// Authorize legacy-to-V4 migration without trusting a stale legacy recovery
/// snapshot as the new data. Only the derived key is held in memory until lock.
pub(crate) fn authorize_qiniu_migration_recovery(path: &Path, vault: &mut VaultRuntime, supplied: Option<&str>) -> Result<(), String> {
    if vault.plaintext {return Ok(());}
    if matches!(read_vault_file(path)?, VaultFileDisk::V4(_)) || vault.recovery_salt.is_none() || vault.recovery_key.is_some() {
        return Ok(());
    }
    let key = supplied.map(str::trim).filter(|value| !value.is_empty())
        .ok_or_else(|| "首次保存七牛账号需要验证现有恢复密钥".to_string())?;
    let legacy = unlock_with_recovery_key(path, key).map_err(|_| "恢复密钥无效，七牛账号未保存".to_string())?;
    vault.recovery_key = Some(legacy.recovery_key);
    Ok(())
}

fn backup_before_qiniu(path: &Path) -> Result<(), String> {
    use std::io::Write as _;
    let encrypted = fs::read(path).map_err(|_| "无法读取原有加密密码库，已停止七牛账号保存".to_string())?;
    let backup_path = path.with_file_name(format!("vault.enc.pre-qiniu-{}.bak", Uuid::new_v4()));
    let mut backup = fs::OpenOptions::new().write(true).create_new(true).open(&backup_path)
        .map_err(|_| "无法创建加密密码库备份，已停止七牛账号保存".to_string())?;
    backup.write_all(&encrypted).and_then(|_| backup.sync_all())
        .map_err(|_| "无法完成加密密码库备份，已停止七牛账号保存".to_string())?;
    let copied = fs::read(&backup_path)
        .map_err(|_| "无法验证加密密码库备份，已停止七牛账号保存".to_string())?;
    if copied != encrypted { return Err("加密密码库备份校验失败，已停止七牛账号保存".to_string()); }
    Ok(())
}

pub(crate) fn has_recovery_key_on_disk(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }

    match read_vault_file(path)? {
        VaultFileDisk::V3(v3) | VaultFileDisk::V4(v3) => Ok(v3.recovery.is_some()),
        _ => Ok(false),
    }
}

/// Deliberately not Debug: the new recovery key is returned once to the local
/// confirmation dialog, never included in diagnostics or persisted in plaintext.
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct RecoveryKeyRotation { pub(crate) recovery_key:String, pub(crate) backup_path:String }

const ROTATION_CHANGED:&str="密码库已在其他操作中变化，请重新解锁后再更换恢复密钥 / The vault changed; unlock it again before rotating the recovery key";
const ROTATION_IO:&str="恢复密钥更换未完成，原密码库与内存状态保持不变；请检查磁盘和加密备份 / Recovery-key rotation did not complete; the original vault and runtime were preserved. Check the disk and encrypted backup";

/// Rotate only the recovery envelope. The primary ciphertext, key and salt are
/// retained exactly, so transfer identities and saved profiles cannot be
/// replaced with a potentially stale legacy recovery snapshot.
pub(crate) fn rotate_recovery_key(path:&Path,vault:&mut VaultRuntime,passphrase:&str,confirmed:bool)->Result<RecoveryKeyRotation,String>{
    rotate_recovery_key_with_io(path,vault,passphrase,confirmed,backup_for_recovery_rotation,persist_recovery_rotation)
}

fn rotation_snapshot(path:&Path)->Result<Vec<u8>,String>{
    let metadata=fs::symlink_metadata(path).map_err(|_|ROTATION_IO.to_string())?;
    if !metadata.is_file()||metadata.file_type().is_symlink(){return Err(ROTATION_IO.into())}
    fs::read(path).map_err(|_|ROTATION_IO.to_string())
}

fn rotate_recovery_key_with_io(
    path:&Path,vault:&mut VaultRuntime,passphrase:&str,confirmed:bool,
    backup:impl FnOnce(&Path,&[u8])->Result<PathBuf,String>,
    persist:impl FnOnce(&Path,&[u8],&[u8])->Result<(),String>,
)->Result<RecoveryKeyRotation,String>{
    if vault.plaintext{return Err(plaintext_accounts::PASSWORD_UNAVAILABLE.into())}
    ensure_writable(vault)?;
    if !confirmed{return Err("请明确确认旧恢复密钥将失效 / Confirm that the old recovery key will become invalid".into())}
    if passphrase.trim().is_empty()||passphrase.len()>4096{return Err("请输入当前云仓密码库密码，不是云服务密钥 / Enter the current Yuncang vault password, not a cloud access key".into())}
    let original=rotation_snapshot(path)?;
    let unlocked=unlock_with_passphrase(path,passphrase).map_err(|_|"当前密码验证失败，恢复密钥未更换 / Current password verification failed; the recovery key was not changed".to_string())?;
    let runtime_data=serde_json::to_value(vault.data.as_ref().ok_or("Vault is locked")?).map_err(|_|ROTATION_IO.to_string())?;
    let disk_data=serde_json::to_value(&unlocked.data).map_err(|_|ROTATION_IO.to_string())?;
    if vault.key.as_ref()!=Some(&unlocked.key)||vault.salt.as_ref()!=Some(&unlocked.salt)
        ||runtime_data!=disk_data||vault.recovery_salt!=unlocked.recovery_salt||rotation_snapshot(path)?!=original {
        return Err(ROTATION_CHANGED.into())
    }
    let (mut file,is_v4)=match read_vault_file(path).map_err(|_|ROTATION_IO.to_string())?{
        VaultFileDisk::V3(file)=>(file,false),VaultFileDisk::V4(file)=>(file,true),
        _=>return Err("请先以当前密码重新解锁并完成旧格式升级 / Unlock with the current password to upgrade the legacy vault first".into()),
    };
    if rotation_snapshot(path)?!=original{return Err(ROTATION_CHANGED.into())}
    let recovery_plain=generate_recovery_key();let recovery_salt=random_bytes::<SALT_BYTES>();let recovery_key=derive_key(&recovery_plain,&recovery_salt);
    let mut candidate=vault.clone();candidate.recovery_key=Some(recovery_key);candidate.recovery_salt=Some(recovery_salt.to_vec());
    let mut plaintext=if is_v4 {unlocked.key.to_vec()}else{serde_json::to_vec(&unlocked.data).map_err(|_|ROTATION_IO.to_string())?};
    let encrypted=encrypt_payload(&recovery_key,&plaintext);plaintext.fill(0);
    let(iv,ciphertext)=encrypted.map_err(|_|ROTATION_IO.to_string())?;
    file.recovery=Some(VaultRecoveryBlob{salt:encode_base64(&recovery_salt),iv:encode_base64(&iv),data:encode_base64(&ciphertext)});
    file.recovery_mode=if is_v4{Some("wrapped-vault-key-v1".into())}else{None};
    let bytes=serde_json::to_vec_pretty(&file).map_err(|_|ROTATION_IO.to_string())?;
    // No backup or mutation before all authentication and identity checks pass.
    let backup_path=backup(path,&original)?;
    persist(path,&original,&bytes)?;
    *vault=candidate;
    Ok(RecoveryKeyRotation{recovery_key:recovery_plain,backup_path:backup_path.to_string_lossy().into_owned()})
}

fn backup_for_recovery_rotation(path:&Path,original:&[u8])->Result<PathBuf,String>{
    if rotation_snapshot(path)?!=original{return Err(ROTATION_CHANGED.into())}
    let backup_path=path.with_file_name(format!("vault.enc.pre-recovery-rotation-{}.bak",Uuid::new_v4()));
    let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&backup_path).map_err(|_|ROTATION_IO.to_string())?;
    file.write_all(original).and_then(|_|file.sync_all()).map_err(|_|ROTATION_IO.to_string())?;
    if fs::read(&backup_path).map_err(|_|ROTATION_IO.to_string())?!=original{return Err(ROTATION_IO.into())}
    Ok(backup_path)
}

fn persist_recovery_rotation(path:&Path,original:&[u8],replacement:&[u8])->Result<(),String>{
    if rotation_snapshot(path)?!=original{return Err(ROTATION_CHANGED.into())}
    let temporary=path.with_file_name(format!(".recovery-rotation-{}.tmp",Uuid::new_v4()));
    let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_|ROTATION_IO.to_string())?;
    let result=(||{
        file.write_all(replacement).and_then(|_|file.sync_all()).map_err(|_|ROTATION_IO.to_string())?;
        if fs::read(&temporary).map_err(|_|ROTATION_IO.to_string())?!=replacement{return Err(ROTATION_IO.into())}
        if rotation_snapshot(path)?!=original{return Err(ROTATION_CHANGED.into())}
        Ok(())
    })();
    drop(file);
    if let Err(error)=result{let _=fs::remove_file(&temporary);return Err(error)}
    if fs::rename(&temporary,path).is_err(){let _=fs::remove_file(&temporary);return Err(ROTATION_IO.into())}
    Ok(())
}

#[cfg(test)]
#[path="vault_recovery_rotation_tests.rs"]
mod recovery_rotation_tests;

pub(crate) fn lock_vault_runtime(vault: &mut VaultRuntime) {
    vault.unlocked = false;
    vault.data = None;
    vault.key = None;
    vault.salt = None;
    vault.recovery_key = None;
    vault.recovery_salt = None;
}

pub(crate) fn to_profile_info(profile: &Profile) -> ProfileInfo {
    ProfileInfo {
        id: profile.id.clone(),
        name: profile.name.clone(),
        provider: profile.provider.clone(),
        endpoint: profile.endpoint.clone(),
        region: profile.region.clone(),
        default_bucket: profile.default_bucket.clone(),
        has_r2_analytics_token: profile.r2_analytics_token.as_ref().is_some_and(|value| !value.is_empty()),
        has_session_token: profile.session_token.as_ref().is_some_and(|value| !value.trim().is_empty()),
        qiniu: profile.qiniu.clone(),
        created_at: profile.created_at.clone(),
        updated_at: profile.updated_at.clone(),
    }
}

pub(crate) fn profile_infos(vault: &VaultRuntime) -> Vec<ProfileInfo> {
    vault
        .data
        .as_ref()
        .map(|data| data.profiles.iter().map(to_profile_info).collect())
        .unwrap_or_default()
}

pub(crate) fn ensure_unlocked(vault: &VaultRuntime) -> Result<(), String> {
    if !vault.unlocked || vault.data.is_none() {
        return Err("Vault is locked".to_string());
    }
    Ok(())
}

pub(crate) fn ensure_writable(vault: &VaultRuntime) -> Result<(), String> {
    ensure_unlocked(vault)?;
    if vault.plaintext{return Ok(());}
    if vault.key.is_none() || vault.salt.is_none() {
        return Err("Vault must be rekeyed before writing".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    fn test_runtime() -> (VaultRuntime, String) {
        let passphrase = "unit-test-passphrase";
        let recovery_text = "unit-test-recovery-key".to_string();
        let salt = vec![1_u8; SALT_BYTES];
        let recovery_salt = vec![2_u8; SALT_BYTES];
        (VaultRuntime {
            plaintext: false,
            unlocked: true,
            data: Some(VaultData::default()),
            key: Some(derive_key(passphrase, &salt)),
            salt: Some(salt),
            recovery_key: Some(derive_key(&recovery_text, &recovery_salt)),
            recovery_salt: Some(recovery_salt),
        }, recovery_text)
    }

    fn qiniu_profile() -> Profile {
        Profile {
            id: "test-profile".into(), name: "test-account".into(),
            provider: S3Provider::Qiniu, access_key_id: "example-ak".into(),
            secret_access_key: "example-sk".into(), session_token: None,
            endpoint: None, region: None, default_bucket: None, r2_analytics_token: None,
            qiniu: Some(qiniu::QiniuConfig::default()), created_at: now_iso(), updated_at: now_iso(),
        }
    }

    #[test]
    fn qiniu_migration_backups_legacy_and_recovery_tracks_later_changes() {
        let dir = std::env::temp_dir().join(format!("yuncang-qiniu-vault-test-{}", Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("vault.enc");
        let (mut vault, recovery_text) = test_runtime();
        save_vault(&path, &vault).unwrap();
        let legacy = fs::read(&path).unwrap();
        assert!(matches!(read_vault_file(&path).unwrap(), VaultFileDisk::V3(_)));
        // Reproduce ordinary passphrase unlock: derived recovery key isn't cached.
        vault.recovery_key = None;
        vault.data.as_mut().unwrap().profiles.push(qiniu_profile());
        assert!(save_vault(&path, &vault).is_err());
        assert_eq!(fs::read(&path).unwrap(), legacy);
        assert!(authorize_qiniu_migration_recovery(&path, &mut vault, Some("incorrect")).is_err());
        authorize_qiniu_migration_recovery(&path, &mut vault, Some(&recovery_text)).unwrap();
        save_vault(&path, &vault).unwrap();
        assert!(matches!(read_vault_file(&path).unwrap(), VaultFileDisk::V4(_)));
        let backups: Vec<_> = fs::read_dir(&dir).unwrap().filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("vault.enc.pre-qiniu-")).collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(backups[0].path()).unwrap(), legacy);
        assert_eq!(unlock_with_recovery_key(&path, &recovery_text).unwrap().data.profiles[0].name, "test-account");
        // A later ordinary password unlock must preserve the wrapped key while
        // recovery still decrypts the newest primary vault content.
        vault.recovery_key = None;
        vault.data.as_mut().unwrap().profiles[0].name = "updated-account".into();
        save_vault(&path, &vault).unwrap();
        assert_eq!(unlock_with_recovery_key(&path, &recovery_text).unwrap().data.profiles[0].name, "updated-account");
        assert_eq!(unlock_with_passphrase(&path, "unit-test-passphrase").unwrap().data.profiles[0].name, "updated-account");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2, "backup should be created only once");

        // Recovery -> password rotation -> normal write -> recovery must always
        // restore the latest data using the newly issued recovery key.
        let recovered = unlock_with_recovery_key(&path, &recovery_text).unwrap();
        let next_passphrase = "new-unit-test-passphrase";
        let next_recovery = "new-unit-test-recovery";
        let next_salt = vec![3_u8; SALT_BYTES];
        let next_recovery_salt = vec![4_u8; SALT_BYTES];
        let mut rotated = VaultRuntime { plaintext:false, unlocked:true, data:Some(recovered.data),
            key:Some(derive_key(next_passphrase, &next_salt)), salt:Some(next_salt),
            recovery_key:Some(derive_key(next_recovery, &next_recovery_salt)), recovery_salt:Some(next_recovery_salt) };
        save_vault(&path, &rotated).unwrap();
        assert!(unlock_with_recovery_key(&path, &recovery_text).is_err());
        rotated.recovery_key = None;
        rotated.data.as_mut().unwrap().profiles.clear();
        save_vault(&path, &rotated).unwrap();
        assert!(matches!(read_vault_file(&path).unwrap(), VaultFileDisk::V4(_)), "removing the last Qiniu account must not downgrade V4");
        assert!(unlock_with_recovery_key(&path, next_recovery).unwrap().data.profiles.is_empty());
        let unlocked = unlock_with_passphrase(&path, next_passphrase).unwrap();
        let mut reopened = VaultRuntime { plaintext:false, unlocked:true, data:Some(unlocked.data), key:Some(unlocked.key), salt:Some(unlocked.salt), recovery_key:None, recovery_salt:unlocked.recovery_salt };
        authorize_qiniu_migration_recovery(&path, &mut reopened, None).unwrap();
        reopened.data.as_mut().unwrap().profiles.push(qiniu_profile());
        save_vault(&path, &reopened).unwrap();
        assert_eq!(unlock_with_recovery_key(&path, next_recovery).unwrap().data.profiles[0].name, "test-account");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_candidate_write_does_not_modify_the_live_runtime() {
        let dir = std::env::temp_dir().join(format!("yuncang-qiniu-vault-failure-{}", Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let parent_file = dir.join("not-a-directory");
        fs::write(&parent_file, b"test").unwrap();
        let (live, _) = test_runtime();
        let mut candidate = live.clone();
        candidate.key = Some([9_u8; KEY_BYTES]);
        candidate.recovery_key = Some([8_u8; KEY_BYTES]);
        assert!(save_vault(&parent_file.join("vault.enc"), &candidate).is_err());
        assert_ne!(candidate.key, live.key);
        assert_ne!(candidate.recovery_key, live.recovery_key);
        fs::remove_dir_all(dir).unwrap();
    }
}
