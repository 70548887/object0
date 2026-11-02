//! S3 object operations: list, multipart upload, download, tar.gz archive,
//! server-side + temp-file copy, and batched delete.

use super::*;
use sha2::{Digest, Sha256};

pub(crate) fn validate_distinct_object(source_bucket: &str, source_key: &str, dest_bucket: &str, dest_key: &str) -> Result<(), String> {
    if source_bucket == dest_bucket && source_key == dest_key {
        Err("Source and destination are the same object; nothing was changed".to_string())
    } else { Ok(()) }
}

pub(crate) fn server_copy_scope_confirmed(source_profile_id: &str, source_bucket: &str, dest_profile_id: &str, dest_bucket: &str) -> bool {
    source_profile_id == dest_profile_id && source_bucket == dest_bucket
}

async fn s3_content_digest(client: &S3Client, bucket: &str, key: &str, etag: &str, cancel: &AtomicBool) -> Result<(i64, Vec<u8>), String> {
    let response = client.get_object().bucket(bucket).key(key).if_match(etag)
        .send().await.map_err(|_| "Could not verify object content; the source was preserved".to_string())?;
    let mut body = response.body;
    let mut hash = Sha256::new();
    let mut bytes = 0_i64;
    while let Some(chunk) = body.try_next().await.map_err(|_| "Object verification stream failed; the source was preserved".to_string())? {
        if cancel.load(Ordering::SeqCst) { return Err(JOB_CANCELLED.to_string()); }
        bytes = bytes.checked_add(chunk.len() as i64).ok_or_else(|| "Object size overflow during verification".to_string())?;
        hash.update(&chunk);
    }
    Ok((bytes, hash.finalize().to_vec()))
}

/// Content is read back with immutable ETag preconditions before source deletion.
/// Unsupported conditional deletion fails closed rather than deleting a newer file.
pub(crate) async fn s3_verify_and_delete_source(
    source_client: &S3Client, source_bucket: &str, source_key: &str,
    dest_client: &S3Client, dest_bucket: &str, dest_key: &str,
    cancel: &AtomicBool,
) -> Result<(), String> {
    validate_distinct_object(source_bucket, source_key, dest_bucket, dest_key)?;
    let source = source_client.head_object().bucket(source_bucket).key(source_key).send().await
        .map_err(|_| "Could not verify source object; it was preserved".to_string())?;
    let destination = dest_client.head_object().bucket(dest_bucket).key(dest_key).send().await
        .map_err(|_| "Could not verify destination object; the source was preserved".to_string())?;
    let source_tag = source.e_tag().filter(|value| !value.is_empty())
        .ok_or_else(|| "Source has no stable identity; it was preserved".to_string())?;
    let dest_tag = destination.e_tag().filter(|value| !value.is_empty())
        .ok_or_else(|| "Destination has no stable identity; the source was preserved".to_string())?;
    if source.content_length() != destination.content_length()
        || source.content_type() != destination.content_type()
        || source.metadata() != destination.metadata() {
        return Err("Destination size or metadata does not match; the source was preserved".to_string());
    }
    let source_digest = s3_content_digest(source_client, source_bucket, source_key, source_tag, cancel).await?;
    let dest_digest = s3_content_digest(dest_client, dest_bucket, dest_key, dest_tag, cancel).await?;
    if source_digest != dest_digest { return Err("Destination content verification failed; the source was preserved".to_string()); }
    if cancel.load(Ordering::SeqCst) { return Err(JOB_CANCELLED.to_string()); }
    source_client.delete_object().bucket(source_bucket).key(source_key).if_match(source_tag)
        .send().await.map_err(|_| "Conditional source deletion failed; destination copy remains and the source was preserved or changed. Refresh both listings.".to_string())?;
    Ok(())
}

pub(crate) async fn s3_list_all_objects(
    client: &S3Client,
    bucket: &str,
    prefix: &str,
) -> Result<Vec<RemoteObject>, String> {
    let mut continuation_token: Option<String> = None;
    let mut seen_tokens = HashSet::new();
    let mut all_objects: Vec<RemoteObject> = Vec::new();

    loop {
        let mut request = client
            .list_objects_v2()
            .bucket(bucket.to_string())
            .max_keys(S3_LIST_MAX_KEYS)
            .prefix(prefix.to_string());

        if let Some(token) = continuation_token.as_deref() {
            request = request.continuation_token(token.to_string());
        }

        let output = request.send().await.map_err(|err| err.to_string())?;

        for item in output.contents() {
            all_objects.push(RemoteObject {
                key: item.key().unwrap_or_default().to_string(),
                size: item.size().unwrap_or(0).max(0),
                etag: item
                    .e_tag()
                    .unwrap_or_default()
                    .trim_matches('"')
                    .to_string(),
                last_modified: item
                    .last_modified()
                    .map(s3_datetime_to_iso)
                    .unwrap_or_else(now_iso),
            });
        }

        if output.is_truncated().unwrap_or(false) {
            let next = output.next_continuation_token().filter(|value| !value.is_empty())
                .ok_or_else(|| "Storage returned an incomplete listing without a continuation token; no complete snapshot is available".to_string())?;
            if !seen_tokens.insert(next.to_string()) {
                return Err("Storage repeated a continuation token; no complete snapshot is available".to_string());
            }
            continuation_token = Some(next.to_string());
        } else {
            break;
        }
    }

    Ok(all_objects)
}

pub(crate) async fn s3_upload_file(
    client: &S3Client,
    bucket: &str,
    key: &str,
    local_path: &Path,
    cancel_flag: &AtomicBool,
    on_progress: impl FnMut(i64, i64),
) -> Result<i64, String> {
    s3_upload_file_with_headers(client,bucket,key,local_path,cancel_flag,None,None,on_progress).await
}

