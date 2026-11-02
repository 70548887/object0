//! Credential-bearing requests are limited to official service hosts or the
//! explicitly configured private environment. Redirects are never followed.
use super::{QiniuConfig, QiniuError, QiniuMode};
use std::collections::HashSet;
use url::Url;

pub const PUBLIC_UC: &str = "https://uc.qbox.me";
const OFFICIAL_SUFFIXES: [&str; 6] = ["qiniuapi.com", "qiniucs.com", "qiniup.com", "qbox.me", "qiniu.com", "qiniuio.com"];

pub fn parse_endpoint(value: &str, allow_http: bool) -> Result<Url, QiniuError> {
    // Check the original spelling before WHATWG parsing can normalize a path
    // such as /folder/.. or a backslash into a different, apparently safe
    // origin. Trimming ordinary outer spaces remains compatible with forms.
    let raw=value.trim();
    let authority=raw.split_once("://").map(|(_,value)|value);
    if value.chars().any(char::is_control) || raw.contains('\\')
        || authority.is_none_or(|authority|authority.find(['/', '?', '#']).is_some_and(|offset|&authority[offset..]!="/")) {
        return Err(QiniuError::invalid("七牛服务地址必须是无凭据、查询和路径的服务源地址 / Qiniu service must be an origin URL"));
    }
    let url=Url::parse(value.trim()).map_err(|_| QiniuError::invalid("七牛服务地址格式无效 / Invalid Qiniu service URL"))?;
    if !matches!(url.scheme(),"https"|"http") || (url.scheme()=="http" && !allow_http) || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() || url.query().is_some()
        || url.path_segments().is_some_and(|mut segments| segments.any(|segment| !segment.is_empty())) {
        return Err(QiniuError::invalid("七牛服务地址必须是无凭据、查询和路径的服务源地址 / Qiniu service must be an origin URL"));
    }
    Ok(url)
}

/// Object download origins do not grant management-API trust. Public Kodo
/// domains may intentionally use HTTP; preserve the chosen scheme, never
/// downgrade a discovered HTTPS endpoint or add this origin to EndpointPolicy.
pub fn parse_download_origin(value:&str,mode:QiniuMode)->Result<Url,QiniuError>{
    let url=parse_endpoint(value,true)?;
    if mode==QiniuMode::Public {
        let expected=if url.scheme()=="https" {443}else{80};
        if url.port_or_known_default()!=Some(expected){return Err(QiniuError::invalid("公有云下载域名必须使用标准 HTTP/HTTPS 端口 / Public download domains require standard HTTP/HTTPS ports"));}
    }
    Ok(url)
}

/// Construct a URL for the exact object key, never a normalized sibling key.
/// WHATWG URLs cannot represent dot-only path segments without normalizing
/// them; url::PathSegmentsMut silently drops those segments. Refuse that narrow
/// case rather than signing or downloading a different resource.
pub fn object_url(domain:&str,key:&str,allow_http:bool)->Result<Url,QiniuError>{
    if key.split('/').any(|segment|matches!(segment,"."|"..")) {
        return Err(QiniuError::unsupported("对象名称包含当前下载协议无法原样表示的点路径段，未生成其他对象的地址 / This object key contains dot-only path segments that cannot be represented safely; no alternate object URL was generated"));
    }
    let mut url=parse_endpoint(domain,allow_http)?;
    // PathSegmentsMut also discards a leading empty segment at the root. Build
    // the escaped path explicitly so keys starting with '/' stay distinct.
    const KEY_SEGMENT_ENCODING:&percent_encoding::AsciiSet=&percent_encoding::NON_ALPHANUMERIC
        .remove(b'-').remove(b'_').remove(b'.').remove(b'~').remove(b'+');
    let path=key.split('/').map(|segment|percent_encoding::utf8_percent_encode(segment,KEY_SEGMENT_ENCODING).to_string()).collect::<Vec<_>>().join("/");
    url.set_path(&format!("/{path}"));
    Ok(url)
}

/// One strict trust loader is shared by native management, sharing and S3.
/// Merely finding a BEGIN marker is insufficient: rustls must parse every DER
/// certificate before the user's private-cloud configuration is accepted.
pub(super) fn validate_ca_bundle(bytes:&[u8])->Result<(),QiniuError>{
    let invalid=||QiniuError::invalid("私有云 CA 格式或证书内容无效 / Invalid private-cloud CA certificate content");
    let certificates=reqwest::Certificate::from_pem_bundle(bytes).map_err(|_|invalid())?;
    if certificates.is_empty(){return Err(invalid());}
    let mut validation=reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none());
    for certificate in certificates {validation=validation.add_root_certificate(certificate);}
    validation.build().map_err(|_|invalid())?;
    Ok(())
}

