//! Ephemeral, read-only directory-share sessions. This runtime never writes
//! credentials, share links, signed URLs or session records to disk.

use crate::qiniu::{self, share::{ShareOperation, ShareSessionStore}, QiniuConfig};
use aws_sdk_s3::{config::retry::RetryConfig, Client};
use aws_sdk_s3::error::{ProvideErrorMetadata,SdkError};
use chrono::Utc;
use futures_util::future::{select, Either};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, future::Future, fs, path::{Component, Path, PathBuf}, sync::{Arc, Mutex, Weak, atomic::{AtomicBool, Ordering}}, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PAGE_SIZE:i32=200;
const MAX_CURSORS:usize=256;
const MAX_CURSOR_HOPS:usize=4096;
const MAX_SAFE_SIZE:i64=9_007_199_254_740_991;

fn inactive()->String{"分享会话已关闭、锁定或过期，请重新登录 / Share session closed, locked or expired; sign in again".into()}
fn state_error()->String{"分享会话状态不可用 / Share session state unavailable".into()}
fn invalid_cursor()->String{"分享分页游标无效或不属于当前目录 / Share cursor is invalid or belongs to another directory".into()}
fn transport_error()->String{"分享存储请求失败，请检查服务权限、网络和有效期 / Share storage request failed; check permissions, network and expiry".into()}
fn local_error()->String{"无法写入下载临时文件；原目标未修改 / Could not write the download temporary file; original target preserved".into()}
fn changed()->String{"共享对象或本地临时文件已变化，未交付目标 / Shared object or local temporary file changed; target not delivered".into()}
fn storage_error<E>(error:&SdkError<E>)->String where E:ProvideErrorMetadata+std::error::Error+'static{
    let code=error.as_service_error().and_then(|e|e.code());let status=error.raw_response().map(|r|r.status().as_u16());
    let (kind,message)=match (code,status){
        (Some("ExpiredToken"|"InvalidToken"|"TokenRefreshRequired"),_)=>("share-token-expired","分享临时凭据无效或已过期，请重新登录 / Share temporary credentials invalid or expired; sign in again"),
        (Some("AccessDenied"|"Forbidden"|"Unauthorized"),_)|(_,Some(401|403))=>("share-storage-forbidden","没有访问此分享资源的权限 / Permission denied for this shared resource"),
        (Some("NoSuchBucket"|"NoSuchKey"|"NotFound"),_)|(_,Some(404))=>("share-storage-not-found","共享空间或对象不存在 / Shared bucket or object not found"),
        (_,Some(405|501))=>("share-storage-unsupported","此环境不支持所请求的分享读取接口 / This environment does not support the requested share read API"),
        (_,Some(429))=>("share-storage-throttled","分享请求过于频繁，请稍后重试 / Too many share requests; retry later"),
        _=>match error{
            SdkError::TimeoutError(_)=>("share-storage-timeout","分享存储请求超时 / Share storage request timed out"),
            SdkError::DispatchFailure(_)=>("share-storage-network","无法连接分享存储，请检查网络及证书 / Could not connect to share storage; check network and certificates"),
            SdkError::ConstructionFailure(_)=>("share-storage-request","分享读取请求无效 / Invalid share read request"),
            SdkError::ResponseError(_)=>("share-storage-response","分享存储响应格式无效 / Invalid share storage response"),
            _=>("share-storage-service","分享存储服务请求失败 / Share storage service request failed"),
        }
    };format!("{message} [{kind}]")
}

/// Acquire while the caller still holds its unlocked-vault guard. The epoch
/// rejects a late remote verification after lock/reset/recovery/quit.
pub struct OperationTicket{epoch:u64,cancel:Arc<AtomicBool>}
impl std::fmt::Debug for OperationTicket{fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{f.write_str("OperationTicket { opaque }")}}

