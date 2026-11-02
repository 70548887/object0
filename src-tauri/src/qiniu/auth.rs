//! Qiniu management v1/v2, upload and private-download signing.
//! The management test vectors come from qiniu/nodejs-sdk/test/util.test.js.
use super::QiniuError;
use base64::{engine::general_purpose::URL_SAFE, Engine};
use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;
use std::collections::BTreeMap;
use url::Url;

pub fn encoded_entry(bucket: &str, key: Option<&str>) -> String {
    URL_SAFE.encode(match key {Some(key) => format!("{bucket}:{key}"), None => bucket.to_string()}.as_bytes())
}
fn digest(secret: &str, bytes: &[u8]) -> String {
    // HMAC accepts arbitrary-length keys, so initialization cannot fail.
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).expect("HMAC accepts arbitrary keys");
    mac.update(bytes);
    URL_SAFE.encode(mac.finalize().into_bytes())
}
fn host(url: &Url) -> Result<String, QiniuError> {
    let host = url.host_str().ok_or_else(|| QiniuError::invalid("签名地址没有域名 / Signing URL has no host"))?;
    // Url::host_str() already includes the mandatory brackets for IPv6.
    // Adding a second pair signs a Host header different from the transport.
    Ok(match url.port() {Some(port) => format!("{host}:{port}"), None => host.to_string()})
}
pub fn access_token_v2(ak: &str, sk: &str, method: &str, url: &Url, content_type: Option<&str>, headers: &BTreeMap<String, String>, body: &[u8]) -> Result<String, QiniuError> {
    let content_type = content_type.unwrap_or("application/x-www-form-urlencoded");
    let path_query = match url.query() {Some(query) => format!("{}?{query}", url.path()), None => url.path().to_string()};
    let mut canonical = format!("{} {path_query}\nHost: {}\nContent-Type: {content_type}\n", method.to_ascii_uppercase(), host(url)?).into_bytes();
    let mut canonical_headers = BTreeMap::new();
    for (name, value) in headers {
        if name.contains(['\r', '\n']) || value.contains(['\r', '\n']) {return Err(QiniuError::invalid("签名请求头格式无效 / Invalid signing header"));}
        let name = name.split('-').map(|part| {let mut chars = part.chars(); match chars.next() {Some(first) => first.to_ascii_uppercase().to_string()+&chars.as_str().to_ascii_lowercase(), None => String::new()}}).collect::<Vec<_>>().join("-");
        if name.starts_with("X-Qiniu-") && name.len() > 8 {canonical_headers.insert(name, value);}
    }
    for (name, value) in canonical_headers {canonical.extend_from_slice(format!("{name}: {value}\n").as_bytes());}
    canonical.push(b'\n');
    if content_type != "application/octet-stream" {canonical.extend_from_slice(body);}
    Ok(format!("Qiniu {ak}:{}", digest(sk, &canonical)))
}
pub fn access_token_v1(ak: &str, sk: &str, url: &Url, content_type: Option<&str>, body: &[u8]) -> String {
    let path_query = match url.query() {Some(query) => format!("{}?{query}", url.path()), None => url.path().to_string()};
    let mut canonical = format!("{path_query}\n").into_bytes();
    if content_type == Some("application/x-www-form-urlencoded") {canonical.extend_from_slice(body);}
    format!("QBox {ak}:{}", digest(sk, &canonical))
}
pub fn upload_token(ak: &str, sk: &str, bucket: &str, key: Option<&str>, deadline: i64, file_type: Option<u8>, insert_only: bool) -> Result<String, QiniuError> {
    if deadline <= 0 || bucket.is_empty() {return Err(QiniuError::invalid("上传凭证参数无效 / Invalid upload policy"));}
    let scope = key.map(|key| format!("{bucket}:{key}")).unwrap_or_else(|| bucket.to_string());
    let mut policy = serde_json::json!({"scope":scope,"deadline":deadline});
    if let Some(file_type) = file_type {policy["fileType"] = file_type.into();}
    if insert_only {policy["insertOnly"] = 1.into();}
    let encoded = URL_SAFE.encode(serde_json::to_vec(&policy).map_err(|_| QiniuError::invalid("上传策略编码失败 / Upload policy serialization failed"))?);
    Ok(format!("{ak}:{}:{encoded}", digest(sk, encoded.as_bytes())))
}
pub fn private_download_url(ak: &str, sk: &str, url: &Url, deadline: i64) -> Result<Url, QiniuError> {
    if deadline <= 0 || url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {return Err(QiniuError::invalid("下载签名参数无效 / Invalid download signing parameters"));}
    // All query parameters must exist before signing; token is strictly last.
    let mut signed = url.clone();
    let parameters = signed.query_pairs().filter(|(name, _)| name != "token" && name != "e").map(|(name,value)|(name.into_owned(),value.into_owned())).collect::<Vec<_>>();
    signed.set_query(None);
    {let mut query=signed.query_pairs_mut(); for (name,value) in parameters {query.append_pair(&name,&value);}query.append_pair("e",&deadline.to_string());}
    let signature = digest(sk, signed.as_str().as_bytes());
    // A colon and '=' are part of Qiniu's token grammar, not form-encoded data.
    let final_url = format!("{}&token={ak}:{signature}", signed.as_str());
    Url::parse(&final_url).map_err(|_| QiniuError::invalid("下载地址无效 / Invalid download URL"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn official_management_vectors_json_and_form() {
        let url=Url::parse("http://rs.qbox.me").unwrap();
        assert_eq!(access_token_v2("ak","sk","GET",&url,Some("application/json"),&BTreeMap::new(),br#"{"name": "test"}"#).unwrap(),"Qiniu ak:ksh7bJBnBzFO0yxJ_tLLUcg0csM=");
        assert_eq!(access_token_v2("ak","sk","POST",&url,Some("application/json"),&BTreeMap::new(),br#"{"name": "test"}"#).unwrap(),"Qiniu ak:IlW01tHjGQ0pGPXV_3jjR1AdD34=");
        assert_eq!(access_token_v2("ak","sk","GET",&url,Some("application/x-www-form-urlencoded"),&BTreeMap::new(),br#"{"name": "test"}"#).unwrap(),"Qiniu ak:CK4wBVOL6sLbVE4G4mrXqL_yEc4=");
    }
    #[test] fn official_management_vector_sorted_qiniu_headers() {
        let url=Url::parse("http://upload.qiniup.com/mkfile/sdf.jpg?s=er3&df").unwrap();
        let headers=BTreeMap::from([("X-Qiniu-Bbb".into(),"BBB".into()),("x-qIniu-aAa".into(),"DDD".into()),("X-Qiniu-".into(),"ignored".into())]);
        assert_eq!(access_token_v2("ak","sk","gET",&url,Some("application/x-www-form-urlencoded"),&headers,b"name=test&language=go").unwrap(),"Qiniu ak:PUFPWsEUIpk_dzUvvxTTmwhp3p4=");
    }
    #[test] fn ipv6_private_service_host_is_signed_with_exactly_one_bracket_pair(){
        let url=Url::parse("http://[::1]:8080/regions").unwrap();
        assert_eq!(host(&url).unwrap(),"[::1]:8080");
        let canonical=b"GET /regions\nHost: [::1]:8080\nContent-Type: application/json\n\n";
        assert_eq!(access_token_v2("ak","sk","GET",&url,Some("application/json"),&BTreeMap::new(),b"").unwrap(),format!("Qiniu ak:{}",digest("sk",canonical)));
        assert_eq!(host(&Url::parse("https://[2001:db8::1]/regions").unwrap()).unwrap(),"[2001:db8::1]");
        assert_eq!(host(&Url::parse("https://private.example:8443/regions").unwrap()).unwrap(),"private.example:8443");
    }
    #[test] fn official_v1_callback_vector() {
        let url=Url::parse("https://test.qiniu.com/callback").unwrap();
        assert_eq!(access_token_v1("abcdefghklmnopq","1234567890",&url,Some("application/x-www-form-urlencoded"),b"name=sunflower.jpg&hash=Fn6qeQi4VDLQ347NiRm-RlQx_4O2&location=Shanghai&price=1500.00&uid=123"),"QBox abcdefghklmnopq:T7F-SjxX7X2zI4Fc1vANiNt1AUE=");
    }
    #[test] fn entry_encoding_matches_official_vectors() {
        assert_eq!(encoded_entry("qiniuphotos",Some("gogopher.jpg")),"cWluaXVwaG90b3M6Z29nb3BoZXIuanBn");
        assert_eq!(encoded_entry("qiniuphotos",Some("012ts?a")),"cWluaXVwaG90b3M6MDEydHM_YQ==");
        assert_eq!(encoded_entry("qiniuphotos",None),"cWluaXVwaG90b3M=");
    }
    #[test] fn upload_policy_preserves_utf8_and_scope() {
        let token=upload_token("ak","sk","space",Some("中文/+?#.txt"),1234567890,Some(1),true).unwrap();
        let fields=token.split(':').collect::<Vec<_>>();
        let value:serde_json::Value=serde_json::from_slice(&URL_SAFE.decode(fields[2]).unwrap()).unwrap();
        assert_eq!(value["scope"],"space:中文/+?#.txt");assert_eq!(value["insertOnly"],1);assert_eq!(value["fileType"],1);
    }
    #[test] fn private_url_covers_all_parameters_and_token_is_last() {
        let url=Url::parse("https://download.example/file?attname=%E6%96%87.txt&token=old&e=1").unwrap();
        let signed=private_download_url("ak","sk",&url,1700000000).unwrap();
        let pairs=signed.query_pairs().collect::<Vec<_>>();
        assert_eq!(pairs.last().unwrap().0,"token");assert_eq!(pairs.iter().filter(|(name,_)|name=="e").count(),1);
        assert!(signed.as_str().contains("attname="));assert!(!signed.as_str().contains("token=old"));
        assert!(private_download_url("ak","sk",&Url::parse("https://example/a#fragment").unwrap(),1).is_err());
    }
    #[test] fn pinned_adapter_private_url_vectors_preserve_protocol_and_special_object_keys(){
        for (origin,token) in [("https://cdn.example","1Ym0NIrMdDYhhLyKukRd0gUJhNA="),("http://origin.example","3IP4J2NjMsNMaXBxOTZ7QGnliAc=")] {
            let url=super::super::endpoint::object_url(origin,"folder/中文 +%?#.txt",true).unwrap();
            assert_eq!(private_download_url("fixture-ak","fixture-sk",&url,1700000000).unwrap().as_str(),format!("{origin}/folder/%E4%B8%AD%E6%96%87%20+%25%3F%23.txt?e=1700000000&token=fixture-ak:{token}"));
        }
    }
}