pub(super) fn read_private_ca(config:&QiniuConfig)->Result<Option<Vec<u8>>,QiniuError>{
    let Some(path)=config.trusted_ca_path.as_deref().filter(|path|!path.trim().is_empty()) else {return Ok(None)};
    if config.mode!=QiniuMode::Private{return Err(QiniuError::invalid("自定义 CA 仅适用于私有云 / Custom CA requires private-cloud mode"));}
    let metadata=std::fs::metadata(path).map_err(|_|QiniuError::invalid("无法读取私有云 CA / Could not read private-cloud CA"))?;
    const MAX_CA_BYTES:u64=1024*1024;
    if !metadata.is_file()||metadata.len()>MAX_CA_BYTES{return Err(QiniuError::invalid("私有云 CA 必须是小于 1 MiB 的 PEM 文件 / Private CA must be a PEM file under 1 MiB"));}
    let bytes=std::fs::read(path).map_err(|_|QiniuError::invalid("无法读取私有云 CA / Could not read private-cloud CA"))?;
    if bytes.len() as u64>MAX_CA_BYTES{return Err(QiniuError::invalid("私有云 CA 文件读取时超过 1 MiB / Private CA file exceeded 1 MiB while reading"));}
    validate_ca_bundle(&bytes)?;
    Ok(Some(bytes))
}
pub fn official_host(host: &str) -> bool {
    let host=host.to_ascii_lowercase();
    OFFICIAL_SUFFIXES.iter().any(|suffix| host==*suffix || host.strip_suffix(suffix).is_some_and(|prefix|prefix.ends_with('.')))
}
fn origin(url: &Url) -> String {url.origin().ascii_serialization()}

