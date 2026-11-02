//! Authenticated native-download manifests. Restoring this store never opens
//! a destination/partial file or performs a network request.
use crate::qiniu::range_download::{DownloadCheckpoint,DownloadPhase};
use crate::JobLocation;
use aes_gcm::{aead::{Aead,KeyInit,Payload},Aes256Gcm,Nonce};
use base64::{engine::general_purpose::{STANDARD,URL_SAFE},Engine};
use rand::RngCore;
use serde::{Deserialize,Serialize};
use std::{fmt,fs::{self,OpenOptions},io::{Read,Write},path::{Component,Path,PathBuf},sync::{Mutex,OnceLock}};

pub(crate) const RECORD_VERSION:u8=1;
pub(crate) const MAX_RECORDS:usize=200;
pub(crate) const MAX_RECORD_BYTES:u64=16*1024*1024;
const MAX_REMOTE_BYTES:u64=9_007_199_254_740_991;
const EMPTY_SHA256:&str="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const INVALID:&str="持久下载记录无效或版本不支持，未执行下载 / Invalid or unsupported durable-download record; no download was executed";
const IO_ERROR:&str="无法保存或读取持久下载记录，请检查磁盘、路径和权限 / Could not save or read durable-download state; check disk, path and permissions";
const UNSAFE:&str="持久下载目录或记录包含不安全链接，操作已停止 / Durable-download store contains an unsafe link; operation stopped";
const AUTH:&str="持久下载记录验证失败，不能信任其中的路径和断点 / Durable-download authentication failed; paths and checkpoints must not be trusted";
const LIMIT:&str="持久下载任务数量或记录大小超过限制 / Durable-download count or record size exceeds the limit";

#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="kebab-case")]
pub(crate) enum DownloadState {Queued,Running,Paused,Interrupted,Completed,Cancelled}
impl DownloadState {
    pub(crate) fn after_restart(self)->Self{match self{Self::Queued|Self::Running=>Self::Interrupted,other=>other}}
    pub(crate) fn terminal(self)->bool{matches!(self,Self::Completed|Self::Cancelled)}
}

