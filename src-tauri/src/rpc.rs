//! RPC dispatch: the single #[tauri::command] entry point that routes every
//! frontend request to its handler. Uses `super::*` to reach the crate-root
//! state, input structs, and helper functions.

use super::*;

/// Empty paths retain the existing zero-byte folder-marker protocol. Every
/// actual upload source must be an inspectable ordinary file before queueing.
/// Provider errors and local paths are deliberately excluded from diagnostics.
fn upload_source_size(local_path: &str) -> Result<i64, String> {
    if local_path.trim().is_empty() {
        return Ok(0);
    }
    let metadata = fs::metadata(expand_user_path(local_path))
        .map_err(|_| "无法读取上传文件，请确认文件存在且可访问 / Could not inspect upload file; check that it exists and is accessible".to_string())?;
    if !metadata.is_file() {
        return Err("上传来源不是普通文件；文件夹请使用上传文件夹功能 / Upload source is not an ordinary file; use Upload Folder for directories".to_string());
    }
    i64::try_from(metadata.len())
        .map_err(|_| "上传文件大小超出支持范围 / Upload file size exceeds the supported range".to_string())
}

#[cfg(test)]
mod upload_source_tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        file: PathBuf,
        empty: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("yuncang-upload-source-{}", Uuid::new_v4().simple()));
            fs::create_dir(&root).unwrap();
            let file = root.join("ordinary.bin");
            let empty = root.join("empty.bin");
            fs::write(&file, b"unchanged source").unwrap();
            fs::write(&empty, b"").unwrap();
            Self { root, file, empty }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // Delete only the two known files and this empty unique fixture,
            // never recursively traverse a user-supplied path.
            let _ = fs::remove_file(&self.file);
            let _ = fs::remove_file(&self.empty);
            let _ = fs::remove_dir(&self.root);
        }
    }

    #[test]
    fn ordinary_and_empty_files_have_their_actual_size() {
        let fixture = Fixture::new();
        assert_eq!(upload_source_size(&fixture.file.to_string_lossy()).unwrap(), 16);
        assert_eq!(upload_source_size(&fixture.empty.to_string_lossy()).unwrap(), 0);
        assert_eq!(fs::read(&fixture.file).unwrap(), b"unchanged source");
        assert!(fs::read(&fixture.empty).unwrap().is_empty());
    }

    #[test]
    fn empty_paths_preserve_zero_byte_folder_markers() {
        for path in ["", " ", "\t\r\n"] {
            assert_eq!(upload_source_size(path).unwrap(), 0);
        }
    }

    #[test]
    fn directories_and_missing_files_fail_before_queueing_without_path_echo() {
        let fixture = Fixture::new();
        let missing = fixture.root.join("does-not-exist.secret");
        for path in [&fixture.root, &missing] {
            let error = upload_source_size(&path.to_string_lossy()).unwrap_err();
            assert!(!error.contains(fixture.root.to_string_lossy().as_ref()));
            assert!(!error.contains("does-not-exist.secret"));
        }
        assert!(!missing.exists());
        assert!(fixture.root.is_dir());
        assert_eq!(fs::read(&fixture.file).unwrap(), b"unchanged source");
        assert!(fs::read(&fixture.empty).unwrap().is_empty());
        assert_eq!(fs::read_dir(&fixture.root).unwrap().count(), 2);
    }
}

#[derive(Default,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct OpenLocalInput {#[serde(default)] skip_legacy_import:bool}
// No Debug: the one-time old-vault import password must not enter logs.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportLegacyInput {passphrase:String}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct ConnectCancelInput {request_id:String}

fn adopt_local_candidate(app:&AppHandle,state:&AppState,vault:&mut VaultRuntime,candidate:VaultRuntime)->Result<(),String>{
    let old_data=serde_json::to_value(&vault.data).map_err(|_|"无法核对账号状态 / Could not compare account state".to_string())?;
    let new_data=serde_json::to_value(&candidate.data).map_err(|_|"无法核对账号状态 / Could not compare account state".to_string())?;
    if !vault.unlocked||vault.plaintext!=candidate.plaintext||old_data!=new_data {
        native_jobs::suspend_for_lock(state,vault);
        native_download_jobs::suspend_for_lock(state,vault);
        usage::cancel_all(state);
        storage_backend::clear(state);
        stop_all_folder_sync_rules(app);
    }
    *vault=candidate;
    Ok(())
}

fn prepare_qiniu_object_mutation(state:&AppState,input:&QiniuObjectMutationInput)->Result<(Profile,qiniu::QiniuClient),String>{
    if input.expected_profile_revision.trim().is_empty(){return Err("缺少账号版本，请重新确认操作 / Missing account revision; confirm the operation again".into())}
    if !input.cost_confirmed{return Err("请先确认可能产生的存储类型或取回费用 / Confirm possible storage or retrieval charges".into())}
    if input.keys.is_empty()||input.keys.len()>100{return Err("请选择 1 至 100 个对象 / Select between 1 and 100 objects".into())}
    let profile=profile_for_id(state,&input.profile_id)?;
    storage_backend::ensure_expected_revision(&profile,Some(&input.expected_profile_revision))?;
    match storage_backend::get(state,&profile)? {
        storage_backend::StorageBackend::Qiniu(client)=>Ok((profile,client)),
        _=>Err("当前账号不是七牛云账号 / Account is not a Qiniu profile".into()),
    }
}

#[cfg(test)]
mod mutation_identity_tests {
    use super::*;
    fn state()->AppState {let state=AppState::default();let profile:Profile=serde_json::from_value(json!({"id":"profile","name":"fixture","provider":"qiniu","accessKeyId":"new-fixture-ak","secretAccessKey":"new-fixture-sk","qiniu":{},"createdAt":"t","updatedAt":"revision-new"})).unwrap();{let mut vault=state.vault.lock().unwrap();vault.unlocked=true;vault.data=Some(VaultData{profiles:vec![profile],..Default::default()});}state}
    fn payload()->Value {json!({"profileId":"profile","expectedProfileRevision":"revision-new","bucket":"bucket","keys":["file"],"value":1,"costConfirmed":true})}
    #[test]fn audit_paid_mutation_requires_the_captured_revision_before_client_construction(){
        let state=state();let valid:QiniuObjectMutationInput=parse_payload(payload()).unwrap();assert!(prepare_qiniu_object_mutation(&state,&valid).is_ok());
        let mut stale=payload();stale["expectedProfileRevision"]=json!("revision-old");let stale:QiniuObjectMutationInput=parse_payload(stale).unwrap();
        // If native-client construction were attempted this invalid private CA
        // configuration would produce a different error. Staleness wins first.
        {let mut vault=state.vault.lock().unwrap();vault.data.as_mut().unwrap().profiles[0].qiniu=Some(qiniu::QiniuConfig{mode:qiniu::QiniuMode::Private,trusted_ca_path:Some("nonexistent-fixture.pem".into()),..Default::default()});}
        let error=prepare_qiniu_object_mutation(&state,&stale).err().unwrap();assert!(error.contains("Account changed"));
        let mut missing=payload();missing.as_object_mut().unwrap().remove("expectedProfileRevision");assert!(parse_payload::<QiniuObjectMutationInput>(missing).is_err());
        let mut empty=payload();empty["expectedProfileRevision"]=json!(" ");assert!(prepare_qiniu_object_mutation(&state,&parse_payload(empty).unwrap()).is_err());
    }
    #[test]fn audit_paid_mutation_rejects_removed_and_locked_profiles(){
        let state=state();let input:QiniuObjectMutationInput=parse_payload(payload()).unwrap();
        {state.vault.lock().unwrap().unlocked=false;}assert!(prepare_qiniu_object_mutation(&state,&input).is_err());
        {let mut vault=state.vault.lock().unwrap();vault.unlocked=true;vault.data.as_mut().unwrap().profiles.clear();}assert!(prepare_qiniu_object_mutation(&state,&input).is_err());
    }
}

#[derive(Serialize, Deserialize)]
struct ObjectCursor {
    version: u8,
    profile_id: String,
    bucket: String,
    prefix: String,
    max_keys: u16,
    token: String,
}

fn is_current_directory_marker(key: &str, prefix: Option<&str>) -> bool {
    prefix.is_some_and(|value| !value.is_empty() && value.ends_with('/') && key == value)
}

#[cfg(test)]
mod directory_marker_tests {
    use super::*;
    #[test]
    fn hides_only_the_current_folder_marker_not_children_or_zero_byte_files() {
        assert!(is_current_directory_marker("中文/+%?#/", Some("中文/+%?#/")));
        assert!(!is_current_directory_marker("中文/+%?#/child/", Some("中文/+%?#/")));
        assert!(!is_current_directory_marker("中文/+%?#/empty.txt", Some("中文/+%?#/")));
        assert!(!is_current_directory_marker("prefix", Some("prefix")));
        assert!(!is_current_directory_marker("", Some("")));
        assert!(!is_current_directory_marker("folder/", None));
    }
}

fn decode_object_cursor(input: &ObjectsListInput, max_keys: u16) -> Result<Option<String>, String> {
    let Some(cursor) = input.cursor.as_deref() else { return Ok(None) };
    if cursor.is_empty() || cursor.len() > 65_536 { return Err("Invalid object listing cursor".to_string()); }
    let decoded = decode_base64(cursor).map_err(|_| "Invalid object listing cursor".to_string())?;
    let cursor: ObjectCursor = serde_json::from_slice(&decoded).map_err(|_| "Invalid object listing cursor".to_string())?;
    if cursor.version != 1 || cursor.profile_id != input.profile_id || cursor.bucket != input.bucket
        || cursor.prefix != input.prefix.as_deref().unwrap_or("") || cursor.max_keys != max_keys
        || cursor.token.is_empty() {
        return Err("Object listing cursor does not match this account, bucket or prefix".to_string());
    }
    Ok(Some(cursor.token))
}

fn encode_object_cursor(input: &ObjectsListInput, max_keys: u16, token: &str) -> Result<String, String> {
    let cursor = ObjectCursor {
        version: 1, profile_id: input.profile_id.clone(), bucket: input.bucket.clone(),
        prefix: input.prefix.clone().unwrap_or_default(), max_keys, token: token.to_string(),
    };
    let bytes = serde_json::to_vec(&cursor).map_err(|_| "Could not encode object listing cursor".to_string())?;
    Ok(encode_base64(&bytes))
}

#[cfg(test)]
mod cursor_tests {
    use super::*;
    fn input() -> ObjectsListInput {
        ObjectsListInput { profile_id:"profile".to_string(), bucket:"bucket".to_string(), prefix:Some("中文/+%?#/".to_string()), max_keys:Some(100), cursor:None }
    }
    #[test]
    fn cursor_roundtrip_preserves_opaque_service_token_and_unicode_scope() {
        let mut request = input();
        let token = "provider/+token==not-an-object-key";
        request.cursor = Some(encode_object_cursor(&request, 100, token).unwrap());
        assert_eq!(decode_object_cursor(&request, 100).unwrap().as_deref(), Some(token));
    }
    #[test]
    fn cursor_cannot_be_reused_for_another_account_bucket_prefix_or_page_size() {
        let mut request = input();
        request.cursor = Some(encode_object_cursor(&request, 100, "next").unwrap());
        request.profile_id = "other".to_string(); assert!(decode_object_cursor(&request, 100).is_err());
        request.profile_id = "profile".to_string(); request.bucket="other".to_string(); assert!(decode_object_cursor(&request, 100).is_err());
        request.bucket="bucket".to_string(); request.prefix=None; assert!(decode_object_cursor(&request, 100).is_err());
        request.prefix=Some("中文/+%?#/".to_string()); assert!(decode_object_cursor(&request, 1000).is_err());
    }
    #[test]
    fn malformed_cursor_is_rejected_without_returning_its_contents() {
        let mut request=input(); request.cursor=Some("sensitive-not-a-cursor".to_string());
        let error=decode_object_cursor(&request,100).unwrap_err();
        assert!(!error.contains("sensitive"));
    }
}

