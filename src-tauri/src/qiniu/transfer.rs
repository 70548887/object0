//! Bounded native form upload and integrity-checked streaming download.
//! Multipart/resume is deliberately not claimed by this implementation.
use super::{QiniuClient,QiniuError,CapabilityState,ResolvedBucketContext};
use base64::{engine::general_purpose::URL_SAFE,Engine};
use futures_util::future::{select,Either};
use sha1::{Digest,Sha1};
use std::{path::{Path,PathBuf},sync::atomic::{AtomicBool,Ordering},time::Duration};
use tokio::io::{AsyncReadExt,AsyncWriteExt};

pub const FORM_UPLOAD_LIMIT:u64=5*1024*1024;
const HASH_BLOCK:usize=4*1024*1024;
const CANCELLED:&str="七牛传输已取消 / Qiniu transfer cancelled";

/// Streaming Qiniu ETag, not an S3 multipart ETag.
pub struct QiniuEtag {current:Sha1,current_bytes:usize,blocks:Vec<[u8;20]>,total:u64}
impl Default for QiniuEtag {fn default()->Self{Self {current:Sha1::new(),current_bytes:0,blocks:vec![],total:0}}}
impl QiniuEtag {
    pub fn update(&mut self,mut bytes:&[u8]) {
        while !bytes.is_empty(){
            let take=(HASH_BLOCK-self.current_bytes).min(bytes.len());
            self.current.update(&bytes[..take]);self.current_bytes+=take;self.total+=take as u64;bytes=&bytes[take..];
            if self.current_bytes==HASH_BLOCK {self.blocks.push(std::mem::take(&mut self.current).finalize().into());self.current_bytes=0;}
        }
    }
    pub fn finish(mut self)->String {
        if self.current_bytes>0||self.blocks.is_empty(){self.blocks.push(self.current.finalize().into());}
        let mut result=Vec::with_capacity(21);
        if self.total<=HASH_BLOCK as u64 {result.push(0x16);result.extend_from_slice(&self.blocks[0]);}
        else{result.push(0x96);let mut hasher=Sha1::new();for block in self.blocks {hasher.update(block);}result.extend_from_slice(&hasher.finalize());}
        URL_SAFE.encode(result)
    }
}
fn cancelled(cancel:&AtomicBool)->Result<(),QiniuError>{if cancel.load(Ordering::SeqCst){Err(QiniuError::new(CapabilityState::Unavailable,"cancelled",CANCELLED))}else{Ok(())}}
async fn cancellable<T>(operation:impl std::future::Future<Output=Result<T,reqwest::Error>>,cancel:&AtomicBool)->Result<T,QiniuError>{
    let mut pending=Box::pin(operation);
    loop {
        cancelled(cancel)?;
        match select(pending,Box::pin(tokio::time::sleep(Duration::from_millis(100)))).await {
            Either::Left((result,_))=>return result.map_err(|error|{
                let (code,message)=if error.is_timeout(){("timeout","七牛传输超时 / Qiniu transfer timed out")}else{("transport-failed","七牛传输失败，请检查网络与服务配置 / Qiniu transfer failed; check network and service settings")};
                QiniuError::new(CapabilityState::Unavailable,code,message)
            }),
            Either::Right((_,operation))=>pending=operation,
        }
    }
}
fn io_error()->QiniuError{QiniuError::new(CapabilityState::Unavailable,"local-io","本地文件操作失败，请检查空间、路径和权限 / Local file operation failed; check disk space, path and permissions")}