/// Temp-relay copies must preserve the source's MIME and user metadata in
/// both single-PUT and multipart paths. Ordinary uploads keep their defaults.
async fn s3_upload_file_with_headers(
    client: &S3Client,
    bucket: &str,
    key: &str,
    local_path: &Path,
    cancel_flag: &AtomicBool,
    content_type: Option<&str>,
    metadata: Option<&HashMap<String,String>>,
    mut on_progress: impl FnMut(i64, i64),
) -> Result<i64, String> {
    if cancel_flag.load(Ordering::SeqCst) {
        return Err(JOB_CANCELLED.to_string());
    }

    let total = fs::metadata(local_path)
        .map(|meta| meta.len() as i64)
        .unwrap_or(0)
        .max(0);

    if total <= MULTIPART_THRESHOLD_BYTES {
        let body = ByteStream::from_path(local_path.to_path_buf())
            .await
            .map_err(|err| format!("Failed to stream {}: {err}", local_path.display()))?;

        client
            .put_object()
            .bucket(bucket.to_string())
            .key(key.to_string())
            .set_content_type(content_type.map(str::to_string))
            .set_metadata(metadata.cloned())
            .body(body)
            .send()
            .await
            .map_err(|err| err.to_string())?;

        on_progress(total, total);
        return Ok(total);
    }

    let multipart = client
        .create_multipart_upload()
        .bucket(bucket.to_string())
        .key(key.to_string())
        .set_content_type(content_type.map(str::to_string))
        .set_metadata(metadata.cloned())
        .send()
        .await
        .map_err(|err| err.to_string())?;
    let upload_id = multipart
        .upload_id()
        .map(str::to_string)
        .ok_or_else(|| "Missing multipart upload id".to_string())?;

    let mut file = tokio_fs::File::open(local_path)
        .await
        .map_err(|err| format!("Failed to open {}: {err}", local_path.display()))?;
    let mut transferred: i64 = 0;
    let mut part_number: i32 = 1;
    let mut parts: Vec<CompletedPart> = Vec::new();

    let upload_result: Result<(), String> = async {
        loop {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(JOB_CANCELLED.to_string());
            }

            let mut buffer = vec![0u8; MULTIPART_PART_SIZE_BYTES];
            let mut read_total: usize = 0;
            while read_total < buffer.len() {
                let read = file
                    .read(&mut buffer[read_total..])
                    .await
                    .map_err(|err| format!("Failed reading {}: {err}", local_path.display()))?;
                if read == 0 {
                    break;
                }
                read_total += read;
            }

            if read_total == 0 {
                break;
            }
            buffer.truncate(read_total);

            let output = client
                .upload_part()
                .bucket(bucket.to_string())
                .key(key.to_string())
                .upload_id(upload_id.clone())
                .part_number(part_number)
                .body(ByteStream::from(buffer))
                .send()
                .await
                .map_err(|err| err.to_string())?;

            let completed_part = CompletedPart::builder()
                .set_e_tag(output.e_tag().map(str::to_string))
                .part_number(part_number)
                .build();
            parts.push(completed_part);

            transferred += read_total as i64;
            on_progress(transferred, total);
            part_number += 1;
        }

        if parts.is_empty() {
            return Err("Multipart upload produced no parts".to_string());
        }

        let completed_upload = CompletedMultipartUpload::builder()
            .set_parts(Some(parts))
            .build();

        client
            .complete_multipart_upload()
            .bucket(bucket.to_string())
            .key(key.to_string())
            .upload_id(upload_id.clone())
            .multipart_upload(completed_upload)
            .send()
            .await
            .map_err(|err| err.to_string())?;

        Ok(())
    }
    .await;

    if let Err(err) = upload_result {
        let _ = client
            .abort_multipart_upload()
            .bucket(bucket.to_string())
            .key(key.to_string())
            .upload_id(upload_id)
            .send()
            .await;
        return Err(err);
    }

    on_progress(total, total);
    Ok(total)
}

pub(crate) async fn s3_download_file(
    client: &S3Client,
    bucket: &str,
    key: &str,
    local_path: &Path,
    cancel_flag: &AtomicBool,
    on_progress: impl FnMut(i64, i64),
) -> Result<i64, String> {
    s3_download_file_with_policy(client,bucket,key,local_path,cancel_flag,true,on_progress).await
}

/// Qiniu native downloads do not overwrite an existing local file without an
/// explicit user choice. Apply the same fail-closed rule to its S3 path.
pub(crate) async fn s3_download_file_create_new(
    client: &S3Client,
    bucket: &str,
    key: &str,
    local_path: &Path,
    cancel_flag: &AtomicBool,
    on_progress: impl FnMut(i64, i64),
) -> Result<i64, String> {
    s3_download_file_with_policy(client,bucket,key,local_path,cancel_flag,false,on_progress).await
}

