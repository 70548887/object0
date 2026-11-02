//! Explicit, credential-free bucket bindings. They are not permission grants:
//! the native client must verify them with an authenticated S3 read operation.
use super::{endpoint::{parse_endpoint,EndpointPolicy},QiniuBucket,QiniuBucketBinding,QiniuConfig,QiniuError,QiniuMode,QiniuRegion,ResolvedBucketContext};
use std::collections::HashMap;

pub const MAX_BUCKET_BINDINGS:usize=32;

pub fn validate_bindings(config:&QiniuConfig,policy:&EndpointPolicy)->Result<(),QiniuError>{
    if config.bucket_bindings.len()>MAX_BUCKET_BINDINGS{return Err(QiniuError::invalid("显式空间绑定最多 32 个 / At most 32 explicit bucket bindings are allowed"));}
    let mut identities=HashMap::new();
    for (index,binding) in config.bucket_bindings.iter().enumerate() {
        let name_ok=|name:&str|!name.trim().is_empty()&&name.len()<=255&&!name.contains(['/', '\\','\r','\n','\0',' ','?','#']);
        if !name_ok(&binding.native_name)||!name_ok(&binding.s3_name) {
            return Err(QiniuError::invalid("显式空间必须提供原生名称和 S3 标识，不能猜测 / An explicit native bucket name and S3 bucket ID are required"));
        }
        for name in [&binding.native_name,&binding.s3_name] {
            // A name may equal its own explicit S3 identity, but no identity
            // may resolve to two different configured buckets.
            if identities.insert(name.clone(),index).is_some_and(|owner|owner!=index) {
                return Err(QiniuError::invalid("显式空间名称或 S3 标识重复 / Duplicate explicit bucket name or S3 ID"));
            }
        }
        let region=&binding.s3_region_id;
        if region.is_empty()||region.len()>128||!region.bytes().all(|byte|byte.is_ascii_alphanumeric()||matches!(byte,b'-'|b'_')) {
            return Err(QiniuError::invalid("显式空间缺少有效 S3 区域标识 / Explicit bucket binding requires a valid S3 region ID"));
        }
        if binding.kodo_region_id.as_ref().is_some_and(|value|value.is_empty()||value.len()>128||!value.bytes().all(|byte|byte.is_ascii_alphanumeric()||matches!(byte,b'-'|b'_'))) {
            return Err(QiniuError::invalid("显式原生区域标识无效 / Invalid explicit native region ID"));
        }
        let endpoint=parse_endpoint(&binding.s3_endpoint,config.mode==QiniuMode::Private)?;
        policy.ensure(&endpoint)?;
        if config.mode==QiniuMode::Private&&!config.regions.is_empty() && !config.regions.iter().any(|manual|manual.id==binding.s3_region_id&&parse_endpoint(&manual.s3_endpoint,true).is_ok_and(|url|url.origin()==endpoint.origin())) {
            return Err(QiniuError::invalid("显式空间绑定须匹配手工区域和 S3 地址 / Explicit bucket binding must match a configured manual region and S3 endpoint"));
        }
    }
    Ok(())
}

pub fn context(binding:&QiniuBucketBinding,config:&QiniuConfig)->Result<ResolvedBucketContext,QiniuError>{
    let endpoint=parse_endpoint(&binding.s3_endpoint,config.mode==QiniuMode::Private)?;
    let bucket=QiniuBucket{name:binding.native_name.clone(),s3_name:Some(binding.s3_name.clone()),kodo_region_id:binding.kodo_region_id.clone(),created_at:None,permission:None,remark:None};
    let region=QiniuRegion{kodo_region_id:binding.kodo_region_id.clone(),s3_region_id:binding.s3_region_id.clone(),label:Some("显式空间映射 / Explicit bucket mapping".into()),uc_urls:config.uc_url.iter().cloned().collect(),up_urls:vec![],rs_urls:vec![],rsf_urls:vec![],api_urls:vec![],s3_urls:vec![endpoint.as_str().trim_end_matches('/').into()],storage_classes:vec![],ttl_seconds:0,expires_at:0,manual:true};
    Ok(ResolvedBucketContext{bucket,region,s3_bucket_name:Some(binding.s3_name.clone()),backend_mode:"s3".into()})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding()->QiniuBucketBinding {QiniuBucketBinding{native_name:"native-bucket".into(),s3_name:"explicit-s3-id".into(),s3_region_id:"cn-east-1".into(),s3_endpoint:"https://s3.cn-east-1.qiniucs.com".into(),kodo_region_id:Some("z0".into())}}
    #[test]fn explicit_identity_does_not_guess_alias_or_grant_writes(){
        let config=QiniuConfig{bucket_bindings:vec![binding()],..Default::default()};
        EndpointPolicy::new(&config).unwrap();let resolved=context(&config.bucket_bindings[0],&config).unwrap();
        assert_eq!(resolved.bucket.name,"native-bucket");assert_eq!(resolved.s3_bucket_name.as_deref(),Some("explicit-s3-id"));
        assert_eq!(resolved.backend_mode,"s3");assert_eq!(resolved.bucket.permission,None);assert!(resolved.region.manual);
        let mut missing=config.clone();missing.bucket_bindings[0].s3_name.clear();assert!(EndpointPolicy::new(&missing).is_err());
    }
    #[test]fn public_bindings_cannot_expand_official_credential_trust(){
        let mut config=QiniuConfig{bucket_bindings:vec![binding()],..Default::default()};
        for endpoint in ["https://s3.cn-east-1.qiniucs.com.attacker.example","http://s3.cn-east-1.qiniucs.com","https://s3.cn-east-1.qiniucs.com:8443"] {
            config.bucket_bindings[0].s3_endpoint=endpoint.into();assert!(EndpointPolicy::new(&config).is_err());
        }
    }
    #[test]fn duplicate_or_ambiguous_native_and_s3_names_are_rejected(){
        let mut config=QiniuConfig{bucket_bindings:vec![binding(),binding()],..Default::default()};assert!(EndpointPolicy::new(&config).is_err());
        config.bucket_bindings[1].native_name="other".into();assert!(EndpointPolicy::new(&config).is_err());
        config.bucket_bindings[1].s3_name="native-bucket".into();assert!(EndpointPolicy::new(&config).is_err());
        config.bucket_bindings.truncate(1);config.bucket_bindings[0].s3_name="native-bucket".into();assert!(EndpointPolicy::new(&config).is_ok());
    }
    #[test]fn private_multi_region_bindings_require_exact_configured_mapping(){
        let mut config=QiniuConfig{mode:QiniuMode::Private,uc_url:Some("https://uc.internal".into()),regions:vec![super::super::QiniuManualRegion{id:"region-a".into(),label:None,s3_endpoint:"https://s3-a.internal".into()},super::super::QiniuManualRegion{id:"region-b".into(),label:None,s3_endpoint:"https://s3-b.internal".into()}],bucket_bindings:vec![binding()],..Default::default()};
        config.bucket_bindings[0].s3_region_id="region-b".into();config.bucket_bindings[0].s3_endpoint="https://s3-b.internal".into();assert!(EndpointPolicy::new(&config).is_ok());
        config.bucket_bindings[0].s3_endpoint="https://s3-a.internal".into();assert!(EndpointPolicy::new(&config).is_err());
        config.bucket_bindings[0].s3_endpoint="https://unconfigured.internal".into();assert!(EndpointPolicy::new(&config).is_err());
    }
}
