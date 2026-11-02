//! Bucket-scoped native download-domain selection and application share policy.
//! Discovery never selects a domain implicitly. Kodo CDN/test/origin domains
//! follow the pinned adapter's public/private URL behavior; S3 stays separate.
use crate::qiniu::{self, client::{DomainReport, QiniuDomain}, CapabilityState, QiniuClient, QiniuMode, ResolvedBucketContext};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

pub(crate) const MAX_NATIVE_SHARE_SECONDS: i64 = 30 * 24 * 60 * 60;
pub(crate) const MAX_S3_SHARE_SECONDS: i64 = 7 * 24 * 60 * 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShareProtocol { QiniuNative, S3 }

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all="lowercase")]
pub(crate) enum DownloadAccessMode { Public, Signed }

pub(crate) fn validate_share_ttl(seconds:i64,protocol:ShareProtocol)->Result<i64,String>{
    let maximum=match protocol {ShareProtocol::QiniuNative=>MAX_NATIVE_SHARE_SECONDS,ShareProtocol::S3=>MAX_S3_SHARE_SECONDS};
    if seconds<1 || seconds>maximum {
        return Err(match protocol {
            ShareProtocol::QiniuNative=>"原生外链有效期必须为 1 秒至 30 天；30 天是云仓应用安全策略，不是七牛服务端承诺的上限 / Native link validity must be 1 second to 30 days; this is Yuncang application policy, not a Qiniu service limit",
            ShareProtocol::S3=>"S3 签名外链有效期必须为 1 秒至 7 天 / S3 signed-link validity must be 1 second to 7 days",
        }.into());
    }
    Ok(seconds)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
pub(crate) struct DownloadDomain {
    pub url:String,
    pub kind:String,
    pub available:bool,
    #[serde(skip_serializing_if="Option::is_none")]
    pub access_mode:Option<DownloadAccessMode>,
    #[serde(skip_serializing_if="Option::is_none")]
    pub reason:Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all="camelCase")]
pub(crate) struct DownloadOptions {
    pub domains:Vec<DownloadDomain>,
    #[serde(skip_serializing_if="Option::is_none")]
    pub selected_domain:Option<String>,
    pub max_share_seconds:i64,
    pub policy_note:String,
}

const UNKNOWN_DOMAIN:&str="此地址不是当前账号配置或此空间已确认的 Kodo 下载域名，未生成链接 / This address is not configured or confirmed as a Kodo download domain for this bucket; no link was generated";
const INCOMPATIBLE_S3:&str="此地址是 S3 服务域名，不能使用原生 Kodo 外链 / This is an S3 service domain and cannot use native Kodo links";
const HTTP_WARNING:&str="HTTP 链接和下载令牌会明文传输，请确认使用该地址；不会从 HTTPS 自动降级 / HTTP sends links and download tokens without transport encryption. Confirm this address; HTTPS is never automatically downgraded";
const POLICY_NOTE:&str="私有或受保护资源使用限时签名；已确认公开资源使用公开直链，不承诺按所选时间失效。域名策略可能强制下载、限制文件类型或提前使链接失效；HTTP 会明文传输链接和令牌。不会购买、绑定域名或绕过服务端策略 / Private or protected resources use expiring signatures; confirmed public resources use direct public URLs with no promised expiry. Domain policy may force downloads, restrict file types or invalidate links earlier; HTTP sends links and tokens without encryption. No domains are purchased/bound and no service restrictions are bypassed";

fn origin(value:&str,mode:QiniuMode,_discovered:bool)->Result<String,String>{
    // A caller cannot smuggle a query, fragment, userinfo or path into the
    // trusted origin and have it reinterpreted while the token is appended.
    let parsed=qiniu::endpoint::parse_download_origin(value,mode).map_err(|_|UNKNOWN_DOMAIN.to_string())?;
    Ok(parsed.origin().ascii_serialization())
}

fn domain_origin(domain:&QiniuDomain,mode:QiniuMode)->Option<String>{
    // Discovery domain names are names, not free-form URL strings. In
    // particular, a host containing :// must never be prefixed then accepted.
    if domain.name.contains("://") {return None;}
    origin(&format!("{}://{}",domain.protocol,domain.name),mode,true).ok()
}

fn native_domain(domain:&QiniuDomain,report:&DomainReport)->bool{
    domain.api_scope=="kodo" && match domain.kind.as_str(){
        "origin"=>report.origins.state==CapabilityState::Supported,
        "cdn"|"test"=>report.cdn.state==CapabilityState::Supported,
        _=>false,
    }
}

