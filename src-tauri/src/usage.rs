//! Read-only whole-bucket usage: official snapshots or a clearly sourced,
//! bounded object scan. Missing metrics never become zero-valued totals.

use super::*;
use futures_util::future::{AbortHandle, AbortRegistration, Abortable};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_SCAN_PAGES: u32 = 1_000;
const SCAN_BUDGET: StdDuration = StdDuration::from_secs(60);
const PAGE_TIMEOUT: StdDuration = StdDuration::from_secs(12);
const MAX_USAGE_TASKS: usize = 16;
const MAX_CANCELLED_REQUESTS: usize = 128;
const CANCELLED: &str = "用量统计已取消";

pub(crate) fn emit_changed(app: &AppHandle, profile_id: &str, bucket: &str) {
    let _ = app.emit("bucket-usage:changed", json!({
        "profileId": profile_id,
        "bucket": bucket,
    }));
}

/// Emits once when a scope may have changed, including early error returns.
pub(crate) struct UsageChangeGuard<'a> {
    app: &'a AppHandle,
    profile_id: &'a str,
    bucket: &'a str,
    dirty: bool,
}

impl<'a> UsageChangeGuard<'a> {
    pub(crate) fn new(app: &'a AppHandle, profile_id: &'a str, bucket: &'a str) -> Self {
        Self { app, profile_id, bucket, dirty: false }
    }

    pub(crate) fn mark_changed(&mut self) { self.dirty = true; }
}

impl Drop for UsageChangeGuard<'_> {
    fn drop(&mut self) {
        if self.dirty { emit_changed(self.app, self.profile_id, self.bucket); }
    }
}

#[derive(Default)]
pub(crate) struct UsageRuntime {
    tasks: HashMap<String, (String, AbortHandle)>,
    cancelled: HashMap<String, Instant>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageInput {
    profile_id: String,
    bucket: String,
    request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageCancelInput {
    request_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BucketUsage {
    profile_id: String,
    bucket: String,
    bytes: Option<u64>,
    object_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata_bytes: Option<u64>,
    source: &'static str,
    measured_at: Option<String>,
    fetched_at: String,
    complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    scanned_pages: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    qiniu_analytics: Option<QiniuAnalyticsDetails>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QiniuAnalyticsDetails {
    complete: bool,
    measured_at: Option<String>,
    classes: Vec<qiniu::analytics::ClassUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

struct UsageTaskGuard<'a> {
    runtime: &'a Mutex<UsageRuntime>,
    request_id: String,
}

impl Drop for UsageTaskGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.tasks.remove(&self.request_id);
        }
    }
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub(crate) fn normalize_analytics_token(value: Option<String>) -> Result<Option<String>, String> {
    let Some(token) = value.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if token.len() > 4096 || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("统计 API Token 格式无效，请重新填写".to_string());
    }
    Ok(Some(token))
}

fn prune_cancelled(runtime: &mut UsageRuntime) {
    runtime.cancelled.retain(|_, time| time.elapsed() < StdDuration::from_secs(120));
}

fn register_task<'a>(
    state: &'a AppState,
    input: &UsageInput,
) -> Result<(Profile, AbortRegistration, UsageTaskGuard<'a>), String> {
    if !valid_request_id(&input.request_id) || input.bucket.trim().is_empty() || input.bucket.len() > 255 {
        return Err("用量统计请求参数无效".to_string());
    }
    // Lock order matches vault lock/reset: a task cannot register after the vault
    // was locked while carrying a credential cloned before that lock.
    let vault = lock_state(&state.vault)?;
    ensure_unlocked(&vault)?;
    let profile = vault.data.as_ref()
        .and_then(|data| data.profiles.iter().find(|profile| profile.id == input.profile_id))
        .cloned()
        .ok_or_else(|| "未找到存储账号".to_string())?;
    let mut runtime = lock_state(&state.usage)?;
    prune_cancelled(&mut runtime);
    if runtime.cancelled.contains_key(&input.request_id) {
        return Err(CANCELLED.to_string());
    }
    if runtime.tasks.contains_key(&input.request_id) {
        return Err("该用量统计请求正在进行中".to_string());
    }
    if runtime.tasks.len() >= MAX_USAGE_TASKS {
        return Err("用量统计任务过多，请稍后重试".to_string());
    }
    let (handle, registration) = AbortHandle::new_pair();
    runtime.tasks.insert(input.request_id.clone(), (profile.id.clone(), handle));
    Ok((profile, registration, UsageTaskGuard {
        runtime: &state.usage,
        request_id: input.request_id.clone(),
    }))
}

