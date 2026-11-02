//! Qiniu native multipart upload v2. The wire contract is pinned to the public
//! API and kodo-s3-adapter-sdk 0.7.1 (Browser 2c5d7bad). Tokens are regenerated
//! in memory and never enter checkpoints, errors or logging.
//!
//! init: POST /buckets/{bucket}/objects/{urlsafe-key}/uploads
//! part: PUT  /buckets/{bucket}/objects/{urlsafe-key}/uploads/{id}/{number}
//! list: GET  /buckets/{bucket}/objects/{urlsafe-key}/uploads/{id}
//! complete/abort: POST/DELETE that same session path.
//! See https://developer.qiniu.com/kodo/6365/initialize-multipartupload,
//! /6366/upload-part, /6368/complete-multipart-upload, /6367/abort-multipart-upload,
//! /6858/listparts. Content-MD5 is optional in the documented part API. The
//! final Qiniu content hash is always verified instead of treating an ACK as
//! proof of successful completion.

use super::{transfer::QiniuEtag,CapabilityState,QiniuClient,QiniuError,ResolvedBucketContext};
use base64::{engine::general_purpose::URL_SAFE,Engine};
use futures_util::future::{select,Either};
use reqwest::Method;
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::{BTreeMap,HashSet},fmt,path::Path,sync::{atomic::{AtomicU8,Ordering},Mutex,OnceLock},time::{Duration,UNIX_EPOCH}};
use tokio::io::{AsyncReadExt,AsyncSeekExt};
use url::Url;

pub const MIN_PART_SIZE:u64=1024*1024;
pub const DEFAULT_PART_SIZE:u64=8*1024*1024;
/// Deliberate desktop memory bound (the service permits larger individual
/// parts). A file requiring more than 10,000 of these parts is Unsupported.
pub const MAX_BUFFERED_PART_SIZE:u64=64*1024*1024;
pub const MAX_PARTS:u16=10_000;
const MAX_JSON:usize=4*1024*1024;

#[derive(Clone,Default,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct MultipartOptions {
    pub part_size:Option<u64>,
    #[serde(default)] pub overwrite:bool,
    pub file_type:Option<u8>,
    pub mime_type:Option<String>,
    #[serde(default)] pub metadata:BTreeMap<String,String>,
}
impl fmt::Debug for MultipartOptions {fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result{f.debug_struct("MultipartOptions").field("part_size",&self.part_size).field("overwrite",&self.overwrite).field("file_type",&self.file_type).finish_non_exhaustive()}}

#[derive(Clone,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct SourceFingerprint {
    pub canonical_path:String,pub size:u64,pub modified_nanos:String,pub sha256:String,pub qiniu_etag:String,
}
impl fmt::Debug for SourceFingerprint {fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result{f.debug_struct("SourceFingerprint").field("size",&self.size).finish_non_exhaustive()}}

#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct MultipartPart {pub part_number:u16,pub etag:String,pub size:u64,pub sha256:String}
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="kebab-case")]
pub enum MultipartPhase {Uploading,Completing,Completed,Cancelled}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct MultipartCheckpoint {
    pub format_version:u8,pub profile_id:String,pub profile_revision:String,
    pub bucket:String,pub key:String,pub endpoint:String,pub region:String,
    pub source:SourceFingerprint,pub options:MultipartOptions,
    pub upload_id:String,pub expire_at:i64,pub part_size:u64,
    pub parts:Vec<MultipartPart>,pub phase:MultipartPhase,
}
impl fmt::Debug for MultipartCheckpoint {fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result{f.debug_struct("MultipartCheckpoint").field("phase",&self.phase).field("source_size",&self.source.size).field("part_count",&self.parts.len()).field("expire_at",&self.expire_at).finish_non_exhaustive()}}
#[derive(Debug)]
pub enum MultipartOutcome {
    Completed {bytes:u64,checkpoint:MultipartCheckpoint},
    Paused {checkpoint:MultipartCheckpoint},
    Cancelled {checkpoint:MultipartCheckpoint},
    Interrupted {checkpoint:MultipartCheckpoint,error:QiniuError},
}

#[derive(Default,Debug)]
pub struct MultipartControl(AtomicU8);
impl MultipartControl {
    pub fn pause(&self){let _=self.0.compare_exchange(0,1,Ordering::SeqCst,Ordering::SeqCst);}
    pub fn cancel(&self){self.0.store(2,Ordering::SeqCst);}
    pub fn resume(&self){self.0.store(0,Ordering::SeqCst);}
    pub fn is_paused(&self)->bool{self.0.load(Ordering::SeqCst)==1}
    pub fn is_cancelled(&self)->bool{self.0.load(Ordering::SeqCst)==2}
    fn check(&self)->Result<(),QiniuError>{if self.is_cancelled(){Err(error("cancelled","七牛分片上传已取消 / Qiniu multipart upload cancelled"))}else if self.is_paused(){Err(error("paused","七牛分片上传已暂停 / Qiniu multipart upload paused"))}else{Ok(())}}
}
fn error(code:&str,message:&str)->QiniuError{QiniuError::new(CapabilityState::Unavailable,code,message)}
fn invalid(message:&str)->QiniuError{QiniuError::invalid(message)}
fn local_error()->QiniuError{error("local-io","无法读取上传来源，请检查路径、权限和文件状态 / Could not read upload source")}
fn now()->i64{chrono::Utc::now().timestamp()}
fn safe_id(value:&str)->bool{!value.is_empty()&&value.len()<=1024&&value.bytes().all(|byte|byte.is_ascii_alphanumeric()||matches!(byte,b'-'|b'_'|b'.'|b'~'))}
fn hex(bytes:impl AsRef<[u8]>)->String{bytes.as_ref().iter().map(|byte|format!("{byte:02x}")).collect()}

struct UploadLease(String);
fn leases()->&'static Mutex<HashSet<String>>{static LEASES:OnceLock<Mutex<HashSet<String>>>=OnceLock::new();LEASES.get_or_init(||Mutex::new(HashSet::new()))}
impl UploadLease {
    fn acquire(profile:&str,_revision:&str,bucket:&str,key:&str)->Result<Self,QiniuError>{
        let identity=serde_json::to_string(&(profile,bucket,key)).map_err(|_|invalid("上传身份编码失败 / Could not encode upload identity"))?;
        let mut active=leases().lock().map_err(|_|error("busy","上传任务状态不可用 / Upload task registry unavailable"))?;
        if active.len()>=32||!active.insert(identity.clone()){return Err(error("busy","同一目标已有上传任务或任务数量过多 / Upload target is already active or concurrency limit reached"));}Ok(Self(identity))
    }
}
impl Drop for UploadLease{fn drop(&mut self){if let Ok(mut active)=leases().lock(){active.remove(&self.0);}}}