impl QiniuClient {
    /// Internal use only after qiniu_download::resolve_domain has validated a
    /// user selection against the current bucket's trusted domain report.
    /// The cached account client is never mutated by a per-operation choice.
    pub(crate) fn for_validated_download_domain(&self,domain:&str)->Result<Self,QiniuError>{
        let url=super::endpoint::parse_download_origin(domain,self.config.mode)?;
        let mut cloned=self.clone();cloned.config.download_domain=Some(url.as_str().trim_end_matches('/').to_string());Ok(cloned)
    }
    /// Small files only. Progress reports 0 and verified completion; it does not
    /// fabricate upload wire progress while an HTTP body is buffered.
    pub async fn upload_file(&self,context:&ResolvedBucketContext,key:&str,path:&Path,overwrite:bool,file_type:Option<u8>,cancel:&AtomicBool,on_progress:impl FnMut(u64,u64))->Result<u64,QiniuError>{
        cancelled(cancel)?;
        if context.bucket.permission.as_deref()==Some("readonly"){return Err(QiniuError::new(CapabilityState::Forbidden,"read-only","此空间只有读取权限 / Bucket is read-only"));}
        let metadata=tokio::fs::metadata(path).await.map_err(|_|io_error())?;
        if !metadata.is_file(){return Err(QiniuError::invalid("上传来源不是文件 / Upload source is not a file"));}
        if metadata.len()>FORM_UPLOAD_LIMIT{return Err(QiniuError::unsupported("文件超过 5 MiB 表单上传上限，请重新选择以进入持久分片队列 / File exceeds the 5 MiB form-upload limit; select it again to use the durable multipart queue"));}
        if let Some(file_type)=file_type {if !context.region.storage_classes.iter().any(|kind|kind.file_type==file_type){return Err(QiniuError::unsupported("当前区域未确认支持该存储类型 / Storage type is not supported by this region"));}}
        let mut bytes=Vec::with_capacity(metadata.len() as usize);
        let source=tokio::fs::File::open(path).await.map_err(|_|io_error())?;
        source.take(FORM_UPLOAD_LIMIT+1).read_to_end(&mut bytes).await.map_err(|_|io_error())?;
        let after=tokio::fs::metadata(path).await.map_err(|_|io_error())?;
        if bytes.len() as u64!=metadata.len()||bytes.len() as u64>FORM_UPLOAD_LIMIT||after.len()!=metadata.len()||after.modified().ok()!=metadata.modified().ok(){return Err(QiniuError::invalid("来源文件在准备上传时已变化 / Upload source changed"));}
        cancelled(cancel)?;
        self.put_native_form(context,key,&bytes,overwrite,file_type,cancel,on_progress).await
    }
    async fn put_native_form(&self,context:&ResolvedBucketContext,key:&str,bytes:&[u8],overwrite:bool,file_type:Option<u8>,cancel:&AtomicBool,mut on_progress:impl FnMut(u64,u64))->Result<u64,QiniuError>{
        cancelled(cancel)?;
        if context.bucket.permission.as_deref()==Some("readonly"){return Err(QiniuError::new(CapabilityState::Forbidden,"read-only","此空间只有读取权限 / Bucket is read-only"));}
        if bytes.len() as u64>FORM_UPLOAD_LIMIT{return Err(QiniuError::unsupported("原生表单上传文件超过 5 MiB / Native form upload exceeds 5 MiB"));}
        let endpoint=self.service(context,"up")?;
        self.policy.ensure(&endpoint)?;
        let token=self.upload_token(&context.bucket.name,key,chrono::Utc::now().timestamp()+3600,file_type,overwrite)?;
        let mut hash=QiniuEtag::default();hash.update(&bytes);let expected_hash=hash.finish();
        let boundary=format!("yuncang-{}",uuid::Uuid::new_v4().simple());
        let mut body=Vec::with_capacity(bytes.len()+4096);
        for(name,value)in [("key",key),("token",token.as_str())]{body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());}
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"upload.bin\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
        body.extend_from_slice(&bytes);body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        on_progress(0,bytes.len() as u64);
        let mut response=cancellable(self.http.post(endpoint.as_str()).header(reqwest::header::CONTENT_TYPE,format!("multipart/form-data; boundary={boundary}")).body(body).send(),cancel).await?;
        if !response.status().is_success(){return Err(QiniuError::http(response.status().as_u16()));}
        let mut result=Vec::new();
        while let Some(chunk)=cancellable(response.chunk(),cancel).await? {if result.len()+chunk.len()>64*1024{return Err(QiniuError::invalid("上传响应过大 / Upload response is too large"));}result.extend_from_slice(&chunk);}
        let value:serde_json::Value=serde_json::from_slice(&result).map_err(|_|QiniuError::invalid("上传响应格式无效 / Invalid upload response"))?;
        if value.get("key").and_then(serde_json::Value::as_str)!=Some(key)||value.get("hash").and_then(serde_json::Value::as_str)!=Some(expected_hash.as_str()){return Err(QiniuError::new(CapabilityState::Unavailable,"integrity-mismatch","上传返回的对象名称或内容校验不匹配，请检查目标文件 / Uploaded object identity or checksum did not match"));}
        cancelled(cancel)?;
        on_progress(bytes.len() as u64,bytes.len() as u64);Ok(bytes.len() as u64)
    }
    pub async fn upload_empty_marker(&self,context:&ResolvedBucketContext,key:&str,cancel:&AtomicBool)->Result<(),QiniuError>{
        if !key.ends_with('/')||key=="/"{return Err(QiniuError::invalid("目录占位对象必须是非空目录路径 / Folder marker must be a nonempty directory path"));}
        self.put_native_form(context,key,&[],false,None,cancel,|_,_|{}).await?;Ok(())
    }
    /// Downloads only through the explicitly configured domain. Existing files
    /// remain intact until the complete download passes size+hash validation.
    pub async fn download_file(&self,context:&ResolvedBucketContext,key:&str,path:&Path,overwrite:bool,cancel:&AtomicBool,mut on_progress:impl FnMut(u64,u64))->Result<u64,QiniuError>{
        cancelled(cancel)?;
        let domain=self.config.download_domain.as_deref().ok_or_else(||QiniuError::invalid("请先配置可信下载域名 / Configure a trusted download domain first"))?;
        let url=super::endpoint::object_url(domain,key,true)?;
        let object=self.stat(context,key).await?;
        if matches!(object.storage_type,Some(2|3))&&object.restore_status!=Some(2){return Err(QiniuError::invalid("归档对象必须先完成解冻 / Restore the archived object before download"));}
        if !valid_native_hash(&object.etag){return Err(QiniuError::unsupported("未取得可验证的七牛内容哈希，下载未开始 / A verifiable Qiniu content hash is required"));}
        let signed=self.signed_download_url(&url,chrono::Utc::now().timestamp()+3600)?;
        let parent=path.parent().filter(|parent|!parent.as_os_str().is_empty()).unwrap_or_else(||Path::new("."));
        if !parent.is_dir(){return Err(io_error());}
        if path.exists()&&!overwrite{return Err(QiniuError::new(CapabilityState::Unavailable,"target-exists","下载目标已存在 / Download destination already exists"));}
        let temporary=parent.join(format!(".yuncang-{}.part",uuid::Uuid::new_v4().simple()));
        let mut temporary_guard=TemporaryFile(Some(temporary.clone()));
        let mut file=tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).await.map_err(|_|io_error())?;
        on_progress(0,object.size);
        let mut response=cancellable(self.http.get(signed.as_str()).timeout(Duration::from_secs(1200)).header(reqwest::header::IF_MATCH,format!("\"{}\"",object.etag)).send(),cancel).await?;
        if !response.status().is_success(){return Err(QiniuError::http(response.status().as_u16()));}
        if response.status().as_u16()!=200{return Err(QiniuError::invalid("下载响应不是完整文件 / Expected a complete file download response"));}
        if response.content_length().is_some_and(|length|length!=object.size){return Err(QiniuError::new(CapabilityState::Unavailable,"object-changed","下载对象大小已变化 / Download object size changed"));}
        let mut transferred=0u64;let mut hash=QiniuEtag::default();
        while let Some(chunk)=cancellable(response.chunk(),cancel).await? {
            cancelled(cancel)?;transferred=transferred.checked_add(chunk.len() as u64).ok_or_else(io_error)?;
            if transferred>object.size{return Err(QiniuError::new(CapabilityState::Unavailable,"integrity-mismatch","下载数据超出预期大小 / Download exceeds expected size"));}
            hash.update(&chunk);file.write_all(&chunk).await.map_err(|_|io_error())?;on_progress(transferred,object.size);
        }
        if transferred!=object.size||hash.finish()!=object.etag{return Err(QiniuError::new(CapabilityState::Unavailable,"integrity-mismatch","下载文件的大小或内容校验失败，原文件保持不变 / Download integrity check failed; original file preserved"));}
        cancelled(cancel)?;file.flush().await.map_err(|_|io_error())?;file.sync_all().await.map_err(|_|io_error())?;drop(file);
        if overwrite {tokio::fs::rename(&temporary,path).await.map_err(|_|io_error())?;temporary_guard.0=None;}
        else {
            // Same-directory hard link is atomic create-if-absent, so a newly
            // created user's target cannot be overwritten by a race.
            tokio::fs::hard_link(&temporary,path).await.map_err(|_|io_error())?;
            tokio::fs::remove_file(&temporary).await.map_err(|_|io_error())?;temporary_guard.0=None;
        }
        on_progress(transferred,object.size);Ok(transferred)
    }
}
fn valid_native_hash(value:&str)->bool{URL_SAFE.decode(value).is_ok_and(|bytes|bytes.len()==21&&matches!(bytes[0],0x16|0x96))}
struct TemporaryFile(Option<PathBuf>);
impl Drop for TemporaryFile{fn drop(&mut self){if let Some(path)=&self.0{let _=std::fs::remove_file(path);}}}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn qiniu_hash_empty_and_hello_match_known_sha1_vectors(){let empty=QiniuEtag::default().finish();assert_eq!(empty,"Fto5o-5ea0sNMlW_75VgGJCv2AcJ");let mut hash=QiniuEtag::default();hash.update(b"hello");assert_eq!(hash.finish(),"Fqr0xh3cxeii2r7eDztILNmuqUNN");}
    #[test]fn streaming_chunk_boundaries_do_not_change_the_hash(){let bytes=vec![42u8;HASH_BLOCK+3];let mut all=QiniuEtag::default();all.update(&bytes);let mut chunks=QiniuEtag::default();for chunk in bytes.chunks(7){chunks.update(chunk);}assert_eq!(all.finish(),chunks.finish());}
    #[test]fn partial_temp_file_guard_never_removes_a_separate_target(){let root=std::env::temp_dir().join(format!("qiniu-temp-{}",uuid::Uuid::new_v4().simple()));std::fs::create_dir(&root).unwrap();let target=root.join("original");let part=root.join("part");std::fs::write(&target,b"keep").unwrap();std::fs::write(&part,b"discard").unwrap();drop(TemporaryFile(Some(part.clone())));assert!(!part.exists());assert_eq!(std::fs::read(&target).unwrap(),b"keep");std::fs::remove_file(target).unwrap();std::fs::remove_dir(root).unwrap();}
    #[test]fn cancellation_and_hash_format_are_explicit(){assert_eq!(cancelled(&AtomicBool::new(true)).unwrap_err().code,"cancelled");assert!(!valid_native_hash("s3-etag-123"));assert!(valid_native_hash("Fqr0xh3cxeii2r7eDztILNmuqUNN"));}
}