pub(crate) fn cancel(state: &AppState, input: UsageCancelInput) -> Result<(), String> {
    if !valid_request_id(&input.request_id) {
        return Err("用量统计请求标识无效".to_string());
    }
    let mut runtime = lock_state(&state.usage)?;
    prune_cancelled(&mut runtime);
    if let Some((_, handle)) = runtime.tasks.get(&input.request_id) {
        handle.abort();
    }
    // Cancellation may race ahead of registration when a tab changes quickly.
    if runtime.cancelled.len() >= MAX_CANCELLED_REQUESTS {
        if let Some(oldest) = runtime.cancelled.iter().min_by_key(|(_, time)| **time).map(|(id, _)| id.clone()) {
            runtime.cancelled.remove(&oldest);
        }
    }
    runtime.cancelled.insert(input.request_id, Instant::now());
    Ok(())
}

pub(crate) fn cancel_all(state: &AppState) {
    if let Ok(runtime) = state.usage.lock() {
        for (_, handle) in runtime.tasks.values() { handle.abort(); }
    }
}

/// Account edits must stop old credential-bearing analytics/scan requests,
/// not just hide the response after it has completed.
pub(crate) fn invalidate_profile(state: &AppState, profile_id: &str) {
    if let Ok(runtime) = state.usage.lock() {
        for (owner, handle) in runtime.tasks.values() {
            if owner == profile_id { handle.abort(); }
        }
    }
}

pub(crate) async fn get(state: &AppState, input: UsageInput) -> Result<BucketUsage, String> {
    let (profile, registration, _guard) = register_task(state, &input)?;
    let result = Abortable::new(collect_usage(&profile, &input.bucket), registration)
        .await.map_err(|_| CANCELLED.to_string())??;
    let vault = lock_state(&state.vault)?;
    ensure_unlocked(&vault)?;
    if !vault.data.as_ref().is_some_and(|data| data.profiles.iter().any(|item| item.id == profile.id && item.updated_at == profile.updated_at)) {
        return Err("存储账号已变更，请重新刷新用量".to_string());
    }
    Ok(result)
}

async fn collect_usage(profile: &Profile, bucket: &str) -> Result<BucketUsage, String> {
    let started = Instant::now();
    if profile.provider == S3Provider::Qiniu {
        return collect_qiniu_usage(profile, bucket, started).await;
    }
    let warning = if profile.provider == S3Provider::R2 && profile.r2_analytics_token.is_some() {
        match r2_snapshot(profile, bucket).await {
            Ok(result) => return Ok(result),
            Err(message) => Some(format!("R2 官方统计：{message}")),
        }
    } else { None };
    let result = scan_bucket(profile, bucket, started, warning.clone()).await;
    result.map_err(|error| match warning {
        Some(warning) => format!("{warning}；S3 扫描：{error}"),
        None => error,
    })
}

async fn collect_qiniu_usage(profile: &Profile, bucket: &str, started: Instant) -> Result<BucketUsage, String> {
    let client = storage_backend::qiniu_client(profile)?;
    let context = tokio::time::timeout(PAGE_TIMEOUT, client.resolve_named_bucket(bucket)).await
        .map_err(|_| "七牛空间解析超时 / Qiniu bucket resolution timed out".to_string())?
        .map_err(|error| error.to_string())?;
    if context.backend_mode != "kodo" {
        return Err("此七牛私有或受限 S3 连接的全桶用量尚未验证，未扩大授权范围 / Whole-bucket usage is not verified for this private or restricted Qiniu S3 connection; access scope was not expanded".to_string());
    }
    let report = match tokio::time::timeout(StdDuration::from_secs(24), client.classified_usage(&context, Utc::now())).await {
        Ok(result) => result.map_err(|error| error.to_string()),
        Err(_) => Err("七牛官方统计超时 / Official Qiniu analytics timed out".into()),
    };
    finish_qiniu_usage(profile, bucket, started, &client, &context, report).await
}