#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct DownloadRecord {
    pub format_version:u8,
    pub job_id:String,
    pub profile_id:String,
    pub profile_revision:String,
    pub bucket:String,
    pub key:String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub location:Option<JobLocation>,
    pub checkpoint:DownloadCheckpoint,
    pub state:DownloadState,
    #[serde(default="default_attempt")]
    pub attempt:u64,
    #[serde(default)]
    pub cancel_requested:bool,
    pub created_at:String,
    pub updated_at:String,
    pub error:Option<String>,
}
fn default_attempt()->u64{1}
impl fmt::Debug for DownloadRecord {
    fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result{f.debug_struct("DownloadRecord").field("state",&self.state).field("size",&self.checkpoint.remote.size).field("offset",&self.checkpoint.offset).finish_non_exhaustive()}
}
fn valid_id(value:&str)->bool{uuid::Uuid::parse_str(value).is_ok_and(|id|id.hyphenated().to_string()==value)}
fn safe_text(value:&str,max:usize)->bool{!value.is_empty()&&value.len()<=max&&!value.chars().any(|c|c.is_control())}
fn valid_hash(value:&str)->bool{value.len()==64&&value.bytes().all(|b|b.is_ascii_hexdigit())}
fn path_shape(path:&Path)->bool{path.is_absolute()&&!path.components().any(|part|matches!(part,Component::ParentDir|Component::CurDir))}
fn is_reparse(metadata:&fs::Metadata)->bool{
    #[cfg(windows)]{use std::os::windows::fs::MetadataExt;metadata.file_attributes()&0x400!=0}
    #[cfg(not(windows))]{metadata.file_type().is_symlink()}
}
fn check_components(path:&Path)->Result<(),String>{
    if !path_shape(path){return Err(UNSAFE.into())}
    let mut current=PathBuf::new();
    for part in path.components(){
        current.push(part.as_os_str());
        if matches!(part,Component::Prefix(_))||!current.is_absolute(){continue;}
        match fs::symlink_metadata(&current){
            Ok(meta)if is_reparse(&meta)||meta.file_type().is_symlink()=>return Err(UNSAFE.into()),
            Ok(_)=>{},Err(error)if error.kind()==std::io::ErrorKind::NotFound=>{},Err(_)=>return Err(IO_ERROR.into()),
        }
    }
    Ok(())
}
fn validate_record(record:&DownloadRecord)->Result<(),String>{
    if !crate::job_location::matches_record(record.location.as_ref(),&record.profile_id,&record.bucket,&record.key){return Err(INVALID.into())}
    let cp=&record.checkpoint;
    if record.format_version!=RECORD_VERSION||!valid_id(&record.job_id)||record.attempt==0
        ||!safe_text(&record.profile_id,512)||!safe_text(&record.profile_revision,512)
        ||!safe_text(&record.bucket,255)||record.bucket.contains(['/', '\\'])
        ||record.key.is_empty()||record.key.len()>4096||record.key.contains('\0')
        ||chrono::DateTime::parse_from_rfc3339(&record.created_at).is_err()
        ||chrono::DateTime::parse_from_rfc3339(&record.updated_at).is_err()
        ||cp.format_version!=RECORD_VERSION||cp.job_id!=record.job_id
        ||cp.profile_id!=record.profile_id||cp.profile_revision!=record.profile_revision
        ||cp.bucket!=record.bucket||cp.key!=record.key{return Err(INVALID.into())}
    if record.error.as_ref().is_some_and(|message|{
        let lower=message.to_ascii_lowercase();!safe_text(message,2048)||["https://","http://","authorization:","bearer ","x-amz-","secretaccesskey","sessiontoken","uploadtoken","downloadtoken"].iter().any(|term|lower.contains(term))
    }){return Err(INVALID.into())}
    let domain=crate::qiniu::endpoint::parse_endpoint(&cp.domain,true).map_err(|_|INVALID.to_string())?;
    let origin=domain.origin().ascii_serialization();
    if cp.domain!=origin&&cp.domain!=format!("{origin}/"){return Err(INVALID.into())}
    let target=Path::new(&cp.target_path);let partial=Path::new(&cp.partial_path);
    if cp.target_path.len()>32768||cp.partial_path.len()>32768
        ||!path_shape(target)||!path_shape(partial)||target.file_name().is_none()
        ||target.parent()!=partial.parent()||target==partial
        ||partial.file_name().and_then(|name|name.to_str())!=Some(format!(".yuncang-range-{}.part",record.job_id).as_str())
        ||cp.remote.size>MAX_REMOTE_BYTES||cp.offset>cp.remote.size
        ||!URL_SAFE.decode(&cp.remote.etag).is_ok_and(|hash|hash.len()==21&&matches!(hash[0],0x16|0x96))
        ||chrono::DateTime::parse_from_rfc3339(&cp.remote.last_modified).is_err()
        ||!valid_hash(&cp.prefix_sha256)||(cp.offset==0&&cp.prefix_sha256!=EMPTY_SHA256)
        ||cp.partial_created.as_ref().is_some_and(|stamp|!safe_text(stamp,256))
        ||(cp.offset>0&&cp.partial_created.is_none())
        ||(matches!(cp.phase,DownloadPhase::Committing|DownloadPhase::Completed)&&(cp.offset!=cp.remote.size||cp.partial_created.is_none()))
        ||(record.state==DownloadState::Completed&&cp.phase!=DownloadPhase::Completed)
        ||(record.state==DownloadState::Cancelled&&cp.phase!=DownloadPhase::Cancelled)
        ||(record.state==DownloadState::Paused&&cp.phase!=DownloadPhase::Downloading){return Err(INVALID.into())}
    Ok(())
}