async fn s3_download_file_with_policy(
    client: &S3Client,
    bucket: &str,
    key: &str,
    local_path: &Path,
    cancel_flag: &AtomicBool,
    allow_replace: bool,
    mut on_progress: impl FnMut(i64, i64),
) -> Result<i64, String> {
    use sha2::{Digest, Sha256};
    use futures_util::future::{select, Either};

    #[derive(PartialEq, Eq)]
    struct LocalSnapshot {
        size: u64,
        modified: Option<std::time::SystemTime>,
        created: Option<std::time::SystemTime>,
        sha256: [u8; 32],
    }
    struct PartialFile(Option<PathBuf>);
    impl Drop for PartialFile {
        fn drop(&mut self) {
            if let Some(path) = &self.0 { let _ = fs::remove_file(path); }
        }
    }
    fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
        if cancel.load(Ordering::SeqCst) { Err(JOB_CANCELLED.to_string()) } else { Ok(()) }
    }
    async fn cancellable<F: std::future::Future>(operation: F, cancel: &AtomicBool) -> Result<F::Output, String> {
        let mut pending = Box::pin(operation);
        loop {
            check_cancel(cancel)?;
            match select(pending, Box::pin(tokio::time::sleep(StdDuration::from_millis(100)))).await {
                Either::Left((result, _)) => return Ok(result),
                Either::Right((_, operation)) => pending = operation,
            }
        }
    }
    async fn snapshot(path: &Path, cancel: &AtomicBool) -> Result<Option<LocalSnapshot>, String> {
        check_cancel(cancel)?;
        let before = match tokio_fs::symlink_metadata(path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Unable to inspect download destination; original file preserved".to_string()),
        };
        if !before.is_file() || before.file_type().is_symlink() {
            return Err("Download destination is not a regular file; original path preserved".to_string());
        }
        let mut file = tokio_fs::File::open(path).await
            .map_err(|_| "Unable to read download destination; original file preserved".to_string())?;
        let opened = file.metadata().await
            .map_err(|_| "Unable to inspect download destination; original file preserved".to_string())?;
        let same_stamp = |a: &fs::Metadata, b: &fs::Metadata| {
            a.len() == b.len() && a.modified().ok() == b.modified().ok() && a.created().ok() == b.created().ok()
        };
        if !same_stamp(&before, &opened) { return Err("Download destination changed; original file preserved".to_string()); }
        let mut hash = Sha256::new();
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            check_cancel(cancel)?;
            let count = file.read(&mut buffer).await
                .map_err(|_| "Unable to read download destination; original file preserved".to_string())?;
            if count == 0 { break; }
            hash.update(&buffer[..count]);
        }
        let after = tokio_fs::symlink_metadata(path).await
            .map_err(|_| "Download destination changed; original file preserved".to_string())?;
        if after.file_type().is_symlink() || !after.is_file() || !same_stamp(&before, &after) {
            return Err("Download destination changed; original file preserved".to_string());
        }
        Ok(Some(LocalSnapshot {size: before.len(), modified: before.modified().ok(), created: before.created().ok(), sha256: hash.finalize().into()}))
    }

    check_cancel(cancel_flag)?;
    let parent = local_path.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    tokio_fs::create_dir_all(parent).await
        .map_err(|_| "Unable to create download directory".to_string())?;
    let resolved_parent = tokio_fs::canonicalize(parent).await
        .map_err(|_| "Unable to resolve download directory".to_string())?;
    let name = local_path.file_name().ok_or_else(|| "Download destination has no file name".to_string())?;
    let target = resolved_parent.join(name);
    let original = snapshot(&target, cancel_flag).await?;
    if original.is_some() && !allow_replace {
        return Err("下载目标已存在，未覆盖原文件 / Download destination already exists; original file preserved".to_string());
    }

    let head = cancellable(client.head_object().bucket(bucket).key(key).send(), cancel_flag).await?
        .map_err(|error| s3_errors::describe("Inspect download object", &error))?;
    let total = head.content_length().filter(|size| *size >= 0)
        .ok_or_else(|| "Storage did not return a valid download size".to_string())?;
    let expected_etag = head.e_tag().filter(|etag| !etag.is_empty())
        .ok_or_else(|| "Storage did not return an object identity; download not started".to_string())?.to_string();
    let expected_version = head.version_id().filter(|version| !version.is_empty()).map(str::to_string);
    let expected_modified = head.last_modified().map(s3_datetime_to_iso);

    let partial = resolved_parent.join(format!(".yuncang-download-{}.part", Uuid::new_v4().simple()));
    let mut partial_guard = PartialFile(Some(partial.clone()));
    let file = tokio_fs::OpenOptions::new().write(true).create_new(true).open(&partial).await
        .map_err(|_| "Unable to create temporary download file; original file preserved".to_string())?;
    let mut writer = BufWriter::new(file);
    let request = client.get_object().bucket(bucket).key(key).if_match(expected_etag.clone())
        .set_version_id(expected_version.clone());
    let output = cancellable(request.send(), cancel_flag).await?
        .map_err(|error| s3_errors::describe("Download object", &error))?;
    if output.content_length() != Some(total) || output.e_tag() != Some(expected_etag.as_str())
        || (expected_version.is_some() && output.version_id() != expected_version.as_deref()) {
        return Err("Download object changed or response length differs; original file preserved".to_string());
    }
    on_progress(0, total);
    let mut body = output.body;
    let mut transferred = 0_i64;
    loop {
        let chunk = cancellable(body.try_next(), cancel_flag).await?
            .map_err(|_| "Download stream interrupted; original file preserved".to_string())?;
        let Some(bytes) = chunk else { break };
        check_cancel(cancel_flag)?;
        transferred = transferred.checked_add(i64::try_from(bytes.len()).map_err(|_| "Download exceeds safe size range".to_string())?)
            .ok_or_else(|| "Download exceeds safe size range".to_string())?;
        if transferred > total { return Err("Download length exceeds expected size; original file preserved".to_string()); }
        writer.write_all(&bytes).await
            .map_err(|_| "Unable to write temporary download; original file preserved".to_string())?;
        on_progress(transferred, total);
    }
    if transferred != total { return Err("Download length does not match expected size; original file preserved".to_string()); }
    check_cancel(cancel_flag)?;
    let final_head = cancellable(client.head_object().bucket(bucket).key(key).send(), cancel_flag).await?
        .map_err(|error| s3_errors::describe("Recheck download object", &error))?;
    if final_head.content_length() != Some(total) || final_head.e_tag() != Some(expected_etag.as_str())
        || final_head.version_id().filter(|version| !version.is_empty()) != expected_version.as_deref()
        || final_head.last_modified().map(s3_datetime_to_iso) != expected_modified {
        return Err("Remote object changed during download; original file preserved".to_string());
    }
    writer.flush().await.map_err(|_| "Unable to flush temporary download; original file preserved".to_string())?;
    writer.get_ref().sync_all().await.map_err(|_| "Unable to sync temporary download; original file preserved".to_string())?;
    drop(writer);
    check_cancel(cancel_flag)?;
    if tokio_fs::canonicalize(parent).await.map_err(|_| "Download directory changed".to_string())? != resolved_parent
        || snapshot(&target, cancel_flag).await? != original {
        return Err("Download destination changed during transfer; replacement refused".to_string());
    }
    check_cancel(cancel_flag)?;
    if original.is_some() {
        // Same-directory rename provides the OS atomic replacement guarantee.
        // A filesystem that cannot replace atomically returns an error: there
        // is deliberately no delete-then-rename fallback.
        tokio_fs::rename(&partial, &target).await
            .map_err(|_| "Atomic download replacement failed; original file preserved".to_string())?;
    } else {
        // Atomic create-if-absent prevents a concurrently created target from
        // being overwritten after the preceding snapshot check.
        tokio_fs::hard_link(&partial, &target).await
            .map_err(|_| "Download destination appeared or atomic creation is unsupported; existing file preserved".to_string())?;
        tokio_fs::remove_file(&partial).await.map_err(|_| "Download completed but temporary cleanup failed".to_string())?;
    }
    partial_guard.0 = None;
    Ok(transferred)
}