/// Keep the official categories as independent evidence even when a scan
/// becomes the displayed value. Never combine metrics from the two sources.
async fn finish_qiniu_usage(
    profile: &Profile, bucket: &str, started: Instant, client: &qiniu::QiniuClient,
    context: &qiniu::ResolvedBucketContext, report: Result<qiniu::analytics::AnalyticsReport, String>,
) -> Result<BucketUsage, String> {
    let details = match report {
        Ok(report) => {
            if report.complete {
                if let (Some(bytes), Some(object_count), Some(measured_at)) = (report.bytes, report.object_count, report.measured_at.as_ref()) {
                    return Ok(BucketUsage {profile_id:profile.id.clone(),bucket:bucket.into(),bytes:Some(bytes),object_count:Some(object_count),metadata_bytes:None,
                        source:"qiniu",measured_at:Some(measured_at.clone()),fetched_at:now_iso(),complete:true,scanned_pages:None,
                        warning:report.warning.clone(),qiniu_analytics:Some(QiniuAnalyticsDetails {complete:true,measured_at:report.measured_at,classes:report.classes,warning:report.warning})});
                }
            }
            QiniuAnalyticsDetails {complete:false,measured_at:report.measured_at,classes:report.classes,warning:report.warning}
        }
        Err(error) => QiniuAnalyticsDetails {complete:false,measured_at:None,classes:vec![],warning:Some(error)},
    };
    let reason = details.warning.as_deref().unwrap_or("分类缺项或时间未对齐 / Missing classes or unaligned measurement times");
    let warning = format!("七牛官方统计暂不能确认全桶总量，回退对象扫描 / Official Qiniu totals are unconfirmed; falling back to an object scan. {reason}");
    match scan_qiniu_objects(profile,bucket,started,client,context,Some(warning.clone())).await {
        Ok(mut scan) => {scan.qiniu_analytics=Some(details);Ok(scan)}
        Err(error) => Ok(BucketUsage {profile_id:profile.id.clone(),bucket:bucket.into(),bytes:None,object_count:None,metadata_bytes:None,
            source:"qiniu",measured_at:None,fetched_at:now_iso(),complete:false,scanned_pages:None,
            warning:Some(format!("{warning}；扫描未取得可用结果 / Scan returned no usable result: {error}")),qiniu_analytics:Some(details)}),
    }
}

