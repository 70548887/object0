//! Native Kodo ranged downloads. Checkpoints contain identities, never signed
//! URLs or credentials. A resume validates the local prefix before appending;
//! user targets are committed with atomic create-if-absent only.
use super::{transfer::QiniuEtag,CapabilityState,QiniuClient,QiniuError,ResolvedBucketContext};
use base64::{engine::general_purpose::URL_SAFE,Engine};
use futures_util::future::{select,Either};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use std::{fmt,fs,io,path::{Component,Path,PathBuf},sync::atomic::{AtomicU8,Ordering},time::{Duration,UNIX_EPOCH}};
use tokio::io::{AsyncReadExt,AsyncSeekExt,AsyncWriteExt};

pub const FORMAT_VERSION:u8=1;
pub const CHECKPOINT_BYTES:u64=4*1024*1024;
const FILE_BUFFER:usize=1024*1024;

#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct RemoteIdentity{pub size:u64,pub etag:String,pub last_modified:String}
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="kebab-case")]
pub enum DownloadPhase{Downloading,Committing,Completed,Cancelled}
#[derive(Clone,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct DownloadCheckpoint{
    pub format_version:u8,pub job_id:String,pub profile_id:String,pub profile_revision:String,
    pub bucket:String,pub key:String,pub domain:String,pub target_path:String,pub partial_path:String,
    pub remote:RemoteIdentity,pub offset:u64,pub prefix_sha256:String,pub partial_created:Option<String>,pub phase:DownloadPhase,
}
impl fmt::Debug for DownloadCheckpoint{fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result{f.debug_struct("DownloadCheckpoint").field("phase",&self.phase).field("offset",&self.offset).field("total",&self.remote.size).finish_non_exhaustive()}}
#[derive(Debug)]
pub enum DownloadOutcome{
    Completed{bytes:u64,checkpoint:DownloadCheckpoint},Paused{checkpoint:DownloadCheckpoint},
    Interrupted{checkpoint:DownloadCheckpoint,error:QiniuError},Cancelled{checkpoint:DownloadCheckpoint},
}
#[derive(Debug,Default)]
pub struct DownloadControl(AtomicU8);
impl DownloadControl{
    pub fn pause(&self){let _=self.0.compare_exchange(0,1,Ordering::SeqCst,Ordering::SeqCst);}
    pub fn cancel(&self){self.0.store(2,Ordering::SeqCst);}
    pub fn resume(&self){self.0.store(0,Ordering::SeqCst);}
    pub fn is_paused(&self)->bool{self.0.load(Ordering::SeqCst)==1}
    pub fn is_cancelled(&self)->bool{self.0.load(Ordering::SeqCst)==2}
    fn check(&self)->Result<(),QiniuError>{if self.is_cancelled(){Err(failure("cancelled","下载已请求取消 / Download cancellation requested"))}else if self.is_paused(){Err(failure("paused","下载已暂停 / Download paused"))}else{Ok(())}}
}
fn failure(code:&str,message:&str)->QiniuError{QiniuError::new(CapabilityState::Unavailable,code,message)}
fn invalid()->QiniuError{failure("invalid-checkpoint","下载断点与任务或路径不匹配，未执行写入 / Download checkpoint identity or path is invalid; no write was performed")}
fn local()->QiniuError{failure("local-io","下载临时文件操作失败，请检查磁盘、路径和权限 / Download temporary-file operation failed; check disk, path and permissions")}
fn changed()->QiniuError{failure("remote-changed","远端对象已变化，未追加或替换本地文件 / Remote object changed; no local append or replacement was accepted")}
fn partial_changed()->QiniuError{failure("partial-changed","下载临时文件的身份或内容已变化，未截断或删除 / Download partial-file identity or content changed; it was not truncated or removed")}
fn target_exists()->QiniuError{failure("target-exists","下载目标已存在或已变化，原文件保持不变 / Download target exists or changed; the original file was preserved")}
fn commit_error(error:io::Error)->QiniuError{if error.kind()==io::ErrorKind::AlreadyExists{target_exists()}else{failure("atomic-commit-failed","无法原子交付下载文件，请检查目标文件系统、磁盘和权限；原目标未修改 / Atomic download commit failed; check filesystem support, disk and permissions; the original target was not modified")}}
fn hex(bytes:impl AsRef<[u8]>)->String{bytes.as_ref().iter().map(|byte|format!("{byte:02x}")).collect()}
fn empty_digest()->String{hex(Sha256::digest([]))}
fn valid_hash(value:&str)->bool{URL_SAFE.decode(value).is_ok_and(|bytes|bytes.len()==21&&matches!(bytes[0],0x16|0x96))}
fn valid_sha(value:&str)->bool{value.len()==64&&value.bytes().all(|b|b.is_ascii_hexdigit())}
fn valid_id(value:&str)->bool{uuid::Uuid::parse_str(value).is_ok_and(|id|id.hyphenated().to_string()==value)}
fn safe_text(value:&str,max:usize)->bool{!value.is_empty()&&value.len()<=max&&!value.chars().any(|c|c.is_control())}
fn is_link(meta:&fs::Metadata)->bool{
    #[cfg(windows)]{use std::os::windows::fs::MetadataExt;meta.file_type().is_symlink()||meta.file_attributes()&0x400!=0}
    #[cfg(not(windows))]{meta.file_type().is_symlink()}
}
fn safe_path(path:&Path)->bool{path.is_absolute()&&!path.components().any(|part|matches!(part,Component::ParentDir|Component::CurDir))}
fn check_components(path:&Path)->Result<(),QiniuError>{
    if !safe_path(path){return Err(invalid())}
    let mut current=PathBuf::new();
    for part in path.components(){current.push(part.as_os_str());if matches!(part,Component::Prefix(_))||!current.is_absolute(){continue;}
        match fs::symlink_metadata(&current){Ok(meta)if is_link(&meta)=>return Err(partial_changed()),Ok(_)=>{},Err(e)if e.kind()==io::ErrorKind::NotFound=>{},Err(_)=>return Err(local())}
    }Ok(())
}
#[cfg(unix)]
fn stamp(meta:&fs::Metadata)->Result<String,QiniuError>{
    if !meta.is_file()||is_link(meta){return Err(partial_changed())}
    use std::os::unix::fs::MetadataExt;Ok(format!("unix:{}:{}",meta.dev(),meta.ino()))
}
#[cfg(not(unix))]
fn stamp(meta:&fs::Metadata)->Result<String,QiniuError>{
    if !meta.is_file()||is_link(meta){return Err(partial_changed())}
    let created=meta.created().map_err(|_|local())?.duration_since(UNIX_EPOCH).map_err(|_|local())?;Ok(format!("created:{}",created.as_nanos()))
}
fn regular_metadata(path:&Path)->Result<Option<fs::Metadata>,QiniuError>{
    check_components(path)?;match fs::symlink_metadata(path){Ok(meta)if !meta.is_file()||is_link(&meta)=>Err(partial_changed()),Ok(meta)=>Ok(Some(meta)),Err(e)if e.kind()==io::ErrorKind::NotFound=>Ok(None),Err(_)=>Err(local())}
}
fn open_read(path:&Path)->Result<tokio::fs::File,QiniuError>{
    let mut options=fs::OpenOptions::new();options.read(true);
    #[cfg(windows)]{use std::os::windows::fs::OpenOptionsExt;options.custom_flags(0x0020_0000);}
    let file=options.open(path).map_err(|_|local())?;if is_link(&file.metadata().map_err(|_|local())?){return Err(partial_changed())}Ok(tokio::fs::File::from_std(file))
}
fn validate_checkpoint(cp:&DownloadCheckpoint)->Result<(),QiniuError>{
    if cp.format_version!=FORMAT_VERSION||!valid_id(&cp.job_id)||!safe_text(&cp.profile_id,512)||!safe_text(&cp.profile_revision,512)
        ||!safe_text(&cp.bucket,255)||cp.bucket.contains(['/', '\\'])||cp.key.is_empty()||cp.key.len()>4096||cp.key.contains('\0')
        ||cp.offset>cp.remote.size||cp.remote.size>9_007_199_254_740_991||!valid_hash(&cp.remote.etag)||!valid_sha(&cp.prefix_sha256)
        ||chrono::DateTime::parse_from_rfc3339(&cp.remote.last_modified).is_err()
        ||(cp.offset==0&&cp.prefix_sha256!=empty_digest()){return Err(invalid())}
    let target=Path::new(&cp.target_path);let partial=Path::new(&cp.partial_path);
    let parent=target.parent().ok_or_else(invalid)?;
    if cp.target_path.len()>32768||cp.partial_path.len()>32768||!safe_path(target)||!safe_path(partial)
        ||target.file_name().is_none()||partial!=parent.join(format!(".yuncang-range-{}.part",cp.job_id))||target==partial
        ||cp.partial_created.as_ref().is_some_and(|value|!safe_text(value,256))
        ||(cp.offset>0&&cp.partial_created.is_none())
        ||(matches!(cp.phase,DownloadPhase::Committing|DownloadPhase::Completed)&&cp.offset!=cp.remote.size){return Err(invalid())}
    super::endpoint::parse_endpoint(&cp.domain,true)?;super::endpoint::object_url(&cp.domain,&cp.key,true)?;
    check_components(parent)?;
    if fs::canonicalize(parent).map_err(|_|local())?!=parent{return Err(partial_changed())}
    Ok(())
}
fn remote(cp:&DownloadCheckpoint,object:&super::client::QiniuObject)->bool{object.size==cp.remote.size&&object.etag==cp.remote.etag&&object.last_modified==cp.remote.last_modified}
fn validate_context(client:&QiniuClient,context:&ResolvedBucketContext,cp:&DownloadCheckpoint)->Result<(),QiniuError>{
    validate_checkpoint(cp)?;
    if context.backend_mode!="kodo"||context.bucket.name!=cp.bucket{return Err(invalid())}
    let configured=client.config.download_domain.as_deref().ok_or_else(invalid)?;
    let origin=super::endpoint::parse_download_origin(configured,client.config.mode)?;
    let selected=super::endpoint::parse_download_origin(&cp.domain,client.config.mode)?;
    if origin.origin()!=selected.origin(){return Err(invalid())}Ok(())
}
async fn controlled<T>(operation:impl std::future::Future<Output=Result<T,reqwest::Error>>,control:&DownloadControl)->Result<T,QiniuError>{
    let mut pending=Box::pin(operation);loop{control.check()?;match select(pending,Box::pin(tokio::time::sleep(Duration::from_millis(100)))).await{
        Either::Left((value,_))=>return value.map_err(|error|if error.is_timeout(){failure("timeout","下载请求超时，断点已保留 / Download timed out; checkpoint retained")}else{failure("transport-failed","下载连接中断，断点已保留 / Download connection interrupted; checkpoint retained")}),
        Either::Right((_,operation))=>pending=operation,
    }}
}
struct Prefix{sha:Sha256,qiniu:QiniuEtag}
async fn verify_prefix(cp:&DownloadCheckpoint,allow_tail:bool,control:Option<&DownloadControl>)->Result<Option<Prefix>,QiniuError>{
    let path=Path::new(&cp.partial_path);let Some(meta)=regular_metadata(path)? else {
        if cp.partial_created.is_none()&&cp.offset==0{return Ok(None)}else{return Err(partial_changed())}
    };
    let expected=cp.partial_created.as_deref().ok_or_else(partial_changed)?;
    if stamp(&meta)?!=expected||meta.len()<cp.offset||meta.len()>cp.remote.size||(!allow_tail&&meta.len()!=cp.offset){return Err(partial_changed())}
    let mut file=open_read(path)?;let opened=file.metadata().await.map_err(|_|local())?;
    if stamp(&opened)?!=expected||opened.len()!=meta.len(){return Err(partial_changed())}
    let mut sha=Sha256::new();let mut qiniu=QiniuEtag::default();let mut left=cp.offset;let mut buffer=vec![0u8;FILE_BUFFER];
    while left>0{if let Some(control)=control{control.check()?;}let want=left.min(buffer.len() as u64)as usize;let n=file.read(&mut buffer[..want]).await.map_err(|_|local())?;if n==0{return Err(partial_changed())}sha.update(&buffer[..n]);qiniu.update(&buffer[..n]);left-=n as u64;}
    if hex(sha.clone().finalize())!=cp.prefix_sha256{return Err(partial_changed())}
    let after=regular_metadata(path)?.ok_or_else(partial_changed)?;
    if stamp(&after)?!=expected||after.len()!=meta.len()||after.modified().ok()!=meta.modified().ok(){return Err(partial_changed())}
    Ok(Some(Prefix{sha,qiniu}))
}
async fn verify_complete_file(path:&Path,cp:&DownloadCheckpoint)->Result<(),QiniuError>{
    let before=regular_metadata(path)?.ok_or_else(target_exists)?;
    if before.len()!=cp.remote.size{return Err(target_exists())}
    let identity=stamp(&before)?;let mut file=open_read(path)?;
    if stamp(&file.metadata().await.map_err(|_|local())?)?!=identity{return Err(target_exists())}
    let mut sha=Sha256::new();let mut qiniu=QiniuEtag::default();let mut total=0u64;let mut buffer=vec![0u8;FILE_BUFFER];
    loop{let n=file.read(&mut buffer).await.map_err(|_|local())?;if n==0{break}total=total.checked_add(n as u64).ok_or_else(local)?;if total>cp.remote.size{return Err(target_exists())}sha.update(&buffer[..n]);qiniu.update(&buffer[..n]);}
    let after=regular_metadata(path)?.ok_or_else(target_exists)?;
    if total!=cp.remote.size||hex(sha.finalize())!=cp.prefix_sha256||qiniu.finish()!=cp.remote.etag||stamp(&after)?!=identity||after.len()!=before.len()||after.modified().ok()!=before.modified().ok(){return Err(target_exists())}Ok(())
}
async fn remove_owned_partial(cp:&DownloadCheckpoint)->Result<(),QiniuError>{
    if regular_metadata(Path::new(&cp.partial_path))?.is_none(){return Ok(())}
    verify_prefix(cp,true,None).await?.ok_or_else(partial_changed)?;
    fs::remove_file(&cp.partial_path).map_err(|_|local())
}
fn checkpoint_error()->QiniuError{failure("checkpoint-save-failed","无法保存下载检查点，后续写入已停止 / Could not persist download checkpoint; subsequent writes stopped")}
fn persist(cp:&DownloadCheckpoint,save:&mut impl FnMut(&DownloadCheckpoint)->Result<(),QiniuError>)->Result<(),QiniuError>{save(cp).map_err(|_|checkpoint_error())}
fn interrupted(cp:DownloadCheckpoint,error:QiniuError)->DownloadOutcome{DownloadOutcome::Interrupted{checkpoint:cp,error}}