async fn test_profile_connection(profile: &Profile) -> Value {
    if profile.provider == S3Provider::Qiniu {
        return match storage_backend::connection_report(profile).await {
            Ok(report) => report,
            Err(error) => json!({ "success": false, "bucketCount": 0, "error": error }),
        };
    }
    let client = match to_s3_client(profile) {
        Ok(client) => client,
        Err(error) => {
            return json!({ "success": false, "bucketCount": 0, "error": error });
        }
    };

    let mut bucket_error = None;
    if let Some(default_bucket) = profile.default_bucket.as_ref() {
        match client
            .head_bucket()
            .bucket(default_bucket.clone())
            .send()
            .await
        {
            Ok(_) => return json!({ "success": true, "bucketCount": 1 }),
            Err(error) => bucket_error = Some(s3_errors::describe("读取默认存储桶", &error)),
        }
        // Some providers deny HeadBucket but allow listing buckets.
    }

    match client.list_buckets().send().await {
        Ok(output) => json!({ "success": true, "bucketCount": output.buckets().len() }),
        Err(err) => {
            let list_error = s3_errors::describe("列出账号存储桶", &err);
            let error = bucket_error.map(|error| format!("{error}；{list_error}")).unwrap_or(list_error);
            json!({ "success": false, "bucketCount": 0, "error": error })
        },
    }
}

