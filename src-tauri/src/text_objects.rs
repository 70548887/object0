//! Bounded UTF-8 editing with fail-closed object preconditions. No credentials
//! or text contents are logged, persisted as tasks, or returned in errors.
use super::*;
use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use std::error::Error;

pub(crate) const MAX_TEXT_BYTES: usize = 1024 * 1024;
const CONFLICT: &str = "条件写入冲突，请重新读取确认远端内容；不会降级为无条件覆盖 / Conditional write conflict; reload to confirm the remote content. Unconditional overwrite is never used";
const LIMIT: &str = "文本编辑仅支持不超过 1 MiB 的 UTF-8 TXT/Markdown 文件 / Text editing supports UTF-8 TXT/Markdown files up to 1 MiB";
const IDENTITY: &str = "对象没有可靠的版本标识，不能安全编辑 / Object has no reliable ETag; safe editing is unavailable";
const UNSUPPORTED: &str = "七牛原生条件写入尚未验证，暂不支持此文本编辑功能 / Qiniu native conditional writes are unverified; this text editor is unavailable";
const EDIT_PROVIDER: &str = "当前仅 R2 支持保留属性的安全文本编辑；其他 S3 可新建文本文件 / Safe text editing with preserved attributes is currently R2-only; other S3 providers can create text files";

#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct ReadInput {
    pub profile_id: String,
    pub expected_profile_revision: String,
    pub bucket: String,
    pub key: String,
}