fn access_mode(domain:&QiniuDomain,report:&DomainReport)->DownloadAccessMode{
    if report.bucket_info.state==CapabilityState::Supported
        && domain.is_private==Some(false) && domain.protected==Some(false) {DownloadAccessMode::Public}
    else {DownloadAccessMode::Signed}
}

/// Pure construction also makes the domain trust rules independently testable.
fn options_from_report(mode:QiniuMode,configured:Option<&str>,report:&DomainReport)->Result<DownloadOptions,String>{
    let configured=configured.filter(|domain|!domain.trim().is_empty()).map(|domain|origin(domain,mode,false)).transpose()?;
    let mut confirmed:HashMap<String,DownloadAccessMode>=HashMap::new();
    let mut native_origins=HashSet::new();
    let mut known_incompatible=HashSet::new();
    for domain in &report.domains {
        let Some(url)=domain_origin(domain,mode) else {continue};
        if native_domain(domain,report){
            if domain.kind=="origin" {native_origins.insert(url.clone());}
            let mode=access_mode(domain,report);
            confirmed.entry(url).and_modify(|current|{if mode==DownloadAccessMode::Signed{*current=mode;}}).or_insert(mode);
        }else if domain.api_scope=="s3" {known_incompatible.insert(url);}
    }
    let mut domains=Vec::new();let mut position=HashMap::new();
    if let Some(url)=configured.as_ref(){
        let unavailable=known_incompatible.contains(url) && !confirmed.contains_key(url);
        let mode=confirmed.get(url).copied().unwrap_or(DownloadAccessMode::Signed);
        let reason=if unavailable {Some(INCOMPATIBLE_S3.into())}
            else if url.starts_with("http://") {Some(HTTP_WARNING.into())}
            else if !confirmed.contains_key(url) {Some("该域名由用户明确配置，但当前空间的关联和访问策略尚未验证 / Explicitly configured by the user; its association and access policy for this bucket remain unverified".into())}
            else {None};
        position.insert(url.clone(),0);
        domains.push(DownloadDomain{url:url.clone(),kind:"configured".into(),available:!unavailable,access_mode:(!unavailable).then_some(mode),reason});
    }
    for domain in &report.domains {
        // The trusted configured value comes only from the account config,
        // never a report entry merely claiming `configured: true`.
        if domain.kind=="configured" {continue;}
        let Some(url)=domain_origin(domain,mode) else {continue};
        if position.contains_key(&url){continue;}
        // An identical origin can appear in several service categories. A
        // native origin wins regardless of ordering; CDN/test domains returned
        // by the bucket-filtered official service also support Kodo URL access.
        let available=confirmed.contains_key(&url);
        let reason=if available {url.starts_with("http://").then(||HTTP_WARNING.into())}
            else if known_incompatible.contains(&url) {Some(INCOMPATIBLE_S3.into())}
            else {Some("此空间原生域名或访问能力尚未确认，暂不可选 / Native-domain capability for this bucket is unverified; selection is disabled".into())};
        position.insert(url.clone(),domains.len());
        let access_mode=confirmed.get(&url).copied();
        let kind=if native_origins.contains(&url){"origin".into()}else{domain.kind.clone()};
        domains.push(DownloadDomain{url,kind,available,access_mode,reason});
    }
    // Even an account-level HTTP configuration needs an explicit per-operation
    // radio selection, so an unrelated download never silently chooses HTTP.
    let selected_domain=configured.filter(|configured|configured.starts_with("https://")&&domains.iter().any(|domain|domain.url==*configured && domain.available));
    Ok(DownloadOptions{domains,selected_domain,max_share_seconds:MAX_NATIVE_SHARE_SECONDS,policy_note:POLICY_NOTE.into()})
}

fn ensure_native(context:&ResolvedBucketContext)->Result<(),String>{
    if context.backend_mode!="kodo" {return Err("此连接使用 S3 协议，不能借用原生 Kodo 域名签名 / This connection uses S3 and cannot borrow native Kodo domain signatures".into());}
    Ok(())
}

pub(crate) async fn download_options(client:&QiniuClient,context:&ResolvedBucketContext)->Result<DownloadOptions,String>{
    ensure_native(context)?;
    let report=client.list_domains(&context.bucket.name).await;
    options_from_report(client.config().mode,client.config().download_domain.as_deref(),&report)
}