#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct SessionInfo{pub session_id:String,pub bucket_name:String,pub prefix:String,pub expires_at:String,pub read_only:bool}
impl From<qiniu::share::ShareSessionInfo> for SessionInfo{
    fn from(info:qiniu::share::ShareSessionInfo)->Self{Self{session_id:info.session_id,bucket_name:info.bucket_name,prefix:info.prefix,expires_at:info.expires_at,read_only:true}}
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct CreatedShare{pub url:String,pub extraction_code:String,pub bucket_name:String,pub prefix:String,pub expires_at:String,pub read_only:bool}
impl std::fmt::Debug for CreatedShare{fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{f.write_str("CreatedShare { link and extraction code: [redacted] }")}}

#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ShareObject{pub key:String,pub size:i64,pub last_modified:Option<String>,pub etag:Option<String>,pub storage_class:Option<String>}
#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ShareListPage{pub objects:Vec<ShareObject>,pub prefixes:Vec<String>,pub is_truncated:bool,#[serde(skip_serializing_if="Option::is_none")]pub next_cursor:Option<String>}
#[derive(Debug,Serialize)]
pub struct ShareDownloadResult{pub bytes:i64}

struct Entry{config:QiniuConfig,bucket:String,prefix:String,expires:i64,cancel:Arc<AtomicBool>}
struct Cursor{session_id:String,prefix:String,token:String,seen:HashSet<[u8;32]>}
#[derive(Default)]
struct RuntimeState{epoch:u64,pending:Vec<Weak<AtomicBool>>,entries:HashMap<String,Entry>,cursors:HashMap<String,Cursor>}

#[derive(Default)]
pub struct ShareRuntime{state:Arc<Mutex<RuntimeState>>,sessions:Arc<ShareSessionStore>}
impl ShareRuntime{
    pub fn begin_operation(&self)->Result<OperationTicket,String>{
        let mut state=self.state.lock().map_err(|_|state_error())?;
        self.prune_locked(&mut state,Utc::now().timestamp());
        state.pending.retain(|value|value.strong_count()>0);
        if state.pending.len()>=64{return Err("分享请求过多，请等待已有操作完成 / Too many pending share operations".into())}
        let cancel=Arc::new(AtomicBool::new(false));state.pending.push(Arc::downgrade(&cancel));
        Ok(OperationTicket{epoch:state.epoch,cancel})
    }
    fn check_ticket(&self,ticket:&OperationTicket)->Result<(),String>{
        let state=self.state.lock().map_err(|_|state_error())?;
        if state.epoch!=ticket.epoch||ticket.cancel.load(Ordering::SeqCst){Err(inactive())}else{Ok(())}
    }
    async fn pending<T>(&self,ticket:&OperationTicket,operation:impl Future<Output=T>)->Result<T,String>{
        let mut pending=Box::pin(operation);
        loop{self.check_ticket(ticket)?;match select(pending,Box::pin(tokio::time::sleep(Duration::from_millis(50)))).await{
            Either::Left((result,_))=>{self.check_ticket(ticket)?;return Ok(result)},
            Either::Right((_,operation))=>pending=operation,
        }}
    }
    pub async fn login(&self,ticket:OperationTicket,config:QiniuConfig,url:&str,code:&str)->Result<SessionInfo,String>{
        self.check_ticket(&ticket)?;
        let service=qiniu::share::QiniuShareService::new(config.clone(),&[]).map_err(|e|e.to_string())?;
        let link=service.parse_share_link(url).map_err(|e|e.to_string())?;
        let api=self.pending(&ticket,service.discover_api_origin()).await?.map_err(|e|e.to_string())?;
        let session=self.pending(&ticket,service.verify_share(&api,&link,code,Utc::now().timestamp())).await?.map_err(|e|e.to_string())?;
        self.accept_login(&ticket,config,session,Utc::now().timestamp())
    }
    fn accept_login(&self,ticket:&OperationTicket,config:QiniuConfig,session:qiniu::share::ShareSession,now:i64)->Result<SessionInfo,String>{
        let mut state=self.state.lock().map_err(|_|state_error())?;
        if state.epoch!=ticket.epoch||ticket.cancel.load(Ordering::SeqCst){return Err(inactive())}
        self.prune_locked(&mut state,now);
        if state.entries.len()>=32{return Err("分享会话过多，请关闭部分会话 / Too many share sessions".into())}
        let info=session.info();let expires=session.expires_at();qiniu::share::validate_share_prefix(&info.prefix).map_err(|e|e.to_string())?;
        // Verify the native S3 client before publishing a frontend identity.
        bridge(&config,&session)?;
        let info=self.sessions.insert(session,now).map_err(|e|e.to_string())?;
        state.entries.insert(info.session_id.clone(),Entry{config,bucket:info.bucket_name.clone(),prefix:info.prefix.clone(),expires,cancel:Arc::new(AtomicBool::new(false))});
        self.expire_later(info.session_id.clone(),expires);
        Ok(info.into())
    }
    fn expire_later(&self,id:String,expires:i64){
        let state=Arc::downgrade(&self.state);let sessions=Arc::downgrade(&self.sessions);
        tokio::spawn(async move{
            loop{
                let remaining=expires.saturating_sub(Utc::now().timestamp());
                if remaining>0{tokio::time::sleep(Duration::from_secs((remaining as u64).min(30))).await;continue}
                let(Some(state),Some(sessions))=(state.upgrade(),sessions.upgrade())else{return};
                if let Ok(mut state)=state.lock(){
                    if state.entries.get(&id).is_some_and(|entry|entry.expires<=Utc::now().timestamp()){
                        if let Some(entry)=state.entries.remove(&id){entry.cancel.store(true,Ordering::SeqCst)}
                        state.cursors.retain(|_,cursor|cursor.session_id!=id);sessions.remove(&id);
                    }
                };
                return
            }
        });
    }
    pub async fn create_share(&self,ticket:OperationTicket,config:QiniuConfig,bucket:&str,prefix:&str,duration:u32,ak:&str,sk:&str)->Result<CreatedShare,String>{
        self.check_ticket(&ticket)?;qiniu::share::validate_share_prefix(prefix).map_err(|e|e.to_string())?;
        let service=qiniu::share::QiniuShareService::new(config,&[]).map_err(|e|e.to_string())?;
        let api=self.pending(&ticket,service.discover_api_origin()).await?.map_err(|e|e.to_string())?;
        let options=qiniu::share::CreateShareOptions{bucket:bucket.into(),prefix:prefix.into(),duration_seconds:duration,extract_code:None};
        let result=self.pending(&ticket,service.create_share(&api,&options,ak,sk,Utc::now().timestamp())).await?.map_err(|e|e.to_string())?;
        Ok(CreatedShare{url:result.url,extraction_code:result.extract_code,bucket_name:bucket.into(),prefix:prefix.into(),expires_at:result.expires_at,read_only:true})
    }
    pub fn info(&self,id:&str)->Result<SessionInfo,String>{
        let mut state=self.state.lock().map_err(|_|state_error())?;self.prune_locked(&mut state,Utc::now().timestamp());
        let entry=state.entries.get(id).ok_or_else(inactive)?;
        self.sessions.with_session(id,&entry.bucket,&entry.prefix,ShareOperation::List,Utc::now().timestamp(),|session|session.info())
            .map(Into::into).map_err(|e|e.to_string())
    }
    fn prepare(&self,id:&str,path:&str,operation:ShareOperation)->Result<RequestPermit,String>{
        match operation{ShareOperation::List=>qiniu::share::validate_share_prefix(path),_=>qiniu::share::validate_share_key(path)}.map_err(|e|e.to_string())?;
        let mut state=self.state.lock().map_err(|_|state_error())?;self.prune_locked(&mut state,Utc::now().timestamp());
        let entry=state.entries.get(id).ok_or_else(inactive)?;
        if entry.cancel.load(Ordering::SeqCst){return Err(inactive())}
        let client=self.sessions.with_session(id,&entry.bucket,path,operation,Utc::now().timestamp(),|session|bridge(&entry.config,session)).map_err(|e|e.to_string())??;
        let bucket=self.sessions.with_session(id,&entry.bucket,path,operation,Utc::now().timestamp(),|session|session.info().bucket_id).map_err(|e|e.to_string())?;
        Ok(RequestPermit{id:id.into(),bucket,path:path.into(),operation,cancel:entry.cancel.clone(),client})
    }
    fn check_at(&self,permit:&RequestPermit,now:i64)->Result<(),String>{
        let mut state=self.state.lock().map_err(|_|state_error())?;self.prune_locked(&mut state,now);self.check_locked(&state,permit,now)
    }
    fn check_locked(&self,state:&RuntimeState,permit:&RequestPermit,now:i64)->Result<(),String>{
        let entry=state.entries.get(&permit.id).ok_or_else(inactive)?;
        if permit.cancel.load(Ordering::SeqCst)||!Arc::ptr_eq(&permit.cancel,&entry.cancel){return Err(inactive())}
        self.sessions.with_session(&permit.id,&entry.bucket,&permit.path,permit.operation,now,|_|()).map_err(|e|e.to_string())
    }
    async fn request<T>(&self,permit:&RequestPermit,operation:impl Future<Output=T>)->Result<T,String>{
        let mut pending=Box::pin(operation);
        loop{self.check_at(permit,Utc::now().timestamp())?;match select(pending,Box::pin(tokio::time::sleep(Duration::from_millis(50)))).await{
            Either::Left((result,_))=>{self.check_at(permit,Utc::now().timestamp())?;return Ok(result)},
            Either::Right((_,operation))=>pending=operation,
        }}
    }
    pub async fn list(&self,id:&str,prefix:&str,cursor:Option<&str>)->Result<ShareListPage,String>{
        let permit=self.prepare(id,prefix,ShareOperation::List)?;
        let (token,mut seen)={
            let state=self.state.lock().map_err(|_|state_error())?;
            match cursor{None=>(None,HashSet::new()),Some(cursor)=>{
                if cursor.len()>128{return Err(invalid_cursor())}
                let value=state.cursors.get(cursor).ok_or_else(invalid_cursor)?;
                if value.session_id!=id||value.prefix!=prefix{return Err(invalid_cursor())}
                (Some(value.token.clone()),value.seen.clone())
            }}
        };
        let output=self.request(&permit,permit.client.list_objects_v2().bucket(&permit.bucket).prefix(prefix).delimiter("/").max_keys(PAGE_SIZE).set_continuation_token(token.clone()).send()).await?.map_err(|e|storage_error(&e))?;
        if output.name().is_some_and(|name|name!=permit.bucket)||output.prefix().is_some_and(|value|value!=prefix)||output.contents().len().saturating_add(output.common_prefixes().len())>PAGE_SIZE as usize{return Err(transport_error())}
        let mut objects=Vec::new();let mut prefixes=Vec::new();
        // A malicious/misconfigured service must not broaden the read-only scope
        // merely by returning a sibling object in a valid prefix response.
        let mut state=self.state.lock().map_err(|_|state_error())?;self.check_locked(&state,&permit,Utc::now().timestamp())?;
        let entry=state.entries.get(id).ok_or_else(inactive)?;
        for object in output.contents(){
            let key=object.key().ok_or_else(transport_error)?;qiniu::share::validate_share_key(key).map_err(|e|e.to_string())?;
            if !key.starts_with(prefix){return Err(transport_error())}
            // S3 may return the directory marker itself along with its direct
            // children. It is not a downloadable child and must not create a
            // navigation loop. Descendant files require opening that folder.
            if key==prefix{continue}
            if key.strip_prefix(prefix).is_none_or(|suffix|suffix.contains('/')){return Err(transport_error())}
            self.sessions.with_session(id,&entry.bucket,key,ShareOperation::Stat,Utc::now().timestamp(),|_|()).map_err(|e|e.to_string())?;
            let size=object.size().filter(|n|*n>=0&&*n<=MAX_SAFE_SIZE).ok_or_else(transport_error)?;
            objects.push(ShareObject{key:key.into(),size,last_modified:object.last_modified().map(|v|v.to_string()),etag:object.e_tag().map(str::to_string),storage_class:object.storage_class().map(|v|v.as_str().to_string())});
        }
        for folder in output.common_prefixes(){
            let value=folder.prefix().ok_or_else(transport_error)?;qiniu::share::validate_share_prefix(value).map_err(|e|e.to_string())?;
            // The empty direct-child name is meaningful: shared// is a
            // different prefix from shared/. Preserve it literally while
            // still rejecting a descendant spanning more than one segment.
            if !value.starts_with(prefix)||value==prefix||value.strip_prefix(prefix).and_then(|v|v.strip_suffix('/')).is_none_or(|v|v.contains('/')){return Err(transport_error())}
            self.sessions.with_session(id,&entry.bucket,value,ShareOperation::List,Utc::now().timestamp(),|_|()).map_err(|e|e.to_string())?;prefixes.push(value.into());
        }
        let truncated=output.is_truncated().ok_or_else(transport_error)?;
        if !truncated&&output.next_continuation_token().is_some_and(|value|!value.is_empty()){return Err(transport_error())}
        let next_cursor=if truncated{
            let next=output.next_continuation_token().filter(|v|!v.is_empty()&&v.len()<=65_536).ok_or_else(invalid_cursor)?;
            let digest:[u8;32]=Sha256::digest(next.as_bytes()).into();
            if token.as_deref()==Some(next)||!seen.insert(digest){return Err("分享存储重复返回分页游标，请重新打开目录 / Share storage returned a repeated cursor; reopen the directory".into())}
            if seen.len()>MAX_CURSOR_HOPS{return Err("分享目录分页已达到安全上限，请缩小目录范围 / Share pagination reached its safety limit; open a narrower directory".into())}
            let replacing=state.cursors.values().any(|v|v.session_id==id&&v.prefix==prefix);
            if state.cursors.len()>=MAX_CURSORS&&!replacing{return Err("分享分页缓存已满，请重新登录 / Share pagination cache is full; sign in again".into())}
            // Forward-only navigation retains one successful cursor chain per
            // directory, and digests (not copies of all provider tokens).
            state.cursors.retain(|_,v|v.session_id!=id||v.prefix!=prefix);
            let opaque=uuid::Uuid::new_v4().to_string();state.cursors.insert(opaque.clone(),Cursor{session_id:id.into(),prefix:prefix.into(),token:next.into(),seen});Some(opaque)
        }else{None};
        if !truncated{state.cursors.retain(|_,v|v.session_id!=id||v.prefix!=prefix);}
        Ok(ShareListPage{objects,prefixes,is_truncated:truncated,next_cursor})
    }
    pub async fn download(&self,id:&str,key:&str,target:&Path)->Result<ShareDownloadResult,String>{
        let permit=self.prepare(id,key,ShareOperation::Download)?;
        if !target.is_absolute()||target.components().any(|p|matches!(p,Component::ParentDir|Component::CurDir)){return Err(local_error())}
        let parent=target.parent().ok_or_else(local_error)?;let filename=target.file_name().ok_or_else(local_error)?;
        let parent=fs::canonicalize(parent).map_err(|_|local_error())?;let target=parent.join(filename);
        if fs::symlink_metadata(&target).is_ok(){return Err("下载目标已存在，未覆盖原文件 / Download target already exists; original file preserved".into())}
        let head=self.request(&permit,permit.client.head_object().bucket(&permit.bucket).key(key).send()).await?.map_err(|e|storage_error(&e))?;
        let identity=RemoteIdentity::head(&head)?;
        let mut partial=Partial::create(&parent)?;
        let request=permit.client.get_object().bucket(&permit.bucket).key(key).if_match(&identity.etag).set_version_id(identity.version.clone());
        let output=self.request(&permit,request.send()).await?.map_err(|e|storage_error(&e))?;
        if output.content_length()!=Some(identity.size)||output.e_tag()!=Some(identity.etag.as_str())||output.version_id().filter(|v|!v.is_empty())!=identity.version.as_deref(){return Err(changed())}
        let mut body=output.body;let mut count=0i64;let mut hash=Sha256::new();
        while let Some(bytes)=self.request(&permit,body.try_next()).await?.map_err(|_|transport_error())?{
            count=count.checked_add(i64::try_from(bytes.len()).map_err(|_|changed())?).ok_or_else(changed)?;
            if count>identity.size{return Err(changed())}
            self.check_at(&permit,Utc::now().timestamp())?;
            partial.file.as_mut().ok_or_else(local_error)?.write_all(&bytes).await.map_err(|_|local_error())?;hash.update(&bytes);
        }
        if count!=identity.size{return Err(changed())}
        partial.file.as_mut().ok_or_else(local_error)?.flush().await.map_err(|_|local_error())?;partial.file.as_ref().ok_or_else(local_error)?.sync_all().await.map_err(|_|local_error())?;
        let final_head=self.request(&permit,permit.client.head_object().bucket(&permit.bucket).key(key).send()).await?.map_err(|e|storage_error(&e))?;
        if RemoteIdentity::head(&final_head)?!=identity{return Err(changed())}
        let expected:[u8;32]=hash.finalize().into();let verified=partial.verify(count as u64,expected).await?;
        // No await between the final authorization and atomic filesystem
        // delivery. close/clear_all serialize on the same mutex, so a revoked
        // session cannot commit after its revocation event has completed.
        let state=self.state.lock().map_err(|_|state_error())?;self.check_locked(&state,&permit,Utc::now().timestamp())?;
        if fs::canonicalize(target.parent().ok_or_else(local_error)?).map_err(|_|local_error())?!=parent{return Err(changed())}
        let final_metadata=partial.check_identity()?;
        if final_metadata.len()!=verified.len||final_metadata.modified().ok()!=verified.modified{return Err(changed())}
        fs::hard_link(&partial.path,&target).map_err(|_|"无法原子创建下载目标，目标可能已存在或文件系统不支持；原文件未修改 / Atomic download creation failed; target may exist or filesystem may not support it; original file preserved".to_string())?;
        // Delivery has won the race; a following close must not delete target.
        drop(state);partial.cleanup();Ok(ShareDownloadResult{bytes:count})
    }
    pub fn close(&self,id:&str){let mut state=self.state.lock().unwrap_or_else(|poisoned|poisoned.into_inner());if let Some(entry)=state.entries.remove(id){entry.cancel.store(true,Ordering::SeqCst)}state.cursors.retain(|_,cursor|cursor.session_id!=id);self.sessions.remove(id);}
    fn prune_locked(&self,state:&mut RuntimeState,now:i64){
        let expired=state.entries.iter().filter(|(_,entry)|entry.expires<=now).map(|(id,_)|id.clone()).collect::<Vec<_>>();
        for id in expired{if let Some(entry)=state.entries.remove(&id){entry.cancel.store(true,Ordering::SeqCst)}self.sessions.remove(&id);state.cursors.retain(|_,cursor|cursor.session_id!=id);}
    }
    pub fn clear_all(&self){let mut state=self.state.lock().unwrap_or_else(|poisoned|poisoned.into_inner());state.epoch=state.epoch.wrapping_add(1);for pending in state.pending.drain(..).filter_map(|p|p.upgrade()){pending.store(true,Ordering::SeqCst)}for(_,entry)in state.entries.drain(){entry.cancel.store(true,Ordering::SeqCst)}state.cursors.clear();self.sessions.clear_all();}
}

struct RequestPermit{id:String,bucket:String,path:String,operation:ShareOperation,cancel:Arc<AtomicBool>,client:Client}
fn bridge(config:&QiniuConfig,session:&qiniu::share::ShareSession)->Result<Client,String>{
    let context=session.context();let info=session.info();let credentials=session.credentials();
    let bridge=qiniu::s3_bridge::from_context(&info.session_id,"share-session",config,&context,credentials.access_key,credentials.secret_key,Some(credentials.session_token)).map_err(|e|e.to_string())?;
    // Each attempt goes through the runtime authorization check. Do not let an
    // internal SDK retry outlive a closed/expired share session.
    Ok(Client::from_conf(bridge.client.config().to_builder().retry_config(RetryConfig::standard().with_max_attempts(1)).build()))
}

#[derive(PartialEq,Eq)]
struct RemoteIdentity{size:i64,etag:String,version:Option<String>,modified:Option<String>}
impl RemoteIdentity{fn head(output:&aws_sdk_s3::operation::head_object::HeadObjectOutput)->Result<Self,String>{
    let size=output.content_length().filter(|n|*n>=0&&*n<=MAX_SAFE_SIZE).ok_or_else(transport_error)?;
    let etag=output.e_tag().filter(|v|!v.is_empty()&&v.len()<=4096&&!v.chars().any(char::is_control)).ok_or_else(transport_error)?.to_string();
    Ok(Self{size,etag,version:output.version_id().filter(|v|!v.is_empty()).map(str::to_string),modified:output.last_modified().map(|v|v.to_string())})
}}

#[derive(PartialEq,Eq)]
struct FileStamp{created:Option<std::time::SystemTime>,#[cfg(unix)]dev:u64,#[cfg(unix)]ino:u64}
fn stamp(metadata:&fs::Metadata)->FileStamp{
    #[cfg(unix)]use std::os::unix::fs::MetadataExt;
    FileStamp{created:metadata.created().ok(),#[cfg(unix)]dev:metadata.dev(),#[cfg(unix)]ino:metadata.ino()}
}
struct VerifiedPartial{len:u64,modified:Option<std::time::SystemTime>}
struct Partial{path:PathBuf,file:Option<tokio::fs::File>,identity:FileStamp}
impl Partial{
    fn create(parent:&Path)->Result<Self,String>{
        let path=parent.join(format!(".yuncang-share-{}.part",uuid::Uuid::new_v4()));
        let mut options=fs::OpenOptions::new();options.write(true).read(true).create_new(true);
        // Retain a Windows handle that denies concurrent writes/deletes while
        // validating and publishing this partial. Close only after delivery.
        #[cfg(windows)]{use std::os::windows::fs::OpenOptionsExt;options.share_mode(1);}
        let file=options.open(&path).map_err(|_|local_error())?;
        let metadata=match file.metadata(){Ok(value)=>value,Err(_)=>{drop(file);let _=fs::remove_file(&path);return Err(local_error())}};
        let identity=stamp(&metadata);
        Ok(Self{path,file:Some(tokio::fs::File::from_std(file)),identity})
    }
    fn check_identity(&self)->Result<fs::Metadata,String>{
        let metadata=fs::symlink_metadata(&self.path).map_err(|_|changed())?;
        if !metadata.is_file()||metadata.file_type().is_symlink()||stamp(&metadata)!=self.identity{return Err(changed())}Ok(metadata)
    }
    async fn verify(&self,size:u64,hash:[u8;32])->Result<VerifiedPartial,String>{
        let before=self.check_identity()?;if before.len()!=size{return Err(changed())}
        let mut file=tokio::fs::File::open(&self.path).await.map_err(|_|changed())?;
        if stamp(&file.metadata().await.map_err(|_|changed())?)!=self.identity{return Err(changed())}
        let mut actual=Sha256::new();let mut total=0u64;let mut buffer=vec![0u8;64*1024];
        loop{let n=file.read(&mut buffer).await.map_err(|_|changed())?;if n==0{break}total=total.checked_add(n as u64).ok_or_else(changed)?;if total>size{return Err(changed())}actual.update(&buffer[..n]);}
        let after=self.check_identity()?;let result:[u8;32]=actual.finalize().into();
        if total!=size||result!=hash||after.len()!=size||after.modified().ok()!=before.modified().ok(){return Err(changed())}Ok(VerifiedPartial{len:size,modified:after.modified().ok()})
    }
    fn cleanup(&mut self){drop(self.file.take());if self.check_identity().is_ok(){let _=fs::remove_file(&self.path);}}
}
impl Drop for Partial{fn drop(&mut self){self.cleanup()}}

#[cfg(test)]
#[path="qiniu_share_runtime_tests.rs"]
mod tests;