async fn scan_qiniu_objects(
    profile: &Profile, bucket: &str, started: Instant, client: &qiniu::QiniuClient,
    context: &qiniu::ResolvedBucketContext, warning: Option<String>,
) -> Result<BucketUsage, String> {
    let mut marker: Option<String> = None;
    let mut seen = HashSet::new();
    let mut bytes = 0_u64;
    let mut count = 0_u64;
    let mut pages = 0_u32;
    loop {
        let remaining = SCAN_BUDGET.saturating_sub(started.elapsed());
        if remaining.is_zero() || pages >= MAX_SCAN_PAGES {
            return if pages == 0 { Err("七牛用量统计超时 / Qiniu usage timed out".to_string()) }
            else { Ok(partial_scan(profile, bucket, bytes, count, pages, warning, "扫描达到时间或分页上限，仅显示已扫描对象的用量下限。")) };
        }
        let response = tokio::time::timeout(remaining.min(PAGE_TIMEOUT), client.list_objects(&context, "", None, marker.as_deref(), 1000)).await;
        let page = match response {
            Ok(Ok(page)) => page,
            Ok(Err(error)) if pages > 0 => return Ok(partial_scan(profile, bucket, bytes, count, pages, warning, &format!("{error}；扫描未完成，当前值仅是已扫描对象的下限。"))),
            Err(_) if pages > 0 => return Ok(partial_scan(profile, bucket, bytes, count, pages, warning, "七牛用量扫描超时；当前值仅是已扫描对象的下限。")),
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_) => return Err("七牛用量扫描超时 / Qiniu usage scan timed out".to_string()),
        };
        if page.is_truncated && page.next_cursor.as_ref().is_some_and(|next| seen.contains(next)) {
            return Ok(partial_scan(profile, bucket, bytes, count, pages, warning, "存储服务重复返回分页标识，扫描已停止；当前值仅是用量下限。"));
        }
        for object in page.objects {
            bytes = bytes.checked_add(object.size).filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or_else(|| "存储桶用量超出安全数值范围，无法准确显示".to_string())?;
            count = count.checked_add(1).filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or_else(|| "对象数量超出安全数值范围，无法准确显示".to_string())?;
        }
        pages += 1;
        if !page.is_truncated {
            return Ok(BucketUsage {profile_id: profile.id.clone(), bucket: bucket.to_string(), bytes:Some(bytes), object_count:Some(count),
                metadata_bytes: None, source: "scan", measured_at: Some(now_iso()), fetched_at: now_iso(),
                complete: true, scanned_pages: Some(pages), warning, qiniu_analytics:None});
        }
        match page.next_cursor {
            Some(next) if seen.insert(next.clone()) => marker = Some(next),
            _ => return Ok(partial_scan(profile, bucket, bytes, count, pages, warning, "存储服务返回异常分页标识，扫描已停止；当前值仅是用量下限。")),
        }
    }
}

fn partial_scan(
    profile: &Profile, bucket: &str, bytes: u64, count: u64, pages: u32,
    warning: Option<String>, reason: &str,
) -> BucketUsage {
    let detail = match warning { Some(message) => format!("{message} {reason}"), None => reason.to_string() };
    BucketUsage {
        profile_id: profile.id.clone(), bucket: bucket.to_string(), bytes:Some(bytes), object_count:Some(count),
        metadata_bytes: None, source: "scan", measured_at: Some(now_iso()), fetched_at: now_iso(),
        complete: false, scanned_pages: Some(pages), warning: Some(detail), qiniu_analytics:None,
    }
}

