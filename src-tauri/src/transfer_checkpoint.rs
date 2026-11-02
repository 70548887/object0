//! Credential-free resumable-transfer state. This module is deliberately not a
//! transfer runner: a caller must bind the original user selection, authenticate
//! the remote session and apply the returned resume plan before sending bytes.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use aes_gcm::{aead::{Aead, KeyInit, Payload as AeadPayload}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::RngCore;
use std::{
    collections::BTreeMap,
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

pub(crate) const CHECKPOINT_VERSION: u8 = 1;
const MAX_CHECKPOINT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PARTS: usize = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CheckpointError {
    InvalidJobId,
    InvalidPath,
    UnsafePath,
    InvalidRecord,
    WrongBinding,
    AuthenticationFailed,
    UnsupportedVersion,
    ExpiredSession,
    SourceChanged,
    RemoteChanged,
    PartialFileChanged,
    InvalidParts,
    SessionMismatch,
    TerminalState,
    Io(std::io::ErrorKind),
}

impl fmt::Display for CheckpointError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidJobId => "Invalid transfer job identifier",
            Self::InvalidPath => "The original transfer selection is not a valid local path",
            Self::UnsafePath => "Transfer checkpoint paths must not use symlinks or reparse points",
            Self::InvalidRecord => "Invalid transfer checkpoint record",
            Self::WrongBinding => "Checkpoint does not match this task and original user selection",
            Self::AuthenticationFailed => "Checkpoint authentication failed; do not trust the stored upload session or parts",
            Self::UnsupportedVersion => "Unsupported transfer checkpoint version",
            Self::ExpiredSession => "The upload session expired; initialize a new upload",
            Self::SourceChanged => "The source file changed; do not reuse uploaded parts",
            Self::RemoteChanged => "The remote object changed; do not append to the existing partial file",
            Self::PartialFileChanged => "The local partial file changed; restart or restore it before resuming",
            Self::InvalidParts => "The multipart state is invalid or contains duplicate parts",
            Self::SessionMismatch => "The authenticated server upload session does not match the checkpoint",
            Self::TerminalState => "Completed or cancelled transfers cannot be resumed",
            Self::Io(_) => "Could not read or save transfer checkpoint data",
        })
    }
}

impl std::error::Error for CheckpointError {}

fn io_error(error: std::io::Error) -> CheckpointError {
    CheckpointError::Io(error.kind())
}

pub(crate) fn valid_job_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn digest_fields(fields: &[&[u8]]) -> String {
    let mut digest = Sha256::new();
    for field in fields {
        digest.update((field.len() as u64).to_be_bytes());
        digest.update(field);
    }
    hex(&digest.finalize())
}