#[derive(Clone, Debug)]
pub struct EndpointPolicy {mode: QiniuMode, explicit_origins: HashSet<String>}
impl EndpointPolicy {
    pub fn new(config: &QiniuConfig) -> Result<Self,QiniuError> {
        let mut explicit_origins=HashSet::new();
        match config.mode {
            QiniuMode::Public => {
                if config.share_api_url.is_some() {return Err(QiniuError::invalid("自定义分享 API 仅适用于私有云 / A custom share API is only supported for private clouds"));}
                if config.uc_url.as_ref().is_some_and(|value| !value.trim().is_empty()) {
                    return Err(QiniuError::invalid("公有云使用官方 UC 地址；自定义 UC 请选择私有云 / Use private mode for a custom UC"));
                }
                if !config.regions.is_empty() {return Err(QiniuError::invalid("手工区域仅适用于私有云 / Manual regions require private mode"));}
            },
            QiniuMode::Private => {
                let uc=config.uc_url.as_deref().filter(|value|!value.trim().is_empty()).ok_or_else(||QiniuError::invalid("私有云必须配置 UC 地址 / Private cloud requires a UC URL"))?;
                explicit_origins.insert(origin(&parse_endpoint(uc,true)?));
                let mut ids=HashSet::new();
                for region in &config.regions {
                    if region.id.trim().is_empty() || !ids.insert(region.id.clone()) {return Err(QiniuError::invalid("私有云区域标识为空或重复 / Missing or duplicate private region ID"));}
                    explicit_origins.insert(origin(&parse_endpoint(&region.s3_endpoint,true)?));
                }
                // Explicit bindings are user configuration, not addresses
                // learned from an untrusted discovery or share response.
                for binding in &config.bucket_bindings {
                    explicit_origins.insert(origin(&parse_endpoint(&binding.s3_endpoint,true)?));
                }
                if config.share_api_url.is_some() && (config.share_portal.as_deref().is_none_or(|value|value.trim().is_empty()) || config.regions.is_empty()) {
                    return Err(QiniuError::invalid("配置私有分享 API 时必须同时提供门户和至少一个手工区域/S3 地址 / A private share API requires a portal and at least one manual region/S3 endpoint"));
                }
                if config.share_api_url.is_some() && config.regions.iter().any(|region| {
                    region.id.is_empty() || region.id.len()>128 || !region.id.bytes().all(|byte|byte.is_ascii_alphanumeric()||matches!(byte,b'-'|b'_'))
                }) {
                    return Err(QiniuError::invalid("私有分享手工区域 ID 必须为 1 至 128 位英文字母、数字、短横线或下划线 / Private-share manual region IDs require 1 to 128 ASCII letters, digits, hyphens or underscores"));
                }
            },
        }
        // These user-configured URLs never enter management trust just because
        // they are used for downloads or directory-sharing links.
        if let Some(value)=&config.download_domain {parse_download_origin(value,config.mode)?;}
        for value in [&config.share_portal,&config.share_api_url].into_iter().flatten() {
            parse_endpoint(value,config.mode==QiniuMode::Private)?;
        }
        let policy=Self {mode:config.mode,explicit_origins};
        super::bucket_binding::validate_bindings(config,&policy)?;
        Ok(policy)
    }
    pub fn permits(&self,url:&Url)->bool {
        if !matches!(url.scheme(),"https"|"http") || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {return false;}
        match self.mode {
            QiniuMode::Public => url.scheme()=="https" && url.host_str().is_some_and(official_host) && url.port_or_known_default()==Some(443),
            QiniuMode::Private => self.explicit_origins.contains(&origin(url)),
        }
    }
    pub fn ensure(&self,url:&Url)->Result<(),QiniuError> {
        if self.permits(url) {Ok(())} else {Err(QiniuError::invalid("服务发现返回了未信任的地址，请配置当前私有云服务 / Discovered endpoint is not trusted for credentials"))}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn public_http_download_origin_is_not_a_management_endpoint(){
        let config=QiniuConfig{download_domain:Some("http://download.example".into()),..Default::default()};
        let policy=EndpointPolicy::new(&config).unwrap();
        let origin=parse_download_origin("http://download.example:80/",QiniuMode::Public).unwrap();
        assert_eq!(origin.as_str(),"http://download.example/");assert!(!policy.permits(&origin));
        assert!(!policy.permits(&Url::parse("https://download.example/").unwrap()));
        assert!(policy.permits(&Url::parse("https://api.qiniuapi.com/domain").unwrap()));
        assert!(!policy.permits(&Url::parse("http://api.qiniuapi.com/domain").unwrap()));
        assert!(parse_download_origin("http://download.example:8080",QiniuMode::Public).is_err());
        assert!(parse_download_origin("http://download.example/a",QiniuMode::Public).is_err());
    }
    #[test] fn public_policy_does_not_accept_suffix_spoofing_or_plain_http() {
        let p=EndpointPolicy::new(&QiniuConfig::default()).unwrap();
        assert!(p.permits(&Url::parse("https://rs-z0.qbox.me/stat/test").unwrap()));
        assert!(!p.permits(&Url::parse("https://qbox.me.attacker.example/stat").unwrap()));
        assert!(!p.permits(&Url::parse("https://fakeqbox.me/stat").unwrap()));
        assert!(!p.permits(&Url::parse("http://uc.qbox.me/regions").unwrap()));
        assert!(!p.permits(&Url::parse("https://uc.qbox.me:8443/regions").unwrap()));
    }
    #[test] fn private_discovery_cannot_expand_credential_trust() {
        let config=QiniuConfig {mode:QiniuMode::Private,uc_url:Some("http://127.0.0.1:38080".into()),regions:vec![super::super::QiniuManualRegion{id:"zone".into(),label:None,s3_endpoint:"https://storage.internal".into()}],download_domain:Some("https://cdn.example".into()),..Default::default()};
        let p=EndpointPolicy::new(&config).unwrap();
        assert!(p.permits(&Url::parse("http://127.0.0.1:38080/regions").unwrap()));
        assert!(p.permits(&Url::parse("https://storage.internal/key").unwrap()));
        assert!(!p.permits(&Url::parse("https://cdn.example/stat/key").unwrap()));
        assert!(!p.permits(&Url::parse("http://127.0.0.1:38081/regions").unwrap()));
        assert!(!p.permits(&Url::parse("https://unconfigured.internal/stat").unwrap()));
    }
    #[test] fn origins_reject_embedded_credentials_paths_and_queries() {
        for url in ["https://ak:sk@example.com","https://example.com/api","https://example.com?token=x","https://example.com#fragment","file:///tmp/x"] {assert!(parse_endpoint(url,false).is_err());}
        assert!(EndpointPolicy::new(&QiniuConfig {mode:QiniuMode::Private,..Default::default()}).is_err());
    }
    #[test] fn raw_origin_paths_are_rejected_before_url_normalization(){
        for value in ["https://example.com/folder/..","https://example.com/./","https://example.com\\folder\\..","https://example.com//","https://exa\tmple.com","https:example.com"] {
            assert!(parse_endpoint(value,false).is_err(),"Unexpected origin acceptance: {value:?}");
        }
        for value in ["https://example.com","https://example.com/","  https://EXAMPLE.com:443/  ","http://[::1]:38080/"] {assert!(parse_endpoint(value,true).is_ok());}
    }
    #[test] fn share_api_is_validated_but_never_added_to_management_trust(){
        let mut config=QiniuConfig {mode:QiniuMode::Private,uc_url:Some("https://uc.internal".into()),share_portal:Some("https://portal.internal".into()),share_api_url:Some("https://share-api.internal".into()),regions:vec![super::super::QiniuManualRegion{id:"private-region".into(),label:None,s3_endpoint:"https://s3.internal".into()}],..Default::default()};
        let policy=EndpointPolicy::new(&config).unwrap();
        assert!(!policy.permits(&Url::parse("https://share-api.internal/stat/a").unwrap()));
        assert!(!policy.permits(&Url::parse("https://portal.internal/stat/a").unwrap()));
        for value in ["https://user:fixture-secret@share-api.internal","https://share-api.internal/v1","https://share-api.internal/?token=fixture-secret","https://share-api.internal/v1/.."] {
            config.share_api_url=Some(value.into());let error=EndpointPolicy::new(&config).unwrap_err();assert!(!error.to_string().contains("fixture-secret"));
        }
        config.share_api_url=None;assert!(EndpointPolicy::new(&config).is_ok()); // Legacy portal-only profile remains saveable.
    }
    #[test] fn saved_share_api_configuration_requires_private_complete_environment(){
        let public=QiniuConfig {share_api_url:Some("https://api.qiniuapi.com".into()),..Default::default()};assert!(EndpointPolicy::new(&public).is_err());
        let mut private=QiniuConfig {mode:QiniuMode::Private,uc_url:Some("https://uc.internal".into()),share_api_url:Some("https://share.internal".into()),..Default::default()};
        assert!(EndpointPolicy::new(&private).is_err());private.share_portal=Some("https://portal.internal".into());assert!(EndpointPolicy::new(&private).is_err());
        private.regions.push(super::super::QiniuManualRegion{id:"private-region".into(),label:None,s3_endpoint:"https://s3.internal".into()});assert!(EndpointPolicy::new(&private).is_ok());
        for invalid in ["invalid region".to_string(),"中文区域".to_string(),"x".repeat(129)] {
            private.regions[0].id=invalid;assert!(EndpointPolicy::new(&private).is_err());
        }
        private.share_api_url=None;private.regions.clear();assert!(EndpointPolicy::new(&private).is_ok());
    }
    #[test] fn object_url_rejects_dot_segments_instead_of_signing_a_sibling_key(){
        for key in [".","..","folder/./file","folder/../file","folder/..","./file"] {
            let error=object_url("https://download.example",key,false).unwrap_err();
            assert_eq!(error.code,"unsupported");
        }
    }
    #[test] fn object_url_preserves_literal_percent_empty_segments_and_reserved_characters(){
        let url=object_url("https://download.example/","/目录//%2e/%2E%2E/+%?#.txt/",false).unwrap();
        assert_eq!(url.path(),"//%E7%9B%AE%E5%BD%95//%252e/%252E%252E/+%25%3F%23.txt/");
        assert!(url.query().is_none());assert!(url.fragment().is_none());
        assert_eq!(url,Url::parse(url.as_str()).unwrap());
        assert!(object_url("https://download.example/forbidden","file",false).is_err());
    }
    #[test] fn ca_loader_rejects_non_certificate_empty_and_invalid_der_files(){
        let path=std::env::temp_dir().join(format!("qiniu-shared-ca-{}",uuid::Uuid::new_v4().simple()));
        let mut config=QiniuConfig{mode:QiniuMode::Private,trusted_ca_path:Some(path.to_string_lossy().into_owned()),..Default::default()};
        for bytes in [b"".as_slice(),b"not a certificate",b"-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n"]{
            std::fs::write(&path,bytes).unwrap();assert!(read_private_ca(&config).is_err());
        }
        config.mode=QiniuMode::Public;assert!(read_private_ca(&config).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
