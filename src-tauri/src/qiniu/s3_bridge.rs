//! A Qiniu S3 connection is constructed only from a resolved bucket identity.
//! No AWS default region, endpoint, environment credential chain or bucket-name
//! inference is used. Temporary credentials remain within the native layer.

use super::{endpoint::{EndpointPolicy,parse_endpoint},QiniuConfig,QiniuError,QiniuMode,ResolvedBucketContext};
use aws_sdk_s3::{Client,config::{Credentials,Region,RequestChecksumCalculation,ResponseChecksumValidation,retry::RetryConfig,timeout::TimeoutConfig}};
use serde::Serialize;
use std::{fmt,time::Duration};

#[derive(Clone,Debug,Serialize,PartialEq,Eq)]
#[serde(rename_all="camelCase")]
pub struct S3Binding {
    pub profile_id:String,
    pub profile_revision:String,
    pub bucket_name:String,
    pub endpoint:String,
    pub region_id:String,
    pub temporary:bool,
    pub custom_ca:bool,
}

#[derive(Clone)]
pub struct QiniuS3Bridge {
    pub client:Client,
    pub bucket_name:String,
    pub endpoint:String,
    pub region:String,
    pub binding:S3Binding,
}
impl fmt::Debug for QiniuS3Bridge {
    fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result {f.debug_struct("QiniuS3Bridge").field("region",&self.region).field("temporary",&self.binding.temporary).field("custom_ca",&self.binding.custom_ca).finish_non_exhaustive()}
}
impl QiniuS3Bridge {
    /// Required before reusing a cached connection after account edits, a
    /// credential refresh, or a share-session replacement.
    pub fn ensure_binding(&self,profile_id:&str,profile_revision:&str)->Result<(),QiniuError>{
        if self.binding.profile_id==profile_id&&self.binding.profile_revision==profile_revision {Ok(())}
        else {Err(QiniuError::invalid("七牛连接所属账号已变化，请重新解析空间 / Qiniu connection identity changed; resolve the bucket again"))}
    }
}