/// No cloud resolution/stat is performed in a committing local transaction.
pub async fn reconcile_download_checkpoint(cp:DownloadCheckpoint,on_checkpoint:impl FnMut(&DownloadCheckpoint)->Result<(),QiniuError>)->Result<DownloadOutcome,QiniuError>{
    reconcile_download_checkpoint_inner(cp,on_checkpoint,true).await
}
async fn reconcile_download_checkpoint_inner(mut cp:DownloadCheckpoint,mut on_checkpoint:impl FnMut(&DownloadCheckpoint)->Result<(),QiniuError>,allow_create:bool)->Result<DownloadOutcome,QiniuError>{
    validate_checkpoint(&cp)?;
    if !matches!(cp.phase,DownloadPhase::Committing|DownloadPhase::Completed){return Err(invalid())}
    let target=Path::new(&cp.target_path);
    let result:Result<(),QiniuError>=async {
        if regular_metadata(target)?.is_some(){verify_complete_file(target,&cp).await?;}
        else {
            if !allow_create||cp.phase==DownloadPhase::Completed{return Err(target_exists())}
            verify_prefix(&cp,false,None).await?.ok_or_else(partial_changed)?;
            verify_complete_file(Path::new(&cp.partial_path),&cp).await?;
            fs::hard_link(&cp.partial_path,&cp.target_path).map_err(commit_error)?;
        }
        remove_owned_partial(&cp).await?;Ok(())
    }.await;
    if let Err(error)=result{return Ok(interrupted(cp,error))}
    let mut complete=cp.clone();complete.phase=DownloadPhase::Completed;
    if let Err(error)=persist(&complete,&mut on_checkpoint){return Ok(interrupted(cp,error))}
    cp=complete;Ok(DownloadOutcome::Completed{bytes:cp.remote.size,checkpoint:cp})
}