fn select_option(options:&DownloadOptions,requested:Option<&str>,mode:QiniuMode)->Result<DownloadDomain,String>{
    let selected=match requested {
        Some(value)=>origin(value,mode,false)?,
        None=>options.selected_domain.clone().ok_or_else(||"请明确选择此空间的下载域名；不会自动选择发现的域名 / Explicitly select a download domain for this bucket; discovered domains are never selected automatically".to_string())?,
    };
    let option=options.domains.iter().find(|domain|domain.url==selected).ok_or_else(||UNKNOWN_DOMAIN.to_string())?;
    if !option.available{return Err(option.reason.clone().unwrap_or_else(||UNKNOWN_DOMAIN.into()));}
    Ok(option.clone())
}

fn select_domain(options:&DownloadOptions,requested:Option<&str>,mode:QiniuMode)->Result<String,String>{Ok(select_option(options,requested,mode)?.url)}

pub(crate) async fn resolve_domain(client:&QiniuClient,context:&ResolvedBucketContext,requested:Option<&str>)->Result<String,String>{
    Ok(resolve_download_option(client,context,requested).await?.url)
}

pub(crate) async fn resolve_download_option(client:&QiniuClient,context:&ResolvedBucketContext,requested:Option<&str>)->Result<DownloadDomain,String>{
    // Validate a user address before making even read-only discovery calls.
    if let Some(requested)=requested {origin(requested,client.config().mode,false)?;}
    let options=download_options(client,context).await?;
    select_option(&options,requested,client.config().mode)
}