fn validate_options(options:&MultipartOptions)->Result<(),QiniuError>{
    if let Some(size)=options.part_size {if !(MIN_PART_SIZE..=MAX_BUFFERED_PART_SIZE).contains(&size){return Err(QiniuError::unsupported("分片大小须为 1 至 64 MiB / Multipart size must be 1 to 64 MiB"));}}
    if options.mime_type.as_ref().is_some_and(|value|value.is_empty()||value.len()>200||value.contains(['\r','\n','\0'])){return Err(invalid("MIME 类型无效或超过 200 字节 / Invalid or oversized MIME type"));}
    let mut total=0usize;let mut metadata_names=HashSet::new();
    for(key,value)in &options.metadata {
        let key=key.strip_prefix("x-qn-meta-").unwrap_or(key);
        if key.is_empty()||key.len()>50||!key.bytes().all(|byte|byte.is_ascii_alphanumeric()||matches!(byte,b'_'|b'-'))||!metadata_names.insert(key){return Err(invalid("元数据名称无效或重复 / Invalid or duplicate metadata name"));}
        total=total.saturating_add(key.len()).saturating_add(value.len());
    }
    if total>1024{return Err(invalid("元数据总长度不能超过 1024 字节 / Metadata exceeds 1024 bytes"));}Ok(())
}
fn part_size(size:u64,requested:Option<u64>)->Result<u64,QiniuError>{
    if size==0{return Err(QiniuError::unsupported("空文件请使用表单上传 / Use form upload for an empty file"));}
    let minimum=size.div_ceil(MAX_PARTS as u64);
    let chosen=requested.unwrap_or(DEFAULT_PART_SIZE.max(minimum.div_ceil(MIN_PART_SIZE)*MIN_PART_SIZE));
    if !(MIN_PART_SIZE..=MAX_BUFFERED_PART_SIZE).contains(&chosen)||size.div_ceil(chosen)>MAX_PARTS as u64{return Err(QiniuError::unsupported("文件超出当前分片数量或内存限制 / File exceeds multipart count or memory limits"));}Ok(chosen)
}
fn metadata_stamp(metadata:&std::fs::Metadata)->Result<(u64,String),QiniuError>{
    let time=metadata.modified().map_err(|_|local_error())?.duration_since(UNIX_EPOCH).map_err(|_|local_error())?;
    Ok((metadata.len(),time.as_nanos().to_string()))
}
pub async fn fingerprint_source(path:&Path,control:&MultipartControl)->Result<SourceFingerprint,QiniuError>{
    control.check()?;
    let canonical=tokio::fs::canonicalize(path).await.map_err(|_|local_error())?;
    let mut file=tokio::fs::File::open(&canonical).await.map_err(|_|local_error())?;
    let before=file.metadata().await.map_err(|_|local_error())?;if !before.is_file(){return Err(local_error());}
    let stamp=metadata_stamp(&before)?;let mut sha=Sha256::new();let mut qiniu=QiniuEtag::default();let mut buffer=vec![0u8;1024*1024];let mut total=0u64;
    loop {control.check()?;let count=file.read(&mut buffer).await.map_err(|_|local_error())?;if count==0{break;}total=total.checked_add(count as u64).ok_or_else(local_error)?;sha.update(&buffer[..count]);qiniu.update(&buffer[..count]);}
    let after=tokio::fs::metadata(&canonical).await.map_err(|_|local_error())?;
    if metadata_stamp(&after)?!=stamp||total!=stamp.0||tokio::fs::canonicalize(path).await.map_err(|_|local_error())?!=canonical{return Err(error("source-changed","来源文件在读取时已变化 / Upload source changed while reading"));}
    Ok(SourceFingerprint{canonical_path:canonical.to_string_lossy().into_owned(),size:total,modified_nanos:stamp.1,sha256:hex(sha.finalize()),qiniu_etag:qiniu.finish()})
}

async fn controlled<T>(operation:impl std::future::Future<Output=Result<T,reqwest::Error>>,control:Option<&MultipartControl>)->Result<T,QiniuError>{
    let mut pending=Box::pin(operation);
    loop {
        if let Some(control)=control{control.check()?;}
        match select(pending,Box::pin(tokio::time::sleep(Duration::from_millis(100)))).await{
            Either::Left((result,_))=>return result.map_err(|failure|if failure.is_timeout(){error("timeout","七牛分片请求超时，已上传分片保留 / Multipart request timed out; uploaded parts retained")}else{error("transport-failed","七牛分片请求失败，已上传分片保留 / Multipart transport failed; uploaded parts retained")}),
            Either::Right((_,operation))=>pending=operation,
        }
    }
}