/// Cancellation is local-only and cannot delete the user's target file.
pub async fn cancel_download_checkpoint(cp:DownloadCheckpoint,on_checkpoint:impl FnMut(&DownloadCheckpoint)->Result<(),QiniuError>)->Result<DownloadOutcome,QiniuError>{
    cancel_download_checkpoint_after_target_check(cp,on_checkpoint,||{}).await
}
async fn cancel_download_checkpoint_after_target_check(mut cp:DownloadCheckpoint,mut on_checkpoint:impl FnMut(&DownloadCheckpoint)->Result<(),QiniuError>,mut after_target_seen:impl FnMut())->Result<DownloadOutcome,QiniuError>{
    validate_checkpoint(&cp)?;
    if matches!(cp.phase,DownloadPhase::Committing|DownloadPhase::Completed){
        if regular_metadata(Path::new(&cp.target_path))?.is_some(){
            // Cancellation may acknowledge an already committed target, but
            // must never re-create one if it vanishes after this first check.
            after_target_seen();return reconcile_download_checkpoint_inner(cp,on_checkpoint,false).await
        }
        if cp.phase==DownloadPhase::Completed{return Ok(interrupted(cp,target_exists()))}
    }
    if cp.phase==DownloadPhase::Cancelled{return Ok(DownloadOutcome::Cancelled{checkpoint:cp})}
    if let Err(error)=remove_owned_partial(&cp).await{return Ok(interrupted(cp,error))}
    cp.phase=DownloadPhase::Cancelled;
    if let Err(error)=persist(&cp,&mut on_checkpoint){return Ok(interrupted(cp,error))}
    Ok(DownloadOutcome::Cancelled{checkpoint:cp})
}