#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Envelope{version:u8,nonce:String,ciphertext:String}
#[derive(Default)]
pub(crate) struct LoadReport{pub records:Vec<DownloadRecord>,pub unreadable_count:usize}
impl fmt::Debug for LoadReport{fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result{f.debug_struct("DownloadLoadReport").field("record_count",&self.records.len()).field("unreadable_count",&self.unreadable_count).finish()}}
pub(crate) struct Store{root:PathBuf,key:[u8;32]}
impl fmt::Debug for Store{fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result{f.write_str("NativeDownloadStore([REDACTED])")}}
impl Drop for Store{fn drop(&mut self){self.key.fill(0);}}
fn gate()->&'static Mutex<()>{static GATE:OnceLock<Mutex<()>>=OnceLock::new();GATE.get_or_init(||Mutex::new(()))}
impl Store {
    pub(crate) fn record_count(root:&Path)->Result<usize,String>{
        let _lock=gate().lock().map_err(|_|IO_ERROR.to_string())?;check_components(root)?;
        let metadata=match fs::symlink_metadata(root){Ok(metadata)=>metadata,Err(error)if error.kind()==std::io::ErrorKind::NotFound=>return Ok(0),Err(_)=>return Err(IO_ERROR.into())};
        if !metadata.is_dir()||is_reparse(&metadata)||metadata.file_type().is_symlink(){return Err(UNSAFE.into())}
        let mut count=0usize;
        for entry in fs::read_dir(root).map_err(|_|IO_ERROR.to_string())?{
            let entry=entry.map_err(|_|IO_ERROR.to_string())?;let name=entry.file_name();let name=name.to_string_lossy();
            let Some(id)=name.strip_suffix(".download")else{continue};if !valid_id(id){return Err(INVALID.into())}
            let metadata=fs::symlink_metadata(entry.path()).map_err(|_|IO_ERROR.to_string())?;
            if !metadata.is_file()||is_reparse(&metadata)||metadata.file_type().is_symlink(){return Err(UNSAFE.into())}
            count+=1;if count>MAX_RECORDS{return Err(LIMIT.into())}
        }
        Ok(count)
    }
    pub(crate) fn for_app(key:&[u8;32])->Result<Self,String>{Self::new(&crate::config_paths::object0_config_dir()?.join("native-download-jobs"),key)}
    pub(crate) fn new(root:&Path,key:&[u8;32])->Result<Self,String>{
        check_components(root)?;fs::create_dir_all(root).map_err(|_|IO_ERROR.to_string())?;check_components(root)?;
        if !root.is_dir(){return Err(UNSAFE.into())}let root=root.canonicalize().map_err(|_|IO_ERROR.to_string())?;check_components(&root)?;
        Ok(Self{root,key:*key})
    }
    fn path(&self,id:&str)->Result<PathBuf,String>{
        if !valid_id(id){return Err(INVALID.into())}check_components(&self.root)?;let path=self.root.join(format!("{id}.download"));check_components(&path)?;Ok(path)
    }
    fn aad(id:&str)->Vec<u8>{format!("yuncang-native-download-v1:{id}").into_bytes()}
    fn seal(&self,id:&str,plain:&[u8])->Result<Vec<u8>,String>{
        let mut nonce=[0u8;12];rand::rngs::OsRng.fill_bytes(&mut nonce);
        let cipher=Aes256Gcm::new_from_slice(&self.key).map_err(|_|AUTH.to_string())?;
        let ciphertext=cipher.encrypt(Nonce::from_slice(&nonce),Payload{msg:plain,aad:&Self::aad(id)}).map_err(|_|AUTH.to_string())?;
        serde_json::to_vec(&Envelope{version:RECORD_VERSION,nonce:STANDARD.encode(nonce),ciphertext:STANDARD.encode(ciphertext)}).map_err(|_|INVALID.to_string())
    }
    fn unseal(&self,id:&str,bytes:&[u8])->Result<Vec<u8>,String>{
        let envelope:Envelope=serde_json::from_slice(bytes).map_err(|_|INVALID.to_string())?;
        if envelope.version!=RECORD_VERSION{return Err(INVALID.into())}
        let nonce=STANDARD.decode(envelope.nonce).map_err(|_|INVALID.to_string())?;if nonce.len()!=12{return Err(INVALID.into())}
        let ciphertext=STANDARD.decode(envelope.ciphertext).map_err(|_|INVALID.to_string())?;
        Aes256Gcm::new_from_slice(&self.key).map_err(|_|AUTH.to_string())?.decrypt(Nonce::from_slice(&nonce),Payload{msg:&ciphertext,aad:&Self::aad(id)}).map_err(|_|AUTH.to_string())
    }
    fn entries(&self)->Result<Vec<fs::DirEntry>,String>{
        check_components(&self.root)?;let mut entries=Vec::new();
        for item in fs::read_dir(&self.root).map_err(|_|IO_ERROR.to_string())?{
            let item=item.map_err(|_|IO_ERROR.to_string())?;if item.file_name().to_string_lossy().ends_with(".download"){entries.push(item);if entries.len()>MAX_RECORDS{return Err(LIMIT.into())}}
        }
        entries.sort_by_key(|entry|entry.file_name());Ok(entries)
    }
    fn load_unlocked(&self,id:&str)->Result<Option<DownloadRecord>,String>{
        let path=self.path(id)?;let mut options=OpenOptions::new();options.read(true);
        #[cfg(windows)]{use std::os::windows::fs::OpenOptionsExt;options.custom_flags(0x0020_0000);}
        let file=match options.open(&path){Ok(file)=>file,Err(error)if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err(IO_ERROR.into())};
        let metadata=file.metadata().map_err(|_|IO_ERROR.to_string())?;
        if !metadata.is_file()||is_reparse(&metadata)||metadata.file_type().is_symlink(){return Err(UNSAFE.into())}
        if metadata.len()>MAX_RECORD_BYTES{return Err(LIMIT.into())}
        let mut bytes=Vec::new();file.take(MAX_RECORD_BYTES+1).read_to_end(&mut bytes).map_err(|_|IO_ERROR.to_string())?;if bytes.len() as u64>MAX_RECORD_BYTES{return Err(LIMIT.into())}
        let mut plain=self.unseal(id,&bytes)?;let parsed=serde_json::from_slice::<DownloadRecord>(&plain).map_err(|_|INVALID.to_string());plain.fill(0);let record=parsed?;
        if record.job_id!=id{return Err(AUTH.into())}validate_record(&record)?;Ok(Some(record))
    }
    pub(crate) fn load(&self,id:&str)->Result<Option<DownloadRecord>,String>{let _lock=gate().lock().map_err(|_|IO_ERROR.to_string())?;self.load_unlocked(id)}
    pub(crate) fn load_all(&self)->Result<LoadReport,String>{
        let _lock=gate().lock().map_err(|_|IO_ERROR.to_string())?;let mut report=LoadReport::default();
        for entry in self.entries()?{let name=entry.file_name();let name=name.to_string_lossy();let id=name.strip_suffix(".download").ok_or_else(||INVALID.to_string())?;match self.load_unlocked(id){Ok(Some(record))=>report.records.push(record),_=>report.unreadable_count+=1}}
        Ok(report)
    }
    fn immutable_binding_equal(a:&DownloadRecord,b:&DownloadRecord)->bool{
        let x=&a.checkpoint;let y=&b.checkpoint;
        a.job_id==b.job_id&&a.profile_id==b.profile_id&&a.profile_revision==b.profile_revision&&a.bucket==b.bucket&&a.key==b.key&&a.created_at==b.created_at
            &&x.format_version==y.format_version&&x.job_id==y.job_id&&x.profile_id==y.profile_id&&x.profile_revision==y.profile_revision&&x.bucket==y.bucket&&x.key==y.key
            &&x.domain==y.domain&&x.target_path==y.target_path&&x.partial_path==y.partial_path&&x.remote==y.remote
    }
    pub(crate) fn save(&self,record:&DownloadRecord)->Result<(),String>{self.save_before_commit(record,||Ok(()))}
    fn save_before_commit(&self,record:&DownloadRecord,before_commit:impl FnOnce()->Result<(),String>)->Result<(),String>{
        let _lock=gate().lock().map_err(|_|IO_ERROR.to_string())?;validate_record(record)?;let path=self.path(&record.job_id)?;let existing=self.load_unlocked(&record.job_id)?;
        if let Some(old)=&existing{
            let x=&old.checkpoint;let y=&record.checkpoint;
            if !Self::immutable_binding_equal(old,record)||record.attempt<old.attempt||(old.cancel_requested&&!record.cancel_requested)
                ||(old.state.terminal()&&old.state!=record.state)||y.offset<x.offset
                ||(y.offset==x.offset&&y.prefix_sha256!=x.prefix_sha256)
                ||(x.partial_created.is_some()&&x.partial_created!=y.partial_created)
                ||(matches!(x.phase,DownloadPhase::Committing|DownloadPhase::Completed)&&y.phase==DownloadPhase::Downloading)
                ||(x.phase==DownloadPhase::Completed&&y.phase!=DownloadPhase::Completed)
                ||(x.phase==DownloadPhase::Cancelled&&y.phase!=DownloadPhase::Cancelled){return Err(INVALID.into())}
        }else if self.entries()?.len()>=MAX_RECORDS{return Err(LIMIT.into())}
        let mut plaintext=serde_json::to_vec(record).map_err(|_|INVALID.to_string())?;
        if plaintext.len() as u64>MAX_RECORD_BYTES{plaintext.fill(0);return Err(LIMIT.into())}
        let sealed=self.seal(&record.job_id,&plaintext);plaintext.fill(0);let bytes=sealed?;if bytes.len() as u64>MAX_RECORD_BYTES{return Err(LIMIT.into())}
        let temporary=self.root.join(format!(".{}-{}.tmp",record.job_id,uuid::Uuid::new_v4()));
        let mut owned_temporary=false;
        let result=(||{
            let mut options=OpenOptions::new();options.write(true).create_new(true);
            #[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
            let mut file=options.open(&temporary).map_err(|_|IO_ERROR.to_string())?;owned_temporary=true;file.write_all(&bytes).map_err(|_|IO_ERROR.to_string())?;file.sync_all().map_err(|_|IO_ERROR.to_string())?;drop(file);
            before_commit()?;self.path(&record.job_id)?;fs::rename(&temporary,&path).map_err(|_|IO_ERROR.to_string())
        })();if result.is_err()&&owned_temporary{let _=fs::remove_file(&temporary);}result
    }
    pub(crate) fn remove(&self,id:&str)->Result<(),String>{
        let _lock=gate().lock().map_err(|_|IO_ERROR.to_string())?;let path=self.path(id)?;match fs::remove_file(path){Ok(())=>Ok(()),Err(error)if error.kind()==std::io::ErrorKind::NotFound=>Ok(()),Err(_)=>Err(IO_ERROR.into())}
    }
}

#[cfg(test)]
#[path="native_download_store_tests.rs"]
mod tests;