#[cfg(test)]
#[path = "s3_download_tests.rs"]
mod download_tests;

#[cfg(test)]
#[path = "s3_archive_tests.rs"]
mod archive_audit_tests;

#[cfg(test)]
#[path = "s3_copy_metadata_tests.rs"]
mod copy_metadata_audit_tests;

pub(crate) async fn s3_download_archive_tar_gz(
    client: &S3Client,
    bucket: &str,
    keys: &[String],
    common_prefix: &str,
    destination_path: &Path,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(i64, i64),
) -> Result<i64, String> {
    if cancel_flag.load(Ordering::SeqCst) {
        return Err(JOB_CANCELLED.to_string());
    }
    if keys.is_empty() {
        return Err("No objects selected for archive".to_string());
    }

    // An archive is a download too: never truncate/delete an existing user
    // file while a remote stream can still fail or be cancelled. Resolve a
    // single destination directory and only publish a fully flushed archive.
    let parent = destination_path.parent().filter(|path| !path.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|_| "Unable to create archive destination directory".to_string())?;
    let resolved_parent = fs::canonicalize(parent).map_err(|_| "Unable to resolve archive destination directory".to_string())?;
    let file_name = destination_path.file_name().ok_or_else(|| "Archive destination has no file name".to_string())?;
    let target = resolved_parent.join(file_name);
    match fs::symlink_metadata(&target) {
        Ok(_) => return Err("归档下载目标已存在，未覆盖原文件 / Archive destination already exists; original file preserved".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {},
        Err(_) => return Err("Unable to inspect archive destination; original path preserved".to_string()),
    }
    struct PartialArchive(PathBuf);
    impl Drop for PartialArchive {
        fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
    }
    let temporary = resolved_parent.join(format!(".yuncang-archive-{}.part", Uuid::new_v4().simple()));

    let result: Result<i64, String> = async {
        let archive_file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)
            .map_err(|_| "Unable to create temporary archive; original file preserved".to_string())?;
        // Register cleanup only after create_new succeeded: even an unlikely
        // path collision must not remove somebody else's file.
        let _partial = PartialArchive(temporary.clone());
        let writer = io::BufWriter::new(archive_file);
        let mut encoder = GzEncoder::new(writer, Compression::default());

        let mut transferred: i64 = 0;
        let mut total: i64 = 0;
        const TAR_BLOCK_SIZE: usize = 512;
        const TAR_END_BLOCKS: [u8; TAR_BLOCK_SIZE * 2] = [0; TAR_BLOCK_SIZE * 2];
        const TAR_PAD_BLOCK: [u8; TAR_BLOCK_SIZE] = [0; TAR_BLOCK_SIZE];

        on_progress(0, 0);

        for key in keys {
            if cancel_flag.load(Ordering::SeqCst) {
                return Err(JOB_CANCELLED.to_string());
            }

            let relative = if !common_prefix.is_empty() && key.starts_with(common_prefix) {
                key[common_prefix.len()..].to_string()
            } else {
                key.clone()
            };
            if relative.is_empty() {
                continue;
            }

            let safe_relative = sanitize_relative_path(&relative)
                .ok_or_else(|| format!("Invalid object key for archive entry: {key}"))?;

            let output = client
                .get_object()
                .bucket(bucket.to_string())
                .key(key.to_string())
                .send()
                .await
                .map_err(|err| err.to_string())?;

            let expected_size = if let Some(size) = output.content_length() {
                size.max(0)
            } else {
                client
                    .head_object()
                    .bucket(bucket.to_string())
                    .key(key.to_string())
                    .send()
                    .await
                    .map_err(|err| err.to_string())?
                    .content_length()
                    .unwrap_or(0)
                    .max(0)
            };

            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_path(&safe_relative).map_err(|err| {
                format!(
                    "Invalid archive entry path {}: {err}",
                    safe_relative.display()
                )
            })?;
            header.set_size(expected_size as u64);
            header.set_mode(0o644);
            header.set_mtime(0);
            header.set_cksum();

            encoder.write_all(header.as_bytes()).map_err(|err| {
                format!(
                    "Failed writing tar header for {}: {err}",
                    safe_relative.display()
                )
            })?;

            let mut body = output.body;
            let mut file_transferred: i64 = 0;

            while let Some(bytes) = body
                .try_next()
                .await
                .map_err(|err| format!("Download stream failed: {err}"))?
            {
                if cancel_flag.load(Ordering::SeqCst) {
                    return Err(JOB_CANCELLED.to_string());
                }

                encoder.write_all(&bytes).map_err(|err| {
                    format!(
                        "Failed writing tar data for {}: {err}",
                        safe_relative.display()
                    )
                })?;
                file_transferred += bytes.len() as i64;

                let aggregate_total = (total + expected_size).max(transferred + file_transferred);
                on_progress(transferred + file_transferred, aggregate_total);
            }

            if file_transferred != expected_size {
                return Err(format!(
                    "Unexpected size for {} (expected {}, downloaded {})",
                    safe_relative.display(),
                    expected_size,
                    file_transferred
                ));
            }

            let padding = (TAR_BLOCK_SIZE as i64 - (file_transferred % TAR_BLOCK_SIZE as i64))
                % TAR_BLOCK_SIZE as i64;
            if padding > 0 {
                encoder
                    .write_all(&TAR_PAD_BLOCK[..padding as usize])
                    .map_err(|err| {
                        format!(
                            "Failed writing tar padding for {}: {err}",
                            safe_relative.display()
                        )
                    })?;
            }

            transferred += file_transferred;
            total += expected_size;
            on_progress(transferred, total);
        }

        encoder
            .write_all(&TAR_END_BLOCKS)
            .map_err(|err| format!("Failed finalizing tar payload: {err}"))?;
        let mut writer = encoder
            .finish()
            .map_err(|err| format!("Failed finalizing gzip stream: {err}"))?;
        writer.flush().map_err(|_| "Unable to flush temporary archive; no archive was committed".to_string())?;
        writer.get_ref().sync_all().map_err(|_| "Unable to sync temporary archive; no archive was committed".to_string())?;
        drop(writer);

        if cancel_flag.load(Ordering::SeqCst) {
            return Err(JOB_CANCELLED.to_string());
        }

        if fs::canonicalize(parent).map_err(|_| "Archive destination directory changed".to_string())? != resolved_parent {
            return Err("Archive destination directory changed; no archive was committed".to_string());
        }
        // Atomic create-if-absent: a concurrent user file must not be replaced.
        // Filesystems without hard-link support fail closed, not delete/rename.
        fs::hard_link(&temporary, &target)
            .map_err(|_| "Archive destination appeared or atomic creation is unsupported; existing file preserved".to_string())?;

        Ok(transferred.max(total))
    }
    .await;

    result
}

