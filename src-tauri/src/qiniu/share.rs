//! Qiniu directory-share protocol, independently of ordinary file URL signing.
//!
//! Contract: Kodo Browser 2c5d7bad + kodo-s3-adapter-sdk@0.7.1
//! dist/share-service.js and dist/share-service.d.ts. In 0.7.1 all operations
//! require an explicit API origin; public portal discovery maps to the central
//! API. No compatibility with untested private deployments is implied.

use super::{auth, endpoint, CapabilityState, QiniuConfig, QiniuError, QiniuMode};
use chrono::{DateTime, Utc};
use rand::Rng;
use reqwest::{Client, Method};
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fmt,
    sync::{atomic::{compiler_fence, Ordering}, Mutex},
    time::Duration,
};
use url::Url;

pub const DEFAULT_PORTAL_URL: &str = "https://portal.qiniu.com";
pub const DEFAULT_CENTRAL_API_URL: &str = "https://api.qiniuapi.com";
pub const DEFAULT_DURATION_SECONDS: u32 = 3600;
pub const MIN_DURATION_SECONDS: u32 = 900;
pub const MAX_DURATION_SECONDS: u32 = 7200;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// Saved private-share login is deliberately stricter than general account
/// discovery. A portal-only legacy profile remains saveable, but cannot send
/// a share token until the user supplies exact API and region/S3 trust.
pub fn validate_private_login_config(config:&QiniuConfig)->Result<(),QiniuError> {
    if config.mode!=QiniuMode::Private || config.share_portal.as_deref().is_none_or(|v|v.trim().is_empty())
        || config.share_api_url.as_deref().is_none_or(|v|v.trim().is_empty()) || config.regions.is_empty() {
        return Err(QiniuError::new(CapabilityState::Unknown,"share-not-configured",
            "私有目录分享需明确配置门户、分享 API 和至少一个手工区域/S3 地址；仍待实机验收 / Private sharing requires an explicit portal, share API and at least one manual region/S3 endpoint; deployment acceptance remains pending"));
    }
    endpoint::EndpointPolicy::new(config)?;
    for region in &config.regions {
        if region.id.is_empty() || region.id.len()>128 || !region.id.bytes().all(|byte|byte.is_ascii_alphanumeric()||matches!(byte,b'-'|b'_')) {
            return Err(invalid("私有分享区域标识无效 / Invalid private-share region identifier"));
        }
    }
    // Pure construction: validates CA bytes and explicit origins without
    // contacting UC, the portal or a link-supplied host.
    QiniuShareService::new(config.clone(),&[])?;
    Ok(())
}

fn invalid(message: &str) -> QiniuError { QiniuError::invalid(message) }
fn unavailable(code: &str, message: &str) -> QiniuError { QiniuError::new(CapabilityState::Unavailable, code, message) }
fn origin(url: &Url) -> String { url.origin().ascii_serialization() }
fn valid_opaque(value: &str, limit: usize) -> bool {
    !value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}
fn valid_extract_code(value: &str) -> bool { value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_alphanumeric()) }
fn valid_share_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte,b'-'|b'_'))
}
fn valid_bucket_identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 255 && !matches!(value, "." | "..")
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// A directory scope must have a lexical boundary. Never normalize object keys
/// into another resource: literal percent escapes remain literal key bytes.
pub fn validate_share_prefix(value: &str) -> Result<(), QiniuError> {
    if value.len() > 8192 || (!value.is_empty() && !value.ends_with('/'))
        || value.starts_with('/') || value.contains('\\') || value.chars().any(char::is_control)
        || value.split('/').any(|segment| matches!(segment, "." | "..")) {
        return Err(invalid("目录分享范围必须是安全的完整目录前缀 / Share scope must be an exact safe directory prefix"));
    }
    Ok(())
}

pub fn validate_share_key(value: &str) -> Result<(), QiniuError> {
    if value.is_empty() || value.len() > 8192 || value.starts_with('/') || value.contains('\\')
        || value.chars().any(char::is_control) || value.split('/').any(|segment| matches!(segment, "." | "..")) {
        return Err(invalid("分享对象名称无法安全访问，未改写为其他路径 / Share object key cannot be accessed safely; no alternative path was used"));
    }
    Ok(())
}
fn expires_at(value: &str, now: i64, max_duration: u32) -> Result<i64, QiniuError> {
    let parsed = DateTime::parse_from_rfc3339(value).map(|date| date.timestamp())
        .or_else(|_| DateTime::parse_from_rfc2822(value).map(|date| date.timestamp()))
        .map_err(|_| invalid("分享服务没有返回有效到期时间 / Invalid share expiry"))?;
    if parsed <= now || parsed > now.saturating_add(i64::from(max_duration)).saturating_add(300) {
        return Err(unavailable("share-expired-or-invalid", "分享已过期或返回超出允许范围的有效期 / Share expired or returned an excessive lifetime"));
    }
    Ok(parsed)
}

/// Secrets deliberately have neither Serialize nor public string fields. The
/// owned byte buffers are cleared on revocation/drop; transport libraries may
/// maintain their own temporary buffers, which are outside this type's control.
pub struct SecretBytes(Vec<u8>);
impl SecretBytes {
    fn new(value: String) -> Result<Self, QiniuError> {
        if !valid_opaque(&value, 8192) { return Err(invalid("分享凭据格式无效 / Invalid share credential")); }
        Ok(Self(value.into_bytes()))
    }
    fn as_str(&self) -> &str { std::str::from_utf8(&self.0).expect("secret originated as UTF-8") }
    fn clear(&mut self) {
        for byte in &mut self.0 {
            // Volatile writes ensure clearing is not elided as a dead store.
            unsafe { std::ptr::write_volatile(byte, 0); }
        }
        compiler_fence(Ordering::SeqCst);
        self.0.clear();
    }
}
impl Drop for SecretBytes { fn drop(&mut self) { self.clear(); } }
impl fmt::Debug for SecretBytes { fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result { formatter.write_str("[redacted]") } }
impl<'de> Deserialize<'de> for SecretBytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self,D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(|_|serde::de::Error::custom("invalid secret field"))
    }
}