/// The caller has already bound the bucket, checked the object and selected a
/// current domain option. Public objects do not acquire an invented expiry.
pub(crate) fn share_link_result(client:&QiniuClient,option:&DownloadDomain,key:&str,expiry:chrono::DateTime<chrono::Utc>)->Result<serde_json::Value,String>{
    let url=qiniu::endpoint::object_url(&option.url,key,true).map_err(|error|error.to_string())?;
    if option.access_mode==Some(DownloadAccessMode::Public){
        Ok(serde_json::json!({"url":url.as_str(),"expiresAt":null,"key":key,"accessMode":"public"}))
    }else{
        let signed=client.signed_download_url(&url,expiry.timestamp()).map_err(|error|error.to_string())?;
        Ok(serde_json::json!({"url":signed.as_str(),"expiresAt":expiry.to_rfc3339(),"key":key,"accessMode":"signed"}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn capability(state:CapabilityState)->qiniu::Capability{qiniu::Capability{state,reason:None}}
    fn domain(name:&str,kind:&str,scope:&str)->QiniuDomain{QiniuDomain{name:name.into(),protocol:"https".into(),kind:kind.into(),api_scope:scope.into(),is_private:Some(true),protected:Some(false),configured:false}}
    fn report(domains:Vec<QiniuDomain>)->DomainReport{DomainReport{domains,origins:capability(CapabilityState::Supported),cdn:capability(CapabilityState::Supported),bucket_info:capability(CapabilityState::Supported)}}
    #[test]fn native_domains_require_explicit_selection_even_when_only_one_exists(){
        let options=options_from_report(QiniuMode::Public,None,&report(vec![domain("origin.example","origin","kodo")])).unwrap();
        assert!(options.selected_domain.is_none());assert!(select_domain(&options,None,QiniuMode::Public).is_err());
        assert_eq!(select_domain(&options,Some("https://origin.example/"),QiniuMode::Public).unwrap(),"https://origin.example");
        assert!(select_domain(&options,Some("https://foreign.example"),QiniuMode::Public).is_err());
    }
    #[test]fn configured_domain_survives_failed_discovery_but_remains_explicitly_unverified(){
        let failed=DomainReport{domains:vec![],origins:capability(CapabilityState::Forbidden),cdn:capability(CapabilityState::Unavailable),bucket_info:capability(CapabilityState::Forbidden)};
        let options=options_from_report(QiniuMode::Public,Some("https://chosen.example"),&failed).unwrap();
        assert_eq!(select_domain(&options,None,QiniuMode::Public).unwrap(),"https://chosen.example");assert!(options.domains[0].reason.as_deref().unwrap().contains("unverified"));
    }
    #[test]fn discovered_kodo_cdn_and_test_domains_are_usable_but_s3_remains_separate(){
        let options=options_from_report(QiniuMode::Public,None,&report(vec![domain("cdn.example","cdn","kodo"),domain("test.example","test","kodo"),domain("s3.example","origin","s3")])).unwrap();
        assert_eq!(options.domains.len(),3);assert_eq!(options.domains.iter().filter(|domain|domain.available).count(),2);
        for value in ["https://cdn.example","https://test.example"]{assert_eq!(select_domain(&options,Some(value),QiniuMode::Public).unwrap(),value);}
        assert!(select_domain(&options,Some("https://s3.example"),QiniuMode::Public).is_err());
        let configured=options_from_report(QiniuMode::Public,Some("https://cdn.example"),&report(vec![domain("cdn.example","cdn","kodo")])).unwrap();assert_eq!(configured.selected_domain.as_deref(),Some("https://cdn.example"));
    }
    #[test]fn unsafe_urls_and_public_nonstandard_ports_are_rejected_without_rewriting_scheme(){
        for invalid in ["http://origin.example:8080","https://origin.example:8443","https://origin.example/path","https://origin.example?token=x","https://origin.example#x","https://ak:sk@origin.example","file:///tmp/a","https://origin.example\\@foreign.example",""]{
            assert!(origin(invalid,QiniuMode::Public,false).is_err(),"unsafe URL was accepted");
        }
        assert_eq!(origin("http://origin.example:80/",QiniuMode::Public,false).unwrap(),"http://origin.example");
        assert_eq!(origin("https://origin.example:443/",QiniuMode::Public,false).unwrap(),"https://origin.example");
    }
    #[test]fn http_is_selectable_but_never_an_implicit_default_or_https_fallback(){
        let options=options_from_report(QiniuMode::Private,Some("http://127.0.0.1:8765"),&report(vec![])).unwrap();
        assert!(select_domain(&options,None,QiniuMode::Private).is_err());
        assert_eq!(select_domain(&options,Some("http://127.0.0.1:8765"),QiniuMode::Private).unwrap(),"http://127.0.0.1:8765");
        let mut source=domain("origin.example","origin","kodo");source.protocol="http".into();
        let options=options_from_report(QiniuMode::Public,None,&report(vec![source])).unwrap();
        assert!(options.selected_domain.is_none());assert!(options.domains[0].available);assert!(options.domains[0].reason.as_deref().unwrap().contains("HTTP"));
        assert_eq!(select_domain(&options,Some("http://origin.example"),QiniuMode::Public).unwrap(),"http://origin.example");
        assert!(select_domain(&options,Some("https://origin.example"),QiniuMode::Public).is_err());
    }
    #[test]fn unconfirmed_origin_report_does_not_promote_a_domain_to_available(){
        let mut pending=report(vec![domain("origin.example","origin","kodo")]);pending.origins.state=CapabilityState::Unknown;
        let options=options_from_report(QiniuMode::Public,None,&pending).unwrap();assert!(!options.domains[0].available);
    }
    #[test]fn fake_configured_report_entry_cannot_expand_trust(){
        let mut value=domain("fake.example","configured","kodo");value.configured=true;
        let options=options_from_report(QiniuMode::Public,None,&report(vec![value])).unwrap();assert!(options.domains.is_empty());
    }
    #[test]fn duplicate_domain_categories_do_not_hide_a_confirmed_native_origin(){
        let options=options_from_report(QiniuMode::Public,None,&report(vec![domain("same.example:443","cdn","kodo"),domain("same.example","origin","kodo")])).unwrap();
        assert_eq!(options.domains.len(),1);assert!(options.domains[0].available);assert_eq!(options.domains[0].kind,"origin");
        assert_eq!(select_domain(&options,Some("https://same.example"),QiniuMode::Public).unwrap(),"https://same.example");
    }
    #[test]fn only_confirmed_public_and_unprotected_buckets_get_public_access_mode(){
        let mut public=domain("cdn.example","cdn","kodo");public.is_private=Some(false);public.protected=Some(false);
        let options=options_from_report(QiniuMode::Public,None,&report(vec![public.clone()])).unwrap();assert_eq!(options.domains[0].access_mode,Some(DownloadAccessMode::Public));
        for (private,protected) in [(Some(true),Some(false)),(Some(false),Some(true)),(None,Some(false)),(Some(false),None)] {
            let mut value=public.clone();value.is_private=private;value.protected=protected;
            let options=options_from_report(QiniuMode::Public,None,&report(vec![value])).unwrap();assert_eq!(options.domains[0].access_mode,Some(DownloadAccessMode::Signed));
        }
        let mut unknown=report(vec![public]);unknown.bucket_info.state=CapabilityState::Forbidden;
        let options=options_from_report(QiniuMode::Public,None,&unknown).unwrap();assert_eq!(options.domains[0].access_mode,Some(DownloadAccessMode::Signed));
    }
    #[test]fn public_link_has_no_fabricated_expiry_and_private_link_matches_official_sdk_vector(){
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();let _entered=runtime.enter();
        let client=QiniuClient::new(qiniu::QiniuConfig::default(),qiniu::QiniuCredentials::new("fixture-ak".into(),"fixture-sk".into(),None).unwrap()).unwrap();
        let expiry=chrono::DateTime::from_timestamp(1700000000,0).unwrap();
        let option=DownloadDomain{url:"https://cdn.example".into(),kind:"cdn".into(),available:true,access_mode:Some(DownloadAccessMode::Public),reason:None};
        let selected=client.for_validated_download_domain(&option.url).unwrap();
        let public=share_link_result(&selected,&option,"folder/中文 +%?#.txt",expiry).unwrap();
        assert_eq!(public["url"],"https://cdn.example/folder/%E4%B8%AD%E6%96%87%20+%25%3F%23.txt");assert!(public["expiresAt"].is_null());assert_eq!(public["accessMode"],"public");
        for access_mode in [None,Some(DownloadAccessMode::Signed)] {
            let option=DownloadDomain{access_mode,..option.clone()};let signed=share_link_result(&selected,&option,"folder/中文 +%?#.txt",expiry).unwrap();
            assert_eq!(signed["url"],"https://cdn.example/folder/%E4%B8%AD%E6%96%87%20+%25%3F%23.txt?e=1700000000&token=fixture-ak:1Ym0NIrMdDYhhLyKukRd0gUJhNA=");assert!(signed["expiresAt"].is_string());assert_eq!(signed["accessMode"],"signed");
        }
    }
    #[test]fn explicit_public_http_signing_does_not_expand_management_endpoint_trust(){
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();let _entered=runtime.enter();
        let client=QiniuClient::new(qiniu::QiniuConfig::default(),qiniu::QiniuCredentials::new("fixture-ak".into(),"fixture-sk".into(),None).unwrap()).unwrap();
        let selected=client.for_validated_download_domain("http://origin.example").unwrap();
        assert!(client.config().download_domain.is_none());assert_eq!(selected.config().download_domain.as_deref(),Some("http://origin.example"));
        assert!(selected.validate_s3_endpoint("http://origin.example").is_err());assert!(selected.validate_s3_endpoint("https://origin.example").is_err());
        let option=DownloadDomain{url:"http://origin.example".into(),kind:"origin".into(),available:true,access_mode:Some(DownloadAccessMode::Signed),reason:Some(HTTP_WARNING.into())};
        let result=share_link_result(&selected,&option,"folder/中文 +%?#.txt",chrono::DateTime::from_timestamp(1700000000,0).unwrap()).unwrap();
        assert_eq!(result["url"],"http://origin.example/folder/%E4%B8%AD%E6%96%87%20+%25%3F%23.txt?e=1700000000&token=fixture-ak:3IP4J2NjMsNMaXBxOTZ7QGnliAc=");
        assert!(runtime.block_on(selected.management_json(reqwest::Method::GET,"http://origin.example","domain",&[],None)).is_err());
    }
    #[test]fn native_application_policy_can_exceed_s3_seven_days_without_clamping(){
        assert_eq!(validate_share_ttl(8*86400,ShareProtocol::QiniuNative).unwrap(),8*86400);
        assert_eq!(validate_share_ttl(MAX_NATIVE_SHARE_SECONDS,ShareProtocol::QiniuNative).unwrap(),MAX_NATIVE_SHARE_SECONDS);
        assert!(validate_share_ttl(MAX_NATIVE_SHARE_SECONDS+1,ShareProtocol::QiniuNative).is_err());
        assert!(validate_share_ttl(8*86400,ShareProtocol::S3).is_err());
        for seconds in [0,-1,i64::MAX]{assert!(validate_share_ttl(seconds,ShareProtocol::QiniuNative).is_err());assert!(validate_share_ttl(seconds,ShareProtocol::S3).is_err());}
        assert_eq!(validate_share_ttl(MAX_S3_SHARE_SECONDS,ShareProtocol::S3).unwrap(),MAX_S3_SHARE_SECONDS);
    }
}