#[tauri::command]
pub(crate) async fn rpc_request(
    app: AppHandle,
    state: State<'_, AppState>,
    method: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    let payload = payload_or_null(payload);
    let update_control = method.starts_with("updates:") || method.starts_with("updater:");
    let method = RpcMethod::parse(&method)
        .ok_or_else(|| format!("RPC method not implemented yet: {method}"))?;
    let _operation = if update_control { None } else { Some(update_guard::begin(&state)?) };

    match method {
        RpcMethod::VaultOpenLocal => {
            let input:OpenLocalInput=if payload.is_null(){OpenLocalInput::default()}else{serde_json::from_value(payload).map_err(|_|"本地账号请求无效 / Invalid local account request".to_string())?};
            let directory=config_paths::object0_config_dir()?;
            let mut vault=lock_state(&state.vault)?;
            let mut candidate=vault.clone();
            let report=local_startup::open_local(&directory.join("vault.enc"),&directory.join("accounts.local.json"),&mut candidate,input.skip_legacy_import)?;
            if report.ready{adopt_local_candidate(&app,&state,&mut vault,candidate)?;}
            Ok(json!(report))
        }
        RpcMethod::VaultImportLegacy => {
            let input:ImportLegacyInput=serde_json::from_value(payload).map_err(|_|"旧账号导入请求无效 / Invalid legacy account import request".to_string())?;
            let directory=config_paths::object0_config_dir()?;
            let mut vault=lock_state(&state.vault)?;
            let mut candidate=vault.clone();
            let report=local_startup::import_legacy(&directory.join("vault.enc"),&directory.join("accounts.local.json"),&mut candidate,&input.passphrase)?;
            if report.ready{adopt_local_candidate(&app,&state,&mut vault,candidate)?;}
            Ok(json!(report))
        }
        RpcMethod::ProfileConnectQiniu => {
            let input:qiniu_connect::ConnectInput=serde_json::from_value(payload).map_err(|_|"七牛连接请求无效 / Invalid Qiniu connection request".to_string())?;
            Ok(json!(qiniu_connect::connect(&state,input).await?))
        }
        RpcMethod::ProfileConnectQiniuCancel => {
            let input:ConnectCancelInput=serde_json::from_value(payload).map_err(|_|"七牛连接取消请求无效 / Invalid Qiniu connection cancellation".to_string())?;
            qiniu_connect::cancel(&state,&input.request_id)?;
            Ok(Value::Null)
        }
        RpcMethod::QiniuShareCreate | RpcMethod::QiniuShareLogin | RpcMethod::QiniuShareList
        | RpcMethod::QiniuShareDownload | RpcMethod::QiniuShareClose => {
            qiniu_share_rpc::dispatch(&state, method, payload).await
        }
        RpcMethod::VaultStatus => {
            let path = vault_path()?;
            let vault=lock_state(&state.vault)?;plaintext_accounts::validate_active_mode(&vault,&path)?;
            let exists = path.exists();
            let plain=plaintext_accounts::is_path(&path);
            if plain {plaintext_accounts::load(&path)?;}
            let version = if exists {
                Some(if plain{5}else{match read_vault_file(&path)? { VaultFileDisk::V1(_) => 1, VaultFileDisk::V2(_) => 2, VaultFileDisk::V3(_) => 3, VaultFileDisk::V4(_) => 4 }})
            } else { None };
            let unlocked = vault.unlocked;
            let has_recovery_key = if exists&&!plain {
                has_recovery_key_on_disk(&path)?
            } else {
                false
            };

            Ok(json!({
                "exists": exists,
                "version": version,
                "unlocked": unlocked,
                "hasRecoveryKey": has_recovery_key,
                "storageMode":if plain{"plaintext"}else{"encrypted"},
                "configPath":path.to_string_lossy(),
            }))
        }
        RpcMethod::VaultEnablePlaintext => {
            let input:plaintext_accounts::EnableInput=serde_json::from_value(payload).map_err(|_|"明文模式请求无效 / Invalid plaintext-mode request".to_string())?;
            let directory=config_paths::object0_config_dir()?;
            let plain=config_paths::plaintext_accounts_path()?;
            let mut vault=lock_state(&state.vault)?;let mut candidate=vault.clone();
            plaintext_accounts::enable(&directory.join("vault.enc"),&plain,&mut candidate,input.confirm_plaintext)?;
            native_jobs::suspend_for_lock(&state,&vault);native_download_jobs::suspend_for_lock(&state,&vault);
            usage::cancel_all(&state);storage_backend::clear(&state);stop_all_folder_sync_rules(&app);
            *vault=candidate;
            Ok(json!({"success":true,"profiles":profile_infos(&vault),"storageMode":"plaintext","configPath":plain.to_string_lossy(),"hasRecoveryKey":false,"version":5}))
        }
        RpcMethod::VaultSetup => {
            let input: VaultSetupInput = parse_payload(payload)?;
            if input.passphrase.trim().is_empty() {
                return Err("Passphrase cannot be empty".to_string());
            }

            let path = vault_path()?;
            if path.exists() {
                return Err("Vault already exists".to_string());
            }

            let salt = random_bytes::<SALT_BYTES>();
            let key = derive_key(&input.passphrase, &salt);
            let recovery_salt = random_bytes::<SALT_BYTES>();
            let recovery_key_plain = generate_recovery_key();
            let recovery_key = derive_key(&recovery_key_plain, &recovery_salt);

            let mut vault = lock_state(&state.vault)?;
            let candidate = VaultRuntime { plaintext:false, unlocked: true, data: Some(VaultData::default()), key: Some(key), salt: Some(salt.to_vec()), recovery_key: Some(recovery_key), recovery_salt: Some(recovery_salt.to_vec()) };
            save_vault(&path, &candidate)?;
            *vault = candidate;
            drop(vault);

            if input.remember.unwrap_or(false) {
                if let Err(err) = store_passphrase(&input.passphrase) {
                    eprintln!("{err}");
                }
            } else {
                let _ = clear_stored_passphrase();
            }

            Ok(json!({ "success": true, "recoveryKey": recovery_key_plain }))
        }
        RpcMethod::VaultUnlock => {
            let input: VaultUnlockInput = parse_payload(payload)?;
            if input.passphrase.trim().is_empty() {
                return Ok(json!({
                    "success": false,
                    "profiles": [],
                    "hasRecoveryKey": false,
                }));
            }

            let path = vault_path()?;
            {let vault=lock_state(&state.vault)?;plaintext_accounts::validate_active_mode(&vault,&path)?;}
            if plaintext_accounts::is_path(&path){return Err(plaintext_accounts::PASSWORD_UNAVAILABLE.into())}
            if !path.exists() {
                return Ok(json!({
                    "success": false,
                    "profiles": [],
                    "hasRecoveryKey": false,
                }));
            }

            let has_recovery_key = has_recovery_key_on_disk(&path).unwrap_or(false);

            match unlock_with_passphrase(&path, &input.passphrase) {
                Ok(unlock) => {
                    let mut vault = lock_state(&state.vault)?;
                    plaintext_accounts::validate_active_mode(&vault,&path)?;
                    state.share_sessions.clear_all();
                    vault.plaintext = false;
                    vault.unlocked = true;
                    vault.data = Some(unlock.data);
                    vault.key = Some(unlock.key);
                    vault.salt = Some(unlock.salt);
                    vault.recovery_salt = unlock.recovery_salt;
                    vault.recovery_key = None;
                    let profiles = profile_infos(&vault);

                    if unlock.needs_rewrite {
                        save_vault(&path, &vault)?;
                    }
                    drop(vault);

                    if input.remember.unwrap_or(false) {
                        if let Err(err) = store_passphrase(&input.passphrase) {
                            eprintln!("{err}");
                        }
                    } else {
                        let _ = clear_stored_passphrase();
                    }

                    Ok(json!({
                        "success": true,
                        "profiles": profiles,
                        "hasRecoveryKey": unlock.has_recovery_key,
                    }))
                }
                Err(_) => Ok(json!({
                    "success": false,
                    "profiles": [],
                    "hasRecoveryKey": has_recovery_key,
                })),
            }
        }
        RpcMethod::VaultAutoUnlock | RpcMethod::VaultUnlockKeychain => {
            let path = vault_path()?;
            {let vault=lock_state(&state.vault)?;plaintext_accounts::validate_active_mode(&vault,&path)?;}
            if plaintext_accounts::is_path(&path){
                let candidate=plaintext_accounts::load(&path)?;
                let mut vault=lock_state(&state.vault)?;
                plaintext_accounts::validate_active_mode(&vault,&path)?;
                if !vault.unlocked {native_jobs::suspend_for_lock(&state,&vault);native_download_jobs::suspend_for_lock(&state,&vault);usage::cancel_all(&state);storage_backend::clear(&state);*vault=candidate;}
                return Ok(json!({"success":true,"profiles":profile_infos(&vault),"hasRecoveryKey":false,"storageMode":"plaintext","version":5,"configPath":path.to_string_lossy()}));
            }
            if !path.exists() {
                return Ok(json!({
                    "success": false,
                    "profiles": [],
                    "hasRecoveryKey": false,
                    "reason": "vault_missing",
                }));
            }

            let has_recovery_key = has_recovery_key_on_disk(&path).unwrap_or(false);

            {
                let vault = lock_state(&state.vault)?;
                plaintext_accounts::validate_active_mode(&vault,&path)?;
                if vault.unlocked {
                    return Ok(json!({
                        "success": true,
                        "profiles": profile_infos(&vault),
                        "hasRecoveryKey": has_recovery_key,
                    }));
                }
            }

            let passphrase = match read_stored_passphrase() {
                KeychainReadResult::Available(Some(passphrase)) => passphrase,
                KeychainReadResult::Available(None) => {
                    return Ok(json!({
                        "success": false,
                        "profiles": [],
                        "hasRecoveryKey": has_recovery_key,
                        "reason": "no_stored_passphrase",
                    }));
                }
                KeychainReadResult::Unavailable(detail) => {
                    return Ok(json!({
                        "success": false,
                        "profiles": [],
                        "hasRecoveryKey": has_recovery_key,
                        "reason": "keychain_unavailable",
                        "detail": detail,
                    }));
                }
            };

            match unlock_with_passphrase(&path, &passphrase) {
                Ok(unlock) => {
                    let mut vault = lock_state(&state.vault)?;
                    plaintext_accounts::validate_active_mode(&vault,&path)?;
                    state.share_sessions.clear_all();
                    vault.plaintext = false;
                    vault.unlocked = true;
                    vault.data = Some(unlock.data);
                    vault.key = Some(unlock.key);
                    vault.salt = Some(unlock.salt);
                    vault.recovery_salt = unlock.recovery_salt;
                    vault.recovery_key = None;

                    if unlock.needs_rewrite {
                        save_vault(&path, &vault)?;
                    }

                    Ok(json!({
                        "success": true,
                        "profiles": profile_infos(&vault),
                        "hasRecoveryKey": unlock.has_recovery_key,
                    }))
                }
                Err(_) => {
                    let _ = clear_stored_passphrase();
                    Ok(json!({
                        "success": false,
                        "profiles": [],
                        "hasRecoveryKey": has_recovery_key,
                        "reason": "stale_stored_passphrase",
                    }))
                }
            }
        }
        RpcMethod::VaultLock => {
            let mut vault = lock_state(&state.vault)?;
            native_jobs::suspend_for_lock(&state,&vault);
            native_download_jobs::suspend_for_lock(&state,&vault);
            lock_vault_runtime(&mut vault);
            usage::cancel_all(&state);
            storage_backend::clear(&state);
            stop_all_folder_sync_rules(&app);
            refresh_tray_menu(&app);
            Ok(Value::Null)
        }
        RpcMethod::VaultKeychainStatus => {
            let (has_stored, available, error) = match read_stored_passphrase() {
                KeychainReadResult::Available(Some(_)) => (true, true, String::new()),
                KeychainReadResult::Available(None) => (false, true, String::new()),
                KeychainReadResult::Unavailable(detail) => (false, false, detail),
            };
            Ok(json!({
                "hasStoredPassphrase": has_stored,
                "available": available,
                "error": error,
            }))
        }
        RpcMethod::VaultKeychainClear => match clear_stored_passphrase() {
            Ok(had) => Ok(json!({ "success": true, "hadStoredPassphrase": had })),
            Err(_) => Ok(json!({ "success": false, "hadStoredPassphrase": false })),
        },
        RpcMethod::VaultRecoverKey => {
            let input: RecoveryKeyInput = parse_payload(payload)?;
            let path = vault_path()?;
            {let vault=lock_state(&state.vault)?;plaintext_accounts::validate_active_mode(&vault,&path)?;}
            if plaintext_accounts::is_path(&path){return Err(plaintext_accounts::PASSWORD_UNAVAILABLE.into())}
            if !path.exists() {
                return Ok(json!({ "success": false, "profiles": [] }));
            }

            match unlock_with_recovery_key(&path, input.recovery_key.trim()) {
                Ok(unlock) => {
                    let mut vault = lock_state(&state.vault)?;
                    plaintext_accounts::validate_active_mode(&vault,&path)?;
                    usage::cancel_all(&state);
                    native_jobs::suspend_for_lock(&state,&vault);
                    native_download_jobs::suspend_for_lock(&state,&vault);
                    storage_backend::clear(&state);
                    vault.plaintext = false;
                    vault.unlocked = true;
                    vault.data = Some(unlock.data);
                    vault.key = None;
                    vault.salt = Some(unlock.salt);
                    vault.recovery_salt = Some(unlock.recovery_salt);
                    vault.recovery_key = Some(unlock.recovery_key);
                    let _ = clear_stored_passphrase();

                    Ok(json!({
                        "success": true,
                        "profiles": profile_infos(&vault),
                    }))
                }
                Err(_) => Ok(json!({ "success": false, "profiles": [] })),
            }
        }
        RpcMethod::VaultChangePassphrase => {
            let input: ChangePassphraseInput = parse_payload(payload)?;
            if input.new_passphrase.trim().is_empty() {
                return Err("Passphrase cannot be empty".to_string());
            }

            let path = vault_path()?;
            if plaintext_accounts::is_path(&path){return Err(plaintext_accounts::PASSWORD_UNAVAILABLE.into())}
            let mut vault = lock_state(&state.vault)?;
            ensure_unlocked(&vault)?;

            if vault.plaintext{return Err(plaintext_accounts::PASSWORD_UNAVAILABLE.into())}

            let new_salt = random_bytes::<SALT_BYTES>();
            let new_key = derive_key(&input.new_passphrase, &new_salt);
            let new_recovery_salt = random_bytes::<SALT_BYTES>();
            let new_recovery_key_plain = generate_recovery_key();
            let new_recovery_key = derive_key(&new_recovery_key_plain, &new_recovery_salt);

            let mut candidate = vault.clone();
            candidate.key = Some(new_key);
            candidate.salt = Some(new_salt.to_vec());
            candidate.recovery_key = Some(new_recovery_key);
            candidate.recovery_salt = Some(new_recovery_salt.to_vec());
            save_vault(&path, &candidate)?;
            *vault = candidate;
            drop(vault);

            if input.remember.unwrap_or(false) {
                if let Err(err) = store_passphrase(&input.new_passphrase) {
                    eprintln!("{err}");
                }
            } else {
                let _ = clear_stored_passphrase();
            }

            Ok(json!({ "success": true, "recoveryKey": new_recovery_key_plain }))
        }
        RpcMethod::VaultAddRecoveryKey => {
            let path = vault_path()?;
            if plaintext_accounts::is_path(&path){return Err(plaintext_accounts::PASSWORD_UNAVAILABLE.into())}
            let mut vault = lock_state(&state.vault)?;
            ensure_writable(&vault)?;
            if vault.plaintext{return Err(plaintext_accounts::PASSWORD_UNAVAILABLE.into())}

            let recovery_salt = random_bytes::<SALT_BYTES>();
            let recovery_key_plain = generate_recovery_key();
            let recovery_key = derive_key(&recovery_key_plain, &recovery_salt);

            let mut candidate = vault.clone();
            candidate.recovery_key = Some(recovery_key);
            candidate.recovery_salt = Some(recovery_salt.to_vec());
            save_vault(&path, &candidate)?;
            *vault = candidate;

            Ok(json!({ "recoveryKey": recovery_key_plain }))
        }
        RpcMethod::VaultRotateRecoveryKey => {
            let input: RotateRecoveryKeyInput = serde_json::from_value(payload)
                .map_err(|_| "恢复密钥更换请求格式无效 / Invalid recovery-key rotation request".to_string())?;
            let path=vault_path()?;
            let mut vault=lock_state(&state.vault)?;
            Ok(json!(rotate_recovery_key(&path,&mut vault,&input.passphrase,input.confirm_invalidate_old_key)?))
        }
        RpcMethod::VaultHasRecoveryKey => {
            let path = vault_path()?;
            {let vault=lock_state(&state.vault)?;plaintext_accounts::validate_active_mode(&vault,&path)?;}
            Ok(json!({ "hasRecoveryKey": if plaintext_accounts::is_path(&path){false}else{has_recovery_key_on_disk(&path)?} }))
        }
        RpcMethod::VaultReset => {
            let path = vault_path()?;
            if plaintext_accounts::is_path(&path){return Err("明文账号模式不提供重置；未删除本地账号或原加密库 / Reset is unavailable in plaintext mode; local accounts and the original encrypted vault were not deleted".into())}
            let mut vault = lock_state(&state.vault)?;
            if vault.plaintext{return Err("明文账号模式不提供重置；原加密库未删除 / Reset is unavailable in plaintext mode; the original encrypted vault was not deleted".into())}
            // Serialize removal with profile writes. Failure must not reset the
            // in-memory session while the old encrypted vault is still present.
            match fs::remove_file(&path) {
                Ok(()) => {},
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(_) => return Err("无法删除密码库，数据未重置 / Could not remove the vault; data was not reset".to_string()),
            }
            native_jobs::suspend_for_lock(&state,&vault);
            native_download_jobs::suspend_for_lock(&state,&vault);
            *vault = VaultRuntime::default();
            usage::cancel_all(&state);
            storage_backend::clear(&state);
            stop_all_folder_sync_rules(&app);
            refresh_tray_menu(&app);
            drop(vault);
            let _ = clear_stored_passphrase();
            Ok(json!({ "success": true }))
        }

        RpcMethod::ProfileList => {
            let vault = lock_state(&state.vault)?;
            ensure_unlocked(&vault)?;
            Ok(json!(profile_infos(&vault)))
        }
        RpcMethod::ProfileCredential => {
            let input: ProfileCredentialInput = parse_payload(payload)?;
            let vault = lock_state(&state.vault)?;
            ensure_unlocked(&vault)?;
            let profile = vault
                .data
                .as_ref()
                .and_then(|data| data.profiles.iter().find(|profile| profile.id == input.profile_id))
                .ok_or_else(|| "Profile not found".to_string())?;
            let value = match input.field {
                ProfileCredentialField::AccessKeyId => profile.access_key_id.as_str(),
                ProfileCredentialField::SecretAccessKey => profile.secret_access_key.as_str(),
            };
            Ok(json!({ "value": value }))
        }
        RpcMethod::ProfileAdd => {
            let input: ProfileInput = parse_payload(payload)?;
            let analytics_token = usage::normalize_analytics_token(input.r2_analytics_token)?;
            let path = vault_path()?;
            let mut vault = lock_state(&state.vault)?;
            ensure_writable(&vault)?;

            if input.name.trim().is_empty() || input.access_key_id.trim().is_empty() || input.secret_access_key.trim().is_empty() {
                return Err("Profile name and credentials cannot be empty".to_string());
            }
            let previous_data = vault.data.clone();
            let previous_recovery_key = vault.recovery_key;

            let timestamp = now_iso();
            let profile = Profile {
                id: Uuid::new_v4().to_string(),
                name: input.name,
                provider: input.provider,
                access_key_id: input.access_key_id,
                secret_access_key: input.secret_access_key,
                session_token: input.session_token,
                endpoint: input.endpoint,
                region: input.region,
                default_bucket: input.default_bucket,
                r2_analytics_token: if input.provider == S3Provider::R2 { analytics_token } else { None },
                qiniu: if input.provider == S3Provider::Qiniu { Some(input.qiniu.unwrap_or_default()) } else { None },
                created_at: timestamp.clone(),
                updated_at: timestamp,
            };

            if profile.provider == S3Provider::Qiniu {
                storage_backend::qiniu_client(&profile)?; // validate without making a request
                authorize_qiniu_migration_recovery(&path, &mut vault, input.migration_recovery_key.as_deref())?;
            }

            let data = vault
                .data
                .as_mut()
                .ok_or_else(|| "Vault is locked".to_string())?;
            data.profiles.push(profile.clone());
            if let Err(error) = save_vault(&path, &vault) {
                vault.data = previous_data;
                vault.recovery_key = previous_recovery_key;
                return Err(error);
            }

            Ok(json!(to_profile_info(&profile)))
        }
        RpcMethod::ProfileUpdate => {
            let input: ProfileUpdateInput = parse_payload(payload)?;
            let analytics_token = usage::normalize_analytics_token(input.r2_analytics_token)?;
            let path = vault_path()?;
            let mut vault = lock_state(&state.vault)?;
            ensure_writable(&vault)?;
            if !vault.data.as_ref().is_some_and(|data| data.profiles.iter().any(|profile| profile.id == input.id)) {
                return Err("Profile not found".to_string());
            }

            let previous_data = vault.data.clone();
            let previous_recovery_key = vault.recovery_key;
            if input.provider == S3Provider::Qiniu {
                authorize_qiniu_migration_recovery(&path, &mut vault, input.migration_recovery_key.as_deref())?;
            }

            let data = vault
                .data
                .as_mut()
                .ok_or_else(|| "Vault is locked".to_string())?;

            let Some(profile) = data
                .profiles
                .iter_mut()
                .find(|profile| profile.id == input.id)
            else {
                return Err("Profile not found".to_string());
            };

            if profile.provider != input.provider {
                if input.access_key_id.as_deref().is_none_or(|key|key.trim().is_empty()) || input.secret_access_key.as_deref().is_none_or(|key|key.trim().is_empty()) {
                    vault.data=previous_data;vault.recovery_key=previous_recovery_key;
                    return Err("更换服务商必须重新填写两项凭据，不能把旧账号密钥发送给新服务 / Changing provider requires both credentials to be explicitly re-entered".into());
                }
                profile.session_token=None;
            }
            profile.name = input.name;
            profile.provider = input.provider;
            if let Some(access_key_id) = input.access_key_id {
                if !access_key_id.trim().is_empty() {
                    profile.access_key_id = access_key_id;
                }
            }
            if let Some(secret_access_key) = input.secret_access_key {
                if !secret_access_key.trim().is_empty() {
                    profile.secret_access_key = secret_access_key;
                }
            }
            if let Some(session_token) = input.session_token {
                profile.session_token = session_token.filter(|value| !value.trim().is_empty());
            }
            profile.endpoint = input.endpoint;
            profile.region = input.region;
            profile.default_bucket = input.default_bucket;
            if input.provider == S3Provider::Qiniu {
                profile.qiniu = input.qiniu.or_else(|| profile.qiniu.clone()).or_else(|| Some(qiniu::QiniuConfig::default()));
            } else {
                profile.qiniu = None;
            }
            if input.provider != S3Provider::R2 || input.clear_r2_analytics_token {
                profile.r2_analytics_token = None;
            } else if let Some(token) = analytics_token {
                profile.r2_analytics_token = Some(token);
            }
            profile.updated_at = now_iso();

            if profile.access_key_id.trim().is_empty()
                || profile.secret_access_key.trim().is_empty()
            {
                vault.data = previous_data;
                vault.recovery_key = previous_recovery_key;
                return Err("Profile credentials cannot be empty".to_string());
            }

            if profile.provider == S3Provider::Qiniu {
                if let Err(error) = storage_backend::qiniu_client(profile) {
                    vault.data = previous_data;
                    vault.recovery_key = previous_recovery_key;
                    return Err(error);
                }
            }

            let profile_info = to_profile_info(profile);
            if let Err(error) = save_vault(&path, &vault) {
                vault.data = previous_data;
                vault.recovery_key = previous_recovery_key;
                return Err(error);
            }
            storage_backend::invalidate(&state, &input.id);

            Ok(json!(profile_info))
        }
        RpcMethod::ProfileRemove => {
            let input: IdInput = parse_payload(payload)?;
            let path = vault_path()?;
            let mut vault = lock_state(&state.vault)?;
            ensure_writable(&vault)?;

            let mut candidate = vault.clone();
            let data = candidate
                .data
                .as_mut()
                .ok_or_else(|| "Vault is locked".to_string())?;
            let before = data.profiles.len();
            data.profiles.retain(|profile| profile.id != input.id);

            if before == data.profiles.len() {
                return Err("Profile not found".to_string());
            }

            save_vault(&path, &candidate)?;
            *vault = candidate;
            storage_backend::invalidate(&state, &input.id);
            Ok(Value::Null)
        }
        RpcMethod::ProfileTest => {
            let input: ProfileTestInput = parse_payload(payload)?;
            let (profile,saved)=profile_test_draft::prepare_profile_test(&state,input)?;
            if let Some(saved)=saved {
                return storage_backend::guarded(&state,&saved,async {Ok(test_profile_connection(&profile).await)}).await;
            }
            Ok(test_profile_connection(&profile).await)
        }
        RpcMethod::ProfileTestSaved => {
            let input: ProfileIdInput = parse_payload(payload)?;
            let profile = profile_for_id(&state, &input.profile_id)?;
            if profile.provider == S3Provider::Qiniu {
                return storage_backend::guarded(&state, &profile, async { storage_backend::connection_report(&profile).await }).await;
            }
            Ok(test_profile_connection(&profile).await)
        }

        RpcMethod::BucketsUsage => {
            let input: usage::UsageInput = parse_payload(payload)?;
            Ok(json!(usage::get(&state, input).await?))
        }
        RpcMethod::BucketsUsageCancel => {
            let input: usage::UsageCancelInput = parse_payload(payload)?;
            usage::cancel(&state, input)?;
            Ok(Value::Null)
        }
        RpcMethod::QiniuRegions => {
            let input: ProfileIdInput = parse_payload(payload)?;
            let (profile, client) = storage_backend::qiniu_for_id(&state, &input.profile_id)?;
            storage_backend::guarded(&state, &profile, async {
                Ok(json!(client.discover_regions().await.map_err(|error| error.to_string())?))
            }).await
        }
        RpcMethod::QiniuBucketContext => {
            let input: QiniuBucketInput = parse_payload(payload)?;
            let (profile, client) = storage_backend::qiniu_for_id(&state, &input.profile_id)?;
            storage_backend::guarded(&state, &profile, async {
                Ok(json!(client.resolve_named_bucket(&input.bucket).await.map_err(|error| error.to_string())?))
            }).await
        }
        RpcMethod::QiniuBucketDetails | RpcMethod::QiniuBucketDomains => {
            let input: QiniuBucketInput = parse_payload(payload)?;
            let (profile, client) = storage_backend::qiniu_for_id(&state, &input.profile_id)?;
            storage_backend::guarded(&state, &profile, async {
                if method == RpcMethod::QiniuBucketDetails {
                    Ok(json!(client.bucket_details(&input.bucket).await.map_err(|error| error.to_string())?))
                } else {
                    Ok(json!(client.list_domains(&input.bucket).await))
                }
            }).await
        }
        RpcMethod::QiniuBucketCreate => {
            let input: QiniuCreateBucketInput = parse_payload(payload)?;
            if input.access != "private" { return Err("目前只支持安全创建私有空间 / Only private bucket creation is currently supported".to_string()); }
            let (profile, client) = storage_backend::qiniu_for_id(&state, &input.profile_id)?;
            storage_backend::guarded(&state, &profile, async {
                let buckets = client.list_buckets().await.map_err(|error| error.to_string())?;
                if buckets.iter().any(|bucket| bucket.name == input.name) { return Err("该空间已存在 / Bucket already exists".to_string()); }
                qiniu_privacy_gate::mark(client.config(), &input.name)?;
                let created = client.create_private_bucket(&input.name, &input.region_id).await.map_err(|error| error.to_string())?;
                if !created.private_verified { return Err("空间私有状态未确认，上传已禁用 / Bucket privacy is unverified; uploads are blocked".to_string()); }
                qiniu_privacy_gate::clear(client.config(), &input.name)?;
                Ok(json!(created))
            }).await
        }
        RpcMethod::QiniuDownloadOptions => {
            let input:QiniuBucketInput=parse_payload(payload)?;
            let (profile,client)=storage_backend::qiniu_for_id(&state,&input.profile_id)?;
            storage_backend::guarded(&state,&profile,async {
                let context=client.resolve_named_bucket(&input.bucket).await.map_err(|error|error.to_string())?;
                Ok(json!(qiniu_download::download_options(&client,&context).await?))
            }).await
        }
        RpcMethod::QiniuBucketDelete => {
            let input: QiniuDeleteBucketInput = parse_payload(payload)?;
            if input.bucket != input.confirm_name { return Err("请输入完整空间名称确认删除 / Enter the exact bucket name to confirm deletion".to_string()); }
            let (profile, client) = storage_backend::qiniu_for_id(&state, &input.profile_id)?;
            storage_backend::guarded(&state, &profile, async {
                let context = client.resolve_named_bucket(&input.bucket).await.map_err(|error| error.to_string())?;
                if context.backend_mode != "kodo" { return Err("私有云空间删除尚未验证 / Private-cloud bucket deletion is not yet verified".to_string()); }
                client.delete_empty_bucket(&context).await.map_err(|error| error.to_string())?;
                qiniu_privacy_gate::clear(client.config(), &context.bucket.name)?;
                Ok(Value::Null)
            }).await
        }
        RpcMethod::QiniuBucketRemark => {
            let input: QiniuRemarkInput = parse_payload(payload)?;
            let (profile, client) = storage_backend::qiniu_for_id(&state, &input.profile_id)?;
            storage_backend::guarded(&state, &profile, async {
                client.update_bucket_remark(&input.bucket, &input.remark).await.map_err(|error| error.to_string())?;
                Ok(Value::Null)
            }).await
        }
        RpcMethod::QiniuObjectChangeType | RpcMethod::QiniuObjectRestore => {
            let input: QiniuObjectMutationInput = parse_payload(payload)?;
            let (profile, client) = prepare_qiniu_object_mutation(&state, &input)?;
            storage_backend::guarded(&state, &profile, async {
                let context = client.resolve_named_bucket(&input.bucket).await.map_err(|error| error.to_string())?;
                if context.backend_mode != "kodo" { return Err("此七牛环境的存储类型操作尚未验证 / Storage-class operations are not yet verified in this Qiniu environment".to_string()); }
                let mut guard = usage::UsageChangeGuard::new(&app, &input.profile_id, &input.bucket);
                let mut results=Vec::with_capacity(input.keys.len());
                for key in &input.keys {
                    guard.mark_changed();
                    let result = if method == RpcMethod::QiniuObjectChangeType { client.change_storage_type(&context, key, input.value).await } else { client.restore_archive(&context, key, input.value).await };
                    match result {
                        Ok(()) => results.push(json!({"key":key,"success":true})),
                        Err(error) => results.push(json!({"key":key,"success":false,"error":error.to_string()})),
                    }
                }
                Ok(json!({"results":results}))
            }).await
        }
        RpcMethod::BucketsList => {
            let input: ProfileIdInput = parse_payload(payload)?;
            let profile = profile_for_id(&state, &input.profile_id)?;
            if let storage_backend::StorageBackend::Qiniu(client) = storage_backend::get(&state, &profile)? {
                return storage_backend::guarded(&state, &profile, async {
                  let buckets = client.list_buckets().await.map_err(|error| error.to_string())?;
                  Ok(json!(buckets.into_iter().map(|bucket| json!({
                    "name": bucket.name,
                    "creationDate": bucket.created_at,
                    "regionId": bucket.kodo_region_id,
                    "s3Name": bucket.s3_name,
                    "permission": bucket.permission,
                    "remark": bucket.remark,
                  })).collect::<Vec<_>>()))
                }).await;
            }
            let client = to_s3_client(&profile)?;

            match client.list_buckets().send().await {
                Ok(output) => {
                    let buckets: Vec<Value> = output
                        .buckets()
                        .iter()
                        .filter_map(|bucket| {
                            let name = bucket.name()?;
                            let creation_date = bucket.creation_date().map(s3_datetime_to_iso);
                            Some(json!({
                                "name": name,
                                "creationDate": creation_date,
                            }))
                        })
                        .collect();
                    Ok(json!(buckets))
                }
                Err(err) => {
                    if let Some(default_bucket) = profile.default_bucket {
                        if !default_bucket.trim().is_empty() {
                            return Ok(json!([{ "name": default_bucket }]));
                        }
                    }

                    Err(s3_errors::describe("列出账号存储桶", &err))
                }
            }
        }

        RpcMethod::ObjectsList => {
            let input: ObjectsListInput = parse_payload(payload)?;
            let max_keys = input.max_keys.unwrap_or(1000);
            if !(1..=1000).contains(&max_keys) { return Err("Page size must be between 1 and 1000".to_string()); }
            let continuation_token = decode_object_cursor(&input, max_keys)?;
            let profile = profile_for_id(&state, &input.profile_id)?;
            let client = match storage_backend::get(&state, &profile)? {
                storage_backend::StorageBackend::S3(client) => client,
                storage_backend::StorageBackend::Qiniu(client) => {
                  return storage_backend::guarded(&state, &profile, async {
                    let context = client.resolve_named_bucket(&input.bucket).await.map_err(|error| error.to_string())?;
                    if context.backend_mode == "s3" {
                        let bridge=storage_backend::qiniu_s3_bridge(&profile,&context)?;
                        let mut request=bridge.client.list_objects_v2().bucket(&bridge.bucket_name).delimiter("/").max_keys(max_keys.into());
                        if let Some(prefix)=input.prefix.as_deref(){request=request.prefix(prefix);}
                        if let Some(token)=continuation_token.as_deref(){request=request.continuation_token(token);}
                        let output=request.send().await.map_err(|error|s3_errors::describe("加载文件列表",&error))?;
                        let truncated=output.is_truncated().unwrap_or(false);
                        let next=if truncated {
                            let token=output.next_continuation_token().filter(|token|!token.is_empty()).ok_or_else(||"Storage returned a truncated listing without a continuation token".to_string())?;
                            if continuation_token.as_deref()==Some(token){return Err("Storage repeated its object listing continuation token".to_string());}
                            Some(encode_object_cursor(&input,max_keys,token)?)
                        }else{None};
                        let objects:Vec<Value>=output.contents().iter().filter(|object|!is_current_directory_marker(object.key().unwrap_or_default(),input.prefix.as_deref())).map(|object|json!({"key":object.key().unwrap_or_default(),"size":object.size().unwrap_or(0).max(0),"lastModified":object.last_modified().map(s3_datetime_to_iso).unwrap_or_default(),"etag":object.e_tag().unwrap_or_default().trim_matches('"'),"storageClass":object.storage_class().map(|value|value.as_str())})).collect();
                        let prefixes:Vec<Value>=output.common_prefixes().iter().filter_map(|prefix|prefix.prefix().map(|value|json!({"prefix":value}))).collect();
                        return Ok(json!({"objects":objects,"prefixes":prefixes,"isTruncated":truncated,"nextCursor":next}));
                    }
                    if context.backend_mode != "kodo" {
                        return Err("未知七牛连接模式 / Unknown Qiniu backend mode".to_string());
                    }
                    let page = client.list_objects(&context, input.prefix.as_deref().unwrap_or(""), Some("/"), continuation_token.as_deref(), max_keys).await.map_err(|error| error.to_string())?;
                    if page.is_truncated && (page.next_cursor.is_none() || page.next_cursor.as_deref() == continuation_token.as_deref()) {
                        return Err("Qiniu returned a missing or repeated object cursor".to_string());
                    }
                    let next = page.next_cursor.as_deref().map(|cursor| encode_object_cursor(&input, max_keys, cursor)).transpose()?;
                    let objects: Vec<Value> = page.objects.into_iter().filter(|object|!is_current_directory_marker(&object.key,input.prefix.as_deref())).map(|object| json!({
                        "key":object.key,"size":object.size,"lastModified":object.last_modified,"etag":object.etag,
                        "storageClass":object.storage_type.map(|value| format!("qiniu:{value}")),
                        "restoreStatus":object.restore_status,
                    })).collect();
                    let prefixes: Vec<Value> = page.prefixes.into_iter().map(|prefix| json!({"prefix":prefix})).collect();
                    Ok(json!({"objects":objects,"prefixes":prefixes,"isTruncated":page.is_truncated,"nextCursor":next}))
                  }).await;
                }
            };

            let mut request = client
                .list_objects_v2()
                .bucket(input.bucket.clone())
                .delimiter("/");

            if let Some(prefix) = input.prefix.as_deref() {
                request = request.prefix(prefix);
            }
            request = request.max_keys(max_keys.into());
            if let Some(token) = continuation_token.as_deref() {
                request = request.continuation_token(token);
            }

            let output = request.send().await.map_err(|err| s3_errors::describe("加载文件列表", &err))?;

            let objects: Vec<Value> = output
                .contents()
                .iter()
                .filter(|item| !is_current_directory_marker(item.key().unwrap_or_default(), input.prefix.as_deref()))
                .map(|item| {
                    json!({
                        "key": item.key().unwrap_or_default(),
                        "size": item.size().unwrap_or(0).max(0),
                        "lastModified": item.last_modified().map(s3_datetime_to_iso).unwrap_or_default(),
                        "etag": item.e_tag().unwrap_or_default().trim_matches('"'),
                        "storageClass": item.storage_class().map(|value| value.as_str()),
                    })
                })
                .collect();

            let prefixes: Vec<Value> = output
                .common_prefixes()
                .iter()
                .filter_map(|prefix| prefix.prefix().map(|p| json!({ "prefix": p })))
                .collect();

            let truncated = output.is_truncated().unwrap_or(false);
            let next_cursor = if truncated {
                let token = output.next_continuation_token().filter(|token| !token.is_empty())
                    .ok_or_else(|| "Storage returned a truncated listing without a continuation token".to_string())?;
                if continuation_token.as_deref() == Some(token) {
                    return Err("Storage repeated its object listing continuation token".to_string());
                }
                Some(encode_object_cursor(&input, max_keys, token)?)
            } else { None };

            Ok(json!({
                "objects": objects,
                "prefixes": prefixes,
                "isTruncated": truncated,
                "nextCursor": next_cursor,
            }))
        }
        RpcMethod::ObjectsDelete => {
            let input: ObjectsDeleteInput = parse_payload(payload)?;
            let profile = profile_for_id(&state, &input.profile_id)?;
            storage_backend::ensure_expected_revision(&profile,input.expected_profile_revision.as_deref())?;
            if input.keys.is_empty() {
                return Ok(json!(batch_delete::DeleteReport::default()));
            }

            let mut usage_change = usage::UsageChangeGuard::new(
                &app, &input.profile_id, &input.bucket,
            );

            if let storage_backend::StorageBackend::Qiniu(client) = storage_backend::get(&state, &profile)? {
              return storage_backend::guarded(&state, &profile, async {
                storage_backend::ensure_qiniu_file_mutations(&input.keys)?;
                let context = client.resolve_named_bucket(&input.bucket).await.map_err(|error| error.to_string())?;
                storage_backend::ensure_qiniu_writable(&context.bucket)?;
                usage_change.mark_changed();
                if context.backend_mode == "s3" {
                    let bridge=storage_backend::qiniu_s3_bridge(&profile,&context)?;
                    return Ok(json!(batch_delete::s3_delete_report(&bridge.client,&bridge.bucket_name,&input.keys).await?));
                }
                if context.backend_mode != "kodo" { return Err("未知七牛连接模式 / Unknown Qiniu backend mode".to_string()); }
                Ok(json!(batch_delete::qiniu_delete_report(&client,&context,&input.keys).await?))
              }).await;
            }
            let client = to_s3_client(&profile)?;

            usage_change.mark_changed();
            Ok(json!(batch_delete::s3_delete_report(&client, &input.bucket, &input.keys).await?))
        }
        RpcMethod::ObjectsRename => {
            let input: ObjectsRenameInput = parse_payload(payload)?;
            if !input.verification_readback_confirmed { return Err("请确认完整校验可能产生的读取流量费用 / Confirm possible readback costs before renaming".to_string()); }
            validate_distinct_object(&input.bucket, &input.old_key, &input.bucket, &input.new_key)?;
            let mut usage_change = usage::UsageChangeGuard::new(
                &app, &input.profile_id, &input.bucket,
            );
            let profile = profile_for_id(&state, &input.profile_id)?;
            if let storage_backend::StorageBackend::Qiniu(client) = storage_backend::get(&state, &profile)? {
              return storage_backend::guarded(&state, &profile, async {
                storage_backend::ensure_qiniu_file_mutations(&[input.old_key.clone(),input.new_key.clone()])?;
                let context = client.resolve_named_bucket(&input.bucket).await.map_err(|error| error.to_string())?;
                storage_backend::ensure_qiniu_writable(&context.bucket)?;
                qiniu_privacy_gate::ensure_verified(&client, &context).await?;
                usage_change.mark_changed();
                if context.backend_mode == "s3" {
                    let bridge=storage_backend::qiniu_s3_bridge(&profile,&context)?;
                    let cancel=AtomicBool::new(false);
                    s3_copy_object(&bridge.client,&bridge.bucket_name,&input.old_key,&bridge.client,&bridge.bucket_name,&input.new_key,&cancel,|_,_|{}).await?;
                    s3_verify_and_delete_source(&bridge.client,&bridge.bucket_name,&input.old_key,&bridge.client,&bridge.bucket_name,&input.new_key,&cancel).await?;
                    return Ok(Value::Null);
                }
                if context.backend_mode != "kodo" { return Err("未知七牛连接模式 / Unknown Qiniu backend mode".to_string()); }
                client.copy_or_move(&context, &input.old_key, &context, &input.new_key, false, true).await.map_err(|error| error.to_string())?;
                Ok(Value::Null)
              }).await;
            }
            let client = to_s3_client(&profile)?;
            let cancel = AtomicBool::new(false);
            usage_change.mark_changed();
            s3_copy_object(&client, &input.bucket, &input.old_key,
                &client, &input.bucket, &input.new_key, &cancel, |_, _| {}).await?;
            s3_verify_and_delete_source(&client, &input.bucket, &input.old_key,
                &client, &input.bucket, &input.new_key, &cancel).await?;

            Ok(Value::Null)
        }
        RpcMethod::ObjectsStat => {
            let input: ObjectsStatInput = parse_payload(payload)?;
            let profile = profile_for_id(&state, &input.profile_id)?;
            let client = match storage_backend::get(&state, &profile)? {
                storage_backend::StorageBackend::S3(client) => client,
                storage_backend::StorageBackend::Qiniu(client) => {
                  return storage_backend::guarded(&state, &profile, async {
                    let context = client.resolve_named_bucket(&input.bucket).await.map_err(|error| error.to_string())?;
                    if context.backend_mode == "s3" {
                        let bridge=storage_backend::qiniu_s3_bridge(&profile,&context)?;
                        let output=bridge.client.head_object().bucket(&bridge.bucket_name).key(&input.key).send().await.map_err(|error|s3_errors::describe("读取对象详情",&error))?;
                        return Ok(json!({"size":output.content_length().unwrap_or(0).max(0),"etag":output.e_tag().unwrap_or_default().trim_matches('"'),"lastModified":output.last_modified().map(s3_datetime_to_iso).unwrap_or_else(now_iso),"type":output.content_type().unwrap_or("application/octet-stream"),"metadata":output.metadata()}));
                    }
                    if context.backend_mode != "kodo" { return Err("未知七牛连接模式 / Unknown Qiniu backend mode".to_string()); }
                    let object = client.stat(&context, &input.key).await.map_err(|error| error.to_string())?;
                    Ok(json!({"size":object.size,"etag":object.etag,"lastModified":object.last_modified,"type":object.mime_type.unwrap_or_else(||"application/octet-stream".to_string()),"metadata":object.metadata,"storageType":object.storage_type,"restoreStatus":object.restore_status}))
                  }).await;
                }
            };

            let output = client
                .head_object()
                .bucket(input.bucket)
                .key(input.key)
                .send()
                .await
                .map_err(|err| err.to_string())?;

            Ok(json!({
                "size": output.content_length().unwrap_or(0).max(0),
                "etag": output.e_tag().unwrap_or_default().trim_matches('"'),
                "lastModified": output.last_modified().map(s3_datetime_to_iso).unwrap_or_else(now_iso),
                "type": output.content_type().unwrap_or("application/octet-stream"),
            }))
        }

        RpcMethod::ObjectsReadText => {
            let input: text_objects::ReadInput = parse_payload(payload)?;
            let result = text_objects::read_for_state(&state, &input).await?;
            serde_json::to_value(result).map_err(|_| "无法返回文本内容 / Could not return text content".to_string())
        }
        RpcMethod::ObjectsWriteText => {
            let input: text_objects::WriteInput = parse_payload(payload)?;
            let result = text_objects::write_for_state(&state, &input).await?;
            usage::emit_changed(&app, &input.profile_id, &input.bucket);
            serde_json::to_value(result).map_err(|_| "无法返回保存结果 / Could not return save result".to_string())
        }

        RpcMethod::TransferUpload => {
            let input: UploadInput = parse_payload(payload)?;
            let upload_profile=profile_for_id(&state,&input.profile_id)?;
            storage_backend::ensure_expected_revision(&upload_profile,input.expected_profile_revision.as_deref())?;
            let bytes_total = upload_source_size(&input.local_path)?;
            let file_name = input
                .key
                .split('/')
                .filter(|part| !part.is_empty())
                .last()
                .unwrap_or(input.key.as_str())
                .to_string();
            let job_id = native_jobs::enqueue_upload(
                &app,
                file_name,
                format!("上传到 {}/{}", input.bucket, input.key),
                bytes_total,
                JobTaskKind::Upload {
                    profile_id: input.profile_id,
                    profile_revision:upload_profile.updated_at,
                    provider:upload_profile.provider,
                    bucket: input.bucket,
                    key: input.key,
                    local_path: input.local_path,
                },
            ).await?;
            Ok(json!({ "jobId": job_id }))
        }
        RpcMethod::TransferDownload => {
            let input: DownloadInput = parse_payload(payload)?;
            let download_profile=profile_for_id(&state,&input.profile_id)?;
            storage_backend::ensure_expected_revision(&download_profile,input.expected_profile_revision.as_deref())?;
            let file_name = input
                .key
                .split('/')
                .filter(|part| !part.is_empty())
                .last()
                .unwrap_or(input.key.as_str())
                .to_string();
            let job_id = native_download_jobs::enqueue_download(
                &app,
                file_name,
                format!("下载 {}/{}", input.bucket, input.key),
                JobTaskKind::Download {
                    profile_id: input.profile_id,
                    profile_revision: download_profile.updated_at,
                    bucket: input.bucket,
                    key: input.key,
                    local_path: input.local_path,
                    download_domain: input.download_domain,
                },
            ).await?;
            Ok(json!({ "jobId": job_id }))
        }
        RpcMethod::TransferPickAndUpload => {
            let input: PickUploadInput = parse_payload(payload)?;
            // Capture before opening the picker and reuse for the entire batch.
            let upload_profile=profile_for_id(&state,&input.profile_id)?;
            storage_backend::ensure_expected_revision(&upload_profile,input.expected_profile_revision.as_deref())?;
            let Some(paths) = FileDialog::new().pick_files() else {
                // User cancelled the native dialog — not an error.
                return Ok(json!({ "jobIds": [] }));
            };
            if paths.is_empty() {
                return Ok(json!({ "jobIds": [] }));
            }

            let mut job_ids = Vec::new();
            for path in paths {
                let file_name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("file")
                    .to_string();
                let key = format!("{}{}", input.prefix, file_name);
                let bytes_total = fs::metadata(&path)
                    .map(|meta| meta.len() as i64)
                    .unwrap_or(0)
                    .max(0);
                let job_id = native_jobs::enqueue_upload(
                    &app,
                    file_name.clone(),
                    format!("上传到 {}/{}", input.bucket, key),
                    bytes_total,
                    JobTaskKind::Upload {
                        profile_id: input.profile_id.clone(),
                        profile_revision:upload_profile.updated_at.clone(),
                        provider:upload_profile.provider,
                        bucket: input.bucket.clone(),
                        key,
                        local_path: path.to_string_lossy().to_string(),
                    },
                ).await?;
                job_ids.push(job_id);
            }

            Ok(json!({ "jobIds": job_ids }))
        }
        RpcMethod::TransferPickAndUploadFolder => {
            let input: PickUploadInput = parse_payload(payload)?;
            let upload_profile=profile_for_id(&state,&input.profile_id)?;
            storage_backend::ensure_expected_revision(&upload_profile,input.expected_profile_revision.as_deref())?;
            let Some(dir_path) = FileDialog::new().pick_folder() else {
                // User cancelled the native dialog — not an error.
                return Ok(json!({ "jobIds": [] }));
            };
            let dir_name = dir_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("folder")
                .to_string();

            let mut files = Vec::new();
            for entry in WalkDir::new(&dir_path).into_iter().filter_map(Result::ok) {
                if entry.file_type().is_file() {
                    files.push(entry.into_path());
                }
            }
            if files.is_empty() {
                return Err("Selected folder is empty".to_string());
            }

            let mut job_ids = Vec::new();
            for file_path in files {
                let Ok(relative) = file_path.strip_prefix(&dir_path) else {
                    continue;
                };
                let relative_path = normalize_slashes(relative);
                if relative_path.is_empty() {
                    continue;
                }
                let key = format!("{}{}/{}", input.prefix, dir_name, relative_path);
                let bytes_total = fs::metadata(&file_path)
                    .map(|meta| meta.len() as i64)
                    .unwrap_or(0)
                    .max(0);
                let job_id = native_jobs::enqueue_upload(
                    &app,
                    relative_path.clone(),
                    format!("上传到 {}/{}", input.bucket, key),
                    bytes_total,
                    JobTaskKind::Upload {
                        profile_id: input.profile_id.clone(),
                        profile_revision:upload_profile.updated_at.clone(),
                        provider:upload_profile.provider,
                        bucket: input.bucket.clone(),
                        key,
                        local_path: file_path.to_string_lossy().to_string(),
                    },
                ).await?;
                job_ids.push(job_id);
            }

            Ok(json!({ "jobIds": job_ids }))
        }
        RpcMethod::TransferDownloadFolder => {
            let input: DownloadFolderInput = parse_payload(payload)?;
            let download_profile=profile_for_id(&state,&input.profile_id)?;
            let client = s3_client_for_profile(&state, &input.profile_id)?;
            let Some(destination) = FileDialog::new().pick_folder() else {
                return Err("No destination folder selected".to_string());
            };

            let prefix = normalize_prefix(&input.prefix);
            let objects = s3_list_all_objects(&client, &input.bucket, &prefix).await?;
            if objects.is_empty() {
                return Err("Folder is empty".to_string());
            }

            let folder_name = input
                .prefix
                .trim_end_matches('/')
                .split('/')
                .filter(|part| !part.is_empty())
                .last()
                .unwrap_or("download")
                .to_string();

            let mut job_ids = Vec::new();
            for RemoteObject { key, size, .. } in objects {
                let relative_path = if prefix.is_empty() {
                    key.clone()
                } else if key.starts_with(&prefix) {
                    key[prefix.len()..].to_string()
                } else {
                    continue;
                };
                if relative_path.is_empty() {
                    continue;
                }
                let Some(safe_relative) = sanitize_relative_path(&relative_path) else {
                    // Skip remote keys that would escape the destination directory.
                    continue;
                };
                let local_path = destination.join(&folder_name).join(&safe_relative);
                let job_id = enqueue_job(
                    &app,
                    JobType::Download,
                    relative_path.clone(),
                    format!("下载 {}/{}", input.bucket, key),
                    size.max(0),
                    JobTaskKind::Download {
                        profile_id: input.profile_id.clone(),
                        profile_revision: download_profile.updated_at.clone(),
                        bucket: input.bucket.clone(),
                        key,
                        local_path: local_path.to_string_lossy().to_string(),
                        download_domain: None,
                    },
                )?;
                job_ids.push(job_id);
            }

            Ok(json!({ "jobIds": job_ids }))
        }
        RpcMethod::TransferCopy => {
            let input: CopyInput = parse_payload(payload)?;
            let (source_profile,dest_profile)=transfer_profiles(&state,&input.source_profile_id,&input.dest_profile_id)?;
            if (input.source_profile_id != input.dest_profile_id || input.source_bucket != input.dest_bucket) && !input.verification_readback_confirmed {
                return Err("请确认跨空间复制可能使用本机中转并产生流量费用 / Confirm potential local relay and bandwidth costs before copying".to_string());
            }
            let file_name = input
                .source_key
                .split('/')
                .filter(|part| !part.is_empty())
                .last()
                .unwrap_or(input.source_key.as_str())
                .to_string();
            let job_id = enqueue_job(
                &app,
                JobType::Copy,
                file_name,
                format!(
                    "复制 {}/{} → {}/{}",
                    input.source_bucket, input.source_key, input.dest_bucket, input.dest_key
                ),
                0,
                JobTaskKind::Copy {
                    source_profile_id: input.source_profile_id,
                    source_profile_revision: source_profile.updated_at,
                    source_provider: source_profile.provider,
                    source_bucket: input.source_bucket,
                    source_key: input.source_key,
                    dest_profile_id: input.dest_profile_id,
                    dest_profile_revision: dest_profile.updated_at,
                    dest_provider: dest_profile.provider,
                    dest_bucket: input.dest_bucket,
                    dest_key: input.dest_key,
                },
            )?;
            Ok(json!({ "jobId": job_id }))
        }
        RpcMethod::TransferMove => {
            let input: CopyInput = parse_payload(payload)?;
            let (source_profile,dest_profile)=transfer_profiles(&state,&input.source_profile_id,&input.dest_profile_id)?;
            if !input.verification_readback_confirmed { return Err("请确认移动校验和本机中转可能产生的费用 / Confirm potential readback and local relay costs before moving".to_string()); }
            let file_name = input
                .source_key
                .split('/')
                .filter(|part| !part.is_empty())
                .last()
                .unwrap_or(input.source_key.as_str())
                .to_string();
            let job_id = enqueue_job(
                &app,
                JobType::Move,
                file_name,
                format!(
                    "移动 {}/{} → {}/{}",
                    input.source_bucket, input.source_key, input.dest_bucket, input.dest_key
                ),
                0,
                JobTaskKind::Move {
                    source_profile_id: input.source_profile_id,
                    source_profile_revision: source_profile.updated_at,
                    source_provider: source_profile.provider,
                    source_bucket: input.source_bucket,
                    source_key: input.source_key,
                    dest_profile_id: input.dest_profile_id,
                    dest_profile_revision: dest_profile.updated_at,
                    dest_provider: dest_profile.provider,
                    dest_bucket: input.dest_bucket,
                    dest_key: input.dest_key,
                },
            )?;
            Ok(json!({ "jobId": job_id }))
        }
        RpcMethod::TransferCrossBucket => {
            let input: CrossBucketInput = parse_payload(payload)?;
            if (input.mode == TransferMode::Move || input.source_profile_id != input.dest_profile_id || input.source_bucket != input.dest_bucket) && !input.verification_readback_confirmed { return Err("请确认跨空间传输和校验可能产生的费用 / Confirm potential transfer and readback costs".to_string()); }
            let (source_profile,dest_profile)=transfer_profiles(&state,&input.source_profile_id,&input.dest_profile_id)?;
            let source_client = to_s3_client(&source_profile)?;

            let mut expanded_keys = Vec::new();
            for key in &input.keys {
                if key.ends_with('/') {
                    let children =
                        s3_list_all_objects(&source_client, &input.source_bucket, key).await?;
                    expanded_keys
                        .extend(children.into_iter().map(|child| child.key));
                } else {
                    expanded_keys.push(key.clone());
                }
            }
            if expanded_keys.is_empty() {
                return Err("No objects to transfer".to_string());
            }

            let mut seen = HashSet::new();
            let mut unique_keys = Vec::new();
            for key in expanded_keys {
                if seen.insert(key.clone()) {
                    unique_keys.push(key);
                }
            }

            let is_move = input.mode == TransferMode::Move;
            let mut job_ids = Vec::new();
            for source_key in unique_keys {
                let relative_path = if source_key.starts_with(&input.source_prefix) {
                    source_key[input.source_prefix.len()..].to_string()
                } else {
                    source_key.clone()
                };
                let dest_key = format!("{}{}", input.dest_prefix, relative_path);
                let file_name = source_key
                    .split('/')
                    .filter(|part| !part.is_empty())
                    .last()
                    .unwrap_or(source_key.as_str())
                    .to_string();
                let job_id = enqueue_job(
                    &app,
                    if is_move {
                        JobType::Move
                    } else {
                        JobType::Copy
                    },
                    file_name,
                    format!(
                        "{} -> {}/{}",
                        if is_move { "移动" } else { "复制" },
                        input.dest_bucket,
                        dest_key
                    ),
                    0,
                    if is_move {
                        JobTaskKind::Move {
                            source_profile_id: input.source_profile_id.clone(),
                            source_profile_revision: source_profile.updated_at.clone(),
                            source_provider: source_profile.provider,
                            source_bucket: input.source_bucket.clone(),
                            source_key,
                            dest_profile_id: input.dest_profile_id.clone(),
                            dest_profile_revision: dest_profile.updated_at.clone(),
                            dest_provider: dest_profile.provider,
                            dest_bucket: input.dest_bucket.clone(),
                            dest_key,
                        }
                    } else {
                        JobTaskKind::Copy {
                            source_profile_id: input.source_profile_id.clone(),
                            source_profile_revision: source_profile.updated_at.clone(),
                            source_provider: source_profile.provider,
                            source_bucket: input.source_bucket.clone(),
                            source_key,
                            dest_profile_id: input.dest_profile_id.clone(),
                            dest_profile_revision: dest_profile.updated_at.clone(),
                            dest_provider: dest_profile.provider,
                            dest_bucket: input.dest_bucket.clone(),
                            dest_key,
                        }
                    },
                )?;
                job_ids.push(job_id);
            }

            Ok(json!({ "jobIds": job_ids }))
        }
        RpcMethod::TransferDownloadArchive => {
            let input: DownloadArchiveInput = parse_payload(payload)?;
            let profile = profile_for_id(&state, &input.profile_id)?;
            let client = to_s3_client(&profile)?;

            let mut resolved_keys = input.keys.clone();
            let prefix = input.prefix.unwrap_or_default();
            if resolved_keys.is_empty() && !prefix.is_empty() {
                let objects = s3_list_all_objects(&client, &input.bucket, &prefix).await?;
                resolved_keys = objects.into_iter().map(|obj| obj.key).collect();
            }
            if resolved_keys.is_empty() {
                return Err("No objects selected for archive".to_string());
            }

            let mut expanded_keys: Vec<(String, i64)> = Vec::new();
            for key in resolved_keys {
                if key.ends_with('/') {
                    let children = s3_list_all_objects(&client, &input.bucket, &key).await?;
                    expanded_keys.extend(
                        children
                            .into_iter()
                            .map(|child| (child.key, child.size.max(0))),
                    );
                } else {
                    let head = client
                        .head_object()
                        .bucket(input.bucket.clone())
                        .key(key.clone())
                        .send()
                        .await
                        .map_err(|err| err.to_string())?;
                    expanded_keys.push((key, head.content_length().unwrap_or(0).max(0)));
                }
            }
            if expanded_keys.is_empty() {
                return Err("Selected folders are empty".to_string());
            }

            let default_name = input.archive_name.unwrap_or_else(|| {
                if !prefix.is_empty() {
                    let name = prefix
                        .trim_end_matches('/')
                        .split('/')
                        .filter(|part| !part.is_empty())
                        .last()
                        .unwrap_or("archive");
                    format!("{name}.tar.gz")
                } else {
                    format!("{}-export.tar.gz", input.bucket)
                }
            });
            let archive_name = if default_name.ends_with(".tar.gz") {
                default_name
            } else {
                format!("{default_name}.tar.gz")
            };
            let Some(destination_path) = FileDialog::new().set_file_name(&archive_name).save_file()
            else {
                return Err("No destination folder selected".to_string());
            };

            let mut seen = HashSet::new();
            let mut unique_keys = Vec::new();
            let mut bytes_total = 0i64;
            for (key, size) in expanded_keys {
                if seen.insert(key.clone()) {
                    unique_keys.push(key);
                    bytes_total += size.max(0);
                }
            }

            let common_prefix = if !prefix.is_empty() {
                normalize_prefix(&prefix)
            } else {
                let mut common: Option<String> = None;
                for key in &unique_keys {
                    let parent = if let Some((head, _)) = key.rsplit_once('/') {
                        format!("{head}/")
                    } else {
                        String::new()
                    };
                    common = match common {
                        Some(existing) => {
                            let mut candidate = String::new();
                            for (a, b) in existing.chars().zip(parent.chars()) {
                                if a == b {
                                    candidate.push(a);
                                } else {
                                    break;
                                }
                            }
                            while !candidate.is_empty() && !candidate.ends_with('/') {
                                candidate.pop();
                            }
                            Some(candidate)
                        }
                        None => Some(parent),
                    };
                }
                common.unwrap_or_default()
            };

            let file_name = destination_path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or(archive_name.clone());
            let job_id = enqueue_job(
                &app,
                JobType::Archive,
                file_name,
                format!(
                    "Archive {} object(s) from {}",
                    unique_keys.len(),
                    input.bucket
                ),
                bytes_total.max(0),
                JobTaskKind::Archive {
                    profile_id: input.profile_id.clone(),
                    profile_revision: profile.updated_at,
                    provider: profile.provider,
                    bucket: input.bucket.clone(),
                    keys: unique_keys,
                    common_prefix,
                    destination_path: destination_path.to_string_lossy().to_string(),
                },
            )?;

            Ok(json!({ "jobId": job_id }))
        }

        RpcMethod::SyncPreview => {
            let input: SyncInput = parse_payload(payload)?;
            let ticket=sync_confirmation::begin(&state,&input)?;
            let diff = generate_sync_diff(&state, &input).await?;
            let token=sync_confirmation::issue(&state,&input,&ticket,&diff)?;
            let mut output=json!(diff);
            output["previewToken"]=json!(token);
            Ok(output)
        }
        RpcMethod::SyncExecute => {
            let input: SyncInput = parse_payload(payload)?;
            let (source_profile,dest_profile)=transfer_profiles(&state,&input.source_profile_id,&input.dest_profile_id)?;
            let ticket=sync_confirmation::begin(&state,&input)?;
            let approved=sync_confirmation::consume(&state,&input,&ticket)?;
            let diff = generate_sync_diff(&state, &input).await?;
            sync_confirmation::verify(&state,&input,&ticket,&approved,&diff)?;
            let job_id = execute_sync_diff(&app, &input, &diff, &source_profile, &dest_profile)?;
            Ok(json!({ "jobId": job_id }))
        }

        RpcMethod::JobsList => {
            native_jobs::restore(&app)?;
            native_download_jobs::restore(&app)?;
            let jobs_runtime = lock_state(&state.jobs)?;
            let mut seen = HashSet::new();
            let mut list = Vec::new();
            for id in &jobs_runtime.order {
                if let Some(job) = jobs_runtime.jobs.get(id) {
                    seen.insert(id.clone());
                    list.push(job.clone());
                }
            }
            for (id, job) in &jobs_runtime.jobs {
                if !seen.contains(id) {
                    list.push(job.clone());
                }
            }
            Ok(json!(list))
        }
        RpcMethod::JobsCancel => {
            let input: JobIdInput = parse_payload(payload)?;
            if !native_download_jobs::cancel(&app,&input.job_id)? && !native_jobs::cancel(&app,&input.job_id)? {cancel_job(&app, &input.job_id);}
            Ok(Value::Null)
        }
        RpcMethod::JobsPause => {let input:JobIdInput=parse_payload(payload)?;if native_download_jobs::contains(&state,&input.job_id)?{native_download_jobs::pause(&app,&input.job_id)?;}else{native_jobs::pause(&app,&input.job_id)?;}Ok(Value::Null)}
        RpcMethod::JobsResume | RpcMethod::JobsRetry => {let input:JobIdInput=parse_payload(payload)?;if native_download_jobs::contains(&state,&input.job_id)?{native_download_jobs::resume(&app,&input.job_id)?;}else{native_jobs::resume(&app,&input.job_id)?;}Ok(Value::Null)}
        RpcMethod::JobsRestore => {let upload=native_jobs::restore(&app)?;let download=native_download_jobs::restore(&app)?;Ok(json!({"restored":upload.restored+download.restored,"unreadable":upload.unreadable+download.unreadable}))},
        RpcMethod::JobsClear => {
            {let vault=lock_state(&state.vault)?;ensure_unlocked(&vault)?;}
            let mut report=NativeClearReport::default();
            // Preserve a completed upload sweep even when download setup or a
            // later manifest removal fails. Errors are per-item and retryable.
            report.merge_phase(native_jobs::clear_terminal(&app));
            report.merge_phase(native_download_jobs::clear_terminal(&app));
            let mut jobs_runtime = lock_state(&state.jobs)?;
            let removed=clear_finished_rows(&mut jobs_runtime,&report.removed);
            drop(jobs_runtime);
            persist_job_history_snapshot(&app);
            Ok(json!({"removed":removed,"errors":report.errors}))
        }
        RpcMethod::JobsGetConcurrency => {
            let jobs_runtime = lock_state(&state.jobs)?;
            Ok(json!({ "concurrency": jobs_runtime.concurrency }))
        }
        RpcMethod::JobsSetConcurrency => {
            let input: JobConcurrencyInput = parse_payload(payload)?;
            {
                let mut jobs_runtime = lock_state(&state.jobs)?;
                jobs_runtime.concurrency =
                    input.concurrency.clamp(MIN_JOB_CONCURRENCY, MAX_JOB_CONCURRENCY);
            }
            try_start_queued_jobs(app.clone());
            let jobs_runtime = lock_state(&state.jobs)?;
            Ok(json!({ "concurrency": jobs_runtime.concurrency }))
        }

        RpcMethod::FavoritesLoad => Ok(json!(load_favorites_from_disk())),
        RpcMethod::FavoritesSave => {
            let input: FavoritesSaveInput = parse_payload(payload)?;
            save_favorites_to_disk(&input.favorites)?;
            Ok(Value::Null)
        }

        RpcMethod::ShareGenerate => {
            let input: ShareGenerateInput = parse_payload(payload)?;
            let profile = profile_for_id(&state, &input.profile_id)?;
            storage_backend::ensure_expected_revision(&profile,input.expected_profile_revision.as_deref())?;
            let client = match storage_backend::get(&state, &profile)? {
                storage_backend::StorageBackend::S3(client) => client,
                storage_backend::StorageBackend::Qiniu(client) => {
                    return storage_backend::guarded(&state, &profile, async {
                        let context = client.resolve_named_bucket(&input.bucket).await.map_err(|error|error.to_string())?;
                        if context.backend_mode == "s3" {
                            if input.download_domain.is_some(){return Err("S3 外链不接受原生域名覆盖 / S3 links do not accept native domain overrides".into());}
                            let ttl=qiniu_download::validate_share_ttl(input.expires_in,qiniu_download::ShareProtocol::S3)?;
                            let bridge=storage_backend::qiniu_s3_bridge(&profile,&context)?;
                            bridge.client.head_object().bucket(&bridge.bucket_name).key(&input.key).send().await.map_err(|error|s3_errors::describe("验证分享对象",&error))?;
                            let config=PresigningConfig::expires_in(StdDuration::from_secs(ttl as u64)).map_err(|_|"Invalid link expiry".to_string())?;
                            let signed=bridge.client.get_object().bucket(&bridge.bucket_name).key(&input.key).presigned(config).await.map_err(|_|"无法签发 S3 下载链接 / Could not sign the S3 download URL".to_string())?;
                            return Ok(json!({"url":signed.uri().to_string(),"expiresAt":(Utc::now()+Duration::seconds(ttl)).to_rfc3339(),"key":input.key}));
                        }
                        if context.backend_mode != "kodo" {return Err("未知七牛连接模式 / Unknown Qiniu backend mode".into());}
                        let ttl=qiniu_download::validate_share_ttl(input.expires_in,qiniu_download::ShareProtocol::QiniuNative)?;
                        let expiry=Utc::now()+Duration::seconds(ttl);
                        let domain=qiniu_download::resolve_download_option(&client,&context,input.download_domain.as_deref()).await?;
                        let client=client.for_validated_download_domain(&domain.url).map_err(|error|error.to_string())?;
                        let object = client.stat(&context, &input.key).await.map_err(|error|error.to_string())?;
                        if matches!(object.storage_type,Some(2|3)) && object.restore_status != Some(2) {
                            return Err("归档文件尚未解冻，暂不能生成可访问的链接 / Restore the archived file before generating an accessible link".to_string());
                        }
                        qiniu_download::share_link_result(&client,&domain,&input.key,expiry)
                    }).await;
                }
            };
            if input.download_domain.is_some(){return Err("S3 外链不接受原生域名覆盖 / S3 links do not accept native domain overrides".into());}
            let ttl=qiniu_download::validate_share_ttl(input.expires_in,qiniu_download::ShareProtocol::S3)?;
            let expires_at=(Utc::now()+Duration::seconds(ttl)).to_rfc3339();
            let config = PresigningConfig::expires_in(StdDuration::from_secs(ttl as u64))
                .map_err(|err| format!("Invalid presign ttl: {err}"))?;

            let presigned = client
                .get_object()
                .bucket(input.bucket)
                .key(input.key.clone())
                .presigned(config)
                .await
                .map_err(|err| err.to_string())?;

            Ok(json!({
                "url": presigned.uri().to_string(),
                "expiresAt": expires_at,
                "key": input.key,
            }))
        }

        RpcMethod::FolderSyncListRules => Ok(json!(load_folder_sync_rules_records())),
        RpcMethod::FolderSyncAddRule => {
            let mut rule = payload
                .as_object()
                .cloned()
                .ok_or_else(|| "Invalid payload: expected object".to_string())?;

            let mut rules = load_folder_sync_rules_records();
            let duplicate = rules.iter().any(|existing| {
                existing.profile_id == map_str(&rule, "profileId").unwrap_or_default()
                    && existing.bucket == map_str(&rule, "bucket").unwrap_or_default()
                    && existing.bucket_prefix == map_str(&rule, "bucketPrefix").unwrap_or_default()
                    && existing.local_path == map_str(&rule, "localPath").unwrap_or_default()
            });
            if duplicate {
                return Err("A sync rule already exists for this folder and bucket".to_string());
            }

            let profile_id = map_str(&rule, "profileId")
                .ok_or_else(|| "Invalid payload: missing profileId".to_string())?;
            let _ = profile_for_id(&state, profile_id)?;

            rule.insert("id".to_string(), Value::String(Uuid::new_v4().to_string()));
            rule.insert("enabled".to_string(), Value::Bool(true));
            rule.insert("createdAt".to_string(), Value::String(now_iso()));

            if !rule.contains_key("pollIntervalMs") {
                rule.insert("pollIntervalMs".to_string(), json!(30_000));
            }
            if !rule.contains_key("excludePatterns") {
                rule.insert(
                    "excludePatterns".to_string(),
                    json!([".DS_Store", "Thumbs.db", ".object0-tmp", "desktop.ini"]),
                );
            }

            let rule_value = Value::Object(rule);
            let rule_record = serde_json::from_value::<FolderSyncRuleRecord>(rule_value.clone())
                .map_err(|err| format!("Invalid folder sync rule: {err}"))?;
            rules.push(rule_record.clone());
            save_folder_sync_rules_records(&rules)?;
            if rule_record.enabled {
                let _ = start_folder_sync_rule(&app, &rule_record.id);
            }
            refresh_tray_menu(&app);
            Ok(json!(rule_record))
        }
        RpcMethod::FolderSyncUpdateRule => {
            let update = payload
                .as_object()
                .cloned()
                .ok_or_else(|| "Invalid payload: expected object".to_string())?;
            let id = update
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| "Invalid payload: missing id".to_string())?
                .to_string();

            let mut rules = load_folder_sync_rules_records();
            if let Some(rule) = rules.iter_mut().find(|rule| rule.id == id) {
                let mut rule_value = serde_json::to_value(rule.clone())
                    .map_err(|err| format!("Failed to serialize stored rule: {err}"))?;
                let Some(rule_obj) = rule_value.as_object_mut() else {
                    return Err("Invalid stored rule format".to_string());
                };
                for (key, value) in update {
                    rule_obj.insert(key, value);
                }
                let updated_rule = serde_json::from_value::<FolderSyncRuleRecord>(rule_value)
                    .map_err(|err| format!("Invalid folder sync update: {err}"))?;
                *rule = updated_rule.clone();
                save_folder_sync_rules_records(&rules)?;

                stop_folder_sync_rule(&app, &id);
                if updated_rule.enabled {
                    let _ = start_folder_sync_rule(&app, &id);
                }
                refresh_tray_menu(&app);
                return Ok(json!(updated_rule));
            }

            Err("Rule not found".to_string())
        }
        RpcMethod::FolderSyncRemoveRule => {
            let input: IdInput = parse_payload(payload)?;
            let mut rules = load_folder_sync_rules_records();
            let before = rules.len();
            rules.retain(|rule| rule.id != input.id);

            if before == rules.len() {
                return Err("Rule not found".to_string());
            }

            stop_folder_sync_rule(&app, &input.id);
            save_folder_sync_rules_records(&rules)?;
            remove_folder_sync_file_records(&input.id);

            let state = app.state::<AppState>();
            if let Ok(mut runtime) = lock_state(&state.folder_sync) {
                runtime.statuses.remove(&input.id);
            }
            refresh_tray_menu(&app);
            Ok(Value::Null)
        }
        RpcMethod::FolderSyncToggleRule => {
            let input: FolderSyncToggleInput = parse_payload(payload)?;
            let mut rules = load_folder_sync_rules_records();

            if let Some(rule) = rules.iter_mut().find(|rule| rule.id == input.id) {
                rule.enabled = input.enabled;
                let updated = rule.clone();
                save_folder_sync_rules_records(&rules)?;

                if input.enabled {
                    let _ = start_folder_sync_rule(&app, &input.id);
                } else {
                    stop_folder_sync_rule(&app, &input.id);
                    let _ = set_and_emit_folder_sync_status(
                        &app,
                        &input.id,
                        FolderSyncStatus::Idle,
                        0,
                        Some(now_iso()),
                        None,
                        None,
                    );
                }
                refresh_tray_menu(&app);
                return Ok(json!(updated));
            }

            Err("Rule not found".to_string())
        }
        RpcMethod::FolderSyncSyncNow => {
            let input: IdInput = parse_payload(payload)?;
            trigger_folder_sync_now(&app, &input.id)?;
            refresh_tray_menu(&app);
            Ok(Value::Null)
        }
        RpcMethod::FolderSyncStartAll => {
            start_all_folder_sync_rules(&app)?;
            refresh_tray_menu(&app);
            Ok(Value::Null)
        }
        RpcMethod::FolderSyncStopAll => {
            stop_all_folder_sync_rules(&app);
            refresh_tray_menu(&app);
            Ok(Value::Null)
        }
        RpcMethod::FolderSyncPauseAll => {
            pause_all_folder_sync_rules(&app);
            refresh_tray_menu(&app);
            Ok(Value::Null)
        }
        RpcMethod::FolderSyncResumeAll => {
            resume_all_folder_sync_rules(&app);
            refresh_tray_menu(&app);
            Ok(Value::Null)
        }
        RpcMethod::FolderSyncGetStatus => Ok(json!(folder_sync_statuses_snapshot(&app))),
        RpcMethod::FolderSyncPreview => {
            let input: IdInput = parse_payload(payload)?;
            let rule = get_folder_sync_rule(&input.id)?;
            let profile = profile_for_id(&state, &rule.profile_id)?;
            let client = to_s3_client(&profile)?;
            let known_records = load_folder_sync_file_records(&rule.id);
            let diff = generate_folder_sync_diff_for_rule(&rule, &client, &known_records).await?;
            Ok(json!(diff))
        }
        RpcMethod::FolderSyncPickFolder => {
            let path = FileDialog::new()
                .pick_folder()
                .map(|path| path.to_string_lossy().to_string());
            Ok(json!({ "path": path }))
        }

        RpcMethod::UpdaterCheck => {
            // Compatibility detection still uses the repository-pinned path;
            // old callers cannot reuse an arbitrary environment feed.
            let result = github_updates::check(&app, github_updates::Channel::Stable).await?;
            Ok(json!({"version":result.release.as_ref().map(|r|r.version.as_str()).unwrap_or(&result.info.current_version),"hash":result.info.build_hash,"updateAvailable":result.release.is_some(),"updateReady":false,"error":""}))
        }
        RpcMethod::UpdaterDownload => {
            Err("请在新版更新窗口选择并下载固定版本 / Select and download a fixed release in the new update dialog".into())
        }
        RpcMethod::UpdaterApply => {
            Err("旧更新入口已停用，请使用有退出保护的更新窗口 / Legacy installation is disabled; use the guarded update dialog".into())
        }
        RpcMethod::UpdaterLocalInfo => { let info=github_updates::info(); Ok(json!({"version":info.current_version,"hash":info.build_hash,"baseUrl":info.release_url,"channel":"stable","name":native_locale::app_name(),"identifier":"dev.object0.app"})) },
        RpcMethod::UpdatesInfo => Ok(serde_json::to_value(github_updates::info()).map_err(|_|"Update info serialization failed".to_string())?),
        RpcMethod::UpdatesCheck => {let input:github_updates::CheckInput=parse_payload(payload)?;Ok(serde_json::to_value(github_updates::check(&app,input.channel).await?).map_err(|_|"Update check serialization failed".to_string())?)},
        RpcMethod::UpdatesDownload => {let input:github_updates::SelectionInput=parse_payload(payload)?;Ok(serde_json::to_value(github_updates::download(&app,&input.release_id).await?).map_err(|_|"Update download serialization failed".to_string())?)},
        RpcMethod::UpdatesCancel => {let input:github_updates::SelectionInput=parse_payload(payload)?;Ok(serde_json::to_value(github_updates::cancel(&app,&input.release_id)?).map_err(|_|"Update cancel serialization failed".to_string())?)},
        RpcMethod::UpdatesApply => {let input:github_updates::ApplyInput=parse_payload(payload)?;github_updates::apply(&app,&input)?;Ok(json!({"accepted":true}))},
        RpcMethod::SystemPlatform => Ok(json!({ "os": std::env::consts::OS })),
        RpcMethod::SystemSetLanguage => {
            let locale = payload.get("locale").and_then(Value::as_str)
                .ok_or_else(|| "Invalid language selection".to_string())?;
            native_locale::set(locale)?;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(native_locale::app_name());
            }
            refresh_tray_menu(&app);
            Ok(Value::Null)
        }
    }
}
