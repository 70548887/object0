//! Provider boundary and credential-safe Qiniu client lifecycle.
//!
//! The generic S3 path remains unchanged. Qiniu must never be silently sent to
//! an AWS endpoint when discovery, credentials, or region mapping are missing.
use super::*;
use futures_util::future::{AbortHandle, Abortable};

#[derive(Default)]
pub(crate) struct BackendRuntime {
    // Cache keys contain only the internal profile id and revision, not keys.
    qiniu: HashMap<String, (String, qiniu::QiniuClient)>,
    tasks: HashMap<Uuid, (String, AbortHandle)>,
}

pub(crate) enum StorageBackend {
    S3(S3Client),
    Qiniu(qiniu::QiniuClient),
}

pub(crate) fn qiniu_client(profile: &Profile) -> Result<qiniu::QiniuClient, String> {
    if profile.provider != S3Provider::Qiniu {
        return Err("当前账号不是七牛云账号 / Account is not a Qiniu profile".into());
    }
    let config = profile.qiniu.clone().unwrap_or_default();
    let credentials = qiniu::QiniuCredentials::new(
        profile.access_key_id.clone(), profile.secret_access_key.clone(), profile.session_token.clone(),
    ).map_err(|error| error.to_string())?;
    qiniu::QiniuClient::new(config, credentials).map_err(|error| error.to_string())
}

pub(crate) fn qiniu_for_id(state: &AppState, profile_id: &str) -> Result<(Profile, qiniu::QiniuClient), String> {
    let profile = profile_for_id(state, profile_id)?;
    match get(state, &profile)? {
        StorageBackend::Qiniu(client) => Ok((profile, client)),
        StorageBackend::S3(_) => Err("当前账号不是七牛云账号 / Account is not a Qiniu profile".into()),
    }
}

pub(crate) fn qiniu_s3_bridge(profile: &Profile, context: &qiniu::ResolvedBucketContext) -> Result<qiniu::s3_bridge::QiniuS3Bridge, String> {
    if profile.provider != S3Provider::Qiniu { return Err("Not a Qiniu profile".to_string()); }
    let config=profile.qiniu.as_ref().ok_or_else(||"七牛账号配置缺失 / Qiniu configuration is missing".to_string())?;
    qiniu::s3_bridge::from_context(&profile.id, &profile.updated_at, config, context,
        &profile.access_key_id, &profile.secret_access_key, profile.session_token.as_deref())
        .map_err(|error|error.to_string())
}

/// Do not issue mutations against a bucket explicitly reported as read-only.
/// Unknown permission is not promoted to writable; the server still decides.
pub(crate) fn ensure_qiniu_writable(bucket:&qiniu::QiniuBucket)->Result<(),String>{
    if bucket.permission.as_deref()==Some("readonly") {
        Err("此七牛空间只有读取权限 / This Qiniu bucket is read-only".to_string())
    } else { Ok(()) }
}

pub(crate) fn ensure_qiniu_file_mutations(keys:&[String])->Result<(),String>{
    if keys.iter().any(|key|key.ends_with('/')) {
        Err("七牛目录删除和重命名尚未完成递归与逐项校验；请先进入目录操作文件 / Qiniu directory mutations need recursive validation; operate on files inside the directory instead".into())
    }else{Ok(())}
}
pub(crate) fn ensure_expected_revision(profile:&Profile,expected:Option<&str>)->Result<(),String>{
    if expected.is_some_and(|revision| revision!=profile.updated_at){
        Err("存储账号已变更，旧任务已拒绝；请重新选择文件 / Account changed; stale operation was refused. Select files again".into())
    }else{Ok(())}
}