impl QiniuClient {
    fn multipart_endpoint(&self,context:&ResolvedBucketContext)->Result<Url,QiniuError>{
        if context.bucket.permission.as_deref()==Some("readonly"){return Err(QiniuError::new(CapabilityState::Forbidden,"read-only","此空间只有读取权限 / Bucket is read-only"));}
        let endpoint=self.service(context,"up")?;self.policy.ensure(&endpoint)?;Ok(endpoint)
    }
    fn multipart_url(&self,endpoint:&Url,bucket:&str,key:&str,upload_id:Option<&str>,number:Option<u16>)->Result<Url,QiniuError>{
        if bucket.is_empty()||bucket.contains(['/', '\\','\0','\r','\n'])||key.is_empty()||key.len()>4096{return Err(invalid("分片上传目标无效 / Invalid multipart target"));}
        if upload_id.is_some_and(|id|!safe_id(id)){return Err(invalid("分片会话标识格式无效 / Invalid multipart upload ID"));}
        let encoded=URL_SAFE.encode(key.as_bytes());let mut url=endpoint.clone();
        {let mut segments=url.path_segments_mut().map_err(|_|invalid("上传服务地址无效 / Invalid upload endpoint"))?;segments.clear();segments.extend(["buckets",bucket,"objects",encoded.as_str(),"uploads"]);if let Some(id)=upload_id{segments.push(id);}if let Some(number)=number{segments.push(&number.to_string());}}
        self.policy.ensure(&url)?;Ok(url)
    }
    async fn multipart_request(&self,context:&ResolvedBucketContext,key:&str,options:&MultipartOptions,method:Method,url:Url,body:Vec<u8>,json_body:bool,control:Option<&MultipartControl>)->Result<Value,QiniuError>{
        self.policy.ensure(&url)?;
        let token=self.upload_token(&context.bucket.name,key,now()+3600,options.file_type,options.overwrite)?;
        let content_type=if json_body{"application/json"}else if method==Method::PUT{"application/octet-stream"}else{"application/x-www-form-urlencoded"};
        let mut response=controlled(self.http.request(method,url.as_str()).timeout(Duration::from_secs(300)).header(reqwest::header::AUTHORIZATION,format!("UpToken {token}")).header(reqwest::header::CONTENT_TYPE,content_type).body(body).send(),control).await?;
        if !response.status().is_success(){return Err(QiniuError::http(response.status().as_u16()));}
        if response.content_length().is_some_and(|length|length>MAX_JSON as u64){return Err(invalid("分片响应过大 / Multipart response is too large"));}
        let mut bytes=Vec::new();while let Some(chunk)=controlled(response.chunk(),control).await?{if bytes.len().saturating_add(chunk.len())>MAX_JSON{return Err(invalid("分片响应过大 / Multipart response is too large"));}bytes.extend_from_slice(&chunk);}
        if bytes.is_empty(){return Ok(Value::Null);}serde_json::from_slice(&bytes).map_err(|_|invalid("分片响应格式无效 / Invalid multipart response"))
    }
    fn validate_checkpoint(&self,profile:&str,revision:&str,context:&ResolvedBucketContext,key:&str,options:&MultipartOptions,checkpoint:&MultipartCheckpoint)->Result<(),QiniuError>{
        let endpoint=self.multipart_endpoint(context)?;
        if checkpoint.format_version!=1||checkpoint.profile_id!=profile||checkpoint.profile_revision!=revision||checkpoint.bucket!=context.bucket.name||checkpoint.key!=key||checkpoint.region!=context.region.s3_region_id||checkpoint.endpoint!=endpoint.as_str().trim_end_matches('/')||checkpoint.options!=*options||!safe_id(&checkpoint.upload_id){return Err(invalid("断点信息与账号、空间、文件或上传选项不匹配 / Checkpoint does not match this upload identity"));}
        if part_size(checkpoint.source.size,Some(checkpoint.part_size))?!=checkpoint.part_size{return Err(invalid("断点分片大小无效 / Invalid checkpoint part size"));}
        let count=checkpoint.source.size.div_ceil(checkpoint.part_size);let mut seen=HashSet::new();
        for part in &checkpoint.parts {if part.part_number==0||part.part_number as u64>count||!seen.insert(part.part_number)||part.etag.is_empty()||part.etag.len()>1024||part.etag.contains(['\r','\n'])||part.sha256.len()!=64||!part.sha256.bytes().all(|byte|byte.is_ascii_hexdigit())||part.size!=expected_part_size(checkpoint,part.part_number){return Err(invalid("断点分片记录无效 / Invalid checkpoint part record"));}}
        Ok(())
    }
    async fn initialize_multipart(&self,profile:&str,revision:&str,context:&ResolvedBucketContext,key:&str,source:SourceFingerprint,options:&MultipartOptions,size:u64,control:&MultipartControl)->Result<MultipartCheckpoint,QiniuError>{
        let endpoint=self.multipart_endpoint(context)?;
        let value=self.multipart_request(context,key,options,Method::POST,self.multipart_url(&endpoint,&context.bucket.name,key,None,None)?,vec![],false,Some(control)).await?;
        let upload_id=value.get("uploadId").and_then(Value::as_str).filter(|id|safe_id(id)).ok_or_else(||invalid("初始化响应缺少有效 uploadId / Multipart initialization returned no valid upload ID"))?.to_string();
        let expire_at=value.get("expireAt").and_then(Value::as_i64).filter(|expiry|*expiry>now()&&*expiry<=now()+8*24*3600).ok_or_else(||invalid("初始化响应缺少有效过期时间 / Multipart initialization returned no valid expiration"))?;
        Ok(MultipartCheckpoint{format_version:1,profile_id:profile.into(),profile_revision:revision.into(),bucket:context.bucket.name.clone(),key:key.into(),endpoint:endpoint.as_str().trim_end_matches('/').into(),region:context.region.s3_region_id.clone(),source,options:options.clone(),upload_id,expire_at,part_size:size,parts:vec![],phase:MultipartPhase::Uploading})
    }
    pub async fn list_multipart_parts(&self,context:&ResolvedBucketContext,checkpoint:&MultipartCheckpoint,control:&MultipartControl)->Result<Vec<MultipartPart>,QiniuError>{
        if checkpoint.expire_at<=now(){return Err(error("upload-expired","上传会话已过期，请明确重新开始上传 / Multipart session expired; start a new upload explicitly"));}
        let endpoint=self.multipart_endpoint(context)?;if checkpoint.bucket!=context.bucket.name||checkpoint.endpoint!=endpoint.as_str().trim_end_matches('/'){return Err(invalid("断点不属于当前上传服务 / Checkpoint belongs to another upload endpoint"));}
        let mut marker=0u16;let mut result=Vec::new();let mut seen=HashSet::new();
        for _ in 0..=MAX_PARTS {
            control.check()?;let mut url=self.multipart_url(&endpoint,&checkpoint.bucket,&checkpoint.key,Some(&checkpoint.upload_id),None)?;
            {let mut query=url.query_pairs_mut();query.append_pair("max-parts","1000");if marker>0{query.append_pair("part-number-marker",&marker.to_string());}}
            let value=self.multipart_request(context,&checkpoint.key,&checkpoint.options,Method::GET,url,vec![],false,Some(control)).await?;
            if value.get("uploadId").and_then(Value::as_str)!=Some(checkpoint.upload_id.as_str())||value.get("expireAt").and_then(Value::as_i64).is_none_or(|expiry|expiry<=now()||expiry>checkpoint.expire_at){return Err(invalid("服务端分片会话与断点不匹配或已过期 / Server multipart session mismatches the checkpoint"));}
            let parts=value.get("parts").and_then(Value::as_array).filter(|parts|parts.len()<=1000).ok_or_else(||invalid("服务端分片列表格式无效 / Invalid server part list"))?;
            let mut last=marker;
            for part in parts {
                let number=part.get("partNumber").and_then(Value::as_u64).and_then(|number|u16::try_from(number).ok()).filter(|number|*number>marker&&*number<=MAX_PARTS).ok_or_else(||invalid("服务端分片编号无效 / Invalid server part number"))?;
                let size=part.get("size").and_then(Value::as_u64).ok_or_else(||invalid("服务端分片大小无效 / Invalid server part size"))?;
                let etag=part.get("etag").and_then(Value::as_str).filter(|etag|!etag.is_empty()&&etag.len()<=1024&&!etag.contains(['\r','\n'])).ok_or_else(||invalid("服务端分片标识无效 / Invalid server part ETag"))?;
                if number<=last||!seen.insert(number)||number as u64>checkpoint.source.size.div_ceil(checkpoint.part_size)||size!=expected_part_size(checkpoint,number){return Err(invalid("服务端分片顺序或大小与来源不匹配 / Server part order or size differs from the source"));}
                last=number;result.push(MultipartPart{part_number:number,etag:etag.into(),size,sha256:String::new()});
            }
            let next=value.get("partNumberMarker").and_then(Value::as_u64).and_then(|number|u16::try_from(number).ok()).filter(|number|*number<=MAX_PARTS).ok_or_else(||invalid("服务端分片分页标识无效 / Invalid server part marker"))?;
            if next==0{return Ok(result);}if next<=marker||next<last{return Err(invalid("服务端重复或倒退分页标识 / Server part marker repeated or moved backwards"));}marker=next;
        }
        Err(invalid("服务端分片分页超过上限 / Server part pagination limit exceeded"))
    }
    pub async fn abort_multipart(&self,context:&ResolvedBucketContext,checkpoint:&MultipartCheckpoint)->Result<(),QiniuError>{
        if checkpoint.phase==MultipartPhase::Cancelled{return Ok(());}
        if matches!(checkpoint.phase,MultipartPhase::Completing|MultipartPhase::Completed){return Err(error("completion-uncertain","完成提交已开始，不能盲目终止会话或删除对象 / Completion has started; do not abort or delete blindly"));}
        let endpoint=self.multipart_endpoint(context)?;if checkpoint.bucket!=context.bucket.name||checkpoint.endpoint!=endpoint.as_str().trim_end_matches('/'){return Err(invalid("断点不属于当前上传服务 / Checkpoint belongs to another upload endpoint"));}
        if checkpoint.expire_at<=now(){return Ok(());}
        self.multipart_request(context,&checkpoint.key,&checkpoint.options,Method::DELETE,self.multipart_url(&endpoint,&checkpoint.bucket,&checkpoint.key,Some(&checkpoint.upload_id),None)?,vec![],false,None).await?;Ok(())
    }
    async fn stopped<F:FnMut(&MultipartCheckpoint)->Result<(),QiniuError>>(&self,context:&ResolvedBucketContext,mut checkpoint:MultipartCheckpoint,control:&MultipartControl,save:&mut F,failure:QiniuError)->MultipartOutcome{
        if control.is_cancelled(){
            if let Err(error)=save(&checkpoint){return MultipartOutcome::Interrupted{checkpoint,error};}
            match self.abort_multipart(context,&checkpoint).await{Ok(())=>{checkpoint.phase=MultipartPhase::Cancelled;match save(&checkpoint){Ok(())=>MultipartOutcome::Cancelled{checkpoint},Err(error)=>MultipartOutcome::Interrupted{checkpoint,error}}},Err(error)=>MultipartOutcome::Interrupted{checkpoint,error}}
        }
        else if control.is_paused(){match save(&checkpoint){Ok(())=>MultipartOutcome::Paused{checkpoint},Err(error)=>MultipartOutcome::Interrupted{checkpoint,error}}}
        else{MultipartOutcome::Interrupted{checkpoint,error:failure}}
    }
    async fn reconcile_multipart<F:FnMut(&MultipartCheckpoint)->Result<(),QiniuError>>(&self,context:&ResolvedBucketContext,key:&str,mut checkpoint:MultipartCheckpoint,save:&mut F)->MultipartOutcome{
        // Completion is a remote transaction. Neither local-source existence,
        // cancellation nor an expired upload lease can authorize replaying or
        // aborting it. Reconcile the immutable expected size/hash by read only.
        match self.stat(context,key).await {
            Ok(object) if object.size==checkpoint.source.size&&object.etag==checkpoint.source.qiniu_etag=>{
                checkpoint.phase=MultipartPhase::Completed;
                match save(&checkpoint){Ok(())=>MultipartOutcome::Completed{bytes:object.size,checkpoint},Err(error)=>MultipartOutcome::Interrupted{checkpoint,error}}
            },
            _=>MultipartOutcome::Interrupted{checkpoint,error:error("completion-uncertain","无法确认上次完成提交，禁止自动重传或删除目标 / Previous completion is uncertain; do not retry or delete automatically")},
        }
    }
    /// Cancel an already-persisted session without requiring the local file.
    /// An expired Uploading lease is cancelled locally because it is no longer
    /// resumable; no object-delete request is ever made. A Completing session
    /// is only reconciled by stat, even when the explicit action was cancel.
    pub async fn cancel_file_multipart<F>(&self,profile_id:&str,profile_revision:&str,context:&ResolvedBucketContext,key:&str,options:&MultipartOptions,mut checkpoint:MultipartCheckpoint,mut on_checkpoint:F)->Result<MultipartOutcome,QiniuError>
    where F:FnMut(&MultipartCheckpoint)->Result<(),QiniuError>{
        if profile_id.is_empty()||profile_revision.is_empty()||profile_id.len()>512||profile_revision.len()>512{return Err(invalid("上传账号标识无效 / Invalid upload profile identity"));}
        validate_options(options)?;
        self.validate_checkpoint(profile_id,profile_revision,context,key,options,&checkpoint)?;
        let _lease=UploadLease::acquire(profile_id,profile_revision,&context.bucket.name,key)?;
        if matches!(checkpoint.phase,MultipartPhase::Completing|MultipartPhase::Completed){
            return Ok(self.reconcile_multipart(context,key,checkpoint,&mut on_checkpoint).await);
        }
        if let Err(error)=on_checkpoint(&checkpoint){return Ok(MultipartOutcome::Interrupted{checkpoint,error});}
        if checkpoint.phase==MultipartPhase::Cancelled{return Ok(MultipartOutcome::Cancelled{checkpoint});}
        match self.abort_multipart(context,&checkpoint).await {
            Ok(())=>{
                checkpoint.phase=MultipartPhase::Cancelled;
                Ok(match on_checkpoint(&checkpoint){Ok(())=>MultipartOutcome::Cancelled{checkpoint},Err(error)=>MultipartOutcome::Interrupted{checkpoint,error}})
            },
            Err(error)=>Ok(MultipartOutcome::Interrupted{checkpoint,error}),
        }
    }
    /// The caller must persist each checkpoint atomically and exhaustively
    /// handle the outcome enum. Only Completed means a committed object.
    /// Resume contexts never issue another Complete when the preceding commit
    /// might already have succeeded: they first verify the remote object.
    pub async fn upload_file_multipart<F,P>(&self,profile_id:&str,profile_revision:&str,context:&ResolvedBucketContext,key:&str,path:&Path,options:&MultipartOptions,resume:Option<MultipartCheckpoint>,control:&MultipartControl,on_checkpoint:F,on_progress:P)->Result<MultipartOutcome,QiniuError>
    where F:FnMut(&MultipartCheckpoint)->Result<(),QiniuError>,P:FnMut(u64,u64){
        self.upload_file_multipart_inner(profile_id,profile_revision,context,key,path,options,None,resume,control,on_checkpoint,on_progress).await
    }
    /// Bind the runner to the full fingerprint captured for the user's queued
    /// task, not merely to a path that might now contain different bytes.
    pub async fn upload_file_multipart_bound<F,P>(&self,profile_id:&str,profile_revision:&str,context:&ResolvedBucketContext,key:&str,path:&Path,options:&MultipartOptions,expected_source:&SourceFingerprint,resume:Option<MultipartCheckpoint>,control:&MultipartControl,on_checkpoint:F,on_progress:P)->Result<MultipartOutcome,QiniuError>
    where F:FnMut(&MultipartCheckpoint)->Result<(),QiniuError>,P:FnMut(u64,u64){
        self.upload_file_multipart_inner(profile_id,profile_revision,context,key,path,options,Some(expected_source),resume,control,on_checkpoint,on_progress).await
    }
    async fn upload_file_multipart_inner<F,P>(&self,profile_id:&str,profile_revision:&str,context:&ResolvedBucketContext,key:&str,path:&Path,options:&MultipartOptions,expected_source:Option<&SourceFingerprint>,resume:Option<MultipartCheckpoint>,control:&MultipartControl,mut on_checkpoint:F,mut on_progress:P)->Result<MultipartOutcome,QiniuError>
    where F:FnMut(&MultipartCheckpoint)->Result<(),QiniuError>,P:FnMut(u64,u64){
        if profile_id.is_empty()||profile_revision.is_empty()||profile_id.len()>512||profile_revision.len()>512{return Err(invalid("上传账号标识无效 / Invalid upload profile identity"));}
        validate_options(options)?;self.multipart_endpoint(context)?;
        if let Some(kind)=options.file_type{if !context.region.storage_classes.iter().any(|supported|supported.file_type==kind){return Err(QiniuError::unsupported("区域未确认支持所选存储类型 / Region does not support the selected storage type"));}}
        let _lease=UploadLease::acquire(profile_id,profile_revision,&context.bucket.name,key)?;
        if let Some(checkpoint)=&resume{
            self.validate_checkpoint(profile_id,profile_revision,context,key,options,checkpoint)?;
            if expected_source.is_some_and(|expected|expected!=&checkpoint.source){return Err(error("source-changed","断点与已排队来源身份不一致，拒绝续传 / Checkpoint differs from the queued source identity"));}
            if matches!(checkpoint.phase,MultipartPhase::Completing|MultipartPhase::Completed){
                return Ok(self.reconcile_multipart(context,key,checkpoint.clone(),&mut on_checkpoint).await);
            }
            if checkpoint.phase==MultipartPhase::Cancelled{return Err(error("cancelled","断点已被明确取消，不能继续使用 / This upload checkpoint was cancelled"));}
        }
        if let Some(checkpoint)=resume.as_ref().filter(|_|control.is_cancelled()){return Ok(self.stopped(context,checkpoint.clone(),control,&mut on_checkpoint,error("cancelled","上传已取消 / Upload cancelled")).await);}
        if let Some(checkpoint)=resume.as_ref().filter(|_|control.is_paused()){
            return Ok(match on_checkpoint(checkpoint){Ok(())=>MultipartOutcome::Paused{checkpoint:checkpoint.clone()},Err(error)=>MultipartOutcome::Interrupted{checkpoint:checkpoint.clone(),error}});
        }
        let source=fingerprint_source(path,control).await?;
        if expected_source.is_some_and(|expected|expected!=&source){return Err(error("source-changed","来源文件与排队时的完整指纹不一致，未初始化上传 / Upload source differs from the queued fingerprint; no upload was initialized"));}
        let mut checkpoint=match resume {
            Some(checkpoint)=>{if checkpoint.source!=source{return Err(error("source-changed","来源文件与断点的完整指纹不一致，拒绝续传 / Upload source fingerprint differs from the checkpoint"));}checkpoint},
            None=>{let size=part_size(source.size,options.part_size)?;self.initialize_multipart(profile_id,profile_revision,context,key,source,options,size,control).await?},
        };
        if checkpoint.expire_at<=now(){return Err(error("upload-expired","上传会话已过期，请明确重新开始上传 / Multipart session expired; start a new upload explicitly"));}
        if let Err(error)=on_checkpoint(&checkpoint){return Ok(MultipartOutcome::Interrupted{checkpoint,error});}
        let mut checkpoint_write_failed=false;
        let execution:Result<(),QiniuError>=async {
            let server=self.list_multipart_parts(context,&checkpoint,control).await?;
            checkpoint.parts.retain(|part|server.iter().any(|remote|remote.part_number==part.part_number&&remote.etag==part.etag&&remote.size==part.size));
            if let Err(error)=on_checkpoint(&checkpoint){checkpoint_write_failed=true;return Err(error);}
            let mut committed=checkpoint.parts.iter().map(|part|part.size).sum();on_progress(committed,checkpoint.source.size);
            let mut file=tokio::fs::File::open(&checkpoint.source.canonical_path).await.map_err(|_|local_error())?;
            let count=checkpoint.source.size.div_ceil(checkpoint.part_size);
            for number in 1..=count as u16 {
                control.check()?;let expected=expected_part_size(&checkpoint,number);
                file.seek(std::io::SeekFrom::Start((number as u64-1)*checkpoint.part_size)).await.map_err(|_|local_error())?;
                let mut bytes=vec![0u8;expected as usize];file.read_exact(&mut bytes).await.map_err(|_|local_error())?;
                let sha256=hex(Sha256::digest(&bytes));
                if let Some(part)=checkpoint.parts.iter().find(|part|part.part_number==number){if part.sha256!=sha256{return Err(error("source-changed","断点分片与来源内容不一致 / Source part differs from checkpoint"));}continue;}
                let endpoint=self.multipart_endpoint(context)?;
                let value=self.multipart_request(context,key,options,Method::PUT,self.multipart_url(&endpoint,&checkpoint.bucket,key,Some(&checkpoint.upload_id),Some(number))?,bytes,false,Some(control)).await?;
                let etag=value.get("etag").and_then(Value::as_str).filter(|etag|!etag.is_empty()&&etag.len()<=1024&&!etag.contains(['\r','\n'])).ok_or_else(||invalid("上传分片缺少有效 ETag / Uploaded part returned no valid ETag"))?;
                checkpoint.parts.push(MultipartPart{part_number:number,etag:etag.into(),size:expected,sha256});checkpoint.parts.sort_by_key(|part|part.part_number);
                if let Err(error)=on_checkpoint(&checkpoint){checkpoint_write_failed=true;return Err(error);}committed+=expected;on_progress(committed,checkpoint.source.size);
            }
            let after=fingerprint_source(path,control).await?;if after!=checkpoint.source{return Err(error("source-changed","完成前来源文件发生变化，已上传分片保留 / Source changed before completion; uploaded parts retained"));}control.check()?;Ok(())
        }.await;
        if let Err(error)=execution{
            if checkpoint_write_failed{return Ok(MultipartOutcome::Interrupted{checkpoint,error});}
            return Ok(self.stopped(context,checkpoint,control,&mut on_checkpoint,error).await);
        }
        checkpoint.phase=MultipartPhase::Completing;
        if let Err(error)=on_checkpoint(&checkpoint){return Ok(MultipartOutcome::Interrupted{checkpoint,error});}
        // Committing is deliberately non-interruptible. A cancellation racing
        // with Complete must never trigger a blind Abort or delete the object.
        let endpoint=self.multipart_endpoint(context)?;
        let metadata: BTreeMap<String,String>=options.metadata.iter().map(|(name,value)|(if name.starts_with("x-qn-meta-"){name.clone()}else{format!("x-qn-meta-{name}")},value.clone())).collect();
        let mut payload=json!({"parts":checkpoint.parts.iter().map(|part|json!({"partNumber":part.part_number,"etag":part.etag})).collect::<Vec<_>>(),"fname":path.file_name().map(|name|name.to_string_lossy().into_owned()).unwrap_or_default(),"metadata":metadata});
        if let Some(mime)=&options.mime_type{payload["mimeType"]=mime.clone().into();}
        let response=self.multipart_request(context,key,options,Method::POST,self.multipart_url(&endpoint,&checkpoint.bucket,key,Some(&checkpoint.upload_id),None)?,serde_json::to_vec(&payload).map_err(|_|invalid("完成请求编码失败 / Could not encode multipart completion"))?,true,None).await;
        match response {
            Ok(value)if value.get("key").and_then(Value::as_str)==Some(key)&&value.get("hash").and_then(Value::as_str)==Some(checkpoint.source.qiniu_etag.as_str())=>{
                checkpoint.phase=MultipartPhase::Completed;match on_checkpoint(&checkpoint){Ok(())=>Ok(MultipartOutcome::Completed{bytes:checkpoint.source.size,checkpoint}),Err(error)=>Ok(MultipartOutcome::Interrupted{checkpoint,error})}
            },
            _=>Ok(MultipartOutcome::Interrupted{checkpoint,error:error("completion-uncertain","完成响应未确认或内容不匹配，禁止自动重传或删除目标 / Completion was not verified; do not retry or delete automatically")}),
        }
    }
}
fn expected_part_size(checkpoint:&MultipartCheckpoint,number:u16)->u64{checkpoint.part_size.min(checkpoint.source.size.saturating_sub((number as u64-1)*checkpoint.part_size))}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qiniu::{QiniuBucket,QiniuConfig,QiniuCredentials,QiniuMode,QiniuRegion};
    use std::{io::{Read,Write},net::TcpListener,sync::Arc,thread,time::Instant};
    struct Reply{status:u16,value:Value}
    fn ok(value:Value)->Reply{Reply{status:200,value}}
    struct Server{origin:String,requests:Arc<Mutex<Vec<Vec<u8>>>>,worker:Option<thread::JoinHandle<()>>}
    impl Drop for Server{fn drop(&mut self){if let Some(worker)=self.worker.take(){let _=worker.join();}}}
    fn server(replies:Vec<Reply>)->Server{
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();let origin=format!("http://{}",listener.local_addr().unwrap());let requests=Arc::new(Mutex::new(vec![]));let captured=requests.clone();
        let worker=thread::spawn(move||{
            for reply in replies {
                let deadline=Instant::now()+Duration::from_secs(4);
                let (mut connection,request)=loop{
                let mut connection=loop{match listener.accept(){Ok((connection,_))=>break connection,Err(error)if error.kind()==std::io::ErrorKind::WouldBlock&&Instant::now()<deadline=>thread::sleep(Duration::from_millis(5)),_=>return}};
                connection.set_nonblocking(false).unwrap();connection.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request=Vec::new();let mut buffer=[0u8;16*1024];
                loop {
                    let read=match connection.read(&mut buffer){Ok(count)if count>0=>count,_=>break};request.extend_from_slice(&buffer[..read]);
                    if let Some(split)=request.windows(4).position(|bytes|bytes==b"\r\n\r\n"){
                        let headers=String::from_utf8_lossy(&request[..split]);let size=headers.lines().find_map(|line|{let(name,value)=line.split_once(':')?;if name.eq_ignore_ascii_case("content-length"){value.trim().parse::<usize>().ok()}else{None}}).unwrap_or(0);
                        if request.len()>=split+4+size{break;}
                    }
                    assert!(request.len()<70*1024*1024);
                }
                if request.is_empty(){if Instant::now()>=deadline{return}continue;}
                break (connection,request);
                };
                captured.lock().unwrap().push(request);
                let body=serde_json::to_vec(&reply.value).unwrap();let mut response=format!("HTTP/1.0 {} Mock\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",reply.status,body.len()).into_bytes();response.extend(body);let _=connection.write_all(&response);let _=connection.shutdown(std::net::Shutdown::Write);
            }
        });Server{origin,requests,worker:Some(worker)}
    }
    fn runtime()->&'static tokio::runtime::Runtime{static RUNTIME:OnceLock<tokio::runtime::Runtime>=OnceLock::new();RUNTIME.get_or_init(||tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap())}
    fn client(server:&Server)->QiniuClient{
        let _enter=runtime().enter();let mut client=QiniuClient::new(QiniuConfig{mode:QiniuMode::Private,uc_url:Some(server.origin.clone()),..Default::default()},QiniuCredentials::new("multipart-fixture-ak".into(),"multipart-fixture-secret".into(),None).unwrap()).unwrap();
        client.http=reqwest::Client::builder().no_proxy().http1_only().pool_max_idle_per_host(0).redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(5)).build().unwrap();client
    }
    fn context(server:&Server)->ResolvedBucketContext{
        let host=server.origin.trim_start_matches("http://");let region=QiniuRegion::from_response(&json!({"region":"z0","ttl":60,"up":{"domains":[host]},"rs":{"domains":[host]},"s3":{"region_alias":"cn-east-1","domains":[host]}}),"http",now()).unwrap();
        ResolvedBucketContext{bucket:QiniuBucket{name:"native-bucket".into(),s3_name:Some("s3-alias".into()),kodo_region_id:Some("z0".into()),created_at:None,permission:None,remark:None},s3_bucket_name:Some("s3-alias".into()),region,backend_mode:"kodo".into()}
    }
    struct FileFixture{path:std::path::PathBuf,profile:String}
    impl FileFixture{fn new(bytes:&[u8])->Self{let id=uuid::Uuid::new_v4().simple().to_string();let path=std::env::temp_dir().join(format!("qiniu-multipart-{id}"));std::fs::write(&path,bytes).unwrap();Self{path,profile:id}}}
    impl Drop for FileFixture{fn drop(&mut self){let _=std::fs::remove_file(&self.path);}}
    fn hash(bytes:&[u8])->String{let mut hash=QiniuEtag::default();hash.update(bytes);hash.finish()}
    fn list(expiry:i64,parts:Value,marker:u16)->Reply{ok(json!({"uploadId":"fixture-upload","expireAt":expiry,"parts":parts,"partNumberMarker":marker}))}
    fn checkpoint(server:&Server,file:&FileFixture,options:&MultipartOptions)->MultipartCheckpoint{
        let source=runtime().block_on(fingerprint_source(&file.path,&MultipartControl::default())).unwrap();
        MultipartCheckpoint{format_version:1,profile_id:file.profile.clone(),profile_revision:"revision-1".into(),bucket:"native-bucket".into(),key:"中文/+%?#.bin".into(),endpoint:server.origin.clone(),region:"cn-east-1".into(),part_size:part_size(source.size,options.part_size).unwrap(),source,options:options.clone(),upload_id:"fixture-upload".into(),expire_at:now()+6*24*3600,parts:vec![],phase:MultipartPhase::Uploading}
    }
    fn request_line(request:&[u8])->String{String::from_utf8_lossy(request).lines().next().unwrap().to_string()}
    fn request_body(request:&[u8])->&[u8]{let split=request.windows(4).position(|bytes|bytes==b"\r\n\r\n").unwrap();&request[split+4..]}

    #[test]fn multipart_bounds_options_and_concurrent_target_are_explicit(){
        assert_eq!(part_size(6*1024*1024+1,None).unwrap(),DEFAULT_PART_SIZE);assert!(part_size(0,None).is_err());assert!(part_size(u64::MAX,None).is_err());assert!(part_size(20*1024*1024,Some(512*1024)).is_err());
        let mut options=MultipartOptions::default();options.metadata.insert("same".into(),"a".into());options.metadata.insert("x-qn-meta-same".into(),"b".into());assert!(validate_options(&options).is_err());
        let id=uuid::Uuid::new_v4().simple().to_string();let lease=UploadLease::acquire(&id,"revision-1","bucket","key").unwrap();assert!(UploadLease::acquire(&id,"revision-2","bucket","key").is_err());drop(lease);assert!(UploadLease::acquire(&id,"revision-2","bucket","key").is_ok());
    }
    #[test]fn source_fingerprint_detects_same_size_content_changes(){
        let file=FileFixture::new(b"same-size-A");let control=MultipartControl::default();let before=runtime().block_on(fingerprint_source(&file.path,&control)).unwrap();std::fs::write(&file.path,b"same-size-B").unwrap();let after=runtime().block_on(fingerprint_source(&file.path,&control)).unwrap();assert_eq!(before.size,after.size);assert_ne!(before.sha256,after.sha256);assert_ne!(before.qiniu_etag,after.qiniu_etag);
    }
    #[test]fn large_file_pause_serialized_resume_lists_server_parts_and_reuploads_unknown(){
        let bytes=vec![0x5au8;6*1024*1024+17];let expiry=now()+6*24*3600;
        let server=server(vec![ok(json!({"uploadId":"fixture-upload","expireAt":expiry})),list(expiry,json!([]),0),ok(json!({"etag":"server-part-1"})),list(expiry,json!([{"partNumber":1,"size":2*1024*1024,"etag":"server-part-1"}]),1),list(expiry,json!([{"partNumber":2,"size":2*1024*1024,"etag":"unrecorded-part-2"}]),0),ok(json!({"etag":"server-part-2"})),ok(json!({"etag":"server-part-3"})),ok(json!({"etag":"server-part-4"})),ok(json!({"key":"中文/+%?#.bin","hash":hash(&bytes)}))]);
        let file=FileFixture::new(&bytes);let options=MultipartOptions{part_size:Some(2*1024*1024),mime_type:Some("application/octet-stream".into()),metadata:BTreeMap::from([("caption".into(),"中文说明".into())]),..Default::default()};let control=MultipartControl::default();let ctx=context(&server);let client=client(&server);
        let first=runtime().block_on(client.upload_file_multipart(&file.profile,"revision-1",&ctx,"中文/+%?#.bin",&file.path,&options,None,&control,|checkpoint|{if checkpoint.parts.len()==1{control.pause();}Ok(())},|_,_|{})).unwrap();
        let saved=match first{MultipartOutcome::Paused{checkpoint}=>checkpoint,other=>panic!("expected pause, got {other:?}")};assert_eq!(saved.parts.len(),1);assert_eq!(saved.phase,MultipartPhase::Uploading);
        let serialized=serde_json::to_vec(&saved).unwrap();let text=String::from_utf8_lossy(&serialized);for secret in ["multipart-fixture-ak","multipart-fixture-secret","UpToken","Authorization"]{assert!(!text.contains(secret));}
        let restored=serde_json::from_slice(&serialized).unwrap();control.resume();let mut progress=vec![];
        let outcome=runtime().block_on(client.upload_file_multipart(&file.profile,"revision-1",&ctx,"中文/+%?#.bin",&file.path,&options,Some(restored),&control,|_|Ok(()),|done,total|progress.push((done,total)))).unwrap();
        let completed=match outcome{MultipartOutcome::Completed{bytes:count,checkpoint}=>{assert_eq!(count,bytes.len() as u64);checkpoint},other=>panic!("expected verified completion, got {other:?}")};assert_eq!(completed.parts.len(),4);assert_eq!(completed.phase,MultipartPhase::Completed);assert_eq!(progress.last(),Some(&(bytes.len() as u64,bytes.len() as u64)));
        let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),9);let lines=requests.iter().map(|request|request_line(request)).collect::<Vec<_>>();assert_eq!(lines.iter().filter(|line|line.starts_with("PUT ")&&line.contains("/fixture-upload/1 ")).count(),1);assert!(lines[4].contains("part-number-marker=1"));assert!(lines[5].contains("/fixture-upload/2 "));
        let complete:Value=serde_json::from_slice(request_body(requests.last().unwrap())).unwrap();assert_eq!(complete["parts"][1]["etag"],"server-part-2");assert_eq!(complete["metadata"]["x-qn-meta-caption"],"中文说明");
    }
    #[test]fn pause_and_transport_error_do_not_abort_uploaded_session(){
        let expiry=now()+6*24*3600;let server=server(vec![ok(json!({"uploadId":"fixture-upload","expireAt":expiry})),list(expiry,json!([]),0),Reply{status:500,value:json!({"error":"mock-server-detail"})}]);let file=FileFixture::new(b"payload");let client=client(&server);let ctx=context(&server);let control=MultipartControl::default();
        let outcome=runtime().block_on(client.upload_file_multipart(&file.profile,"revision-1",&ctx,"中文/+%?#.bin",&file.path,&MultipartOptions::default(),None,&control,|_|Ok(()),|_,_|{})).unwrap();match outcome{MultipartOutcome::Interrupted{checkpoint,error}=>{assert_eq!(checkpoint.upload_id,"fixture-upload");assert_eq!(checkpoint.phase,MultipartPhase::Uploading);assert!(!error.to_string().contains("mock-server-detail"));},other=>panic!("unexpected {other:?}")};assert!(!server.requests.lock().unwrap().iter().any(|request|request_line(request).starts_with("DELETE ")));
    }
    #[test]fn explicit_cancel_sends_abort_and_never_complete(){
        let expiry=now()+6*24*3600;let server=server(vec![ok(json!({"uploadId":"fixture-upload","expireAt":expiry})),ok(Value::Null)]);let file=FileFixture::new(b"payload");let client=client(&server);let ctx=context(&server);let control=MultipartControl::default();
        let outcome=runtime().block_on(client.upload_file_multipart(&file.profile,"revision-1",&ctx,"中文/+%?#.bin",&file.path,&MultipartOptions::default(),None,&control,|_|{control.cancel();Ok(())},|_,_|{})).unwrap();assert!(matches!(outcome,MultipartOutcome::Cancelled{..}));let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),2);assert!(request_line(&requests[1]).starts_with("DELETE "));
    }
    #[test]fn changed_source_rejects_resume_before_any_upload_request(){
        let server=server(vec![]);let file=FileFixture::new(b"original");let client=client(&server);let ctx=context(&server);let options=MultipartOptions::default();let cp=checkpoint(&server,&file,&options);std::fs::write(&file.path,b"modified").unwrap();
        let error=runtime().block_on(client.upload_file_multipart(&file.profile,"revision-1",&ctx,"中文/+%?#.bin",&file.path,&options,Some(cp),&MultipartControl::default(),|_|Ok(()),|_,_|{})).unwrap_err();assert_eq!(error.code,"source-changed");assert!(server.requests.lock().unwrap().is_empty());
    }
    #[test]fn server_marker_and_part_size_are_rechecked_not_trusted(){
        let expiry=now()+6*24*3600;let server=server(vec![list(expiry,json!([{"partNumber":1,"size":4,"etag":"bad-size"}]),0)]);let file=FileFixture::new(b"payload");let options=MultipartOptions::default();let mut cp=checkpoint(&server,&file,&options);cp.expire_at=expiry;
        assert!(runtime().block_on(client(&server).list_multipart_parts(&context(&server),&cp,&MultipartControl::default())).is_err());
    }
    #[test]fn completion_cancel_race_returns_verified_commit_without_abort(){
        let data=b"payload";let expiry=now()+6*24*3600;let server=server(vec![ok(json!({"uploadId":"fixture-upload","expireAt":expiry})),list(expiry,json!([]),0),ok(json!({"etag":"part-1"})),ok(json!({"key":"中文/+%?#.bin","hash":hash(data)}))]);let file=FileFixture::new(data);let control=MultipartControl::default();
        let outcome=runtime().block_on(client(&server).upload_file_multipart(&file.profile,"revision-1",&context(&server),"中文/+%?#.bin",&file.path,&MultipartOptions::default(),None,&control,|cp|{if cp.phase==MultipartPhase::Completing{control.cancel();}Ok(())},|_,_|{})).unwrap();assert!(matches!(outcome,MultipartOutcome::Completed{..}));assert!(!server.requests.lock().unwrap().iter().any(|request|request_line(request).starts_with("DELETE ")));
    }
    #[test]fn uncertain_completion_resume_only_checks_object_and_never_reposts_or_deletes(){
        let server=server(vec![Reply{status:403,value:json!({"error":"no-stat-permission"})}]);let file=FileFixture::new(b"payload");let options=MultipartOptions::default();let mut cp=checkpoint(&server,&file,&options);cp.phase=MultipartPhase::Completing;
        let outcome=runtime().block_on(client(&server).upload_file_multipart(&file.profile,"revision-1",&context(&server),"中文/+%?#.bin",&file.path,&options,Some(cp),&MultipartControl::default(),|_|Ok(()),|_,_|{})).unwrap();assert!(matches!(outcome,MultipartOutcome::Interrupted{error:QiniuError{ref code,..},..} if code=="completion-uncertain"));let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),1);assert!(request_line(&requests[0]).starts_with("GET /stat/"));
    }
    #[test]fn bound_queued_source_mismatch_is_rejected_before_initialization(){
        let server=server(vec![]);let file=FileFixture::new(b"queued-A");let options=MultipartOptions::default();
        let expected=runtime().block_on(fingerprint_source(&file.path,&MultipartControl::default())).unwrap();
        std::fs::write(&file.path,b"queued-B").unwrap();
        let error=runtime().block_on(client(&server).upload_file_multipart_bound(&file.profile,"revision-1",&context(&server),"中文/+%?#.bin",&file.path,&options,&expected,None,&MultipartControl::default(),|_|Ok(()),|_,_|{})).unwrap_err();
        assert_eq!(error.code,"source-changed");assert!(server.requests.lock().unwrap().is_empty());
    }
    #[test]fn completing_resume_succeeds_by_stat_even_after_the_local_source_was_removed(){
        let bytes=b"payload";let server=server(vec![ok(json!({"fsize":bytes.len(),"hash":hash(bytes)}))]);
        let file=FileFixture::new(bytes);let options=MultipartOptions::default();let mut cp=checkpoint(&server,&file,&options);cp.phase=MultipartPhase::Completing;let expected=cp.source.clone();
        std::fs::remove_file(&file.path).unwrap();let mut saved=vec![];
        let outcome=runtime().block_on(client(&server).upload_file_multipart_bound(&file.profile,"revision-1",&context(&server),"中文/+%?#.bin",&file.path,&options,&expected,Some(cp),&MultipartControl::default(),|checkpoint|{saved.push(checkpoint.phase);Ok(())},|_,_|panic!("stat reconciliation has no upload progress"))).unwrap();
        assert!(matches!(outcome,MultipartOutcome::Completed{bytes:7,..}));assert_eq!(saved,vec![MultipartPhase::Completed]);
        let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),1);assert!(request_line(&requests[0]).starts_with("GET /stat/"));
    }
    #[test]fn missing_source_and_uncertain_completion_never_reinitializes_or_aborts(){
        let server=server(vec![Reply{status:403,value:json!({"error":"unavailable fixture detail"})}]);
        let file=FileFixture::new(b"payload");let options=MultipartOptions::default();let mut cp=checkpoint(&server,&file,&options);cp.phase=MultipartPhase::Completing;cp.expire_at=now()-1;
        std::fs::remove_file(&file.path).unwrap();
        let outcome=runtime().block_on(client(&server).upload_file_multipart(&file.profile,"revision-1",&context(&server),"中文/+%?#.bin",&file.path,&options,Some(cp),&MultipartControl::default(),|_|Ok(()),|_,_|{})).unwrap();
        assert!(matches!(outcome,MultipartOutcome::Interrupted{checkpoint:MultipartCheckpoint{phase:MultipartPhase::Completing,..},error:QiniuError{ref code,..}} if code=="completion-uncertain"));
        let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),1);assert!(request_line(&requests[0]).starts_with("GET /stat/"));
    }
    #[test]fn cancelled_suspended_upload_aborts_without_opening_local_source(){
        let server=server(vec![ok(Value::Null)]);let file=FileFixture::new(b"payload");let options=MultipartOptions::default();let cp=checkpoint(&server,&file,&options);
        std::fs::remove_file(&file.path).unwrap();let mut saved=vec![];
        let outcome=runtime().block_on(client(&server).cancel_file_multipart(&file.profile,"revision-1",&context(&server),"中文/+%?#.bin",&options,cp,|checkpoint|{saved.push(checkpoint.phase);Ok(())})).unwrap();
        assert!(matches!(outcome,MultipartOutcome::Cancelled{checkpoint:MultipartCheckpoint{phase:MultipartPhase::Cancelled,..}}));assert_eq!(saved,vec![MultipartPhase::Uploading,MultipartPhase::Cancelled]);
        let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),1);assert!(request_line(&requests[0]).starts_with("DELETE /buckets/"));assert!(request_line(&requests[0]).contains("/uploads/fixture-upload "));
    }
    #[test]fn cancelling_completing_upload_only_reconciles_and_never_aborts(){
        let server=server(vec![ok(json!({"fsize":7,"hash":hash(b"payload")}))]);let file=FileFixture::new(b"payload");let options=MultipartOptions::default();let mut cp=checkpoint(&server,&file,&options);cp.phase=MultipartPhase::Completing;
        std::fs::remove_file(&file.path).unwrap();
        let outcome=runtime().block_on(client(&server).cancel_file_multipart(&file.profile,"revision-1",&context(&server),"中文/+%?#.bin",&options,cp,|_|Ok(()))).unwrap();
        assert!(matches!(outcome,MultipartOutcome::Completed{..}));let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),1);assert!(request_line(&requests[0]).starts_with("GET /stat/"));
    }
    #[test]fn expired_uploading_cancel_is_local_and_never_deletes_the_object(){
        let server=server(vec![]);let file=FileFixture::new(b"payload");let options=MultipartOptions::default();let mut cp=checkpoint(&server,&file,&options);cp.expire_at=now()-1;
        std::fs::remove_file(&file.path).unwrap();
        let outcome=runtime().block_on(client(&server).cancel_file_multipart(&file.profile,"revision-1",&context(&server),"中文/+%?#.bin",&options,cp,|_|Ok(()))).unwrap();
        assert!(matches!(outcome,MultipartOutcome::Cancelled{..}));assert!(server.requests.lock().unwrap().is_empty());
    }
    #[test]fn abort_failure_keeps_suspended_session_interrupted_and_redacts_server_details(){
        let server=server(vec![Reply{status:500,value:json!({"error":"secret fixture detail"})}]);let file=FileFixture::new(b"payload");let options=MultipartOptions::default();let cp=checkpoint(&server,&file,&options);
        let outcome=runtime().block_on(client(&server).cancel_file_multipart(&file.profile,"revision-1",&context(&server),"中文/+%?#.bin",&options,cp,|_|Ok(()))).unwrap();
        match outcome{MultipartOutcome::Interrupted{checkpoint,error}=>{assert_eq!(checkpoint.phase,MultipartPhase::Uploading);assert_eq!(checkpoint.upload_id,"fixture-upload");assert!(!error.to_string().contains("secret fixture detail"));},other=>panic!("unexpected {other:?}")};
        let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),1);assert!(request_line(&requests[0]).starts_with("DELETE /buckets/"));
    }
    #[test]fn cancellation_checkpoint_failure_prevents_even_an_abort_request(){
        let server=server(vec![]);let file=FileFixture::new(b"payload");let options=MultipartOptions::default();let cp=checkpoint(&server,&file,&options);
        let outcome=runtime().block_on(client(&server).cancel_file_multipart(&file.profile,"revision-1",&context(&server),"中文/+%?#.bin",&options,cp,|_|Err(error("checkpoint-io","checkpoint storage failed")))).unwrap();
        assert!(matches!(outcome,MultipartOutcome::Interrupted{error:QiniuError{ref code,..},..} if code=="checkpoint-io"));assert!(server.requests.lock().unwrap().is_empty());
    }
    #[test]fn failing_part_checkpoint_does_not_follow_a_racing_cancel_with_network_writes(){
        let expiry=now()+6*24*3600;let server=server(vec![ok(json!({"uploadId":"fixture-upload","expireAt":expiry})),list(expiry,json!([]),0),ok(json!({"etag":"part-1"}))]);let file=FileFixture::new(b"payload");let options=MultipartOptions::default();let control=MultipartControl::default();
        let outcome=runtime().block_on(client(&server).upload_file_multipart(&file.profile,"revision-1",&context(&server),"中文/+%?#.bin",&file.path,&options,None,&control,|checkpoint|{if !checkpoint.parts.is_empty(){control.cancel();Err(error("checkpoint-io","checkpoint storage failed"))}else{Ok(())}},|_,_|{})).unwrap();
        assert!(matches!(outcome,MultipartOutcome::Interrupted{error:QiniuError{ref code,..},checkpoint:MultipartCheckpoint{phase:MultipartPhase::Uploading,..}} if code=="checkpoint-io"));
        let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),3);assert!(!requests.iter().any(|request|request_line(request).starts_with("DELETE ")));
    }
    #[test]fn failing_completing_checkpoint_prevents_commit_and_abort(){
        let expiry=now()+6*24*3600;let server=server(vec![ok(json!({"uploadId":"fixture-upload","expireAt":expiry})),list(expiry,json!([]),0),ok(json!({"etag":"part-1"}))]);let file=FileFixture::new(b"payload");let options=MultipartOptions::default();let control=MultipartControl::default();
        let outcome=runtime().block_on(client(&server).upload_file_multipart(&file.profile,"revision-1",&context(&server),"中文/+%?#.bin",&file.path,&options,None,&control,|checkpoint|{if checkpoint.phase==MultipartPhase::Completing{control.cancel();Err(error("checkpoint-io","checkpoint storage failed"))}else{Ok(())}},|_,_|{})).unwrap();
        assert!(matches!(outcome,MultipartOutcome::Interrupted{error:QiniuError{ref code,..},checkpoint:MultipartCheckpoint{phase:MultipartPhase::Completing,..}} if code=="checkpoint-io"));
        let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),3);assert_eq!(requests.iter().filter(|request|request_line(request).starts_with("POST ")).count(),1);
    }
    #[test]fn cancellation_rejects_another_revision_or_changed_metadata_before_network(){
        let server=server(vec![]);let file=FileFixture::new(b"payload");let options=MultipartOptions::default();let cp=checkpoint(&server,&file,&options);let client=client(&server);let ctx=context(&server);
        assert!(runtime().block_on(client.cancel_file_multipart(&file.profile,"another-revision",&ctx,"中文/+%?#.bin",&options,cp.clone(),|_|Ok(()))).is_err());
        let mut changed=options.clone();changed.metadata.insert("caption".into(),"changed".into());assert!(runtime().block_on(client.cancel_file_multipart(&file.profile,"revision-1",&ctx,"中文/+%?#.bin",&changed,cp,|_|Ok(()))).is_err());assert!(server.requests.lock().unwrap().is_empty());
    }
    #[test]fn bound_checkpoint_mismatch_rejects_before_stat_reconciliation(){
        let server=server(vec![]);let file=FileFixture::new(b"payload");let options=MultipartOptions::default();let mut cp=checkpoint(&server,&file,&options);cp.phase=MultipartPhase::Completing;let mut expected=cp.source.clone();expected.sha256="f".repeat(64);
        let error=runtime().block_on(client(&server).upload_file_multipart_bound(&file.profile,"revision-1",&context(&server),"中文/+%?#.bin",&file.path,&options,&expected,Some(cp),&MultipartControl::default(),|_|Ok(()),|_,_|{})).unwrap_err();assert_eq!(error.code,"source-changed");assert!(server.requests.lock().unwrap().is_empty());
    }
}
