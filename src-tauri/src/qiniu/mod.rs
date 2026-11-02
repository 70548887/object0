//! Native Qiniu protocol layer. No credentials or signed URLs are exposed by
//! discovery responses, and no third-party telemetry is sent.

pub mod auth;
pub mod analytics;
pub mod client;
pub mod endpoint;
pub mod region;
pub mod transfer;
pub mod range_download;
pub mod s3_bridge;
pub mod bucket_binding;
pub mod multipart;
pub mod share;
#[cfg(test)] mod contract_tests;
#[cfg(test)] mod bucket_binding_tests;

pub use client::{QiniuClient, QiniuCredentials};
pub use region::{QiniuRegion, ResolvedBucketContext};
use serde::{Deserialize, Serialize};
use std::fmt;

pub const REFERENCE_BROWSER_COMMIT: &str = "2c5d7bad6c44e9d57529f8f19bf0faa7c2ee27dd";
pub const REFERENCE_ADAPTER_VERSION: &str = "0.7.1";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QiniuMode { #[default] Public, Private }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QiniuManualRegion {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub s3_endpoint: String,
}

/// User-supplied, explicit bucket identity for credentials that cannot call the
/// native account-wide listing API. A native name is never guessed as an S3 ID.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QiniuBucketBinding {
    pub native_name: String,
    pub s3_name: String,
    pub s3_region_id: String,
    pub s3_endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kodo_region_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QiniuConfig {
    #[serde(default)] pub mode: QiniuMode,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub uc_url: Option<String>,
    #[serde(default)] pub regions: Vec<QiniuManualRegion>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")] pub bucket_bindings: Vec<QiniuBucketBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub download_domain: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub share_portal: Option<String>,
    /// Explicitly trusted directory-share API origin. Private portal discovery
    /// cannot silently authorize a different service to receive credentials.
    #[serde(default, skip_serializing_if = "Option::is_none")] pub share_api_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub trusted_ca_path: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityState { Supported, Forbidden, Unsupported, Unknown, Unavailable }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub state: CapabilityState,
    #[serde(skip_serializing_if = "Option::is_none")] pub reason: Option<String>,
}
impl Capability {
    pub fn supported() -> Self { Self {state: CapabilityState::Supported, reason: None} }
    pub fn from_error(error: &QiniuError) -> Self { Self {state: error.state, reason: Some(error.to_string())} }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QiniuBucket {
    /// Human/native bucket name. Never substitute this for s3_name.
    pub name: String,
    /// Server supplied, globally unique S3 name/ID. Missing is not guessed.
    #[serde(skip_serializing_if = "Option::is_none")] pub s3_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub kodo_region_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub permission: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub remark: Option<String>,
}

/// Safe diagnostics only: HTTP response bodies, source errors and request URLs
/// can contain secrets and are deliberately not retained here.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QiniuError {
    pub state: CapabilityState,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")] pub status: Option<u16>,
}
impl QiniuError {
    pub fn new(state: CapabilityState, code: &str, message: &str) -> Self {
        Self {state, code: code.to_string(), message: message.to_string(), status: None}
    }
    pub fn invalid(message: &str) -> Self {Self::new(CapabilityState::Unavailable, "invalid-config", message)}
    pub fn unsupported(message: &str) -> Self {Self::new(CapabilityState::Unsupported, "unsupported", message)}
    pub fn http(status: u16) -> Self {
        let (state, code, message) = match status {
            401 | 403 => (CapabilityState::Forbidden, "permission-denied", "七牛请求被拒绝，请检查当前账号的权限 / Qiniu permission denied"),
            404 | 405 | 501 => (CapabilityState::Unsupported, "unsupported-api", "当前环境不支持该七牛接口 / Qiniu API unavailable in this deployment"),
            429 => (CapabilityState::Unavailable, "rate-limited", "七牛请求过于频繁，请稍后重试 / Qiniu rate limit exceeded"),
            612 => (CapabilityState::Unavailable, "not-found", "七牛对象或空间不存在 / Qiniu object or bucket not found"),
            614 => (CapabilityState::Unavailable, "already-exists", "七牛目标已存在，请确认覆盖策略 / Qiniu target already exists"),
            631 => (CapabilityState::Unavailable, "bucket-not-found", "七牛空间不存在 / Qiniu bucket not found"),
            408 | 504 => (CapabilityState::Unavailable, "timeout", "七牛请求超时 / Qiniu request timed out"),
            _ => (CapabilityState::Unavailable, "request-failed", "七牛服务请求失败，请重试 / Qiniu service request failed"),
        };
        Self {state, code: code.to_string(), message: message.to_string(), status: Some(status)}
    }
}
impl fmt::Display for QiniuError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} [{}]", self.message, self.code)?;
        if let Some(status) = self.status {write!(f, " (HTTP {status})")?;}
        Ok(())
    }
}
impl std::error::Error for QiniuError {}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionReport {
    pub authentication: Capability,
    pub bucket_access: Capability,
    pub region_discovery: Capability,
    pub download_domain: Capability,
    pub buckets: Vec<QiniuBucket>,
}
