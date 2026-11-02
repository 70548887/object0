//! Credential-safe, per-object deletion outcomes shared by provider RPC paths.
//! A transport success is not evidence that every requested object was deleted.
use super::{qiniu, S3Client};
use serde::Serialize;
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteResult {
    pub key: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteReport {
    pub results: Vec<DeleteResult>,
}

impl DeleteReport {
    /// Compatibility for existing queue jobs that only support one final status.
    /// Interactive RPC callers must return the report rather than discarding it.
    pub fn ensure_all_succeeded(&self) -> Result<(), String> {
        let failed = self.results.iter().filter(|item| !item.success).count();
        if failed == 0 { return Ok(()); }
        let confirmed = self.results.len() - failed;
        Err(format!("删除部分失败：{confirmed} 个已确认删除，{failed} 个失败或结果未确认，请刷新列表后仅重试失败项 / Delete partially failed: {confirmed} confirmed deleted, {failed} failed or unconfirmed; refresh before retrying failed items"))
    }
}

fn unique_keys(keys: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    keys.iter().filter(|key| seen.insert((*key).clone())).cloned().collect()
}

fn unconfirmed(key: &str) -> DeleteResult {
    DeleteResult {
        key: key.into(), success: false,
        error: Some("删除结果未确认，请刷新列表后核对，勿假定文件已删除 / Deletion is unconfirmed; refresh and verify before retrying".into()),
    }
}

fn s3_error(code: Option<&str>) -> String {
    match code {
        Some("AccessDenied") => "访问被拒绝，请检查对象删除权限 / Access denied; check object-delete permission",
        Some("InvalidArgument") => "对象删除参数无效 / Invalid object-delete argument",
        Some("NoSuchKey") => "对象不存在，未取得删除确认 / Object does not exist; deletion was not confirmed",
        Some("SlowDown") => "存储服务限流，请稍后重试 / Storage service rate-limited the operation; retry later",
        Some("InternalError" | "ServiceUnavailable") => "存储服务暂时失败，删除结果未确认 / Storage service failed; deletion is unconfirmed",
        _ => "删除结果未确认，请刷新列表后核对 / Deletion is unconfirmed; refresh and verify",
    }.into()
}

pub(crate) async fn s3_delete_report(client: &S3Client, bucket: &str, keys: &[String]) -> Result<DeleteReport, String> {
    let items = super::s3::s3_delete_keys_detailed(client, bucket, keys).await?;
    Ok(DeleteReport { results: items.into_iter().map(|item| DeleteResult {
        key: item.key, success: item.deleted,
        error: if item.deleted { None } else { Some(s3_error(item.error_code.as_deref())) },
    }).collect() })
}

fn qiniu_results(keys: &[String], items: Vec<qiniu::client::QiniuBatchResult>) -> Vec<DeleteResult> {
    // The native protocol is positional. Never zip a short response or accept
    // a reordered/duplicated provider result as confirmation for another key.
    if items.len() != keys.len() || items.iter().zip(keys).any(|(item, key)| item.key != *key) {
        return keys.iter().map(|key| unconfirmed(key)).collect();
    }
    items.into_iter().map(|item| {
        if item.success && (200..300).contains(&item.status) {
            DeleteResult { key: item.key, success: true, error: None }
        } else {
            // Ignore messages/error structs supplied by callers or services.
            // Only our fixed safe HTTP classification reaches the frontend.
            DeleteResult { key: item.key, success: false,
                error: Some(qiniu::QiniuError::http(item.status).to_string()) }
        }
    }).collect()
}

pub(crate) async fn qiniu_delete_report(client: &qiniu::QiniuClient, context: &qiniu::ResolvedBucketContext, keys: &[String]) -> Result<DeleteReport, String> {
    let unique = unique_keys(keys);
    let mut results = Vec::with_capacity(unique.len());
    // Call the existing native implementation once per chunk: a later network
    // failure must not erase confirmations already obtained for earlier chunks.
    for chunk in unique.chunks(1000) {
        match client.delete_objects(context, chunk).await {
            Ok(items) => results.extend(qiniu_results(chunk, items)),
            Err(error) => {
                // A refusal is a known failure; all other failures, including
                // malformed response after a write, leave remote state unknown.
                let permission_denied = error.state == qiniu::CapabilityState::Forbidden;
                results.extend(chunk.iter().map(|key| if permission_denied {
                    DeleteResult {key:key.clone(),success:false,error:Some("访问被拒绝，请检查对象删除权限 / Access denied; check object-delete permission".into())}
                } else { unconfirmed(key) }));
            }
        }
    }
    Ok(DeleteReport { results })
}

#[cfg(test)]
#[path = "batch_delete_tests.rs"]
mod tests;