pub struct ParsedShareLink { portal: Url, share_id: String, token: SecretBytes }
impl fmt::Debug for ParsedShareLink {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result { formatter.write_str("ParsedShareLink { url: [redacted] }") }
}

#[derive(Clone)]
pub struct CreateShareOptions { pub bucket: String, pub prefix: String, pub duration_seconds: u32, pub extract_code: Option<String> }
impl fmt::Debug for CreateShareOptions {
    fn fmt(&self, formatter:&mut fmt::Formatter<'_>)->fmt::Result {formatter.debug_struct("CreateShareOptions").field("duration_seconds",&self.duration_seconds).field("extract_code",&"[redacted]").finish_non_exhaustive()}
}

/// This is intentionally user-shareable data, NOT federation credentials.
/// Debug redacts its URL and extraction code to prevent accidental log output.
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct CreatedDirectoryShare { pub url: String, pub extract_code: String, pub expires_at: String, pub read_only: bool }
impl fmt::Debug for CreatedDirectoryShare {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result { formatter.write_str("CreatedDirectoryShare { link: [redacted], extraction_code: [redacted], read_only: true }") }
}

#[derive(Deserialize)]
struct CreateWire { id: String, token: SecretBytes, expires: String }
#[derive(Deserialize)]
struct VerifyWire {
    endpoint: String, region: String, bucket_name: String, bucket_id: String, prefix: String,
    federated_ak: SecretBytes, federated_sk: SecretBytes, session_token: SecretBytes,
    permission: String, expires: String,
}

pub struct QiniuShareService {
    config: QiniuConfig,
    portal: Url,
    trusted_api_origins: HashSet<String>,
    trusted_storage_origins: HashSet<String>,
    http: Client,
}
impl fmt::Debug for QiniuShareService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result { formatter.debug_struct("QiniuShareService").field("mode", &self.config.mode).finish_non_exhaustive() }
}