// No Debug: editor content must not enter diagnostic logs.
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct WriteInput {
    pub profile_id: String,
    pub expected_profile_revision: String,
    pub bucket: String,
    pub key: String,
    pub content: String,
    pub expected_etag: Option<String>,
    pub create_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct ReadOutput {
    pub content: String,
    pub etag: String,
    pub content_type: String,
    pub byte_length: usize,
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct WriteOutput {
    pub etag: Option<String>,
    pub byte_length: usize,
}

fn validate_key(bucket:&str,key:&str)->Result<(),String> {
    let name=key.rsplit('/').next().unwrap_or_default();
    let lower=name.to_ascii_lowercase();
    let valid=[".txt",".md",".markdown"].iter().any(|ext|lower.ends_with(ext) && lower.len()>ext.len());
    if bucket.is_empty() || key.len()>1024 || key.chars().any(|c|matches!(c,'\0'|'\r'|'\n')) || !valid {return Err(LIMIT.into())}
    Ok(())
}

fn validate_text(content:&str)->Result<(),String> {
    if content.len()>MAX_TEXT_BYTES || content.chars().any(|c|c.is_control() && !matches!(c,'\n'|'\r'|'\t')) {return Err(LIMIT.into())}
    Ok(())
}

fn stable_etag(etag:Option<&str>)->Result<&str,String> {
    let value=etag.ok_or_else(||IDENTITY.to_string())?;
    if value.len()<3 || value.len()>1024 || !value.starts_with('"') || !value.ends_with('"')
        || value[1..value.len()-1].bytes().any(|byte|byte<0x21 || byte>0x7e || byte==b'"') {
        return Err(IDENTITY.into())
    }
    Ok(value)
}

fn validate_encoding(encoding:Option<&str>,content_type:Option<&str>)->Result<(),String> {
    if encoding.is_some_and(|value|!value.trim().is_empty() && !value.trim().eq_ignore_ascii_case("identity")) {
        return Err("压缩或编码对象不能直接编辑，避免损坏原文件 / Encoded or compressed objects cannot be edited directly".into())
    }
    if let Some(kind)=content_type {
        for parameter in kind.split(';').skip(1) {
            if let Some((name,value))=parameter.trim().split_once('=') {
                let charset=value.trim().trim_matches('"');
                if name.trim().eq_ignore_ascii_case("charset") && !charset.eq_ignore_ascii_case("utf-8") && !charset.eq_ignore_ascii_case("utf8") {
                    return Err("文件声明的字符编码不是 UTF-8，不能直接编辑 / The declared charset is not UTF-8; direct editing is unavailable".into())
                }
            }
        }
    }
    Ok(())
}

fn failure<E>(error:&SdkError<E>)->String where E:ProvideErrorMetadata+Error+'static {
    let status=error.raw_response().map(|response|response.status().as_u16());
    let code=error.as_service_error().and_then(|value|value.code());
    if matches!(status,Some(409|412)) || matches!(code,Some("PreconditionFailed"|"ConditionalRequestConflict")) {return CONFLICT.into()}
    if status==Some(404) {return "文件不存在或已删除，请刷新列表 / File does not exist or was deleted; refresh the list".into()}
    if matches!(status,Some(401|403)) {return "文本操作被拒绝，请检查当前存储桶的对象读取和写入权限 / Text operation denied; check object read and write permissions for this bucket".into()}
    format!("{} / Text operation failed; check permissions, connection and conditional-write support",s3_errors::describe("文本操作",error))
}

fn bound_profile(state:&AppState,id:&str,revision:&str)->Result<Profile,String> {
    if revision.is_empty() {return Err("账号版本缺失，请重新打开编辑器 / Account revision is missing; reopen the editor".into())}
    let profile=profile_for_id(state,id)?;
    storage_backend::ensure_expected_revision(&profile,Some(revision))?;
    if profile.provider==S3Provider::Qiniu {return Err(UNSUPPORTED.into())}
    Ok(profile)
}

pub(crate) async fn read_for_state(state:&AppState,input:&ReadInput)->Result<ReadOutput,String> {
    validate_key(&input.bucket,&input.key)?;
    let profile=bound_profile(state,&input.profile_id,&input.expected_profile_revision)?;
    if profile.provider!=S3Provider::R2 {return Err(EDIT_PROVIDER.into())}
    read(&to_s3_client(&profile)?,&input.bucket,&input.key).await
}

pub(crate) async fn write_for_state(state:&AppState,input:&WriteInput)->Result<WriteOutput,String> {
    validate_key(&input.bucket,&input.key)?;
    validate_text(&input.content)?;
    validate_write_identity(input.create_only,input.expected_etag.as_deref())?;
    let profile=bound_profile(state,&input.profile_id,&input.expected_profile_revision)?;
    if !input.create_only && profile.provider!=S3Provider::R2 {return Err(EDIT_PROVIDER.into())}
    write(&to_s3_client(&profile)?,&input.bucket,&input.key,&input.content,input.create_only,input.expected_etag.as_deref()).await
}

fn validate_write_identity(create_only:bool,etag:Option<&str>)->Result<(),String> {
    if create_only {
        if etag.is_some() {return Err("新建请求不能包含旧版本标识 / A create request cannot include an existing ETag".into())}
    } else {stable_etag(etag)?;}
    Ok(())
}

async fn read(client:&S3Client,bucket:&str,key:&str)->Result<ReadOutput,String> {
    validate_key(bucket,key)?;
    let response=client.get_object().bucket(bucket).key(key).send().await.map_err(|error|failure(&error))?;
    if response.content_length().is_some_and(|length|length<0 || length>MAX_TEXT_BYTES as i64) {return Err(LIMIT.into())}
    validate_encoding(response.content_encoding(),response.content_type())?;
    if response.sse_customer_algorithm().is_some() {return Err("SSE-C 加密对象不能在此编辑 / SSE-C encrypted objects cannot be edited here".into())}
    let etag=stable_etag(response.e_tag())?.to_string();
    let kind=response.content_type().unwrap_or("text/plain; charset=utf-8").to_string();
    let mut body=response.body;let mut bytes=Vec::new();
    while let Some(chunk)=body.try_next().await.map_err(|_|"读取文本流失败，未修改远端文件 / Text stream failed; remote file was not changed".to_string())? {
        if chunk.len()>MAX_TEXT_BYTES.saturating_sub(bytes.len()) {return Err(LIMIT.into())}
        bytes.extend_from_slice(&chunk);
    }
    let byte_length=bytes.len();
    // Preserve a UTF-8 BOM as U+FEFF rather than silently stripping it. Other
    // encodings and binary control characters are deliberately rejected.
    let content=String::from_utf8(bytes).map_err(|_|LIMIT.to_string())?;
    validate_text(&content)?;
    Ok(ReadOutput{content,etag,content_type:kind,byte_length})
}

async fn write(client:&S3Client,bucket:&str,key:&str,content:&str,create_only:bool,expected_etag:Option<&str>)->Result<WriteOutput,String> {
    validate_key(bucket,key)?;validate_text(content)?;validate_write_identity(create_only,expected_etag)?;
    let mut request=client.put_object().bucket(bucket).key(key).body(ByteStream::from(content.as_bytes().to_vec()));
    if create_only {
        let kind=if key.to_ascii_lowercase().ends_with(".txt") {"text/plain; charset=utf-8"} else {"text/markdown; charset=utf-8"};
        request=request.if_none_match("*").content_type(kind);
    } else {
        let expected=stable_etag(expected_etag)?;
        let head=client.head_object().bucket(bucket).key(key).if_match(expected).send().await.map_err(|error|failure(&error))?;
        if stable_etag(head.e_tag())?!=expected {return Err(CONFLICT.into())}
        // A bounded GET can measure a body without a declared size. HEAD has
        // no body to measure: missing/negative size must fail closed on edit.
        if !head.content_length().is_some_and(|length|length>=0 && length<=MAX_TEXT_BYTES as i64) {return Err(LIMIT.into())}
        validate_encoding(head.content_encoding(),head.content_type())?;
        if head.sse_customer_algorithm().is_some() {return Err("SSE-C 加密对象不能在此编辑 / SSE-C encrypted objects cannot be edited here".into())}
        let expires=head.expires_string().map(|value|chrono::DateTime::parse_from_rfc2822(value)
            .map(|date|aws_sdk_s3::primitives::DateTime::from_secs(date.timestamp()))
            .map_err(|_|"对象 Expires 属性无法安全保留，未发送保存请求 / The Expires attribute cannot be preserved safely; save was not sent".to_string())).transpose()?;
        request=request.if_match(expected)
            .content_type(head.content_type().unwrap_or("text/plain; charset=utf-8"))
            .set_metadata(head.metadata().cloned())
            .set_content_disposition(head.content_disposition().map(str::to_string))
            .set_content_language(head.content_language().map(str::to_string))
            .set_content_encoding(head.content_encoding().map(str::to_string))
            .set_cache_control(head.cache_control().map(str::to_string))
            .set_expires(expires)
            .set_storage_class(head.storage_class().cloned())
            .set_server_side_encryption(head.server_side_encryption().cloned())
            .set_ssekms_key_id(head.ssekms_key_id().map(str::to_string))
            .set_bucket_key_enabled(head.bucket_key_enabled());
    }
    // Never retry a failed condition as an unconditional overwrite. A service
    // that rejects conditional writes remains unsupported instead of unsafe.
    let output=request.send().await.map_err(|error|failure(&error))?;
    Ok(WriteOutput{etag:output.e_tag().and_then(|value|stable_etag(Some(value)).ok()).map(str::to_string),byte_length:content.len()})
}

#[cfg(test)]
#[path="text_objects_tests.rs"]
mod tests;