pub(crate) async fn s3_copy_object_via_temp_file(
    source_client: &S3Client,
    source_bucket: &str,
    source_key: &str,
    dest_client: &S3Client,
    dest_bucket: &str,
    dest_key: &str,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(i64, i64),
) -> Result<i64, String> {
    if cancel_flag.load(Ordering::SeqCst) {
        return Err(JOB_CANCELLED.to_string());
    }

    let head = source_client
        .head_object()
        .bucket(source_bucket.to_string())
        .key(source_key.to_string())
        .send()
        .await
        .map_err(|err| err.to_string())?;
    let size = head.content_length().filter(|size|*size>=0)
        .ok_or_else(||"Source copy size is missing or invalid; destination was not written".to_string())?;
    let source_tag=head.e_tag().filter(|tag|!tag.is_empty())
        .ok_or_else(||"Source has no stable identity; destination was not written".to_string())?.to_string();

    let temp_path = std::env::temp_dir().join(format!("object0-copy-{}", Uuid::new_v4()));
    struct RelayFile {path:PathBuf,owned:bool}
    impl Drop for RelayFile {fn drop(&mut self){if self.owned{let _=fs::remove_file(&self.path);}}}
    let mut temporary=RelayFile{path:temp_path.clone(),owned:false};

    let result = async {
        s3_download_file_create_new(
            source_client,
            source_bucket,
            source_key,
            &temp_path,
            cancel_flag,
            |transferred, _| on_progress((transferred / 2).min(size), size),
        )
        .await?;
        temporary.owned=true;

        if cancel_flag.load(Ordering::SeqCst) {
            return Err(JOB_CANCELLED.to_string());
        }

        // The safe downloader protects its own HEAD/GET identity. Compare
        // again with the outer snapshot before pairing these downloaded bytes
        // with the MIME/metadata captured before the download began.
        let after=source_client.head_object().bucket(source_bucket).key(source_key)
            .send().await.map_err(|_|"Could not recheck copy source; destination was not written".to_string())?;
        if after.content_length()!=Some(size)||after.e_tag()!=Some(source_tag.as_str())
            ||after.version_id()!=head.version_id()
            ||after.last_modified().map(s3_datetime_to_iso)!=head.last_modified().map(s3_datetime_to_iso)
            ||after.content_type()!=head.content_type()||after.metadata()!=head.metadata(){
            return Err("Copy source identity or metadata changed during download; destination was not written".to_string());
        }
        if cancel_flag.load(Ordering::SeqCst){return Err(JOB_CANCELLED.to_string());}

        s3_upload_file_with_headers(
            dest_client,
            dest_bucket,
            dest_key,
            &temp_path,
            cancel_flag,
            head.content_type(),
            head.metadata(),
            |transferred, _| on_progress((size / 2 + transferred / 2).min(size), size),
        )
        .await?;

        on_progress(size, size);
        Ok(size)
    }
    .await;

    drop(temporary);
    result
}

