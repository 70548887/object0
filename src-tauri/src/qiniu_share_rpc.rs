//! Application boundary for ephemeral, read-only directory shares.
//! A session ID never becomes a saved profile, and cannot enter ordinary
//! mutation, sync, quota or persistent-transfer RPCs.
use super::*;
use serde::de::DeserializeOwned;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateInput {
    profile_id: String,
    expected_profile_revision: String,
    bucket_name: String,
    prefix: String,
    duration_seconds: u32,
    read_only: bool,
}

#[cfg(test)]
#[path="qiniu_share_private_rpc_tests.rs"]
mod private_tests;

// Intentionally no Debug: the URL contains a share token and the extraction
// code must never be included in diagnostics.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoginInput {
    url: String,
    extraction_code: String,
    private_environment_id: Option<String>,
    expected_private_environment_revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListInput { session_id: String, prefix: String, cursor: Option<String> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DownloadInput { session_id: String, key: String }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloseInput { session_id: String }

fn decode<T: DeserializeOwned>(payload: Value) -> Result<T, String> {
    serde_json::from_value(payload).map_err(|_| "目录分享请求格式无效 / Invalid directory share request".into())
}

fn create_profile(state: &AppState, input: &CreateInput) -> Result<(Profile, qiniu_share_runtime::OperationTicket), String> {
    let vault = lock_state(&state.vault)?;
    ensure_unlocked(&vault)?;
    let profile = vault.data.as_ref().and_then(|data| data.profiles.iter().find(|p| p.id == input.profile_id))
        .ok_or_else(|| "账号不存在 / Profile not found".to_string())?;
    if input.expected_profile_revision.is_empty() { return Err("缺少账号版本，请重新打开分享 / Missing account revision; reopen sharing".into()); }
    storage_backend::ensure_expected_revision(profile, Some(&input.expected_profile_revision))?;
    let config = profile.qiniu.clone().unwrap_or_default();
    if profile.provider != S3Provider::Qiniu || config.mode != qiniu::QiniuMode::Public
        || profile.session_token.as_deref().is_some_and(|value| !value.is_empty()) || !config.bucket_bindings.is_empty() {
        return Err("此连接尚未开放目录分享创建；需要公有云原生永久凭据 / Creating directory shares requires a public native connection with permanent credentials".into());
    }
    if !input.read_only { return Err("目录分享仅支持只读 / Directory sharing is read-only".into()); }
    qiniu::share::validate_share_prefix(&input.prefix).map_err(|error| error.to_string())?;
    if !(qiniu::share::MIN_DURATION_SECONDS..=qiniu::share::MAX_DURATION_SECONDS).contains(&input.duration_seconds) {
        return Err("目录分享有效期必须为 15 至 120 分钟 / Directory shares must expire in 15 to 120 minutes".into());
    }
    Ok((profile.clone(), state.share_sessions.begin_operation()?))
}

fn login_environment(state: &AppState, id: Option<&str>, expected_revision: Option<&str>) -> Result<(qiniu::QiniuConfig, qiniu_share_runtime::OperationTicket), String> {
    let vault = lock_state(&state.vault)?;
    ensure_unlocked(&vault)?;
    let config = if let Some(id) = id {
        if id.trim().is_empty() || expected_revision.is_none_or(|value| value.trim().is_empty()) {
            return Err("私有分享缺少环境版本，请重新选择已保存环境 / Private sharing requires a saved environment revision; select the environment again".into());
        }
        let profile = vault.data.as_ref().and_then(|data| data.profiles.iter().find(|p| p.id == id))
            .ok_or_else(|| "私有分享环境不存在 / Private share environment not found".to_string())?;
        storage_backend::ensure_expected_revision(profile, expected_revision)?;
        let config = profile.qiniu.as_ref().filter(|config| profile.provider == S3Provider::Qiniu && config.mode == qiniu::QiniuMode::Private)
            .ok_or_else(|| "所选账号不是私有七牛环境 / Selected profile is not a private Qiniu environment".to_string())?;
        qiniu::share::validate_private_login_config(config).map_err(|error| error.to_string())?;
        config.clone() // Never copy profile AK/SK into share login.
    } else {
        if expected_revision.is_some() { return Err("公有分享登录不能携带私有环境版本 / Public sharing cannot carry a private environment revision".into()); }
        qiniu::QiniuConfig::default()
    };
    Ok((config, state.share_sessions.begin_operation()?))
}

fn ensure_open(state: &AppState) -> Result<(), String> {
    let vault = lock_state(&state.vault)?;
    ensure_unlocked(&vault)
}

pub(crate) async fn dispatch(state: &AppState, method: RpcMethod, payload: Value) -> Result<Value, String> {
    match method {
        RpcMethod::QiniuShareCreate => {
            let input: CreateInput = decode(payload)?;
            let (profile, ticket) = create_profile(state, &input)?;
            let client = storage_backend::qiniu_client(&profile)?;
            storage_backend::guarded(state, &profile, async {
                let context = client.resolve_named_bucket(&input.bucket_name).await.map_err(|error| error.to_string())?;
                if context.bucket.name != input.bucket_name || context.backend_mode != "kodo" {
                    return Err("目录分享空间身份未确认 / Directory share bucket identity is unconfirmed".into());
                }
                storage_backend::ensure_qiniu_writable(&context.bucket)?;
                let result = state.share_sessions.create_share(ticket, profile.qiniu.clone().unwrap_or_default(),
                    &context.bucket.name, &input.prefix, input.duration_seconds,
                    &profile.access_key_id, &profile.secret_access_key).await?;
                Ok(json!(result))
            }).await
        }
        RpcMethod::QiniuShareLogin => {
            let input: LoginInput = decode(payload)?;
            let (config, ticket) = login_environment(state, input.private_environment_id.as_deref(), input.expected_private_environment_revision.as_deref())?;
            Ok(json!(state.share_sessions.login(ticket, config, &input.url, &input.extraction_code).await?))
        }
        RpcMethod::QiniuShareList => {
            let input: ListInput = decode(payload)?;
            ensure_open(state)?;
            Ok(json!(state.share_sessions.list(&input.session_id, &input.prefix, input.cursor.as_deref()).await?))
        }
        RpcMethod::QiniuShareDownload => {
            let input: DownloadInput = decode(payload)?;
            ensure_open(state)?;
            let info = state.share_sessions.info(&input.session_id)?;
            qiniu::share::validate_share_key(&input.key).map_err(|error| error.to_string())?;
            if !input.key.starts_with(&info.prefix) || input.key.ends_with('/') {
                return Err("仅可下载分享范围内的文件 / Only files within the shared scope can be downloaded".into());
            }
            let filename = input.key.rsplit('/').next().filter(|name| !name.is_empty()).unwrap_or("download").to_string();
            let selected = tauri::async_runtime::spawn_blocking(move || FileDialog::new().set_file_name(&filename).save_file()).await
                .map_err(|_| "无法打开保存对话框 / Could not open save dialog".to_string())?;
            let Some(target) = selected else { return Ok(json!({"cancelled":true})); };
            ensure_open(state)?;
            let result = state.share_sessions.download(&input.session_id, &input.key, &target).await?;
            Ok(json!({"cancelled":false,"bytes":result.bytes}))
        }
        RpcMethod::QiniuShareClose => {
            let input: CloseInput = decode(payload)?;
            // Cleanup remains permitted after lock; there is no cloud revoke.
            state.share_sessions.close(&input.session_id);
            Ok(Value::Null)
        }
        _ => Err("不支持的目录分享操作 / Unsupported directory share operation".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> Profile {
        serde_json::from_value(json!({"id":"p","name":"fixture","provider":"qiniu","accessKeyId":"fixture-ak","secretAccessKey":"fixture-sk","qiniu":{},"createdAt":"t","updatedAt":"v1"})).unwrap()
    }
    fn state() -> AppState {
        let state = AppState::default();
        { let mut vault = state.vault.lock().unwrap(); vault.unlocked=true; vault.data=Some(VaultData {profiles:vec![profile()],..Default::default()}); }
        state
    }
    fn input() -> CreateInput {
        CreateInput {profile_id:"p".into(), expected_profile_revision:"v1".into(),bucket_name:"bucket".into(),prefix:"shared/".into(),duration_seconds:3600,read_only:true}
    }
    #[test]
    fn create_requires_current_public_native_identity_and_readonly_scope() {
        let state=state(); let mut request=input(); assert!(create_profile(&state,&request).is_ok());
        request.expected_profile_revision="old".into(); assert!(create_profile(&state,&request).is_err());
        request=input();request.read_only=false;assert!(create_profile(&state,&request).is_err());
        request=input();request.prefix="shared/../outside/".into();assert!(create_profile(&state,&request).is_err());
        request=input();request.duration_seconds=7201;assert!(create_profile(&state,&request).is_err());
        {let mut vault=state.vault.lock().unwrap();vault.data.as_mut().unwrap().profiles[0].session_token=Some("fixture-session".into());}
        assert!(create_profile(&state,&input()).is_err());
        {let mut vault=state.vault.lock().unwrap();vault.unlocked=false;}
        assert!(create_profile(&state,&input()).is_err());
        assert!(login_environment(&state,None,None).is_err());
    }
    #[test]
    fn public_login_never_derives_config_from_active_account_or_payload_credentials() {
        let state=state();let (config,_)=login_environment(&state,None,None).unwrap();assert_eq!(config,qiniu::QiniuConfig::default());
        assert!(login_environment(&state,Some("p"),Some("v1")).is_err());
        assert!(login_environment(&state,None,Some("v1")).is_err());
        let error=decode::<LoginInput>(json!({"url":"secret-share-token","extractionCode":"Ab12Cd","accessKeyId":"private-key"})).err().unwrap();
        for secret in ["secret-share-token","Ab12Cd","private-key"] {assert!(!error.contains(secret));}
    }
    #[test]
    fn share_methods_are_routed_but_never_offer_mutations_or_arbitrary_output_paths() {
        for name in ["qiniu:share-create","qiniu:share-login","qiniu:share-list","qiniu:share-download","qiniu:share-close"] {assert!(RpcMethod::parse(name).is_some());}
        for name in ["qiniu:share-upload","qiniu:share-delete","qiniu:share-move"] {assert!(RpcMethod::parse(name).is_none());}
        assert!(decode::<DownloadInput>(json!({"sessionId":"s","key":"shared/a","localPath":"C:/unselected"})).is_err());
        assert!(decode::<CreateInput>(json!({"profileId":"p","bucketName":"b","prefix":"","readOnly":true,"durationSeconds":3600})).is_err());
    }
    #[test]
    fn application_clear_and_profile_invalidation_reject_pending_share_login_before_network() {
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let state=state();
        for profile_change in [false,true] {
            let ticket=state.share_sessions.begin_operation().unwrap();
            if profile_change {storage_backend::invalidate(&state,"p");} else {storage_backend::clear(&state);}
            let error=runtime.block_on(state.share_sessions.login(ticket,qiniu::QiniuConfig::default(),"not-a-url","Ab12Cd")).unwrap_err();
            assert!(error.contains("closed, locked or expired"));
        }
    }
    #[test]
    fn locked_rpc_refuses_list_download_and_login_without_network_or_picker() {
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let state=AppState::default();
        for (method,payload) in [
            (RpcMethod::QiniuShareList,json!({"sessionId":"fixture","prefix":"shared/"})),
            (RpcMethod::QiniuShareDownload,json!({"sessionId":"fixture","key":"shared/a"})),
            (RpcMethod::QiniuShareLogin,json!({"url":"not-a-url","extractionCode":"Ab12Cd"})),
        ] {assert!(runtime.block_on(dispatch(&state,method,payload)).unwrap_err().contains("locked"));}
        assert!(runtime.block_on(dispatch(&state,RpcMethod::QiniuShareClose,json!({"sessionId":"fixture"}))).unwrap().is_null());
    }
}