async fn scan_bucket(
    profile: &Profile, bucket: &str, started: Instant, warning: Option<String>,
) -> Result<BucketUsage, String> {
    let client = to_s3_client(profile).map_err(|_| "无法创建存储连接，请检查账号配置".to_string())?;
    let mut token: Option<String> = None;
    let mut seen_tokens = HashSet::new();
    let mut bytes = 0_u64;
    let mut count = 0_u64;
    let mut pages = 0_u32;
    loop {
        let remaining = SCAN_BUDGET.saturating_sub(started.elapsed());
        if remaining.is_zero() || pages >= MAX_SCAN_PAGES {
            return if pages == 0 { Err("用量统计超时，请稍后重试".to_string()) }
            else { Ok(partial_scan(profile, bucket, bytes, count, pages, warning, "扫描达到时间或分页上限，仅显示已扫描对象的用量下限。")) };
        }
        // No delimiter and no prefix: every descendant contributes to the bucket,
        // independent of the folder currently open in the file browser.
        let request = client.list_objects_v2().bucket(bucket).max_keys(1000)
            .set_continuation_token(token.clone());
        let response = tokio::time::timeout(remaining.min(PAGE_TIMEOUT), request.send()).await;
        let page = match response {
            Ok(Ok(output)) => Ok(output),
            Ok(Err(error)) => Err(s3_errors::describe("扫描存储桶用量", &error)),
            Err(_) => Err("扫描存储桶用量失败：单页请求超时，请检查网络后重试".to_string()),
        };
        let output = match page {
            Ok(output) => output,
            Err(error) if pages > 0 => return Ok(partial_scan(profile, bucket, bytes, count, pages, warning, &format!("{error}；扫描未完成，当前值仅是已扫描对象的下限。"))),
            Err(error) => return Err(error),
        };
        let truncated = output.is_truncated().ok_or_else(|| "存储服务缺少分页状态，不能确认空桶或完整用量 / Storage response lacks pagination status; empty or complete usage cannot be confirmed".to_string())?;
        let next = output.next_continuation_token().filter(|value| !value.is_empty()).map(str::to_string);
        if truncated && next.as_ref().is_some_and(|next| seen_tokens.contains(next)) {
            // A repeated cursor can mean a repeated page. Exclude the page from
            // the lower bound rather than double-counting its objects.
            return Ok(partial_scan(profile, bucket, bytes, count, pages, warning, "存储服务重复返回分页标识，扫描已停止；当前值仅是用量下限。"));
        }
        let mut page_bytes = 0_u64;
        let mut page_count = 0_u64;
        for object in output.contents() {
            let size = object.size().filter(|value| *value >= 0)
                .ok_or_else(|| "存储服务返回了无效的对象大小，统计已停止".to_string())? as u64;
            if object.key().is_none() { return Err("存储服务返回了无效的对象信息，统计已停止".to_string()); }
            page_bytes = page_bytes.checked_add(size).filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or_else(|| "对象用量超出安全数值范围，无法准确显示".to_string())?;
            page_count = page_count.checked_add(1).ok_or_else(|| "对象数量超出安全数值范围".to_string())?;
        }
        bytes = bytes.checked_add(page_bytes).filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| "存储桶用量超出安全数值范围，无法准确显示".to_string())?;
        count = count.checked_add(page_count).filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| "对象数量超出安全数值范围，无法准确显示".to_string())?;
        pages += 1;
        if !truncated {
            return Ok(BucketUsage {
                profile_id: profile.id.clone(), bucket: bucket.to_string(), bytes:Some(bytes), object_count:Some(count),
                metadata_bytes: None, source: "scan", measured_at: Some(now_iso()), fetched_at: now_iso(),
                complete: true, scanned_pages: Some(pages), warning, qiniu_analytics:None,
            });
        }
        match next {
            Some(next) if seen_tokens.insert(next.clone()) => token = Some(next),
            _ => return Ok(partial_scan(profile, bucket, bytes, count, pages, warning, "存储服务返回异常分页标识，扫描已停止；当前值仅是用量下限。")),
        }
    }
}

fn r2_scope(profile: &Profile, bucket: &str) -> Result<(String, String), String> {
    let endpoint = profile.endpoint.as_ref().ok_or_else(|| "未配置有效的 R2 统计接口地址".to_string())?;
    let parsed = Url::parse(endpoint).map_err(|_| "无法识别 R2 账号，请检查接口地址".to_string())?;
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let prefix = host.strip_suffix(".r2.cloudflarestorage.com")
        .ok_or_else(|| "R2 统计只支持官方接口地址".to_string())?;
    let parts: Vec<_> = prefix.split('.').collect();
    let account_id = parts.first().copied().unwrap_or("");
    if account_id.len() != 32 || !account_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("无法从接口地址识别 R2 账号 ID".to_string());
    }
    let scoped_bucket = match parts.as_slice() {
        [_] => bucket.to_string(),
        [_, "eu"] => format!("eu_{bucket}"),
        [_, "us"] => format!("us_{bucket}"),
        _ => return Err("此 R2 管辖区域暂不支持官方统计".to_string()),
    };
    Ok((account_id.to_string(), scoped_bucket))
}

fn safe_metric(value: &Value, key: &str) -> Result<u64, String> {
    let number = value.get(key).and_then(Value::as_f64)
        .filter(|number| number.is_finite() && *number >= 0.0 && number.fract() == 0.0 && *number <= MAX_SAFE_INTEGER as f64)
        .ok_or_else(|| "R2 返回了缺失或无效的用量数据".to_string())?;
    Ok(number as u64)
}

