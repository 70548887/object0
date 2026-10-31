//! Safe, actionable S3 diagnostics. Never format a complete SDK error or request.

use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use std::error::Error;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FailureKind {
    AccessDenied,
    InvalidKey,
    Signature,
    MissingBucket,
    ExpiredToken,
    Clock,
    Timeout,
    Dns,
    Tls,
    Connection,
    InvalidRequest,
    Response,
    Throttled,
    Unavailable,
    Service,
}

impl FailureKind {
    fn message(self) -> &'static str {
        match self {
            Self::AccessDenied => "访问被拒绝，请检查凭据是否有当前存储桶的对象列表读取权限",
            Self::InvalidKey => "访问密钥 ID 无效，请检查保存的 S3 凭据及其所属账号",
            Self::Signature => "请求签名不匹配，请检查访问密钥、接口地址、区域和本机时间",
            Self::MissingBucket => "存储桶不存在，请检查桶名称及其所属账号或管辖区域",
            Self::ExpiredToken => "会话令牌无效或已过期，请更新凭据",
            Self::Clock => "本机时间与存储服务相差过大，请校准系统时间后重试",
            Self::Timeout => "请求超时，请检查网络连接后重试",
            Self::Dns => "接口域名解析失败，请检查接口地址、DNS 和网络连接",
            Self::Tls => "TLS 连接或证书验证失败，请检查系统时间、证书和代理连接",
            Self::Connection => "连接存储接口失败，请检查网络、代理和接口地址",
            Self::InvalidRequest => "请求参数无效，请检查接口地址、区域和存储桶名称",
            Self::Response => "存储服务返回了无法解析的响应，请检查接口地址及代理连接",
            Self::Throttled => "存储服务请求过于频繁，请稍后重试",
            Self::Unavailable => "存储服务暂时不可用，请稍后重试",
            Self::Service => "存储服务拒绝了请求，请核对连接信息后重试",
        }
    }
}

fn service_kind(code: Option<&str>, status: Option<u16>) -> FailureKind {
    match code {
        Some("AccessDenied" | "AllAccessDisabled" | "Unauthorized" | "Forbidden") => FailureKind::AccessDenied,
        Some("InvalidAccessKeyId" | "InvalidAccessKey") => FailureKind::InvalidKey,
        Some("SignatureDoesNotMatch" | "InvalidSignatureException" | "AuthorizationHeaderMalformed") => FailureKind::Signature,
        Some("NoSuchBucket") => FailureKind::MissingBucket,
        Some("ExpiredToken" | "InvalidToken" | "TokenRefreshRequired") => FailureKind::ExpiredToken,
        Some("RequestTimeTooSkewed" | "RequestExpired") => FailureKind::Clock,
        Some("RequestTimeout" | "RequestTimeoutException") => FailureKind::Timeout,
        Some("SlowDown" | "Throttling" | "ThrottlingException") => FailureKind::Throttled,
        Some("InvalidArgument" | "InvalidRequest" | "InvalidBucketName") => FailureKind::InvalidRequest,
        _ => match status {
            Some(401 | 403) => FailureKind::AccessDenied,
            Some(408 | 504) => FailureKind::Timeout,
            Some(429) => FailureKind::Throttled,
            Some(500..=599) => FailureKind::Unavailable,
            Some(400) => FailureKind::InvalidRequest,
            _ => FailureKind::Service,
        },
    }
}

fn network_kind(error: &(dyn Error + 'static)) -> FailureKind {
    let mut current = Some(error);
    let mut timeout = false;
    let mut tls = false;
    let mut dns = false;
    // Inspect only to classify. Raw source text may contain URLs or credentials;
    // none of it is returned to the UI or written to logs.
    for _ in 0..12 {
        let Some(error) = current else { break };
        let text = error.to_string().to_ascii_lowercase();
        dns |= ["dns", "failed to lookup address", "no such host", "name resolution", "11001"]
            .iter().any(|term| text.contains(term));
        tls |= ["tls", "ssl", "certificate", "unknownissuer", "invalidpeer"]
            .iter().any(|term| text.contains(term));
        timeout |= text.contains("timed out") || text.contains("timeout");
        current = error.source();
    }
    if dns { FailureKind::Dns }
    else if tls { FailureKind::Tls }
    else if timeout { FailureKind::Timeout }
    else { FailureKind::Connection }
}

pub(crate) fn describe<E>(operation: &str, error: &SdkError<E>) -> String
where
    E: ProvideErrorMetadata + Error + 'static,
{
    let status = error.raw_response().map(|response| response.status().as_u16());
    let kind = match error {
        SdkError::ServiceError(_) => service_kind(error.as_service_error().and_then(|error| error.code()), status),
        SdkError::TimeoutError(_) => FailureKind::Timeout,
        SdkError::DispatchFailure(context) if context.is_timeout() => FailureKind::Timeout,
        SdkError::DispatchFailure(_) => network_kind(error),
        SdkError::ConstructionFailure(_) => FailureKind::InvalidRequest,
        SdkError::ResponseError(_) => FailureKind::Response,
        _ => FailureKind::Service,
    };
    // The operation is a developer-supplied label; metadata messages, hosts,
    // request IDs, headers and credential material are deliberately excluded.
    eprintln!("S3 request failed: operation={operation}, kind={kind:?}, http={status:?}");
    let http = status.map(|status| format!("（HTTP {status}）")).unwrap_or_default();
    format!("{operation}失败：{}{http}", kind.message())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_codes_take_precedence_over_generic_http_status() {
        assert_eq!(service_kind(Some("SignatureDoesNotMatch"), Some(403)), FailureKind::Signature);
        assert_eq!(service_kind(Some("InvalidAccessKeyId"), Some(403)), FailureKind::InvalidKey);
        assert_eq!(service_kind(Some("NoSuchBucket"), Some(404)), FailureKind::MissingBucket);
        assert_eq!(service_kind(None, Some(403)), FailureKind::AccessDenied);
        assert_eq!(service_kind(None, Some(503)), FailureKind::Unavailable);
    }

    #[test]
    fn unknown_service_text_is_not_echoed() {
        let kind = service_kind(Some("secret-credential-or-host"), Some(400));
        assert_eq!(kind, FailureKind::InvalidRequest);
        assert!(!kind.message().contains("secret-credential-or-host"));
    }

    #[test]
    fn network_sources_produce_fixed_safe_diagnostics() {
        for (source, expected) in [
            ("dns error at https://private.example/?token=secret", FailureKind::Dns),
            ("invalid peer certificate for private.example", FailureKind::Tls),
            ("connection timed out with secret", FailureKind::Timeout),
            ("connection refused at private.example", FailureKind::Connection),
        ] {
            let error = std::io::Error::other(source);
            let kind = network_kind(&error);
            assert_eq!(kind, expected);
            assert!(!kind.message().contains("private.example"));
            assert!(!kind.message().contains("secret"));
        }
    }
}