pub(crate) fn get(state: &AppState, profile: &Profile) -> Result<StorageBackend, String> {
    if profile.provider != S3Provider::Qiniu {
        return Ok(StorageBackend::S3(to_s3_client(profile)?));
    }
    // Same vault→backend lock order as lock/reset: a cloned profile cannot
    // repopulate the credential cache after the vault has been locked.
    let vault = lock_state(&state.vault)?;
    ensure_unlocked(&vault)?;
    if !vault.data.as_ref().is_some_and(|data| data.profiles.iter().any(|current| current.id == profile.id && current.updated_at == profile.updated_at && current.provider == S3Provider::Qiniu)) {
        return Err("存储账号已变更，请重试 / Storage account changed; retry".to_string());
    }
    let mut cache = lock_state(&state.backends)?;
    if let Some((revision, client)) = cache.qiniu.get(&profile.id) {
        if revision == &profile.updated_at { return Ok(StorageBackend::Qiniu(client.clone())); }
    }
    let client = qiniu_client(profile)?;
    cache.qiniu.insert(profile.id.clone(), (profile.updated_at.clone(), client.clone()));
    Ok(StorageBackend::Qiniu(client))
}

pub(crate) fn clear(state: &AppState) {
    qiniu_connect::clear(state);
    // Shares hold only temporary credentials, but must obey the same vault
    // lifecycle. Invalidate login tickets and in-flight transfers as well.
    state.share_sessions.clear_all();
    if let Ok(mut previews)=state.sync_previews.lock(){previews.clear();}
    if let Ok(mut runtime) = state.backends.lock() {
        for (_, (_, handle)) in runtime.tasks.drain() { handle.abort(); }
        runtime.qiniu.clear();
    }
}

pub(crate) fn invalidate(state: &AppState, profile_id: &str) {
    qiniu_connect::clear(state);
    usage::invalidate_profile(state,profile_id);
    // A private share environment can be edited or removed. Conservatively
    // close all ephemeral sessions instead of retaining stale endpoint trust.
    state.share_sessions.clear_all();
    if let Ok(mut runtime) = state.backends.lock() {
        runtime.qiniu.remove(profile_id);
        runtime.tasks.retain(|_, (owner, handle)| {
            if owner == profile_id { handle.abort(); false } else { true }
        });
    }
}

struct TaskGuard<'a> { runtime: &'a Mutex<BackendRuntime>, id: Uuid }
impl Drop for TaskGuard<'_> {
    fn drop(&mut self) { if let Ok(mut runtime) = self.runtime.lock() { runtime.tasks.remove(&self.id); } }
}

/// Abort in-flight Qiniu operations on lock/reset/profile change. Creation and
/// registration use the same vault→backend lock order as those operations.
pub(crate) async fn guarded<T>(state: &AppState, profile: &Profile, future: impl std::future::Future<Output=Result<T,String>>) -> Result<T,String> {
    let (registration, _guard) = {
        let vault = lock_state(&state.vault)?;
        ensure_unlocked(&vault)?;
        if !vault.data.as_ref().is_some_and(|data|data.profiles.iter().any(|current| current.id==profile.id && current.updated_at==profile.updated_at)) {
            return Err("存储账号已变更，请重试 / Storage account changed; retry".to_string());
        }
        let mut runtime=lock_state(&state.backends)?;
        if runtime.tasks.len() >= 128 {return Err("七牛任务过多，请稍后重试 / Too many Qiniu operations".to_string());}
        let id=Uuid::new_v4();
        let (handle,registration)=AbortHandle::new_pair();
        runtime.tasks.insert(id,(profile.id.clone(),handle));
        (registration, TaskGuard{runtime:&state.backends,id})
    };
    Abortable::new(future,registration).await.map_err(|_|"密码库已锁定或账号已变更，存储请求已取消 / Storage request cancelled because the vault was locked or the account changed".to_string())?
}

/// A structured connection check never treats an absent bucket read or a
/// rejected region query as a complete connection success.
pub(crate) async fn connection_report(profile: &Profile) -> Result<Value, String> {
    let client = qiniu_client(profile)?;
    let report = client.test_connection(profile.default_bucket.as_deref()).await;
    Ok(qiniu_connection_report_value(&report))
}