pub(crate) async fn s3_copy_object(
    source_client: &S3Client,
    source_bucket: &str,
    source_key: &str,
    dest_client: &S3Client,
    dest_bucket: &str,
    dest_key: &str,
    cancel_flag: &AtomicBool,
    mut on_progress: impl FnMut(i64, i64),
) -> Result<i64, String> {
    if cancel_flag.load(Ordering::SeqCst) {
        return Err(JOB_CANCELLED.to_string());
    }

    let head = source_client
        .head_object()
        .bucket(source_bucket.to_string())
        .key(source_key.to_string())
        .send()
        .await
        .map_err(|err| err.to_string())?;
    let size = head.content_length().unwrap_or(0).max(0);
    let source_tag = head.e_tag().filter(|value| !value.is_empty())
        .ok_or_else(|| "Source has no stable identity; server-side copy was not attempted".to_string())?;

    let source_key_encoded = utf8_percent_encode(source_key, COPY_SOURCE_ENCODE_SET);
    let copy_source = format!("{}/{}", source_bucket, source_key_encoded);

    dest_client
        .copy_object()
        .bucket(dest_bucket.to_string())
        .key(dest_key.to_string())
        .copy_source(copy_source)
        .copy_source_if_match(source_tag)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    on_progress(size, size);
    Ok(size)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteKeyResult {
    pub key: String,
    pub deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

fn safe_delete_code(code: Option<&str>) -> String {
    match code {
        Some("AccessDenied" | "NoSuchKey" | "InvalidArgument" | "InternalError" | "SlowDown" | "ServiceUnavailable") => code.unwrap().to_string(),
        _ => "Unconfirmed".to_string(),
    }
}

fn parse_delete_results(keys: &[String], output: &aws_sdk_s3::operation::delete_objects::DeleteObjectsOutput) -> Vec<DeleteKeyResult> {
    // Quiet=false requires an explicit success entry. A missing/ambiguous entry
    // must never be reported as deleted, even when HTTP returned 200.
    let requested: HashSet<&str> = keys.iter().map(String::as_str).collect();
    let mut returned = HashSet::new();
    let valid = output.deleted().iter().map(|item|item.key())
        .chain(output.errors().iter().map(|item|item.key()))
        .all(|key|key.is_some_and(|key|requested.contains(key) && returned.insert(key)));
    if !valid {
        // Duplicate, keyless or unrequested entries make the batch response
        // ambiguous. Do not attribute any such response to a requested object.
        return keys.iter().map(|key|DeleteKeyResult{key:key.clone(),deleted:false,error_code:Some("Unconfirmed".into())}).collect();
    }
    let deleted: HashSet<&str> = output.deleted().iter().filter_map(|item| item.key()).collect();
    let errors: HashMap<&str, String> = output.errors().iter()
        .filter_map(|item| item.key().map(|key| (key, safe_delete_code(item.code())))).collect();
    keys.iter().map(|key| {
        if let Some(code) = errors.get(key.as_str()) {
            DeleteKeyResult { key: key.clone(), deleted: false, error_code: Some(code.clone()) }
        } else if deleted.contains(key.as_str()) {
            DeleteKeyResult { key: key.clone(), deleted: true, error_code: None }
        } else {
            DeleteKeyResult { key: key.clone(), deleted: false, error_code: Some("Unconfirmed".to_string()) }
        }
    }).collect()
}

pub(crate) async fn s3_delete_keys_detailed(client: &S3Client, bucket: &str, keys: &[String]) -> Result<Vec<DeleteKeyResult>, String> {
    let mut seen = HashSet::new();
    let unique: Vec<String> = keys.iter().filter(|key| seen.insert((*key).clone())).cloned().collect();
    let mut results = Vec::with_capacity(unique.len());
    for chunk in unique.chunks(1000) {
        if chunk.len() == 1 {
            let result = client.delete_object().bucket(bucket).key(&chunk[0]).send().await;
            results.push(DeleteKeyResult {
                key: chunk[0].clone(), deleted: result.is_ok(),
                error_code: result.err().map(|error| {
                    use aws_sdk_s3::error::ProvideErrorMetadata;
                    safe_delete_code(error.as_service_error().and_then(|service| service.code()))
                }),
            });
            continue;
        }
        let mut objects = Vec::with_capacity(chunk.len());
        for key in chunk {
            objects.push(ObjectIdentifier::builder().key(key).build()
                .map_err(|_| "Invalid object identifier in delete request".to_string())?);
        }
        let delete = Delete::builder().set_objects(Some(objects)).quiet(false).build()
            .map_err(|_| "Invalid delete request".to_string())?;
        match client.delete_objects().bucket(bucket).delete(delete).send().await {
            Ok(output) => results.extend(parse_delete_results(chunk, &output)),
            Err(_) => results.extend(chunk.iter().map(|key| DeleteKeyResult {
                key: key.clone(), deleted: false, error_code: Some("Unconfirmed".to_string()),
            })),
        }
    }
    Ok(results)
}

pub(crate) async fn s3_delete_keys(client: &S3Client, bucket: &str, keys: &[String]) -> Result<(), String> {
    super::batch_delete::s3_delete_report(client,bucket,keys).await?.ensure_all_succeeded()
}

pub(crate) fn to_s3_client(profile: &Profile) -> Result<S3Client, String> {
    if profile.provider == S3Provider::Qiniu {
        return Err("Qiniu requires its per-bucket storage adapter; the generic S3 connection was not created".to_string());
    }
    if profile.access_key_id.trim().is_empty() || profile.secret_access_key.trim().is_empty() {
        return Err("Profile credentials are missing".to_string());
    }

    let region = profile
        .region
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("us-east-1");

    let credentials = Credentials::new(
        profile.access_key_id.clone(),
        profile.secret_access_key.clone(),
        profile.session_token.clone(),
        None,
        "object0",
    );

    let mut config_builder = aws_sdk_s3::config::Builder::new()
        .behavior_version_latest()
        .region(Region::new(region.to_string()))
        .credentials_provider(credentials);

    if let Some(endpoint) = profile
        .endpoint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        config_builder = config_builder.endpoint_url(endpoint.to_string());
    }

    // R2 TLS handshakes on this Windows network can exceed the SDK's
    // default 3.1s. Extend only connection establishment, not file transfers.
    if profile.provider == S3Provider::R2 {
        config_builder = config_builder.timeout_config(
            aws_sdk_s3::config::timeout::TimeoutConfig::builder()
                .connect_timeout(StdDuration::from_secs(15))
                .build(),
        );
    }
    if matches!(profile.provider, S3Provider::Minio | S3Provider::Custom) {
        config_builder = config_builder.force_path_style(true);
    }

    Ok(S3Client::from_conf(config_builder.build()))
}

pub(crate) fn s3_datetime_to_iso(dt: &aws_sdk_s3::primitives::DateTime) -> String {
    dt.to_millis()
        .ok()
        .and_then(chrono::DateTime::<Utc>::from_timestamp_millis)
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(now_iso)
}

pub(crate) fn profile_for_id(state: &AppState, profile_id: &str) -> Result<Profile, String> {
    let vault = lock_state(&state.vault)?;
    ensure_unlocked(&vault)?;
    let data = vault
        .data
        .as_ref()
        .ok_or_else(|| "Vault is locked".to_string())?;
    data.profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or_else(|| format!("Profile not found: {profile_id}"))
}

// Convenience for the common "look up the profile, then build its S3 client" pair.
// Use the two-step form directly when the profile itself is needed afterwards.
pub(crate) fn s3_client_for_profile(state: &AppState, profile_id: &str) -> Result<S3Client, String> {
    let profile = profile_for_id(state, profile_id)?;
    to_s3_client(&profile)
}

#[cfg(test)]
mod safety_tests {
    use super::*;
    use aws_sdk_s3::{operation::delete_objects::DeleteObjectsOutput, types::{DeletedObject, Error as DeleteError}};

    #[test]
    fn batch_delete_does_not_treat_http_success_as_all_deleted() {
        let output = DeleteObjectsOutput::builder()
            .deleted(DeletedObject::builder().key("ok").build())
            .errors(DeleteError::builder().key("denied").code("AccessDenied").message("sensitive-provider-message").build())
            .build();
        let keys = ["ok", "denied", "missing"].map(str::to_string);
        let result = parse_delete_results(&keys, &output);
        assert!(result[0].deleted);
        assert_eq!(result[1].error_code.as_deref(), Some("AccessDenied"));
        assert_eq!(result[2].error_code.as_deref(), Some("Unconfirmed"));
        assert!(!serde_json::to_string(&result).unwrap().contains("sensitive-provider-message"));
    }

    #[test]
    fn batch_delete_error_wins_over_conflicting_success_entry() {
        let output = DeleteObjectsOutput::builder()
            .deleted(DeletedObject::builder().key("same").build())
            .errors(DeleteError::builder().key("same").code("secret-custom-error").build())
            .build();
        let results = parse_delete_results(&["same".to_string()], &output);
        assert!(!results[0].deleted);
        assert_eq!(results[0].error_code.as_deref(), Some("Unconfirmed"));
    }

    #[test]
    fn same_object_moves_are_rejected_before_network_calls() {
        assert!(validate_distinct_object("bucket", "file", "bucket", "file").is_err());
        assert!(validate_distinct_object("bucket", "file", "bucket", "other").is_ok());
        assert!(validate_distinct_object("bucket", "file", "other", "file").is_ok());
    }

    #[test]
    fn server_copy_does_not_assume_different_buckets_share_a_region() {
        assert!(server_copy_scope_confirmed("profile", "bucket", "profile", "bucket"));
        assert!(!server_copy_scope_confirmed("profile", "first", "profile", "second"));
        assert!(!server_copy_scope_confirmed("first", "bucket", "second", "bucket"));
    }

    #[test]
    fn qiniu_never_falls_back_to_the_default_aws_endpoint() {
        let profile: Profile = serde_json::from_value(json!({
            "id":"qiniu-test", "name":"Local fixture", "provider":"qiniu",
            "accessKeyId":"fixture-ak", "secretAccessKey":"fixture-sk",
            "createdAt":"2026-10-31T00:00:00Z", "updatedAt":"2026-10-31T00:00:00Z"
        })).unwrap();
        assert!(to_s3_client(&profile).is_err());
    }

    fn transport_fixture(provider:&str, endpoint:&str)->Profile {
        serde_json::from_value(json!({
            "id":"transport-fixture", "name":"Local fixture", "provider":provider,
            "endpoint":endpoint,"region":"auto", "accessKeyId":"fixture-ak", "secretAccessKey":"fixture-sk",
            "createdAt":"2026-11-02T00:00:00Z", "updatedAt":"2026-11-02T00:00:00Z"
        })).unwrap()
    }

    #[test]
    fn r2_only_extends_connect_timeout_without_changing_transfer_limits_or_identity() {
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _guard=runtime.enter();
        for provider in ["r2","aws","spaces","minio","gcs","backblaze","custom"] {
            let endpoint="https://transport-fixture.example";
            let client=to_s3_client(&transport_fixture(provider,endpoint)).unwrap();
            let config=client.config();
            assert_eq!(config.region().map(|r|r.as_ref()),Some("auto"));
            let timeout=config.timeout_config();
            assert_eq!(timeout.and_then(|v|v.connect_timeout()),if provider=="r2"{Some(StdDuration::from_secs(15))}else{None});
            assert!(timeout.and_then(|v|v.read_timeout()).is_none());
            assert!(timeout.and_then(|v|v.operation_timeout()).is_none());
            assert!(timeout.and_then(|v|v.operation_attempt_timeout()).is_none());
        }
    }

    #[test]
    fn r2_local_slow_tls_fixture_outlives_old_connect_deadline_without_disabling_timeout() {
        use std::{io::Read,net::TcpListener,thread,time::Instant};
        fn run(previous_default:bool)->(bool,u128) {
            let listener=TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let endpoint=format!("https://{}",listener.local_addr().unwrap());
            let server=thread::spawn(move||{
                let until=Instant::now()+StdDuration::from_secs(6);
                let mut socket=loop {match listener.accept(){
                    Ok((socket,_))=>break socket,
                    Err(error)if error.kind()==std::io::ErrorKind::WouldBlock && Instant::now()<until=>thread::sleep(StdDuration::from_millis(5)),
                    _=>panic!("Local handshake fixture was not reached"),
                }};
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(StdDuration::from_secs(3))).unwrap();
                let mut hello=[0_u8;1024];
                assert!(socket.read(&mut hello).unwrap()>0);
                // Not a TLS server: deliberately close after the old deadline.
                // This establishes timing only, not successful TLS/authentication.
                thread::sleep(StdDuration::from_millis(4500));
                let _=socket.shutdown(std::net::Shutdown::Both);
            });
            let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            let observed=runtime.block_on(async {
                let client=to_s3_client(&transport_fixture("r2",&endpoint)).unwrap();
                let mut builder=client.config().to_builder().force_path_style(true)
                    .retry_config(aws_sdk_s3::config::retry::RetryConfig::standard().with_max_attempts(1));
                if previous_default {builder=builder.timeout_config(aws_sdk_s3::config::timeout::TimeoutConfig::builder().connect_timeout(StdDuration::from_millis(3100)).build());}
                let client=S3Client::from_conf(builder.build());
                let start=Instant::now();
                let error=tokio::time::timeout(StdDuration::from_secs(20),client.list_objects_v2().bucket("fixture").max_keys(1).send()).await.expect("Local fixture exceeded bounded wait").expect_err("Non-TLS fixture cannot succeed");
                let timed_out=matches!(&error,aws_sdk_s3::error::SdkError::TimeoutError(_)) || matches!(&error,aws_sdk_s3::error::SdkError::DispatchFailure(context) if context.is_timeout());
                (timed_out,start.elapsed().as_millis())
            });
            server.join().unwrap();observed
        }
        let old=run(true);let modified=run(false);
        println!("LOCAL_SLOW_TLS_OLD timeout={} elapsed_ms={}",old.0,old.1);
        println!("LOCAL_SLOW_TLS_MODIFIED timeout={} elapsed_ms={}",modified.0,modified.1);
        assert!(old.0,"The old 3.1s connection deadline must expire");
        assert!(!modified.0,"The 15s connection deadline must allow the 4.5s fixture wait");
        assert!(modified.1>=4000);
    }

    /// Opt-in transport diagnostic. Uses synthetic credentials only and never
    /// prints endpoint, bucket, service body or credential-bearing errors.
    #[test]
    #[ignore = "requires explicitly supplied R2 endpoint; one read-only synthetic request"]
    fn r2_transport_probe() {
        let endpoint = std::env::var("YUNCANG_R2_DIAGNOSTIC_ENDPOINT").expect("Missing diagnostic endpoint");
        let url = url::Url::parse(&endpoint).expect("Invalid diagnostic origin");
        let host = url.host_str().expect("Missing host");
        let suffix = host.strip_suffix(".r2.cloudflarestorage.com").expect("Only R2 origins allowed");
        let account = suffix.strip_suffix(".eu").or_else(||suffix.strip_suffix(".fedramp")).unwrap_or(suffix);
        assert!(account.len()==32 && account.bytes().all(|b|b.is_ascii_hexdigit()));
        assert!(url.scheme()=="https" && url.port_or_known_default()==Some(443) && url.path()=="/" && url.query().is_none() && url.fragment().is_none() && url.username().is_empty() && url.password().is_none());
        let bucket = std::env::var("YUNCANG_R2_DIAGNOSTIC_BUCKET").expect("Missing diagnostic bucket");
        assert!(!bucket.is_empty() && bucket.len()<=63 && bucket.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'-'|b'.')));
        let profile: Profile = serde_json::from_value(json!({
            "id":"r2-transport-fixture", "name":"Transport fixture", "provider":"r2",
            "endpoint":endpoint,"region":"auto", "accessKeyId":"00000000000000000000000000000000", "secretAccessKey":"synthetic-diagnostic-not-a-real-key",
            "createdAt":"2026-11-02T00:00:00Z", "updatedAt":"2026-11-02T00:00:00Z"
        })).unwrap();
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let client=to_s3_client(&profile).unwrap();
            println!("CONNECT_TIMEOUT_MS={:?}",client.config().timeout_config().and_then(|value|value.connect_timeout()).map(|value|value.as_millis()));
            let config=client.config().to_builder().retry_config(aws_sdk_s3::config::retry::RetryConfig::standard().with_max_attempts(1)).build();
            let client=S3Client::from_conf(config);
            let started=std::time::Instant::now();
            let response=tokio::time::timeout(StdDuration::from_secs(22),client.list_objects_v2().bucket(bucket).max_keys(1).send()).await;
            match response {
                Err(_)=>println!("RESULT=outer-timeout;HTTP=none"),
                Ok(Ok(_))=>panic!("Synthetic credentials unexpectedly authorized; no output retained"),
                Ok(Err(error))=>{
                    println!("HTTP={:?}",error.raw_response().map(|r|r.status().as_u16()));
                    println!("RESULT={}",s3_errors::describe("R2合成凭据连接诊断",&error));
                }
            }
            println!("ELAPSED_MS={}",started.elapsed().as_millis());
        });
    }
}