impl QiniuClient{
    pub async fn prepare_download_checkpoint(&self,job_id:&str,profile_id:&str,profile_revision:&str,context:&ResolvedBucketContext,key:&str,target:&Path,control:&DownloadControl)->Result<DownloadCheckpoint,QiniuError>{
        control.check()?;
        if context.backend_mode!="kodo"||!valid_id(job_id){return Err(invalid())}
        let domain=self.config.download_domain.as_deref().ok_or_else(invalid)?;
        let origin=super::endpoint::parse_download_origin(domain,self.config.mode)?;
        super::endpoint::object_url(domain,key,true)?;
        if !safe_path(target)||target.file_name().is_none(){return Err(invalid())}
        let parent=target.parent().ok_or_else(invalid)?;check_components(parent)?;fs::create_dir_all(parent).map_err(|_|local())?;
        let parent=fs::canonicalize(parent).map_err(|_|local())?;check_components(&parent)?;
        let target=parent.join(target.file_name().ok_or_else(invalid)?);
        match fs::symlink_metadata(&target){Ok(_)=>return Err(target_exists()),Err(error)if error.kind()==io::ErrorKind::NotFound=>{},Err(_)=>return Err(local())}
        let object=self.stat(context,key).await?;control.check()?;
        if matches!(object.storage_type,Some(2|3))&&object.restore_status!=Some(2){return Err(failure("restore-required","归档对象必须先解冻 / Restore the archived object first"))}
        let cp=DownloadCheckpoint{format_version:FORMAT_VERSION,job_id:job_id.into(),profile_id:profile_id.into(),profile_revision:profile_revision.into(),bucket:context.bucket.name.clone(),key:key.into(),domain:origin.origin().ascii_serialization(),target_path:target.to_string_lossy().into_owned(),partial_path:parent.join(format!(".yuncang-range-{job_id}.part")).to_string_lossy().into_owned(),remote:RemoteIdentity{size:object.size,etag:object.etag,last_modified:object.last_modified},offset:0,prefix_sha256:empty_digest(),partial_created:None,phase:DownloadPhase::Downloading};
        validate_checkpoint(&cp)?;Ok(cp)
    }
    pub async fn reconcile_download_checkpoint(&self,cp:DownloadCheckpoint,on_checkpoint:impl FnMut(&DownloadCheckpoint)->Result<(),QiniuError>)->Result<DownloadOutcome,QiniuError>{reconcile_download_checkpoint(cp,on_checkpoint).await}
    pub async fn cancel_download_checkpoint(&self,cp:DownloadCheckpoint,on_checkpoint:impl FnMut(&DownloadCheckpoint)->Result<(),QiniuError>)->Result<DownloadOutcome,QiniuError>{cancel_download_checkpoint(cp,on_checkpoint).await}
    pub async fn run_download_checkpoint(&self,context:&ResolvedBucketContext,mut cp:DownloadCheckpoint,control:&DownloadControl,mut on_checkpoint:impl FnMut(&DownloadCheckpoint)->Result<(),QiniuError>,mut on_progress:impl FnMut(u64,u64))->Result<DownloadOutcome,QiniuError>{
        if control.is_cancelled(){return cancel_download_checkpoint(cp,on_checkpoint).await}
        if matches!(cp.phase,DownloadPhase::Committing|DownloadPhase::Completed){return reconcile_download_checkpoint(cp,on_checkpoint).await}
        validate_context(self,context,&cp)?;
        if cp.phase==DownloadPhase::Cancelled{return Ok(DownloadOutcome::Cancelled{checkpoint:cp})}
        if control.is_paused(){return Ok(DownloadOutcome::Paused{checkpoint:cp})}
        match fs::symlink_metadata(&cp.target_path){Ok(_)=>return Ok(interrupted(cp,target_exists())),Err(error)if error.kind()==io::ErrorKind::NotFound=>{},Err(_)=>return Ok(interrupted(cp,local()))}
        let identity=self.stat(context,&cp.key).await?;if !remote(&cp,&identity){return Ok(interrupted(cp,changed()))}
        if matches!(identity.storage_type,Some(2|3))&&identity.restore_status!=Some(2){return Ok(interrupted(cp,failure("restore-required","归档对象必须先解冻 / Restore the archived object first")))}
        let prefix=match verify_prefix(&cp,true,Some(control)).await{
            Ok(prefix)=>prefix,
            Err(_)if control.is_cancelled()=>return cancel_download_checkpoint(cp,on_checkpoint).await,
            Err(_)if control.is_paused()=>return Ok(DownloadOutcome::Paused{checkpoint:cp}),
            Err(error)=>return Ok(interrupted(cp,error)),
        };
        let path=Path::new(&cp.partial_path);let mut options=fs::OpenOptions::new();options.read(true).write(true);
        if prefix.is_none(){options.create_new(true);}
        #[cfg(windows)]{use std::os::windows::fs::OpenOptionsExt;options.custom_flags(0x0020_0000);}
        #[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
        let opened=options.open(path).map_err(|_|partial_changed())?;let meta=opened.metadata().map_err(|_|local())?;let created=stamp(&meta)?;
        if cp.partial_created.as_ref().is_some_and(|expected|*expected!=created){return Err(partial_changed())}
        let mut file=tokio::fs::File::from_std(opened);
        let Prefix{mut sha,mut qiniu}=prefix.unwrap_or_else(||Prefix{sha:Sha256::new(),qiniu:QiniuEtag::default()});
        if cp.partial_created.is_none(){cp.partial_created=Some(created);if let Err(error)=persist(&cp,&mut on_checkpoint){return Ok(interrupted(cp,error))}}
        // The checkpoint owns only the authenticated prefix. A process may die
        // after writing more bytes but before persisting the next checkpoint.
        // After full prefix+identity validation, trim only that owned tail.
        if meta.len()>cp.offset{file.set_len(cp.offset).await.map_err(|_|local())?;file.sync_all().await.map_err(|_|local())?;}
        file.seek(io::SeekFrom::Start(cp.offset)).await.map_err(|_|local())?;
        // A crash can leave all bytes durable but not yet record Committing.
        // Do not ask for bytes=size- (which would be a 416 forever); verify the
        // complete owned prefix and finish the local transaction instead.
        if cp.offset==cp.remote.size{
            if qiniu.finish()!=cp.remote.etag{return Ok(interrupted(cp,failure("integrity-mismatch","完整断点内容校验失败，未交付目标 / Full checkpoint integrity failed; target was not committed")))}
            let final_identity=self.stat(context,&cp.key).await?;if !remote(&cp,&final_identity){return Ok(interrupted(cp,changed()))}
            control.check()?;file.flush().await.map_err(|_|local())?;file.sync_all().await.map_err(|_|local())?;drop(file);cp.phase=DownloadPhase::Committing;
            if let Err(error)=persist(&cp,&mut on_checkpoint){return Ok(interrupted(cp,error))}
            return reconcile_download_checkpoint(cp,on_checkpoint).await
        }
        let url=super::endpoint::object_url(&cp.domain,&cp.key,true)?;
        let signed=self.signed_download_url(&url,chrono::Utc::now().timestamp()+3600)?;
        let mut request=self.http.get(signed.as_str()).timeout(Duration::from_secs(1200)).header(reqwest::header::ACCEPT_ENCODING,"identity").header(reqwest::header::IF_MATCH,format!("\"{}\"",cp.remote.etag));
        if cp.offset>0{request=request.header(reqwest::header::RANGE,format!("bytes={}-",cp.offset));}
        let mut last_saved=cp.offset;let mut durable=cp.clone();let mut write_failed=false;
        let transfer:Result<(),QiniuError>=async {
            let mut response=controlled(request.send(),control).await?;
            validate_response(&response,&cp)?;on_progress(cp.offset,cp.remote.size);
            while let Some(chunk)=controlled(response.chunk(),control).await?{
                for bytes in chunk.chunks(CHECKPOINT_BYTES as usize){
                    control.check()?;let next=cp.offset.checked_add(bytes.len()as u64).ok_or_else(local)?;if next>cp.remote.size{return Err(changed())}
                    file.write_all(bytes).await.map_err(|_|local())?;sha.update(bytes);qiniu.update(bytes);cp.offset=next;cp.prefix_sha256=hex(sha.clone().finalize());
                    if cp.offset-last_saved>=CHECKPOINT_BYTES{file.flush().await.map_err(|_|local())?;file.sync_all().await.map_err(|_|local())?;if let Err(error)=persist(&cp,&mut on_checkpoint){write_failed=true;return Err(error)}last_saved=cp.offset;durable=cp.clone();}
                    on_progress(cp.offset,cp.remote.size);
                }
            }
            if cp.offset!=cp.remote.size{return Err(failure("short-read","下载流不完整，断点保留 / Download stream was incomplete; checkpoint retained"))}
            if qiniu.finish()!=cp.remote.etag{return Err(failure("integrity-mismatch","下载内容校验失败，目标文件保持不变 / Download integrity check failed; target preserved"))}
            control.check()?;
            let final_identity=self.stat(context,&cp.key).await?;if !remote(&cp,&final_identity){return Err(changed())}
            file.flush().await.map_err(|_|local())?;file.sync_all().await.map_err(|_|local())?;control.check()?;Ok(())
        }.await;
        if let Err(error)=transfer{
            if write_failed{return Ok(interrupted(durable,error))}
            // Persist a complete prefix at a deliberate pause/network boundary.
            // If fsync or checkpoint persistence fails, never append further.
            if file.flush().await.is_err()||file.sync_all().await.is_err(){return Ok(interrupted(durable,local()))}
            if let Err(save_error)=persist(&cp,&mut on_checkpoint){return Ok(interrupted(durable,save_error))}
            drop(file);
            if control.is_cancelled(){return cancel_download_checkpoint(cp,on_checkpoint).await}
            if control.is_paused(){return Ok(DownloadOutcome::Paused{checkpoint:cp})}
            return Ok(interrupted(cp,error))
        }
        drop(file);cp.phase=DownloadPhase::Committing;
        if let Err(error)=persist(&cp,&mut on_checkpoint){return Ok(interrupted(cp,error))}
        reconcile_download_checkpoint(cp,on_checkpoint).await
    }
}