/// The credential-bearing client remains native. The account form only needs
/// the already-authorized bucket identities to offer a default-bucket picker.
fn qiniu_connection_report_value(report:&qiniu::ConnectionReport)->Value {
    let capability = |name: &str, value: &qiniu::Capability| {
        let status = match value.state {
            qiniu::CapabilityState::Supported => "ok",
            qiniu::CapabilityState::Forbidden | qiniu::CapabilityState::Unavailable => "error",
            qiniu::CapabilityState::Unsupported => "unsupported",
            qiniu::CapabilityState::Unknown => "warning",
        };
        json!({"name":name,"status":status,"message":value.reason})
    };
    let success = report.authentication.state == qiniu::CapabilityState::Supported
        && report.region_discovery.state == qiniu::CapabilityState::Supported
        && report.bucket_access.state == qiniu::CapabilityState::Supported;
    let buckets:Vec<Value>=report.buckets.iter().map(|bucket|{
        let mut value=json!({"name":bucket.name});
        if let Some(region)=&bucket.kodo_region_id {value["regionId"]=json!(region);}
        if let Some(alias)=&bucket.s3_name {value["s3Name"]=json!(alias);}
        if let Some(permission)=&bucket.permission {value["permission"]=json!(permission);}
        value
    }).collect();
    json!({
        "success": success,
        "bucketCount": report.buckets.len(),
        "buckets": buckets,
        "error": if success { None } else { Some("连接尚未完整验证，请查看各项诊断 / Connection is not fully verified; see diagnostics") },
        "checks": [
            capability("authentication", &report.authentication),
            capability("bucketAccess", &report.bucket_access),
            capability("regionDiscovery", &report.region_discovery),
            capability("downloadDomain", &report.download_domain),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_picker_returns_native_names_without_promoting_unverified_bucket_reads(){
        let report=qiniu::ConnectionReport {authentication:qiniu::Capability::supported(),region_discovery:qiniu::Capability::supported(),bucket_access:qiniu::Capability {state:qiniu::CapabilityState::Unknown,reason:Some("Select a bucket".into())},download_domain:qiniu::Capability {state:qiniu::CapabilityState::Unknown,reason:None},buckets:vec![qiniu::QiniuBucket {name:"native-bucket".into(),s3_name:Some("server-s3-alias".into()),kodo_region_id:Some("z0".into()),created_at:None,permission:Some("readonly".into()),remark:Some("not-needed-by-picker".into())}]};
        let value=qiniu_connection_report_value(&report);
        assert_eq!(value["success"],false);assert_eq!(value["bucketCount"],1);
        assert_eq!(value["buckets"][0],json!({"name":"native-bucket","s3Name":"server-s3-alias","regionId":"z0","permission":"readonly"}));
        assert!(!value.to_string().contains("not-needed-by-picker"));
        for field in ["accessKeyId","secretAccessKey","sessionToken","endpoint","credentials"] {assert!(!value.to_string().contains(field));}
    }

    #[test]
    fn denied_connection_has_no_fabricated_picker_entries(){
        let denied=qiniu::Capability::from_error(&qiniu::QiniuError::http(403));
        let report=qiniu::ConnectionReport {authentication:denied.clone(),region_discovery:denied.clone(),bucket_access:denied.clone(),download_domain:denied,buckets:vec![]};
        let value=qiniu_connection_report_value(&report);assert_eq!(value["success"],false);assert_eq!(value["buckets"],json!([]));assert_eq!(value["bucketCount"],0);
    }

    fn profile() -> Profile {
        Profile { id:"test-profile".into(), name:"test".into(), provider:S3Provider::Qiniu,
            access_key_id:"example-ak".into(),secret_access_key:"example-sk".into(),session_token:None,
            endpoint:None,region:None,default_bucket:None,r2_analytics_token:None,qiniu:Some(qiniu::QiniuConfig::default()),
            created_at:"test".into(),updated_at:"revision-1".into() }
    }
    #[test]
    fn folder_markers_cannot_be_reported_as_recursive_mutation_success(){
        assert!(ensure_qiniu_file_mutations(&["folder/".into()]).is_err());
        assert!(ensure_qiniu_file_mutations(&["file".into(),"folder/".into()]).is_err());
        assert!(ensure_qiniu_file_mutations(&["folder/file".into()]).is_ok());
    }
    #[test]
    fn delayed_delete_cannot_use_changed_credentials_or_environment(){
        let value=profile();assert!(ensure_expected_revision(&value,Some(&value.updated_at)).is_ok());
        assert!(ensure_expected_revision(&value,Some("previous-revision")).is_err());
    }

    #[test]
    fn qiniu_write_preflight_rejects_read_only_without_promoting_unknown() {
        let mut bucket=qiniu::QiniuBucket{name:"fixture".into(),s3_name:Some("fixture-alias".into()),kodo_region_id:None,created_at:None,permission:Some("readonly".into()),remark:None};
        assert!(ensure_qiniu_writable(&bucket).unwrap_err().contains("read-only"));
        bucket.permission=None;
        // No local grant is inferred: this only permits a server-side check.
        assert!(ensure_qiniu_writable(&bucket).is_ok());
    }

    #[test]
    fn profile_info_exposes_credential_mode_but_not_session_secret() {
        let mut value=profile();
        assert!(!to_profile_info(&value).has_session_token);
        value.session_token=Some("fixture-secret-session-token".into());
        let info=to_profile_info(&value);
        assert!(info.has_session_token);
        let serialized=serde_json::to_string(&info).unwrap();
        assert!(serialized.contains("\"hasSessionToken\":true"));
        assert!(!serialized.contains("fixture-secret-session-token"));
        value.session_token=Some("   ".into());
        assert!(!to_profile_info(&value).has_session_token);
        assert!(serde_json::from_value::<ProfileCredentialInput>(json!({"profileId":"p","field":"sessionToken"})).is_err());
    }

    #[test]
    fn locked_vault_cannot_repopulate_qiniu_credentials_from_a_cloned_profile() {
        let state = AppState::default();
        let profile = profile();
        {
            let mut vault = state.vault.lock().unwrap();
            vault.unlocked = true;
            vault.data = Some(VaultData {profiles:vec![profile.clone()],..Default::default()});
        }
        assert!(matches!(get(&state,&profile),Ok(StorageBackend::Qiniu(_))));
        {
            let mut vault=state.vault.lock().unwrap();
            lock_vault_runtime(&mut vault);
            clear(&state);
        }
        assert!(get(&state,&profile).is_err());
        assert!(state.backends.lock().unwrap().qiniu.is_empty());
    }

    #[test]
    fn stale_profile_revision_cannot_reuse_a_cached_client() {
        let state=AppState::default();
        let old=profile();
        let mut current=old.clone(); current.updated_at="revision-2".into();
        {
            let mut vault=state.vault.lock().unwrap();
            vault.unlocked=true;vault.data=Some(VaultData{profiles:vec![current.clone()],..Default::default()});
        }
        assert!(get(&state,&old).is_err());
        assert!(matches!(get(&state,&current),Ok(StorageBackend::Qiniu(_))));
        invalidate(&state,&current.id);
        assert!(state.backends.lock().unwrap().qiniu.is_empty());
    }

    #[test]
    fn locking_aborts_a_registered_qiniu_request() {
        let runtime=tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        runtime.block_on(async {
            let state=AppState::default();let profile=profile();
            {let mut vault=state.vault.lock().unwrap();vault.unlocked=true;vault.data=Some(VaultData{profiles:vec![profile.clone()],..Default::default()});}
            let future=guarded(&state,&profile,async { futures_util::future::pending::<Result<(),String>>().await });
            tokio::pin!(future);
            assert!(tokio::time::timeout(StdDuration::from_millis(5), &mut future).await.is_err());
            {let mut vault=state.vault.lock().unwrap();lock_vault_runtime(&mut vault);clear(&state);}
            assert!(future.await.is_err());
            assert!(state.backends.lock().unwrap().tasks.is_empty());
        });
    }
}