impl QiniuShareService {
    /// Private API origins must be explicitly approved by the user. Merely
    /// returning an apiHost from a portal does not expand credential trust.
    pub fn new(config: QiniuConfig, explicit_api_origins: &[String]) -> Result<Self,QiniuError> {
        let private = config.mode == QiniuMode::Private;
        let portal = match config.share_portal.as_deref().filter(|value|!value.trim().is_empty()) {
            Some(value) => endpoint::parse_endpoint(value,private)?,
            None if private => return Err(QiniuError::new(CapabilityState::Unknown,"share-not-configured","私有云目录分享门户尚未配置或验证 / Private directory sharing is not configured or verified")),
            None => endpoint::parse_endpoint(DEFAULT_PORTAL_URL,false)?,
        };
        if !private && (portal.scheme() != "https" || !portal.host_str().is_some_and(endpoint::official_host) || portal.port_or_known_default()!=Some(443)) {
            return Err(invalid("公有云分享门户必须属于七牛官方 HTTPS 服务 / Public sharing requires an official Qiniu HTTPS portal"));
        }
        let mut trusted_api_origins=HashSet::new();
        for value in explicit_api_origins.iter().map(String::as_str).chain(config.share_api_url.as_deref()) {
            let url=endpoint::parse_endpoint(value,private)?;
            if !private && !(url.scheme()=="https" && url.host_str().is_some_and(endpoint::official_host) && url.port_or_known_default()==Some(443)) {
                return Err(invalid("公有云分享 API 地址不属于七牛官方服务 / Untrusted public share API origin"));
            }
            trusted_api_origins.insert(origin(&url));
        }
        let mut trusted_storage_origins=HashSet::new();
        for region in &config.regions {trusted_storage_origins.insert(origin(&endpoint::parse_endpoint(&region.s3_endpoint,private)?));}
        for binding in &config.bucket_bindings {trusted_storage_origins.insert(origin(&endpoint::parse_endpoint(&binding.s3_endpoint,private)?));}
        let mut builder=Client::builder().connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none()).user_agent("Yuncang/1 Qiniu-directory-share");
        if let Some(bytes)=endpoint::read_private_ca(&config)? {
            for cert in reqwest::Certificate::from_pem_bundle(&bytes).map_err(|_|invalid("私有云 CA 格式无效 / Invalid private-cloud CA"))? {
                builder=builder.add_root_certificate(cert);
            }
        }
        let http=builder.build().map_err(|_|invalid("无法初始化目录分享连接 / Could not initialize share connection"))?;
        Ok(Self {config,portal,trusted_api_origins,trusted_storage_origins,http})
    }

    fn api_endpoint(&self,value:&str)->Result<Url,QiniuError> {
        let url=endpoint::parse_endpoint(value,self.config.mode==QiniuMode::Private)?;
        let trusted=if self.config.mode==QiniuMode::Public {
            url.scheme()=="https" && url.host_str().is_some_and(endpoint::official_host) && url.port_or_known_default()==Some(443)
        } else {self.trusted_api_origins.contains(&origin(&url))};
        if !trusted {return Err(invalid("分享服务返回了未明确允许的 API 地址，长期凭据没有发送 / Share API origin was not explicitly trusted; credentials were not sent"));}
        Ok(url)
    }

    fn session_endpoint(&self,value:&str)->Result<Url,QiniuError> {
        let url=endpoint::parse_endpoint(value,self.config.mode==QiniuMode::Private)?;
        let trusted=if self.config.mode==QiniuMode::Public {
            url.scheme()=="https" && url.port_or_known_default()==Some(443) && url.host_str().is_some_and(|host|host=="qiniucs.com"||host.ends_with(".qiniucs.com"))
        }else{self.trusted_storage_origins.contains(&origin(&url))};
        if !trusted {return Err(invalid("分享会话的存储地址未被允许，临时凭据没有发送 / Share session storage endpoint is not trusted"));}
        Ok(url)
    }

    pub fn parse_share_link(&self,value:&str)->Result<ParsedShareLink,QiniuError> {
        if value.len()>16384 || value.chars().any(char::is_control) {return Err(invalid("目录分享链接过长或包含控制字符 / Directory share URL is too long or contains control characters"));}
        let url=Url::parse(value.trim()).map_err(|_|invalid("目录分享链接格式无效 / Invalid directory share URL"))?;
        if origin(&url)!=origin(&self.portal) || url.path().trim_end_matches('/')!="/kodo-shares/verify"
            || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err(invalid("目录分享链接不属于已配置的分享门户 / Share URL does not belong to the configured portal"));
        }
        let mut id=None;let mut token=None;
        for (name,value) in url.query_pairs() {
            match name.as_ref() {
                "id" if id.is_none()=>id=Some(value.into_owned()),
                "token" if token.is_none()=>token=Some(value.into_owned()),
                "id"|"token"=>return Err(invalid("目录分享链接包含重复参数 / Duplicate share URL parameters")),
                _=>return Err(invalid("目录分享链接包含不支持的参数 / Unsupported share URL parameters")),
            }
        }
        let share_id=id.filter(|value|valid_share_id(value)).ok_or_else(||invalid("目录分享标识无效 / Invalid share identifier"))?;
        let token=SecretBytes::new(token.ok_or_else(||invalid("目录分享凭证缺失 / Missing share token"))?)?;
        Ok(ParsedShareLink {portal:self.portal.clone(),share_id,token})
    }

    async fn json<T:DeserializeOwned>(&self,method:Method,url:Url,body:Option<Vec<u8>>,signer:Option<(&str,&str)>) -> Result<T,QiniuError> {
        let content_type="application/json";
        let body=body.unwrap_or_default();
        let mut request=self.http.request(method.clone(),url.as_str());
        if let Some((ak,sk))=signer {
            self.api_endpoint(url.origin().ascii_serialization().as_str())?;
            if !valid_opaque(ak,4096)||!valid_opaque(sk,4096){return Err(invalid("分享创建凭据无效 / Invalid share creation credentials"));}
            let stamp=Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
            let headers=BTreeMap::from([("X-Qiniu-Date".to_string(),stamp.clone())]);
            let signature=auth::access_token_v2(ak,sk,method.as_str(),&url,Some(content_type),&headers,&body)?;
            request=request.header("X-Qiniu-Date",stamp).header(reqwest::header::AUTHORIZATION,signature);
        }
        if !body.is_empty(){request=request.header(reqwest::header::CONTENT_TYPE,content_type).body(body);}
        let mut response=request.send().await.map_err(|error|{
            if error.is_timeout(){unavailable("share-timeout","目录分享请求超时 / Directory share request timed out")}
            else{unavailable("share-network","无法连接目录分享服务，请检查网络和证书 / Could not connect to directory sharing; check network and certificates")}
        })?;
        if response.status().as_u16()!=200 {return Err(QiniuError::http(response.status().as_u16()));}
        if response.content_length().is_some_and(|length|length>MAX_RESPONSE_BYTES as u64){return Err(invalid("目录分享响应过大 / Directory share response is too large"));}
        let mut bytes=Vec::new();
        while let Some(chunk)=response.chunk().await.map_err(|_|unavailable("share-response","读取目录分享响应失败 / Could not read share response"))? {
            if bytes.len().saturating_add(chunk.len())>MAX_RESPONSE_BYTES {return Err(invalid("目录分享响应过大 / Directory share response is too large"));}
            bytes.extend_from_slice(&chunk);
        }
        let owned=SecretBytes(bytes);
        serde_json::from_slice(if owned.0.is_empty(){b"null"}else{&owned.0}).map_err(|_|invalid("目录分享响应格式无效 / Invalid directory share response"))
    }

    pub async fn discover_api_origin(&self)->Result<String,QiniuError> {
        if let Some(explicit)=self.config.share_api_url.as_deref() {
            return Ok(self.api_endpoint(explicit)?.as_str().trim_end_matches('/').to_string());
        }
        if self.config.mode==QiniuMode::Public && origin(&self.portal)==DEFAULT_PORTAL_URL {
            return Ok(DEFAULT_CENTRAL_API_URL.to_string());
        }
        #[derive(Deserialize)] struct ConfigWire { #[serde(rename="apiHost")] api_host:String }
        let url=self.portal.join("api/kodov2/shares/config").map_err(|_|invalid("分享配置地址无效 / Invalid share configuration URL"))?;
        let config:ConfigWire=self.json(Method::GET,url,None,None).await?;
        Ok(self.api_endpoint(&config.api_host)?.as_str().trim_end_matches('/').to_string())
    }

    pub async fn create_share(&self,api_origin:&str,options:&CreateShareOptions,ak:&str,sk:&str,now:i64)->Result<CreatedDirectoryShare,QiniuError> {
        if !valid_bucket_identity(&options.bucket) {
            return Err(invalid("目录分享空间或目录范围无效 / Invalid directory share bucket or prefix"));
        }
        validate_share_prefix(&options.prefix)?;
        if !(MIN_DURATION_SECONDS..=MAX_DURATION_SECONDS).contains(&options.duration_seconds) {
            return Err(invalid("目录分享有效期必须为 15 至 120 分钟 / Directory sharing must expire within 15 to 120 minutes"));
        }
        let extract_code=options.extract_code.clone().unwrap_or_else(random_extract_code);
        if !valid_extract_code(&extract_code){return Err(invalid("提取码必须为六位字母或数字 / Extraction code must contain six ASCII letters or digits"));}
        let url=self.api_endpoint(api_origin)?.join("shares/").map_err(|_|invalid("分享 API 地址无效 / Invalid share API URL"))?;
        let body=serde_json::to_vec(&serde_json::json!({"bucket":options.bucket,"prefix":options.prefix,"duration_seconds":options.duration_seconds,"extract_code":extract_code,"permission":"READONLY"}))
            .map_err(|_|invalid("无法编码目录分享请求 / Could not encode directory share request"))?;
        let result:CreateWire=self.json(Method::POST,url,Some(body),Some((ak,sk))).await?;
        if !valid_share_id(&result.id){return Err(invalid("分享服务返回无效标识 / Share service returned an invalid identifier"));}
        let expiry=expires_at(&result.expires,now,options.duration_seconds)?;
        let mut link=self.portal.join("kodo-shares/verify").map_err(|_|invalid("分享门户地址无效 / Invalid share portal URL"))?;
        link.query_pairs_mut().append_pair("id",&result.id).append_pair("token",result.token.as_str());
        Ok(CreatedDirectoryShare {url:link.to_string(),extract_code,expires_at:DateTime::<Utc>::from_timestamp(expiry,0).expect("parsed timestamp").to_rfc3339(),read_only:true})
    }

    fn operation_url(&self,api_origin:&str,link:&ParsedShareLink,operation:&str)->Result<Url,QiniuError> {
        if origin(&link.portal)!=origin(&self.portal){return Err(invalid("分享链接来自不同环境 / Share link belongs to another environment"));}
        let mut url=self.api_endpoint(api_origin)?;
        url.set_path(&format!("/shares/{}/{operation}",link.share_id));
        url.query_pairs_mut().append_pair("token",link.token.as_str());Ok(url)
    }

    pub async fn check_share(&self,api_origin:&str,link:&ParsedShareLink)->Result<(),QiniuError> {
        let value:serde_json::Value=self.json(Method::POST,self.operation_url(api_origin,link,"check")?,None,None).await?;
        if value.get("error").is_some()||value.get("error_code").is_some(){return Err(unavailable("share-check-failed","目录分享无效或不可访问 / Directory share is invalid or inaccessible"));}
        Ok(())
    }

    pub async fn verify_share(&self,api_origin:&str,link:&ParsedShareLink,extract_code:&str,now:i64)->Result<ShareSession,QiniuError> {
        if !valid_extract_code(extract_code){return Err(invalid("提取码必须为六位字母或数字 / Extraction code must contain six ASCII letters or digits"));}
        let body=serde_json::to_vec(&serde_json::json!({"extract_code":extract_code})).map_err(|_|invalid("无法编码提取码 / Could not encode extraction code"))?;
        let wire:VerifyWire=self.json(Method::POST,self.operation_url(api_origin,link,"verify")?,Some(body),None).await?;
        let endpoint=self.session_endpoint(&wire.endpoint)?;
        if !valid_bucket_identity(&wire.bucket_name)||!valid_bucket_identity(&wire.bucket_id)
            || wire.region.is_empty() || wire.region.len()>128
            || !wire.region.bytes().all(|byte|byte.is_ascii_alphanumeric()||matches!(byte,b'-'|b'_'))
            || !matches!(wire.permission.as_str(),"READONLY"|"READWRITE") {
            return Err(invalid("分享会话缺少有效的空间或授权范围 / Invalid share session bucket or scope"));
        }
        validate_share_prefix(&wire.prefix)?;
        let expires=expires_at(&wire.expires,now,MAX_DURATION_SECONDS)?;
        // Cloud-created READWRITE shares are deliberately downscoped in this
        // desktop client; this feature grants read-only access, never writes.
        Ok(ShareSession {id:uuid::Uuid::new_v4().to_string(),endpoint,region:wire.region,bucket_name:wire.bucket_name,bucket_id:wire.bucket_id,prefix:wire.prefix,expires,
            credentials:TemporaryCredentials{access_key:wire.federated_ak,secret_key:wire.federated_sk,session_token:wire.session_token},revoked:false})
    }
}

