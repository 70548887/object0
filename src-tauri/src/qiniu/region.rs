use super::{QiniuBucket,QiniuConfig,QiniuError,QiniuMode};
use serde::{Deserialize,Serialize};
use serde_json::Value;
use url::Url;

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct QiniuStorageClass {
    pub file_type:u8,
    pub kodo_name:String,
    pub s3_name:Option<String>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct QiniuRegion {
    pub kodo_region_id:Option<String>,
    pub s3_region_id:String,
    pub label:Option<String>,
    pub uc_urls:Vec<String>,pub up_urls:Vec<String>,pub rs_urls:Vec<String>,pub rsf_urls:Vec<String>,pub api_urls:Vec<String>,pub s3_urls:Vec<String>,
    pub storage_classes:Vec<QiniuStorageClass>,
    pub ttl_seconds:u64,
    pub expires_at:i64,
    pub manual:bool,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ResolvedBucketContext {
    pub bucket:QiniuBucket,
    pub region:QiniuRegion,
    pub s3_bucket_name:Option<String>,
    pub backend_mode:String,
}
impl QiniuRegion {
    pub fn from_response(value:&Value,scheme:&str,now:i64)->Result<Self,QiniuError> {
        let s3=value.get("s3").unwrap_or(&Value::Null);
        let s3_region_id=s3.get("region_alias").and_then(Value::as_str).unwrap_or_default().to_string();
        let kodo_region_id=value.get("region").or_else(||value.get("id")).and_then(Value::as_str).map(str::to_string);
        if kodo_region_id.as_ref().is_none_or(|value|value.is_empty()) && s3_region_id.is_empty() {return Err(QiniuError::invalid("七牛区域响应缺少标识 / Qiniu region response has no identifier"));}
        let ttl=value.get("ttl").and_then(Value::as_u64).unwrap_or(0);
        let urls=|name:&str| -> Result<Vec<String>,QiniuError> {
            let mut result=Vec::new();
            if let Some(items)=value.pointer(&format!("/{name}/domains")).and_then(Value::as_array) {
                for item in items {
                    let domain=item.as_str().ok_or_else(||QiniuError::invalid("区域地址格式无效 / Invalid region endpoint"))?;
                    let url=if domain.contains("://") {super::endpoint::parse_endpoint(domain,scheme=="http")?} else {super::endpoint::parse_endpoint(&format!("{scheme}://{domain}"),scheme=="http")?};
                    result.push(url.as_str().trim_end_matches('/').to_string());
                }
            }
            Ok(result)
        };
        let mut storage_classes=Vec::new();
        if let Some(classes)=value.pointer("/extra/file_types").and_then(Value::as_array) {
            for item in classes {
                let Some(file_type)=item.get("file_type").and_then(Value::as_u64).and_then(|value|u8::try_from(value).ok()) else {continue};
                let Some(name)=item.get("storage_class").and_then(Value::as_str) else {continue};
                storage_classes.push(QiniuStorageClass {file_type,kodo_name:name.to_string(),s3_name:item.get("s3_storage_class").and_then(Value::as_str).map(str::to_string)});
            }
        }
        Ok(Self {kodo_region_id,s3_region_id,label:value.get("description").and_then(Value::as_str).map(str::to_string),uc_urls:urls("uc")?,up_urls:urls("up")?,rs_urls:urls("rs")?,rsf_urls:urls("rsf")?,api_urls:urls("api")?,s3_urls:urls("s3")?,storage_classes,ttl_seconds:ttl,expires_at:now.saturating_add(i64::try_from(ttl).unwrap_or(i64::MAX)),manual:false})
    }
    pub fn manual_regions(config:&QiniuConfig)->Vec<Self> {
        if config.mode!=QiniuMode::Private {return vec![];}
        config.regions.iter().map(|r|Self {kodo_region_id:None,s3_region_id:r.id.clone(),label:r.label.clone(),uc_urls:config.uc_url.iter().cloned().collect(),s3_urls:vec![r.s3_endpoint.trim_end_matches('/').to_string()],up_urls:vec![],rs_urls:vec![],rsf_urls:vec![],api_urls:vec![],storage_classes:vec![],ttl_seconds:0,expires_at:0,manual:true}).collect()
    }
    pub fn s3_endpoint(&self)->Result<Url,QiniuError> {
        let endpoint=self.s3_urls.first().ok_or_else(||QiniuError::unsupported("当前区域未提供 S3 地址 / This region has no S3 endpoint"))?;
        super::endpoint::parse_endpoint(endpoint,endpoint.starts_with("http:"))
    }
}

pub fn parse_buckets(value:&Value)->Result<Vec<QiniuBucket>,QiniuError> {
    let values=value.as_array().ok_or_else(||QiniuError::invalid("七牛空间列表响应格式无效 / Invalid Qiniu bucket list"))?;
    let mut buckets=Vec::with_capacity(values.len());
    for value in values {
        let name=value.get("tbl").or_else(||value.get("name")).and_then(Value::as_str).ok_or_else(||QiniuError::invalid("七牛空间缺少原生名称 / Qiniu bucket has no native name"))?;
        let s3_name=value.get("id").or_else(||value.get("s3_id")).and_then(Value::as_str).filter(|value|!value.is_empty()).map(str::to_string);
        let permission=match value.get("perm").and_then(Value::as_u64) {Some(1)=>Some("readonly".into()),Some(2)=>Some("readwrite".into()),_=>None};
        let created_at=value.get("ctime").and_then(Value::as_i64).and_then(|seconds|chrono::DateTime::<chrono::Utc>::from_timestamp(seconds,0)).map(|value|value.to_rfc3339());
        buckets.push(QiniuBucket {name:name.to_string(),s3_name,kodo_region_id:value.get("region").and_then(Value::as_str).map(str::to_string),created_at,permission,remark:value.get("remark").and_then(Value::as_str).map(str::to_string)});
    }
    Ok(buckets)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn names_are_never_used_as_guessed_s3_aliases() {
        let buckets=parse_buckets(&serde_json::json!([{"tbl":"my-space","id":"server-alias","region":"z0","perm":1},{"tbl":"another"}])).unwrap();
        assert_eq!(buckets[0].s3_name.as_deref(),Some("server-alias"));assert_eq!(buckets[0].permission.as_deref(),Some("readonly"));assert_eq!(buckets[1].s3_name,None);
    }
    #[test] fn region_ids_storage_classes_and_ttl_remain_distinct() {
        let region=QiniuRegion::from_response(&serde_json::json!({"region":"z0","ttl":120,"s3":{"region_alias":"cn-east-1","domains":["s3.cn-east-1.qiniucs.com"]},"up":{"domains":["upload.qiniup.com"]},"extra":{"file_types":[{"file_type":4,"storage_class":"archive_ir","s3_storage_class":"GLACIER_IR"}]}}),"https",1000).unwrap();
        assert_eq!(region.kodo_region_id.as_deref(),Some("z0"));assert_eq!(region.s3_region_id,"cn-east-1");assert_eq!(region.expires_at,1120);assert_eq!(region.storage_classes[0].file_type,4);assert_eq!(region.s3_urls[0],"https://s3.cn-east-1.qiniucs.com");
    }
    #[test] fn malformed_region_and_bucket_responses_are_errors_not_empty_success() {
        assert!(parse_buckets(&serde_json::json!({"error":"denied"})).is_err());
        assert!(QiniuRegion::from_response(&serde_json::json!({}),"https",0).is_err());
        assert!(QiniuRegion::from_response(&serde_json::json!({"id":"z0","s3":{"region_alias":"x","domains":["https://user:secret@example.com"]}}),"https",0).is_err());
    }
}