pub fn from_context(profile_id:&str,profile_revision:&str,config:&QiniuConfig,context:&ResolvedBucketContext,access_key:&str,secret_key:&str,session_token:Option<&str>)->Result<QiniuS3Bridge,QiniuError>{
    for identity in [profile_id,profile_revision] {
        if identity.is_empty()||identity.len()>512||identity.contains(['\r','\n','\0']) {return Err(QiniuError::invalid("七牛账号连接标识无效 / Invalid Qiniu connection identity"));}
    }
    let valid_credential=|value:&str|!value.trim().is_empty()&&value.len()<=4096&&!value.contains(['\r','\n','\0']);
    if !valid_credential(access_key)||!valid_credential(secret_key)||session_token.is_some_and(|token|!valid_credential(token)){return Err(QiniuError::invalid("七牛 S3 凭据格式无效 / Invalid Qiniu S3 credentials"));}
    let bucket_name=context.s3_bucket_name.as_deref().filter(|name|!name.is_empty()).ok_or_else(||QiniuError::unsupported("未取得七牛 S3 空间标识，禁止使用原生空间名猜测 / A server-supplied Qiniu S3 bucket identity is required"))?;
    if bucket_name.len()>255||bucket_name.contains(['/', '\\','\r','\n','\0',' ','?','#']) {return Err(QiniuError::invalid("七牛 S3 空间标识无效 / Invalid Qiniu S3 bucket identity"));}
    if context.bucket.s3_name.as_deref().is_some_and(|alias|alias!=bucket_name){return Err(QiniuError::invalid("空间与解析结果的 S3 标识不一致 / Conflicting Qiniu S3 bucket identities"));}
    let region=context.region.s3_region_id.trim();
    if region.is_empty()||region.len()>128||!region.bytes().all(|byte|byte.is_ascii_alphanumeric()||matches!(byte,b'-'|b'_')){return Err(QiniuError::invalid("七牛空间缺少有效 S3 区域标识 / A valid Qiniu S3 region is required"));}
    let endpoint=context.region.s3_urls.first().ok_or_else(||QiniuError::unsupported("当前空间未提供 S3 地址 / The bucket has no S3 endpoint"))?;
    let endpoint=parse_endpoint(endpoint,config.mode==QiniuMode::Private)?;
    EndpointPolicy::new(config)?.ensure(&endpoint)?;
    if config.mode==QiniuMode::Private&&!config.regions.is_empty(){
        let matches=config.regions.iter().any(|manual|manual.id==region&&parse_endpoint(&manual.s3_endpoint,true).is_ok_and(|url|url.origin()==endpoint.origin()));
        if !matches{return Err(QiniuError::invalid("空间区域和 S3 地址与私有云配置不一致 / Bucket region and S3 endpoint do not match private-cloud configuration"));}
    }
    let ca=super::endpoint::read_private_ca(config)?;
    let credentials=Credentials::new(access_key.to_string(),secret_key.to_string(),session_token.map(str::to_string),None,"Yuncang-Qiniu");
    let mut builder=aws_sdk_s3::config::Builder::new().behavior_version_latest()
        .credentials_provider(credentials).region(Region::new(region.to_string()))
        .endpoint_url(endpoint.as_str()).force_path_style(true)
        // Qiniu's compatibility contract does not guarantee all optional AWS
        // checksum algorithms enabled by new SDK defaults.
        .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
        .retry_config(RetryConfig::standard().with_max_attempts(3))
        .timeout_config(TimeoutConfig::builder().connect_timeout(Duration::from_secs(10)).read_timeout(Duration::from_secs(60)).build());
    if let Some(bytes)=ca.as_ref(){
        use aws_smithy_http_client::{Builder,tls::{self,TlsContext,TrustStore}};
        let context=TlsContext::builder().with_trust_store(TrustStore::default().with_pem_certificate(bytes.clone())).build().map_err(|_|QiniuError::invalid("无法建立私有云 CA 信任 / Could not initialize private-cloud CA trust"))?;
        let http=Builder::new().tls_provider(tls::Provider::Rustls(tls::rustls_provider::CryptoMode::AwsLc)).tls_context(context).build_https();
        builder=builder.http_client(http);
    }
    let endpoint_text=endpoint.as_str().trim_end_matches('/').to_string();
    let binding=S3Binding {profile_id:profile_id.into(),profile_revision:profile_revision.into(),bucket_name:bucket_name.into(),endpoint:endpoint_text.clone(),region_id:region.into(),temporary:session_token.is_some(),custom_ca:ca.is_some()};
    let client=Client::from_conf(builder.build());
    Ok(QiniuS3Bridge {client,bucket_name:bucket_name.into(),endpoint:endpoint_text,region:region.into(),binding})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qiniu::endpoint::validate_ca_bundle;
    // Public test certificate from aws-smithy-http-client 1.1.13 tests/server.pem
    // (Apache-2.0). No private key or real deployment certificate is embedded.
    const VALID_PEM:&str=r#"-----BEGIN CERTIFICATE-----
MIID2TCCAkGgAwIBAgICAcgwDQYJKoZIhvcNAQELBQAwJzElMCMGA1UEAwwcU0RL
IFJTQSBsZXZlbCAyIGludGVybWVkaWF0ZTAeFw0yNTAyMTkxNDUzMDJaFw0zMDA4
MTIxNDUzMDJaMBYxFDASBgNVBAMMC3Nka3Rlc3QuY29tMIIBIjANBgkqhkiG9w0B
AQEFAAOCAQ8AMIIBCgKCAQEAq0qAhLP/7uVfR5zv8d41eciCEco2kKjqoN9NlUy8
xt8fNUFvFdSqEsrPMyycyfPg9HBhJHhCBtVQSxmr/y/IEkvbf5P5aq2CnVKKMjGm
xlqUm+mHmtDYZkJp/2nnK3ZFm9/b1oqs6XvfEJ3R2eqFf454a8SRHX1gVdj+LFnm
EVfUkVBSZCMJm9EOL9HL2I6tDPzXvJpEZMzu/pHouMNeSBBeQDGQN7vZo36cb2wG
PCTwHCh/DjZpKtJK8eKRDipIbjQr3upNbLxva36/V70xM6rTy9ac+GT/IUh0Dh0q
nXgjntez5grtlz4DrQBBhNhGAAliOTGvk74kPjzHYFy8FQIDAQABo4GfMIGcMAwG
A1UdEwEB/wQCMAAwCwYDVR0PBAQDAgbAMB0GA1UdDgQWBBTF0O0/x6KcdOoqlv0T
//HVFq2RODA9BgNVHSMENjA0gBQFk2G/rf1Iob6rw0H6lQ/uzbfLaKEZpBcwFTET
MBEGA1UEAwwKU0RLIFJTQSBDQYIBezAhBgNVHREEGjAYggtzZGt0ZXN0LmNvbYIJ
bG9jYWxob3N0MA0GCSqGSIb3DQEBCwUAA4IBgQAHDCVmgHAuUkJCyNJefN+GLj9s
hCzoSScWSSuyUTOP+N2cT9SOIyjdBb0uLaj4E/Casf/fEvqd/qSz2pBZtXXG3udP
NOfO7ZXOuAW/DqMKL7B/JYvybr2ugJefB7+fVqEdJ/lKZ6DT517nO+V9BRZRrcyR
vx5gM4j46p2qkN9yiAvimE37hBUIkjKCdejXA4IVr90Z6kG2yGo1XIFp8fDAEoSm
u5h5ftuyGvy3kXg8e1quVs38yeh3Vcxk60g8MpFrbUBZjYd3mBN0wnQAOmsK592k
3mEJIDN5NfFvuap/Tl0SAqsP7vfIy7t3Wu5aJoH5VlepmKOhHVnbwhd61pd2ZeHs
zvo8dLsfgowGiSItvdw+pg0PUsozXG0JH7o8igzEfIiRJ237pX8U1/Lr1v5fKYhL
pfZoGVfpH2oK6uUE4TzAK7bf9tGCKkvqx0MhvQ1Y6tjbp3l/+vxDTSgoo5Oh4XJ+
gRxRIoosMVJffwwy+sbfMs5rqCTC7DrqHoFb+3I=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIEtjCCAp6gAwIBAgIBezANBgkqhkiG9w0BAQsFADAVMRMwEQYDVQQDDApTREsg
UlNBIENBMB4XDTI1MDIxOTE0NTMwMloXDTM1MDIxNzE0NTMwMlowJzElMCMGA1UE
AwwcU0RLIFJTQSBsZXZlbCAyIGludGVybWVkaWF0ZTCCAaIwDQYJKoZIhvcNAQEB
BQADggGPADCCAYoCggGBALpfp+sVFpcJxmK7v/aCL5R5sjWzfkwUABhYNWsk+26x
ioayPUZ3IMnKYvzGXmX2a6pjPJeP5HpFIvFnezac/tHHEk8zgATVGGbC1gO6aKT+
o1UYKICcwHuhwG6BZ3hoFqjuBY8wk+zIgV9pd+907E0oZOy+TutCtk3dHPBYYbJO
NS8pQDw804ckKpEa34NQcLN9D3FBsgMXX6/pYyvzpD2fDgo6X6lDOWVZ31mtgmwP
jV6Be/y2r7Z/aA9fePfSTxSZnsNpwS5tkVwVG8v42ph7rVNJ/zaBsfXfCbbRV0q8
HjJAzWGtXbPH4Ojj6MEOSjGK+rusIOZmqQAbvJ0fMH4soW5FjYWsngEuDYOrWRlB
bkv4ixeMfaz8rwC0fkLIJWFOZnHt0nmVtEVsGRc0ndTrQDlaqIJq87cL0cYkqYZE
vn2I0lmkIgna9OTCDbvBUaglYrxLe8e41OSvvcVrFmSxvx1GcWjuU1Q08P3JcBmP
9uhhjW53TYoarFhKjrO+WQIDAQABo38wfTAdBgNVHQ4EFgQUBZNhv639SKG+q8NB
+pUP7s23y2gwIAYDVR0lAQH/BBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMCMAwGA1Ud
EwQFMAMBAf8wCwYDVR0PBAQDAgH+MB8GA1UdIwQYMBaAFOCtnMCd873GJzp4HbZs
uuxho+wIMA0GCSqGSIb3DQEBCwUAA4ICAQBvCShvDdnp+pSRzK4sJS/AgElhIDVR
QrFfnhOxElVWxXSYEXVegwj1qKhgM+de9k9eKH/dM7mr5Ry9N6GfTjtRuf4fDp8W
Zj6bnqQoNz1vTPmX5ymnEipRwg5BeQtfmHVf++uor4Ch6Xx5lp9mlyCkZqEgHKkz
UietQNkZjalnIex/nBr+2kHD1dh2ZTefsTOHofnz+gsg3tNjjvzf+YMOw7aifQvI
2uoQVDjb2FBq24LSpBAc9r2sU2CKHD4/4Ei11QRI29gNgOJiiUArAV6P13mdCVMY
ue92chdLg3/AYctAUXE7NXMXeqZdOlST65GgEg36tays3l7JqlF+FaPqzuJnB+kt
pzYDdt1pFxV0Ep8RsyWm7TbYsRVqzx0eueReVKQQBBjM2+8uD8X3bZB/0QtPknBo
6x0S90g32BL4dPn/mHLLbKTNWPQ9dGmIBHvZocw5UxRYhiFLx+Wurw+V8CWmoU2g
kEiTAaA/5jiZNR02sz6H7CC70FN0vHYREiivqvNMhLbmWxORrCL/TdmwdwfEMCT4
ozEzyGHFUVatCTUeiWxI2YXg1oNHLQU5gfy8gxfygNjG8r3A/L1SOoCsS2Cw/FcW
LJXtCyJoVzM1oLSzPbvUpe4fbnhQ/5hcM2+Tfm2DsNb9RVLjbl5t6EUTuVwKP8us
y0Qg67cAE/Grlw==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIFCzCCAvOgAwIBAgIUbOKEL90YNxD9QGi6wIP6zs5AzCMwDQYJKoZIhvcNAQEL
BQAwFTETMBEGA1UEAwwKU0RLIFJTQSBDQTAeFw0yNTAyMTkxNDUzMDFaFw0zNTAy
MTcxNDUzMDFaMBUxEzARBgNVBAMMClNESyBSU0EgQ0EwggIiMA0GCSqGSIb3DQEB
AQUAA4ICDwAwggIKAoICAQDKHnrAedyOnngswWm1oeOgcfjUHo4EMHMgTn6b6vnj
KRV5idN9iIl0rI/QuyZeGcvEkarSZZMnkme1cnhOpLvelPEgCRqMI+02VodEpVer
7i2QIxqpCzf2VfZMAQ5cNyuBeN+IS+FDViPge71eypmBnF1CHu5d9lfI8y8PVVfJ
QRsP1M/bWCLIgGs7ZjHNt+cA+ZBTBHID66aXx4egW59MPBCq9SH9FC0PfvJqJjkU
QNfiSCpn4XKYRraucQ9LChNlaJqu58HPnCMX+B9/g3MuQ9qCNUq7m/p4ILre0rcJ
mz30RMGFXhyp+94DRwJBDUsWVny9fVhbMtSQKcGd51nBrrn1xcWC0+NNEWkf4VLt
sp3OPOGw/b+njgshxOdi2oPmSumRhHmMC98nl7iWT41Hy/uvLuTpd8KStN/2VIFt
7lsCRnPoIUezM34oZvsIiMsEm93AFPfQtWaKm/8GvSzGBHZ0ba8op9ZVL879yaSN
B1oHrR6OzgpfiekB8Jg3OLFSxwtgDuKJeAiorFXMiSIfqZxBfzsOQCU4UhlY38xR
SVYZMRxmHq06Mi9tVGak60RHV4opu9ixlm5sUbv0NliIzHbOHjry85z+iNSttjqu
Wv3w6jVeIHJcZeYHXZYNx8nGMWEI3JpVBNaF9ycvVpvV1hC5GM/Egn5qggpAjiL+
uwIDAQABo1MwUTAdBgNVHQ4EFgQU4K2cwJ3zvcYnOngdtmy67GGj7AgwHwYDVR0j
BBgwFoAU4K2cwJ3zvcYnOngdtmy67GGj7AgwDwYDVR0TAQH/BAUwAwEB/zANBgkq
hkiG9w0BAQsFAAOCAgEAifwXv/ezBA8BbdV+7IcdA9R5Yz/fENQ8n5u8U0Mmpu2v
mcGpuqJOQlH6Yr5cs0zS9BRmNaMYlVWNnJxMz/3m+uaqohiFf98SgxhT+RGFRohx
jSPI6jE19vKbi1RMvv8yf8DLIjnc8d5e8kOEWNleOarVtkpAhze5nyKVyYkIyyER
zL2RKslmWzxsG0ae0HZ5T5U1voIUG5Y8WyE662egR7INLE3HMUklYljIUJNXClqe
sMfDyvl735z8S93r7sRFv3x+2YZpIzJZGk0ZbyWxfpwAVfr+ktf01BZ+lASXCmDX
94TPHswhoC4HQyxziyf2CLHvpnRczS57/bSVgatYELN4oU2sPicHqPTntrSA6Yhq
+qswrShiF47MXZeiXrddjcWTRQZOs30dmBvTj7CufAYek7r+9KeK0j+ETs/yr5Q4
NQd7/7kkS/4GIKx0uf/+WJJhMDD8qJfWlZDV4kZ+laz49ksjES19IPKoalugst06
SquAqOCKiOQxWeD+QQvdUu9Yac8jNEt3th1z29MoJ02QHSrKe1CmFu7jXcgvWTVI
1dhO2YJ4UNvGaFK3rWU8sDvgFnV6Hpw7y1YAgVYtterSPMAyAGdSFDvZKuo2Bq2N
juj9U9BUS1Xrl1cj8RjpZ0g0gYYF+BX2qwDCqi9qkxHel/oCzG80QAY0dnM+JT4=
-----END CERTIFICATE-----
"#;
    use crate::qiniu::{QiniuBucket,QiniuManualRegion,QiniuRegion};
    fn fixture()->(QiniuConfig,ResolvedBucketContext){
        let config=QiniuConfig {mode:QiniuMode::Private,uc_url:Some("https://uc.internal".into()),regions:vec![QiniuManualRegion{id:"region-one".into(),label:None,s3_endpoint:"https://s3.internal:8443".into()}],..Default::default()};
        let region=QiniuRegion {kodo_region_id:Some("native-region".into()),s3_region_id:"region-one".into(),label:None,uc_urls:vec![],up_urls:vec![],rs_urls:vec![],rsf_urls:vec![],api_urls:vec![],s3_urls:vec!["https://s3.internal:8443".into()],storage_classes:vec![],ttl_seconds:60,expires_at:0,manual:true};
        let bucket=QiniuBucket{name:"human-space-name".into(),s3_name:Some("server-s3-alias".into()),kodo_region_id:Some("native-region".into()),created_at:None,permission:None,remark:None};
        (config,ResolvedBucketContext{bucket,region,s3_bucket_name:Some("server-s3-alias".into()),backend_mode:"s3".into()})
    }
    fn bridge(config:&QiniuConfig,context:&ResolvedBucketContext)->Result<QiniuS3Bridge,QiniuError>{from_context("profile-a","revision-1",config,context,"mock-ak","mock-sk",None)}
    #[test]fn missing_or_conflicting_alias_is_never_guessed_from_display_name(){let(config,mut context)=fixture();context.s3_bucket_name=None;assert!(bridge(&config,&context).is_err());context.s3_bucket_name=Some("different-alias".into());assert!(bridge(&config,&context).is_err());}
    #[test]fn missing_region_or_endpoint_never_uses_aws_defaults(){let(config,mut context)=fixture();context.region.s3_region_id.clear();assert!(bridge(&config,&context).is_err());context.region.s3_region_id="region-one".into();context.region.s3_urls.clear();assert!(bridge(&config,&context).is_err());}
    #[test]fn endpoint_and_region_must_both_match_the_configured_environment(){let(config,mut context)=fixture();context.region.s3_urls=vec!["https://unconfigured.internal".into()];assert!(bridge(&config,&context).is_err());context.region.s3_urls=vec!["https://s3.internal:8443".into()];context.region.s3_region_id="wrong-region".into();assert!(bridge(&config,&context).is_err());}
    #[test]fn binding_prevents_reusing_another_profile_or_credential_revision(){let(config,context)=fixture();let value=bridge(&config,&context).unwrap();assert_eq!(value.bucket_name,"server-s3-alias");assert_eq!(value.region,"region-one");assert_eq!(value.endpoint,"https://s3.internal:8443");assert!(value.ensure_binding("profile-a","revision-1").is_ok());assert!(value.ensure_binding("profile-b","revision-1").is_err());assert!(value.ensure_binding("profile-a","revision-2").is_err());}
    #[test]fn presigning_uses_the_explicit_alias_endpoint_region_and_temporary_token(){
        let(config,context)=fixture();let value=from_context("profile-a","share-session-1",&config,&context,"mock-ak","mock-sk",Some("temporary-session")).unwrap();
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let request=runtime.block_on(value.client.get_object().bucket(&value.bucket_name).key("folder/中文+%?#.txt").presigned(aws_sdk_s3::presigning::PresigningConfig::expires_in(Duration::from_secs(60)).unwrap())).unwrap();
        let url=url::Url::parse(request.uri()).unwrap();assert_eq!(url.origin().ascii_serialization(),"https://s3.internal:8443");assert!(url.path().starts_with("/server-s3-alias/folder/"));assert!(!url.path().contains("human-space-name"));
        let query=url.query_pairs().collect::<std::collections::HashMap<_,_>>();assert!(query.get("X-Amz-Credential").unwrap().contains("/region-one/s3/aws4_request"));assert_eq!(query.get("X-Amz-Security-Token").unwrap(),"temporary-session");assert!(value.binding.temporary);
    }
    #[test]fn invalid_custom_ca_is_an_error_without_disabling_certificate_validation(){let(mut config,context)=fixture();let path=std::env::temp_dir().join(format!("qiniu-invalid-ca-{}",uuid::Uuid::new_v4().simple()));std::fs::write(&path,b"not a certificate").unwrap();config.trusted_ca_path=Some(path.to_string_lossy().into_owned());let result=bridge(&config,&context);std::fs::remove_file(path).unwrap();assert!(result.is_err());}
    #[test]fn normal_certificate_is_validated_offline(){assert!(validate_ca_bundle(VALID_PEM.as_bytes()).is_ok());}
    #[test]fn valid_pem_markers_with_invalid_der_are_rejected(){assert!(validate_ca_bundle(b"-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n").is_err());}
    #[test]fn every_block_in_a_certificate_bundle_is_validated(){let normal=format!("{VALID_PEM}\n{VALID_PEM}");assert!(validate_ca_bundle(normal.as_bytes()).is_ok());let bad=format!("{VALID_PEM}\n-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n");assert!(validate_ca_bundle(bad.as_bytes()).is_err());}
    #[test]fn native_share_and_s3_clients_use_the_same_complete_ca_bundle_validation(){
        let(mut config,context)=fixture();config.share_portal=Some("https://portal.internal".into());
        let path=std::env::temp_dir().join(format!("qiniu-ca-constructors-{}",uuid::Uuid::new_v4().simple()));
        config.trusted_ca_path=Some(path.to_string_lossy().into_owned());
        let native=|config:&QiniuConfig|crate::qiniu::QiniuClient::new(config.clone(),crate::qiniu::QiniuCredentials::new("mock-ak".into(),"mock-sk".into(),None).unwrap());
        let sharing=|config:&QiniuConfig|crate::qiniu::share::QiniuShareService::new(config.clone(),&[]);
        std::fs::write(&path,VALID_PEM).unwrap();
        assert!(native(&config).is_ok());assert!(sharing(&config).is_ok());assert!(bridge(&config,&context).is_ok());
        for bytes in ["not a certificate".to_string(),format!("{VALID_PEM}\n-----BEGIN CERTIFICATE-----\nAQID\n-----END CERTIFICATE-----\n")] {
            std::fs::write(&path,bytes).unwrap();
            assert!(native(&config).is_err());assert!(sharing(&config).is_err());assert!(bridge(&config,&context).is_err());
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]fn credential_material_is_not_serialized_into_binding_or_debug(){let(config,context)=fixture();let value=from_context("profile-a","revision-1",&config,&context,"unique-ak","unique-sk",Some("unique-session")).unwrap();let text=format!("{value:?} {}",serde_json::to_string(&value.binding).unwrap());for secret in ["unique-ak","unique-sk","unique-session"]{assert!(!text.contains(secret));}}
}