async fn r2_snapshot(profile: &Profile, bucket: &str) -> Result<BucketUsage, String> {
    let (account_id, scoped_bucket) = r2_scope(profile, bucket)?;
    let token = profile.r2_analytics_token.as_deref().filter(|value| !value.is_empty())
        .ok_or_else(|| "未配置 R2 用量统计令牌".to_string())?;
    let now = Utc::now();
    let start = now - Duration::days(30);
    let query = r#"query BucketUsage($accountTag: string!, $startDate: Time!, $endDate: Time!, $bucketName: string!) {
      viewer { accounts(filter: {accountTag: $accountTag}) {
        r2StorageAdaptiveGroups(limit: 1, filter: {datetime_geq: $startDate, datetime_leq: $endDate, bucketName: $bucketName}, orderBy: [datetime_DESC]) {
          max {payloadSize metadataSize objectCount}
          dimensions {datetime}
        }
      }}
    }"#;
    let client = reqwest::Client::builder()
        .timeout(StdDuration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "无法初始化官方统计连接".to_string())?;
    let mut response = client.post("https://api.cloudflare.com/client/v4/graphql")
        .bearer_auth(token)
        .json(&json!({"query": query, "variables": {
            "accountTag": account_id,
            "startDate": start.to_rfc3339(), "endDate": now.to_rfc3339(),
            "bucketName": scoped_bucket,
        }}))
        .send().await.map_err(|_| "无法连接 R2 官方统计接口".to_string())?;
    if !response.status().is_success() {
        return Err(format!("R2 官方统计请求失败（HTTP {}），请检查统计令牌权限", response.status().as_u16()));
    }
    // Limit memory even if a proxy or provider returns an unexpected body.
    if response.content_length().is_some_and(|length| length > 1_048_576) {
        return Err("R2 官方统计响应过大，已停止读取".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取 R2 官方统计响应失败".to_string())? {
        if bytes.len().saturating_add(chunk.len()) > 1_048_576 {
            return Err("R2 官方统计响应过大，已停止读取".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| "R2 官方统计响应格式无效".to_string())?;
    if data.get("errors").and_then(Value::as_array).is_some_and(|errors| !errors.is_empty()) {
        return Err("R2 官方统计不可用，请检查账号及统计令牌权限".to_string());
    }
    let accounts = data.pointer("/data/viewer/accounts").and_then(Value::as_array)
        .filter(|accounts| accounts.len() == 1)
        .ok_or_else(|| "R2 官方统计没有返回当前账号".to_string())?;
    let snapshots = accounts[0].get("r2StorageAdaptiveGroups").and_then(Value::as_array)
        .ok_or_else(|| "R2 官方统计缺少存储桶数据".to_string())?;
    let snapshot = snapshots.first().ok_or_else(|| "R2 官方暂未生成此存储桶的用量统计".to_string())?;
    let metrics = snapshot.get("max").ok_or_else(|| "R2 官方统计缺少用量字段".to_string())?;
    let measured = snapshot.pointer("/dimensions/datetime").and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .ok_or_else(|| "R2 官方统计缺少有效的统计时间".to_string())?;
    if measured > now + Duration::minutes(5) || measured < start {
        return Err("R2 官方统计的时间超出查询范围".to_string());
    }
    let warning = if now.signed_duration_since(measured).num_hours() >= 24 {
        Some("R2 官方统计快照超过 24 小时，数据可能延迟。".to_string())
    } else { None };
    Ok(BucketUsage {
        profile_id: profile.id.clone(), bucket: bucket.to_string(),
        bytes: Some(safe_metric(metrics, "payloadSize")?), object_count: Some(safe_metric(metrics, "objectCount")?),
        metadata_bytes: if metrics.get("metadataSize").is_some_and(|value| !value.is_null()) { Some(safe_metric(metrics, "metadataSize")?) } else { None }, source: "r2",
        measured_at: Some(measured.to_rfc3339()), fetched_at: now_iso(), complete: true,
        scanned_pages: None, warning, qiniu_analytics:None,
    })
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