fn validate_response(response:&reqwest::Response,cp:&DownloadCheckpoint)->Result<(),QiniuError>{
    let status=response.status().as_u16();
    if matches!(status,412|416){return Err(changed())}
    if status!=if cp.offset==0{200}else{206}{return Err(failure("invalid-range","存储服务未返回精确范围响应，未追加数据 / Storage did not return the exact byte range; no data was appended"))}
    if response.headers().get(reqwest::header::CONTENT_ENCODING).is_some_and(|value|value.as_bytes()!=b"identity"){return Err(failure("encoded-range","范围响应包含压缩编码，未追加数据 / Encoded range response was refused; no data was appended"))}
    let etag=response.headers().get(reqwest::header::ETAG).and_then(|value|value.to_str().ok()).ok_or_else(changed)?;
    if etag!=cp.remote.etag&&etag!=format!("\"{}\"",cp.remote.etag){return Err(changed())}
    if response.content_length().is_some_and(|length|length!=cp.remote.size-cp.offset){return Err(changed())}
    if cp.offset>0{
        let range=response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|value|value.to_str().ok()).ok_or_else(changed)?;
        let expected=format!("bytes {}-{}/{}",cp.offset,cp.remote.size-1,cp.remote.size);
        if range!=expected{return Err(failure("invalid-range","范围起点、终点或总长度与断点不一致 / Range start, end or total differs from the checkpoint"))}
    }else if response.headers().contains_key(reqwest::header::CONTENT_RANGE){return Err(changed())}
    Ok(())
}

#[cfg(test)]
#[path="range_download_tests.rs"]
mod tests;