fn hex(value: &[u8]) -> String {
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn check_path_components(path: &Path) -> Result<(), CheckpointError> {
    if !path.is_absolute() || path.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err(CheckpointError::InvalidPath);
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        // A verbatim Windows drive prefix (\\?\C:) is syntactically absolute
        // but is not a filesystem root until its following RootDir is joined.
        if matches!(component, Component::Prefix(_)) { continue; }
        if !current.is_absolute() { continue; }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if is_reparse(&metadata) || metadata.file_type().is_symlink() => return Err(CheckpointError::UnsafePath),
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

/// A binding comes from the live job/original user choice, never from JSON.
/// Paths and remote names are represented by digests in persisted records.
#[derive(Clone, Debug)]
pub(crate) struct TransferBinding {
    job_id: String,
    scope_digest: String,
    selection_digest: String,
    selected_path: PathBuf,
}

impl TransferBinding {
    pub(crate) fn new(job_id: &str, remote_scope: &[&str], selected_path: &Path) -> Result<Self, CheckpointError> {
        if !valid_job_id(job_id) { return Err(CheckpointError::InvalidJobId); }
        if remote_scope.is_empty() || remote_scope.iter().any(|field| field.len() > 65_536) {
            return Err(CheckpointError::InvalidRecord);
        }
        check_path_components(selected_path)?;
        let file_name = selected_path.file_name().ok_or(CheckpointError::InvalidPath)?;
        let parent = selected_path.parent().ok_or(CheckpointError::InvalidPath)?;
        let parent = parent.canonicalize().map_err(io_error)?;
        if !parent.is_dir() { return Err(CheckpointError::InvalidPath); }
        let selected_path = parent.join(file_name);
        let normalized = selected_path.to_str().ok_or(CheckpointError::InvalidPath)?;
        let fields: Vec<&[u8]> = remote_scope.iter().map(|value| value.as_bytes()).collect();
        Ok(Self {
            job_id: job_id.to_string(),
            scope_digest: digest_fields(&fields),
            selection_digest: digest_fields(&[normalized.as_bytes()]),
            selected_path,
        })
    }

    pub(crate) fn job_id(&self) -> &str { &self.job_id }
    pub(crate) fn selected_path(&self) -> &Path { &self.selected_path }
    pub(crate) fn download_part_path(&self) -> PathBuf {
        // No checkpoint-provided path is ever opened or executed.
        self.selected_path.parent().expect("binding has a checked parent")
            .join(format!(".yuncang-{}.part", self.job_id))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum TransferState { Queued, Running, Paused, Interrupted, Completed, Cancelled }

impl TransferState {
    pub(crate) fn after_restart(self) -> Self {
        match self { Self::Queued | Self::Running => Self::Interrupted, state => state }
    }
    pub(crate) fn pause(self) -> Result<Self, CheckpointError> {
        match self {
            Self::Completed | Self::Cancelled => Err(CheckpointError::TerminalState),
            _ => Ok(Self::Paused),
        }
    }
    pub(crate) fn resumable(self) -> bool { !matches!(self, Self::Completed | Self::Cancelled) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ControlIntent { Pause, Cancel }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CheckpointAction {
    Preserve,
    /// Authenticate and verify the upload ID before aborting it; then delete the
    /// checkpoint/owned partial file. This module never aborts untrusted IDs.
    CancelAndCleanCallerVerifiedSession,
}
pub(crate) fn control_action(intent: ControlIntent) -> CheckpointAction {
    match intent { ControlIntent::Pause => CheckpointAction::Preserve, ControlIntent::Cancel => CheckpointAction::CancelAndCleanCallerVerifiedSession }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileFingerprint {
    pub size: u64,
    pub modified_ns: u64,
    pub sha256: String,
}

/// Streaming, bounded-memory fingerprint. Run using spawn_blocking for large
/// files so hashing does not block the asynchronous networking executor.
pub(crate) fn fingerprint_file(path: &Path) -> Result<FileFingerprint, CheckpointError> {
    check_path_components(path)?;
    let mut file = File::open(path).map_err(io_error)?;
    let before = file.metadata().map_err(io_error)?;
    if !before.is_file() { return Err(CheckpointError::InvalidPath); }
    let modified = |metadata: &fs::Metadata| -> Result<u64, CheckpointError> {
        let time = metadata.modified().map_err(io_error)?.duration_since(UNIX_EPOCH).map_err(|_| CheckpointError::InvalidRecord)?;
        u64::try_from(time.as_nanos()).map_err(|_| CheckpointError::InvalidRecord)
    };
    let before_ns = modified(&before)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut size = 0_u64;
    loop {
        let count = file.read(&mut buffer).map_err(io_error)?;
        if count == 0 { break; }
        size = size.checked_add(count as u64).ok_or(CheckpointError::InvalidRecord)?;
        digest.update(&buffer[..count]);
    }
    let after = file.metadata().map_err(io_error)?;
    if before.len() != size || after.len() != size || before_ns != modified(&after)? {
        return Err(CheckpointError::SourceChanged);
    }
    Ok(FileFingerprint { size, modified_ns: before_ns, sha256: hex(&digest.finalize()) })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UploadedPart {
    pub number: u32,
    pub size: u64,
    pub etag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UploadCheckpoint {
    pub upload_id: String,
    pub expires_at_ms: Option<u64>,
    pub part_size: u64,
    pub source: FileFingerprint,
    pub parts: Vec<UploadedPart>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteIdentity {
    pub size: u64,
    /// Provider version or ETag used as an opaque conditional-request identity.
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadCheckpoint {
    pub remote: RemoteIdentity,
    pub partial_bytes: u64,
    pub partial_sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum TransferPayload { Upload(UploadCheckpoint), Download(DownloadCheckpoint) }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferCheckpoint {
    pub version: u8,
    pub job_id: String,
    pub scope_digest: String,
    pub selection_digest: String,
    pub saved_at_ms: u64,
    pub state: TransferState,
    pub payload: TransferPayload,
}

impl TransferCheckpoint {
    pub(crate) fn new(binding: &TransferBinding, state: TransferState, payload: TransferPayload, saved_at_ms: u64) -> Result<Self, CheckpointError> {
        let record = Self { version: CHECKPOINT_VERSION, job_id: binding.job_id.clone(), scope_digest: binding.scope_digest.clone(), selection_digest: binding.selection_digest.clone(), saved_at_ms, state, payload };
        record.validate(binding)?;
        Ok(record)
    }

    fn validate(&self, binding: &TransferBinding) -> Result<(), CheckpointError> {
        if self.version != CHECKPOINT_VERSION { return Err(CheckpointError::UnsupportedVersion); }
        if !valid_job_id(&self.job_id) || self.job_id != binding.job_id || self.scope_digest != binding.scope_digest || self.selection_digest != binding.selection_digest {
            return Err(CheckpointError::WrongBinding);
        }
        match &self.payload {
            TransferPayload::Upload(upload) => {
                if upload.upload_id.is_empty() || upload.upload_id.len() > 4096 || upload.upload_id.chars().any(char::is_control)
                    || upload.part_size == 0 || !valid_sha256(&upload.source.sha256) || upload.parts.len() > MAX_PARTS {
                    return Err(CheckpointError::InvalidRecord);
                }
                validate_parts(&upload.parts, upload.source.size, upload.part_size, MAX_PARTS as u32)?;
            }
            TransferPayload::Download(download) => {
                if download.remote.version.is_empty() || download.remote.version.len() > 4096 || download.remote.version.chars().any(char::is_control)
                    || download.partial_bytes > download.remote.size || !valid_sha256(&download.partial_sha256)
                    || download.remote.sha256.as_ref().is_some_and(|value| !valid_sha256(value)) {
                    return Err(CheckpointError::InvalidRecord);
                }
            }
        }
        Ok(())
    }
}

fn validate_parts(parts: &[UploadedPart], size: u64, part_size: u64, max_parts: u32) -> Result<BTreeMap<u32, UploadedPart>, CheckpointError> {
    if part_size == 0 || size == 0 || max_parts == 0 { return Err(CheckpointError::InvalidParts); }
    let total_parts = size / part_size + u64::from(size % part_size != 0);
    if total_parts > u64::from(max_parts) || parts.len() > max_parts as usize { return Err(CheckpointError::InvalidParts); }
    let mut result = BTreeMap::new();
    for part in parts {
        let number = u64::from(part.number);
        if number == 0 || number > total_parts || part.etag.is_empty() || part.etag.len() > 4096 || part.etag.chars().any(char::is_control)
            || part.sha256.as_ref().is_some_and(|value| !valid_sha256(value)) {
            return Err(CheckpointError::InvalidParts);
        }
        let expected_size = if number == total_parts { size - (number - 1) * part_size } else { part_size };
        if part.size != expected_size || result.insert(part.number, part.clone()).is_some() { return Err(CheckpointError::InvalidParts); }
    }
    Ok(result)
}

#[derive(Clone, Debug)]
pub(crate) struct UploadResumePlan {
    pub confirmed_parts: Vec<UploadedPart>,
    pub missing_parts: Vec<u32>,
}

/// server_upload_id and server_parts must come from an authenticated ListParts
/// for this binding, not from the checkpoint itself. Expired sessions restart.
pub(crate) fn validate_upload_resume(
    binding: &TransferBinding, record: &TransferCheckpoint, now_ms: u64,
    server_upload_id: &str, server_parts: &[UploadedPart], max_parts: u32,
) -> Result<UploadResumePlan, CheckpointError> {
    record.validate(binding)?;
    if !record.state.resumable() { return Err(CheckpointError::TerminalState); }
    let TransferPayload::Upload(upload) = &record.payload else { return Err(CheckpointError::InvalidRecord) };
    if upload.expires_at_ms.is_some_and(|expires| expires <= now_ms) { return Err(CheckpointError::ExpiredSession); }
    if upload.upload_id != server_upload_id { return Err(CheckpointError::SessionMismatch); }
    if fingerprint_file(binding.selected_path())? != upload.source { return Err(CheckpointError::SourceChanged); }
    let local = validate_parts(&upload.parts, upload.source.size, upload.part_size, max_parts)?;
    let server = validate_parts(server_parts, upload.source.size, upload.part_size, max_parts)?;
    for (number, part) in &local {
        if let Some(remote) = server.get(number) {
            if part.etag != remote.etag || part.size != remote.size
                || matches!((&part.sha256, &remote.sha256), (Some(left), Some(right)) if left != right) {
                return Err(CheckpointError::SessionMismatch);
            }
        }
    }
    let count = upload.source.size / upload.part_size + u64::from(upload.source.size % upload.part_size != 0);
    Ok(UploadResumePlan {
        confirmed_parts: server.values().cloned().collect(),
        missing_parts: (1..=count as u32).filter(|number| !server.contains_key(number)).collect(),
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DownloadResumePlan { pub offset: u64, pub remote_version: String }

pub(crate) fn validate_download_resume(binding: &TransferBinding, record: &TransferCheckpoint, current_remote: &RemoteIdentity) -> Result<DownloadResumePlan, CheckpointError> {
    record.validate(binding)?;
    if !record.state.resumable() { return Err(CheckpointError::TerminalState); }
    let TransferPayload::Download(download) = &record.payload else { return Err(CheckpointError::InvalidRecord) };
    if &download.remote != current_remote { return Err(CheckpointError::RemoteChanged); }
    let partial = fingerprint_file(&binding.download_part_path())?;
    if partial.size != download.partial_bytes || partial.sha256 != download.partial_sha256 { return Err(CheckpointError::PartialFileChanged); }
    Ok(DownloadResumePlan { offset: partial.size, remote_version: current_remote.version.clone() })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SealedCheckpoint { version: u8, nonce: String, ciphertext: String }

/// The caller supplies a vault-derived 32-byte key while the vault is unlocked.
/// It is not a storage credential and is never serialized. AES-GCM authenticates
/// every field and binds it to the live caller's task/path selection.
pub(crate) struct CheckpointStore { root: PathBuf, key: [u8; 32] }

impl Drop for CheckpointStore {
    fn drop(&mut self) { self.key.fill(0); }
}

impl CheckpointStore {
    pub(crate) fn for_app(key: &[u8; 32]) -> Result<Self, CheckpointError> {
        let root = super::config_paths::object0_config_dir().map_err(|_| CheckpointError::InvalidPath)?.join("transfer-checkpoints");
        Self::new(&root, key)
    }

    pub(crate) fn new(root: &Path, key: &[u8; 32]) -> Result<Self, CheckpointError> {
        check_path_components(root)?;
        fs::create_dir_all(root).map_err(io_error)?;
        check_path_components(root)?;
        if !root.is_dir() { return Err(CheckpointError::InvalidPath); }
        Ok(Self { root: root.canonicalize().map_err(io_error)?, key: *key })
    }

    fn associated_data(binding: &TransferBinding) -> Vec<u8> {
        format!("yuncang-transfer-checkpoint-v1:{}:{}:{}", binding.job_id, binding.scope_digest, binding.selection_digest).into_bytes()
    }

    fn seal(&self, binding: &TransferBinding, plaintext: &[u8]) -> Result<Vec<u8>, CheckpointError> {
        let mut nonce = [0_u8; 12]; rand::rngs::OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| CheckpointError::InvalidRecord)?;
        let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce), AeadPayload { msg: plaintext, aad: &Self::associated_data(binding) })
            .map_err(|_| CheckpointError::AuthenticationFailed)?;
        serde_json::to_vec(&SealedCheckpoint { version: CHECKPOINT_VERSION, nonce: BASE64.encode(nonce), ciphertext: BASE64.encode(ciphertext) })
            .map_err(|_| CheckpointError::InvalidRecord)
    }

    fn unseal(&self, binding: &TransferBinding, bytes: &[u8]) -> Result<Vec<u8>, CheckpointError> {
        let sealed: SealedCheckpoint = serde_json::from_slice(bytes).map_err(|_| CheckpointError::InvalidRecord)?;
        if sealed.version != CHECKPOINT_VERSION { return Err(CheckpointError::UnsupportedVersion); }
        let nonce = BASE64.decode(sealed.nonce).map_err(|_| CheckpointError::InvalidRecord)?;
        let ciphertext = BASE64.decode(sealed.ciphertext).map_err(|_| CheckpointError::InvalidRecord)?;
        if nonce.len() != 12 { return Err(CheckpointError::InvalidRecord); }
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| CheckpointError::InvalidRecord)?;
        cipher.decrypt(Nonce::from_slice(&nonce), AeadPayload { msg: &ciphertext, aad: &Self::associated_data(binding) })
            .map_err(|_| CheckpointError::AuthenticationFailed)
    }

    fn path(&self, binding: &TransferBinding) -> Result<PathBuf, CheckpointError> {
        if !valid_job_id(binding.job_id()) { return Err(CheckpointError::InvalidJobId); }
        check_path_components(&self.root)?;
        let path = self.root.join(format!("{}.json", binding.job_id()));
        check_path_components(&path)?;
        Ok(path)
    }

    pub(crate) fn save(&self, binding: &TransferBinding, record: &TransferCheckpoint) -> Result<(), CheckpointError> {
        record.validate(binding)?;
        let path = self.path(binding)?;
        let plaintext = serde_json::to_vec(record).map_err(|_| CheckpointError::InvalidRecord)?;
        if plaintext.len() as u64 > MAX_CHECKPOINT_BYTES { return Err(CheckpointError::InvalidRecord); }
        let bytes = self.seal(binding, &plaintext)?;
        if bytes.len() as u64 > MAX_CHECKPOINT_BYTES { return Err(CheckpointError::InvalidRecord); }
        let temporary = self.root.join(format!(".{}-{}.tmp", binding.job_id(), uuid::Uuid::new_v4()));
        let write = (|| {
            let mut options = OpenOptions::new(); options.write(true).create_new(true);
            #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            let mut file = options.open(&temporary).map_err(io_error)?;
            file.write_all(&bytes).map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            drop(file);
            // Recheck the managed target before replacement. No path from the
            // persisted document participates in this operation.
            self.path(binding)?;
            fs::rename(&temporary, &path).map_err(io_error)
        })();
        if write.is_err() { let _ = fs::remove_file(&temporary); }
        write
    }

    pub(crate) fn load(&self, binding: &TransferBinding) -> Result<Option<TransferCheckpoint>, CheckpointError> {
        let path = self.path(binding)?;
        let mut options = OpenOptions::new(); options.read(true);
        #[cfg(windows)] { use std::os::windows::fs::OpenOptionsExt; options.custom_flags(0x0020_0000); }
        let file = match options.open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(error)),
        };
        let metadata = file.metadata().map_err(io_error)?;
        if is_reparse(&metadata) || !metadata.is_file() { return Err(CheckpointError::UnsafePath); }
        if metadata.len() > MAX_CHECKPOINT_BYTES { return Err(CheckpointError::InvalidRecord); }
        let mut bytes = Vec::new(); file.take(MAX_CHECKPOINT_BYTES + 1).read_to_end(&mut bytes).map_err(io_error)?;
        if bytes.len() as u64 > MAX_CHECKPOINT_BYTES { return Err(CheckpointError::InvalidRecord); }
        let plaintext = self.unseal(binding, &bytes)?;
        let mut record: TransferCheckpoint = serde_json::from_slice(&plaintext).map_err(|_| CheckpointError::InvalidRecord)?;
        record.validate(binding)?;
        record.state = record.state.after_restart();
        Ok(Some(record))
    }

    /// Only removes this job's managed JSON; cancellation's remote abort and
    /// partial-file cleanup require the caller's authenticated session context.
    pub(crate) fn remove(&self, binding: &TransferBinding) -> Result<(), CheckpointError> {
        let path = self.path(binding)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("yuncang-checkpoint-tests-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap(); Self(path)
        }
        fn source(&self) -> PathBuf { let path=self.0.join("source.bin"); fs::write(&path,b"abcdefghij").unwrap(); path }
        fn binding(&self, path: &Path) -> TransferBinding { TransferBinding::new("fixture-job", &["profile-id", "qiniu-native", "bucket", "中文/+%key"], path).unwrap() }
        fn upload(&self, binding: &TransferBinding) -> TransferCheckpoint {
            TransferCheckpoint::new(binding, TransferState::Running, TransferPayload::Upload(UploadCheckpoint {
                upload_id:"fixture-upload-id".to_string(), expires_at_ms:Some(2000), part_size:4,
                source:fingerprint_file(binding.selected_path()).unwrap(),
                parts:vec![UploadedPart{number:1,size:4,etag:"part-1".to_string(),sha256:None}],
            }),1000).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let allowed = std::env::temp_dir();
            if self.0.is_absolute() && self.0.parent()==Some(allowed.as_path()) && self.0.file_name().unwrap().to_string_lossy().starts_with("yuncang-checkpoint-tests-") {
                let _=fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test] fn identifiers_reject_traversal_and_non_ascii() {
        for value in ["", "../job", "a/b", "a\\b", "C:job", "job.json", "中文", ".", ".."] { assert!(!valid_job_id(value)); }
        assert!(valid_job_id("job-123_ab"));
    }

    #[test] fn fingerprint_detects_same_size_content_changes() {
        let fixture=Fixture::new(); let source=fixture.source(); let before=fingerprint_file(&source).unwrap();
        fs::write(&source,b"jihgfedcba").unwrap(); let after=fingerprint_file(&source).unwrap();
        assert_eq!(before.size,after.size); assert_ne!(before.sha256,after.sha256);
    }

    #[test] fn persisted_state_is_bound_and_has_no_paths_urls_or_credentials() {
        let fixture=Fixture::new(); let source=fixture.source(); let binding=fixture.binding(&source); let record=fixture.upload(&binding);
        let store=CheckpointStore::new(&fixture.0.join("state"), &[7;32]).unwrap(); store.save(&binding,&record).unwrap();
        let json=fs::read_to_string(store.path(&binding).unwrap()).unwrap();
        for forbidden in ["source.bin", "中文", "secretAccessKey", "sessionToken", "Authorization", "https://"] { assert!(!json.contains(forbidden)); }
        let loaded=store.load(&binding).unwrap().unwrap(); assert_eq!(loaded.state,TransferState::Interrupted);
        store.remove(&binding).unwrap(); assert!(store.load(&binding).unwrap().is_none());
    }

    #[test] fn changing_scope_or_user_selected_path_rejects_record() {
        let fixture=Fixture::new(); let source=fixture.source(); let binding=fixture.binding(&source); let record=fixture.upload(&binding);
        let other=TransferBinding::new("fixture-job", &["other-account"], &source).unwrap();
        assert_eq!(record.validate(&other),Err(CheckpointError::WrongBinding));
        let destination=fixture.0.join("other.bin"); let other=fixture.binding(&destination);
        assert_eq!(record.validate(&other),Err(CheckpointError::WrongBinding));
    }

    #[test] fn unknown_fields_and_versions_fail_closed() {
        let fixture=Fixture::new(); let source=fixture.source(); let binding=fixture.binding(&source); let record=fixture.upload(&binding);
        let store=CheckpointStore::new(&fixture.0.join("state"), &[7;32]).unwrap();
        let mut json=serde_json::to_value(&record).unwrap(); json["secretAccessKey"]=serde_json::json!("never-load-me");
        fs::write(store.path(&binding).unwrap(),store.seal(&binding,&serde_json::to_vec(&json).unwrap()).unwrap()).unwrap();
        let error=store.load(&binding).unwrap_err(); assert_eq!(error,CheckpointError::InvalidRecord); assert!(!error.to_string().contains("never-load-me"));
        let mut future=record;future.version=2;assert_eq!(store.save(&binding,&future),Err(CheckpointError::UnsupportedVersion));
    }

    #[test] fn upload_resume_uses_authenticated_server_parts_as_truth() {
        let fixture=Fixture::new();let source=fixture.source();let binding=fixture.binding(&source);let record=fixture.upload(&binding);
        let server=vec![UploadedPart{number:1,size:4,etag:"part-1".to_string(),sha256:None},UploadedPart{number:2,size:4,etag:"part-2".to_string(),sha256:None}];
        let plan=validate_upload_resume(&binding,&record,1500,"fixture-upload-id",&server,10000).unwrap();
        assert_eq!(plan.confirmed_parts.len(),2);assert_eq!(plan.missing_parts,vec![3]);
    }

    #[test] fn upload_resume_rejects_expiry_session_changes_and_duplicates() {
        let fixture=Fixture::new();let source=fixture.source();let binding=fixture.binding(&source);let record=fixture.upload(&binding);
        assert_eq!(validate_upload_resume(&binding,&record,2000,"fixture-upload-id",&[],10000).unwrap_err(),CheckpointError::ExpiredSession);
        assert_eq!(validate_upload_resume(&binding,&record,1500,"different-upload",&[],10000).unwrap_err(),CheckpointError::SessionMismatch);
        let part=UploadedPart{number:1,size:4,etag:"part-1".to_string(),sha256:None};
        assert_eq!(validate_upload_resume(&binding,&record,1500,"fixture-upload-id",&[part.clone(),part],10000).unwrap_err(),CheckpointError::InvalidParts);
        fs::write(&source,b"changed!!!").unwrap();
        assert_eq!(validate_upload_resume(&binding,&record,1500,"fixture-upload-id",&[],10000).unwrap_err(),CheckpointError::SourceChanged);
    }

    #[test] fn partial_download_requires_matching_remote_identity_and_local_bytes() {
        let fixture=Fixture::new();let binding=fixture.binding(&fixture.0.join("target.bin"));let part=binding.download_part_path();fs::write(&part,b"abc").unwrap();
        let remote=RemoteIdentity{size:10,version:"opaque-version".to_string(),sha256:None};
        let record=TransferCheckpoint::new(&binding,TransferState::Paused,TransferPayload::Download(DownloadCheckpoint{remote:remote.clone(),partial_bytes:3,partial_sha256:fingerprint_file(&part).unwrap().sha256}),1000).unwrap();
        let plan=validate_download_resume(&binding,&record,&remote).unwrap();assert_eq!(plan.offset,3);assert_eq!(plan.remote_version,"opaque-version");
        let mut changed=remote.clone();changed.version="new-version".to_string();assert_eq!(validate_download_resume(&binding,&record,&changed).unwrap_err(),CheckpointError::RemoteChanged);
        fs::write(&part,b"abd").unwrap();assert_eq!(validate_download_resume(&binding,&record,&remote).unwrap_err(),CheckpointError::PartialFileChanged);
    }

    #[test] fn pause_preserves_state_and_cancel_requires_caller_cleanup() {
        assert_eq!(TransferState::Running.pause().unwrap(),TransferState::Paused);
        assert_eq!(TransferState::Completed.pause(),Err(CheckpointError::TerminalState));
        assert_eq!(control_action(ControlIntent::Pause),CheckpointAction::Preserve);
        assert_eq!(control_action(ControlIntent::Cancel),CheckpointAction::CancelAndCleanCallerVerifiedSession);
    }

    #[test] fn a_file_cannot_be_used_as_checkpoint_directory() {
        let fixture=Fixture::new();let path=fixture.source();assert!(CheckpointStore::new(&path,&[7;32]).is_err());
    }

    #[test] fn managed_directory_rejects_parent_traversal() {
        let fixture=Fixture::new();assert!(matches!(CheckpointStore::new(&fixture.0.join("../escape"),&[7;32]),Err(CheckpointError::InvalidPath)));
    }

    #[test] fn authenticated_envelope_rejects_known_field_tampering_wrong_key_and_scope() {
        let fixture=Fixture::new();let source=fixture.source();let binding=fixture.binding(&source);let record=fixture.upload(&binding);
        let root=fixture.0.join("state");let store=CheckpointStore::new(&root,&[7;32]).unwrap();store.save(&binding,&record).unwrap();
        let wrong_key=CheckpointStore::new(&root,&[8;32]).unwrap();
        assert_eq!(wrong_key.load(&binding).unwrap_err(),CheckpointError::AuthenticationFailed);
        let other_scope=TransferBinding::new("fixture-job",&["other-provider"],&source).unwrap();
        assert_eq!(store.load(&other_scope).unwrap_err(),CheckpointError::AuthenticationFailed);
        let path=store.path(&binding).unwrap();let mut sealed:SealedCheckpoint=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let mut ciphertext=BASE64.decode(sealed.ciphertext).unwrap();ciphertext[0]^=1;sealed.ciphertext=BASE64.encode(ciphertext);
        fs::write(&path,serde_json::to_vec(&sealed).unwrap()).unwrap();
        assert_eq!(store.load(&binding).unwrap_err(),CheckpointError::AuthenticationFailed);
    }

    #[test] fn permission_errors_are_explicit_but_do_not_expose_paths_or_secrets() {
        let error=io_error(std::io::Error::new(std::io::ErrorKind::PermissionDenied,"private-path-with-secret"));
        assert_eq!(error,CheckpointError::Io(std::io::ErrorKind::PermissionDenied));
        assert!(!error.to_string().contains("private-path-with-secret"));
    }

    #[test] fn repeated_atomic_saves_preserve_the_latest_state_without_temporary_files() {
        let fixture=Fixture::new();let source=fixture.source();let binding=fixture.binding(&source);let mut record=fixture.upload(&binding);
        let root=fixture.0.join("state");let store=CheckpointStore::new(&root,&[7;32]).unwrap();
        store.save(&binding,&record).unwrap();record.state=TransferState::Paused;record.saved_at_ms=1500;
        store.save(&binding,&record).unwrap();
        let loaded=store.load(&binding).unwrap().unwrap();assert_eq!(loaded.state,TransferState::Paused);assert_eq!(loaded.saved_at_ms,1500);
        assert_eq!(fs::read_dir(&root).unwrap().count(),1);
    }
}