pub fn random_extract_code()->String {
    const ALPHANUMERIC:&[u8]=b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    let mut random=rand::rngs::OsRng;
    (0..6).map(|_|char::from(ALPHANUMERIC[random.gen_range(0..ALPHANUMERIC.len())])).collect()
}

pub struct TemporaryCredentials {access_key:SecretBytes,secret_key:SecretBytes,session_token:SecretBytes}
impl fmt::Debug for TemporaryCredentials {fn fmt(&self,formatter:&mut fmt::Formatter<'_>)->fmt::Result{formatter.write_str("TemporaryCredentials { [redacted] }")}}
pub struct CredentialView<'a> {pub access_key:&'a str,pub secret_key:&'a str,pub session_token:&'a str}
impl fmt::Debug for CredentialView<'_> {fn fmt(&self,formatter:&mut fmt::Formatter<'_>)->fmt::Result{formatter.write_str("CredentialView { [redacted] }")}}

#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub enum ShareOperation {List,Stat,Download,Preview,Upload,Delete,Move,Rename,CreateShare}
impl ShareOperation {fn is_read(self)->bool{matches!(self,Self::List|Self::Stat|Self::Download|Self::Preview)}}

pub struct ShareSession {id:String,endpoint:Url,region:String,bucket_name:String,bucket_id:String,prefix:String,expires:i64,credentials:TemporaryCredentials,revoked:bool}
impl fmt::Debug for ShareSession {fn fmt(&self,formatter:&mut fmt::Formatter<'_>)->fmt::Result{formatter.write_str("ShareSession { credentials: [redacted], read_only: true }")}}

#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ShareSessionInfo {pub session_id:String,pub bucket_name:String,pub bucket_id:String,pub region:String,pub prefix:String,pub expires_at:String,pub read_only:bool}
impl ShareSession {
    pub fn info(&self)->ShareSessionInfo {
        ShareSessionInfo {session_id:self.id.clone(),bucket_name:self.bucket_name.clone(),bucket_id:self.bucket_id.clone(),region:self.region.clone(),prefix:self.prefix.clone(),expires_at:DateTime::<Utc>::from_timestamp(self.expires,0).expect("validated timestamp").to_rfc3339(),read_only:true}
    }
    pub fn authorize(&self,bucket:&str,key_or_prefix:&str,operation:ShareOperation,now:i64)->Result<(),QiniuError> {
        if self.revoked||self.expires<=now{return Err(unavailable("share-session-expired","分享会话已过期或已关闭 / Share session expired or was closed"));}
        if !operation.is_read(){return Err(QiniuError::new(CapabilityState::Forbidden,"share-read-only","目录分享会话为只读，禁止修改资源 / Directory share sessions are read-only"));}
        validate_share_prefix(&self.prefix)?;
        if operation == ShareOperation::List { validate_share_prefix(key_or_prefix)?; }
        else { validate_share_key(key_or_prefix)?; }
        let in_scope = self.prefix.is_empty() || key_or_prefix.starts_with(&self.prefix);
        if (bucket!=self.bucket_name&&bucket!=self.bucket_id)||!in_scope{return Err(QiniuError::new(CapabilityState::Forbidden,"share-out-of-scope","请求超出目录分享授权范围 / Request exceeds the shared directory scope"));}
        Ok(())
    }
    /// Native transport access only. Call authorize immediately before every
    /// request and never construct an RPC response containing this view.
    pub fn credentials(&self)->CredentialView<'_>{CredentialView {access_key:self.credentials.access_key.as_str(),secret_key:self.credentials.secret_key.as_str(),session_token:self.credentials.session_token.as_str()}}
    pub fn endpoint(&self)->&Url{&self.endpoint}
    pub fn region(&self)->&str{&self.region}
    pub fn expires_at(&self)->i64{self.expires}
    /// Construct a read-only S3 binding from the verified server identities.
    /// This does not authorize an operation; the caller must authorize each
    /// request and still enforce the environment's endpoint policy.
    pub fn context(&self)->super::ResolvedBucketContext {
        super::ResolvedBucketContext {
            bucket:super::QiniuBucket {name:self.bucket_name.clone(),s3_name:Some(self.bucket_id.clone()),kodo_region_id:None,created_at:None,permission:Some("readonly".into()),remark:None},
            region:super::QiniuRegion {kodo_region_id:None,s3_region_id:self.region.clone(),label:None,
                uc_urls:vec![],up_urls:vec![],rs_urls:vec![],rsf_urls:vec![],api_urls:vec![],s3_urls:vec![self.endpoint.as_str().trim_end_matches('/').to_string()],
                storage_classes:vec![],ttl_seconds:0,expires_at:self.expires,manual:false},
            s3_bucket_name:Some(self.bucket_id.clone()),backend_mode:"s3".into(),
        }
    }
    pub fn revoke(&mut self){self.revoked=true;self.credentials.access_key.clear();self.credentials.secret_key.clear();self.credentials.session_token.clear();}
}
impl Drop for ShareSession {fn drop(&mut self){self.revoke();}}

#[derive(Default)]
pub struct ShareSessionStore {sessions:Mutex<HashMap<String,ShareSession>>}
impl ShareSessionStore {
    pub fn insert(&self,session:ShareSession,now:i64)->Result<ShareSessionInfo,QiniuError>{
        session.authorize(&session.bucket_name,&session.prefix,ShareOperation::List,now)?;
        let info=session.info();let mut sessions=self.sessions.lock().map_err(|_|unavailable("share-state","分享会话状态不可用 / Share session state unavailable"))?;
        sessions.retain(|_,session|session.expires>now&&!session.revoked);
        if sessions.len()>=32{return Err(unavailable("share-session-limit","分享会话过多，请关闭部分会话 / Too many share sessions"));}
        sessions.insert(info.session_id.clone(),session);Ok(info)
    }
    /// The closure must only prepare a native request/client; do not await a
    /// network operation while holding this synchronous store lock.
    pub fn with_session<R>(&self,id:&str,bucket:&str,key_or_prefix:&str,operation:ShareOperation,now:i64,callback:impl FnOnce(&ShareSession)->R)->Result<R,QiniuError>{
        let mut sessions=self.sessions.lock().map_err(|_|unavailable("share-state","分享会话状态不可用 / Share session state unavailable"))?;
        sessions.retain(|_,session|session.expires>now&&!session.revoked);
        let session=sessions.get(id).ok_or_else(||unavailable("share-session-missing","分享会话不存在或已过期 / Share session missing or expired"))?;
        session.authorize(bucket,key_or_prefix,operation,now)?;Ok(callback(session))
    }
    pub fn remove(&self,id:&str){
        let mut sessions=self.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        sessions.remove(id);
    }
    /// Invoke on vault lock/reset and application quit; Drop clears credentials.
    pub fn clear_all(&self){
        // A prior internal panic must not prevent lock/quit from revoking
        // credentials. Ordinary access still fails closed on a poisoned lock.
        let mut sessions=self.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        sessions.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{Read,Write},net::{TcpListener,TcpStream},sync::Arc,thread,time::Instant};
    struct MockServer {origin:String,requests:Arc<Mutex<Vec<String>>>,worker:Option<thread::JoinHandle<()>>}
    impl Drop for MockServer {fn drop(&mut self){if let Some(worker)=self.worker.take(){worker.join().unwrap();}}}
    fn server(responses:Vec<(u16,String,Option<String>)>)->MockServer{server_with(|_|responses)}
    fn server_with(make_responses:impl FnOnce(&str)->Vec<(u16,String,Option<String>)>)->MockServer{
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();let origin=format!("http://{}",listener.local_addr().unwrap());
        let responses=make_responses(&origin);
        let requests=Arc::new(Mutex::new(vec![]));let captures=requests.clone();
        let worker=thread::spawn(move||{for(status,body,location)in responses{
            let deadline=Instant::now()+Duration::from_secs(5);
            let (mut socket,bytes)=loop{
                let mut socket:TcpStream=loop{match listener.accept(){Ok((socket,_))=>break socket,Err(error)if error.kind()==std::io::ErrorKind::WouldBlock&&Instant::now()<deadline=>thread::sleep(Duration::from_millis(5)),_=>return}};
                // Accepted sockets can inherit nonblocking mode on Windows.
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();let mut bytes=vec![];let mut buffer=[0_u8;8192];
                loop{let count=socket.read(&mut buffer).unwrap_or(0);if count==0{break}bytes.extend_from_slice(&buffer[..count]);if let Some(split)=bytes.windows(4).position(|value|value==b"\r\n\r\n"){
                    let headers=String::from_utf8_lossy(&bytes[..split]);let length=headers.lines().find_map(|line|{let(name,value)=line.split_once(':')?;name.eq_ignore_ascii_case("content-length").then(||value.trim().parse::<usize>().ok()).flatten()}).unwrap_or(0);
                    if bytes.len()>=split+4+length{break}
                }}
                // An abandoned speculative TCP connection is not a request
                // and must not consume a mock response.
                if bytes.is_empty(){if Instant::now()>=deadline{return}continue;}
                break (socket,bytes);
            };
            captures.lock().unwrap().push(String::from_utf8(bytes).unwrap());
            let location=location.map(|value|format!("Location: {value}\r\n")).unwrap_or_default();let wire=format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n{location}\r\n{body}",body.len());socket.write_all(wire.as_bytes()).unwrap();let _=socket.shutdown(std::net::Shutdown::Write);
        }});MockServer {origin,requests,worker:Some(worker)}
    }
    fn runtime()->tokio::runtime::Runtime{tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()}
    fn private_service(origin:&str,allow_api:bool)->QiniuShareService{
        QiniuShareService::new(QiniuConfig{mode:QiniuMode::Private,uc_url:Some(origin.to_string()),share_portal:Some(origin.to_string()),regions:vec![super::super::QiniuManualRegion{id:"private-region".into(),label:None,s3_endpoint:origin.to_string()}],..Default::default()},&if allow_api{vec![origin.to_string()]}else{vec![]}).unwrap()
    }
    fn session()->ShareSession{
        ShareSession {id:"fixture-session".into(),endpoint:Url::parse("https://s3.cn-east-1.qiniucs.com").unwrap(),region:"cn-east-1".into(),bucket_name:"native-name".into(),bucket_id:"s3-alias".into(),prefix:"shared/".into(),expires:2000,
            credentials:TemporaryCredentials{access_key:SecretBytes::new("temporary-ak".into()).unwrap(),secret_key:SecretBytes::new("temporary-secret".into()).unwrap(),session_token:SecretBytes::new("temporary-token".into()).unwrap()},revoked:false}
    }
    #[test]fn public_default_matches_the_pinned_071_central_api_contract(){
        let service=QiniuShareService::new(QiniuConfig::default(),&[]).unwrap();
        assert_eq!(runtime().block_on(service.discover_api_origin()).unwrap(),DEFAULT_CENTRAL_API_URL);
        assert!(QiniuShareService::new(QiniuConfig{mode:QiniuMode::Private,..Default::default()},&[]).is_err());
    }
    #[test]fn link_parser_rejects_duplicates_origins_and_path_injection_without_echoing_token(){
        let service=QiniuShareService::new(QiniuConfig::default(),&[]).unwrap();
        let link=service.parse_share_link("https://portal.qiniu.com/kodo-shares/verify?id=fixture&token=secret-token").unwrap();
        assert!(!format!("{link:?}").contains("secret-token"));
        for value in ["https://portal.qiniu.com.attacker.example/kodo-shares/verify?id=a&token=secret", "https://portal.qiniu.com/kodo-shares/verify?id=a&id=b&token=secret", "https://portal.qiniu.com/kodo-shares/verify?id=..%2Fadmin&token=secret", "https://ak:sk@portal.qiniu.com/kodo-shares/verify?id=a&token=secret"]{let error=service.parse_share_link(value).unwrap_err();assert!(!format!("{error:?}").contains("secret"));}
    }
    #[test]fn generated_codes_and_directory_lifetimes_follow_browser_limits(){
        for _ in 0..64{assert!(valid_extract_code(&random_extract_code()));}
        assert_eq!(DEFAULT_DURATION_SECONDS,3600);assert_eq!(MIN_DURATION_SECONDS,900);assert_eq!(MAX_DURATION_SECONDS,7200);
        for invalid in ["12345","1234567","12345!","１２３４５６"]{assert!(!valid_extract_code(invalid));}
    }
    #[test]fn session_enforces_bucket_prefix_readonly_expiry_and_redaction(){
        let mut session=session();assert!(session.authorize("native-name","shared/中文.txt",ShareOperation::Download,1000).is_ok());
        assert!(session.authorize("s3-alias","shared/",ShareOperation::List,1000).is_ok());
        for (bucket,key,operation,now)in[("other","shared/a",ShareOperation::List,1000),("native-name","shared-other/a",ShareOperation::List,1000),("native-name","shared/a",ShareOperation::Delete,1000),("native-name","shared/a",ShareOperation::Download,2000)]{assert!(session.authorize(bucket,key,operation,now).is_err());}
        let json=serde_json::to_string(&session.info()).unwrap();for secret in ["temporary-ak","temporary-secret","temporary-token","federated_sk","session_token"]{assert!(!json.contains(secret));assert!(!format!("{session:?}").contains(secret));}
        session.revoke();assert!(session.credentials().secret_key.is_empty());assert!(session.authorize("native-name","shared/",ShareOperation::List,1000).is_err());
    }
    #[test]fn unnormalized_share_scope_is_rejected_without_widening_to_a_sibling(){
        let mut session=session();session.prefix="shared".into();
        assert!(session.authorize("native-name","shared",ShareOperation::List,1000).is_err());
        assert!(session.authorize("native-name","shared/file",ShareOperation::Download,1000).is_err());
        assert!(session.authorize("native-name","shared-secret/file",ShareOperation::Download,1000).is_err());
    }
    #[test]fn exact_directory_scopes_reject_path_normalization_and_preserve_literal_key_bytes(){
        for prefix in ["shared", "/shared/", "shared\\child/", "shared/../", "shared/./", "shared/\n/"] {
            assert!(validate_share_prefix(prefix).is_err(), "unsafe scope was accepted");
        }
        for key in ["", "/shared/a", "shared\\a", "shared/../secret", "shared/./a", "shared/\0a"] {
            assert!(validate_share_key(key).is_err(), "unsafe object was accepted");
        }
        for prefix in ["", "shared/", "shared//中文+%?#/"] { assert!(validate_share_prefix(prefix).is_ok()); }
        let session=session();
        for key in ["shared/a", "shared/中文+%?#.txt", "shared/%2e%2e/literal"] {
            assert!(session.authorize("s3-alias",key,ShareOperation::Download,1000).is_ok());
        }
        for prefix in ["shared", "shared/../secret/", "shared-other/"] {
            assert!(session.authorize("s3-alias",prefix,ShareOperation::List,1000).is_err());
        }
    }
    #[test]fn creation_validates_the_entire_directory_prefix_before_sending_credentials(){
        let service=QiniuShareService::new(QiniuConfig::default(),&[]).unwrap();
        for prefix in ["not-a-directory", "/shared/", "shared/../", "shared\\nested/"] {
            let options=CreateShareOptions {bucket:"native-name".into(),prefix:prefix.into(),duration_seconds:3600,extract_code:None};
            let error=runtime().block_on(service.create_share(DEFAULT_CENTRAL_API_URL,&options,"fixture-ak","fixture-secret",1000)).unwrap_err();
            assert_eq!(error.code,"invalid-config");
            assert!(!error.to_string().contains("fixture-secret"));
        }
    }
    #[test]fn private_share_api_requires_its_own_explicit_origin_not_uc_or_portal_trust(){
        let fixture=server_with(|origin|vec![(200,serde_json::json!({"apiHost":origin}).to_string(),None)]);
        let service=private_service(&fixture.origin,false);
        assert!(runtime().block_on(service.discover_api_origin()).is_err());
        assert!(!fixture.requests.lock().unwrap()[0].to_ascii_lowercase().contains("authorization:"));
        let service=QiniuShareService::new(QiniuConfig {mode:QiniuMode::Private,
            uc_url:Some("http://127.0.0.1:31001".into()),share_portal:Some("http://127.0.0.1:31002".into()),
            share_api_url:Some("http://127.0.0.1:31003".into()),..Default::default()},&[]).unwrap();
        assert_eq!(runtime().block_on(service.discover_api_origin()).unwrap(),"http://127.0.0.1:31003");
        assert!(service.api_endpoint("http://127.0.0.1:31001").is_err());
        assert!(service.api_endpoint("http://127.0.0.1:31002").is_err());
    }
    #[test]fn explicit_share_api_config_is_optional_and_rejects_non_origin_and_foreign_public_urls(){
        let old:QiniuConfig=serde_json::from_value(serde_json::json!({"mode":"public"})).unwrap();
        assert!(old.share_api_url.is_none());
        assert!(serde_json::to_value(&old).unwrap().get("shareApiUrl").is_none());
        for value in ["https://untrusted.example", "https://api.qiniuapi.com/api", "https://api.qiniuapi.com?token=secret", "https://ak:sk@api.qiniuapi.com"] {
            assert!(QiniuShareService::new(QiniuConfig {share_api_url:Some(value.into()),..Default::default()},&[]).is_err());
        }
        let service=QiniuShareService::new(QiniuConfig {share_api_url:Some(DEFAULT_CENTRAL_API_URL.into()),..Default::default()},&[]).unwrap();
        assert_eq!(runtime().block_on(service.discover_api_origin()).unwrap(),DEFAULT_CENTRAL_API_URL);
    }
    #[test]fn verified_session_rejects_malformed_server_scope_or_s3_identity(){
        for (field,value) in [("prefix","shared"),("prefix","shared/../secret/"),("prefix","/shared/"),("bucket_id","../other"),("region","../region")] {
            let fixture=server_with(|origin|{
                let mut body=serde_json::json!({"endpoint":origin,"region":"private-region","bucket_name":"native-name","bucket_id":"s3-alias","prefix":"shared/","federated_ak":"temporary-ak","federated_sk":"temporary-secret","session_token":"temporary-token","permission":"READONLY","expires":"1970-01-01T01:16:40Z"});
                body[field]=serde_json::json!(value);vec![(200,body.to_string(),None)]
            });
            let service=private_service(&fixture.origin,true);
            let link=service.parse_share_link(&format!("{}/kodo-shares/verify?id=fixture&token=link-secret",fixture.origin)).unwrap();
            let error=runtime().block_on(service.verify_share(&fixture.origin,&link,"Ab12Cd",1000)).unwrap_err();
            assert_eq!(error.code,"invalid-config");
            for secret in ["temporary-ak","temporary-secret","temporary-token","link-secret"] { assert!(!format!("{error:?}").contains(secret)); }
        }
    }
    #[test]fn session_context_preserves_server_s3_identity_without_credentials(){
        let session=session();let context=session.context();
        assert_eq!(context.bucket.name,"native-name");
        assert_eq!(context.bucket.s3_name.as_deref(),Some("s3-alias"));
        assert_eq!(context.s3_bucket_name.as_deref(),Some("s3-alias"));
        assert_eq!(context.bucket.permission.as_deref(),Some("readonly"));
        assert_eq!(context.region.s3_region_id,"cn-east-1");assert_eq!(context.region.expires_at,session.expires_at());
        let json=serde_json::to_string(&context).unwrap();
        for secret in ["temporary-ak","temporary-secret","temporary-token"] { assert!(!json.contains(secret)); }
    }
    #[test]fn locking_or_expiring_the_store_removes_native_credentials(){
        let store=ShareSessionStore::default();let info=store.insert(session(),1000).unwrap();
        assert!(store.with_session(&info.session_id,"native-name","shared/a",ShareOperation::Stat,1000,|value|value.region().to_string()).is_ok());
        assert!(store.with_session(&info.session_id,"native-name","shared/a",ShareOperation::Upload,1000,|_|panic!("must not execute")).is_err());
        store.clear_all();assert!(store.with_session(&info.session_id,"native-name","shared/",ShareOperation::List,1000,|_|()).is_err());
        let info=store.insert(session(),1000).unwrap();assert!(store.with_session(&info.session_id,"native-name","shared/",ShareOperation::List,2000,|_|()).is_err());
    }
    #[test]fn poisoned_store_still_revokes_credentials_when_closed_or_locked(){
        let store=ShareSessionStore::default();let info=store.insert(session(),1000).unwrap();
        let panicked=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{
            let _=store.with_session(&info.session_id,"native-name","shared/",ShareOperation::List,1000,|_|panic!("fixture panic"));
        }));
        assert!(panicked.is_err());assert!(store.sessions.is_poisoned());
        store.remove(&info.session_id);
        assert!(store.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty());
        {
            let mut sessions=store.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            sessions.insert("fixture-session".into(),session());
        }
        store.clear_all();
        assert!(store.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty());
        assert!(store.with_session(&info.session_id,"native-name","shared/",ShareOperation::List,1000,|_|()).is_err());
    }
    #[test]fn private_discovery_does_not_authorize_a_returned_foreign_api_host(){
        let fixture=server(vec![(200,"{\"apiHost\":\"https://untrusted.example\"}".into(),None)]);let service=private_service(&fixture.origin,true);
        let error=runtime().block_on(service.discover_api_origin()).unwrap_err();assert_eq!(error.code,"invalid-config");
        assert!(!fixture.requests.lock().unwrap()[0].to_ascii_lowercase().contains("authorization:"));
    }
    #[test]fn creation_sends_exact_readonly_contract_and_redacts_user_share_data(){
        let fixture=server(vec![(200,"{\"id\":\"fixture\",\"token\":\"link-secret\",\"expires\":\"1970-01-01T01:16:40Z\"}".into(),None)]);let service=private_service(&fixture.origin,true);
        let options=CreateShareOptions{bucket:"native-name".into(),prefix:"shared/".into(),duration_seconds:3600,extract_code:Some("Ab12Cd".into())};
        let result=runtime().block_on(service.create_share(&fixture.origin,&options,"fixture-ak","fixture-sk",1000)).unwrap();
        assert!(result.read_only);assert_eq!(result.extract_code,"Ab12Cd");assert!(!format!("{result:?}").contains("link-secret"));assert!(!format!("{result:?}").contains("Ab12Cd"));
        let requests=fixture.requests.lock().unwrap();let request=&requests[0];assert!(request.starts_with("POST /shares/ HTTP/1.1"));assert!(request.to_ascii_lowercase().contains("authorization: qiniu fixture-ak:"));assert!(request.contains("\"permission\":\"READONLY\""));assert!(request.contains("\"duration_seconds\":3600"));assert!(!request.contains("fixture-sk"));
    }
    #[test]fn missing_private_service_and_forbidden_are_not_false_success(){
        for(status,state)in[(404,CapabilityState::Unsupported),(403,CapabilityState::Forbidden)]{
            let fixture=server(vec![(status,"{\"error\":\"private-secret-message\"}".into(),None)]);let service=private_service(&fixture.origin,true);let error=runtime().block_on(service.discover_api_origin()).unwrap_err();assert_eq!(error.state,state);assert!(!format!("{error:?}").contains("private-secret-message"));
        }
    }
    #[test]fn verification_uses_no_long_term_authorization_and_keeps_credentials_native(){
        let fixture=server_with(|origin|vec![(200,serde_json::json!({"endpoint":origin,"region":"private-region","bucket_name":"native-name","bucket_id":"s3-alias","prefix":"shared/","federated_ak":"temporary-ak","federated_sk":"temporary-secret","session_token":"temporary-token","permission":"READWRITE","expires":"1970-01-01T01:16:40Z"}).to_string(),None)]);
        let service=private_service(&fixture.origin,true);
        let link=service.parse_share_link(&format!("{}/kodo-shares/verify?id=fixture&token=link-secret",fixture.origin)).unwrap();
        let session=runtime().block_on(service.verify_share(&fixture.origin,&link,"Ab12Cd",1000)).unwrap();
        assert_eq!(session.credentials().secret_key,"temporary-secret");assert!(session.authorize("s3-alias","shared/file",ShareOperation::Upload,1000).is_err());
        let safe=serde_json::to_string(&session.info()).unwrap();assert!(!safe.contains("temporary-secret"));
        let requests=fixture.requests.lock().unwrap();assert!(requests[0].starts_with("POST /shares/fixture/verify?token=link-secret HTTP/1.1"));assert!(!requests[0].to_ascii_lowercase().contains("authorization:"));assert!(requests[0].contains("\"extract_code\":\"Ab12Cd\""));
    }
    #[test]fn redirects_are_not_followed_with_long_term_credentials(){
        let sink=TcpListener::bind("127.0.0.1:0").unwrap();sink.set_nonblocking(true).unwrap();
        let fixture=server(vec![(302,String::new(),Some(format!("http://{}/steal",sink.local_addr().unwrap())))]);let service=private_service(&fixture.origin,true);
        let options=CreateShareOptions{bucket:"native-name".into(),prefix:"shared/".into(),duration_seconds:3600,extract_code:Some("Ab12Cd".into())};
        assert!(runtime().block_on(service.create_share(&fixture.origin,&options,"fixture-ak","fixture-sk",1000)).is_err());assert!(sink.accept().is_err());
    }
}
