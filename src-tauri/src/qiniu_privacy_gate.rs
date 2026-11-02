//! Durable fail-closed guard for newly created Qiniu spaces whose private state
//! has not yet been verified. Markers contain no credentials or bucket names.
use super::*;
use sha2::{Digest, Sha256};

fn directory() -> Result<PathBuf, String> {
    Ok(config_paths::object0_config_dir()?.join("qiniu-pending-privacy"))
}
fn marker_name(config: &qiniu::QiniuConfig, bucket: &str) -> Result<String, String> {
    if bucket.trim().is_empty() || bucket.len() > 255 { return Err("Invalid bucket name".into()); }
    let environment = match config.mode {
        qiniu::QiniuMode::Public => qiniu::endpoint::PUBLIC_UC,
        qiniu::QiniuMode::Private => config.uc_url.as_deref().ok_or("Private UC URL is required")?,
    };
    let mut digest = Sha256::new();
    digest.update((environment.len() as u64).to_be_bytes());
    digest.update(environment.as_bytes());
    digest.update((bucket.len() as u64).to_be_bytes());
    digest.update(bucket.as_bytes());
    let bytes = digest.finalize();
    Ok(format!("{}.pending", bytes.iter().map(|byte|format!("{byte:02x}")).collect::<String>()))
}
fn check_directory(root: &Path, create: bool) -> Result<bool, String> {
    if create { fs::create_dir_all(root).map_err(|_| "无法保存空间隐私保护状态 / Could not save bucket privacy state".to_string())?; }
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err("空间隐私保护目录无效 / Bucket privacy guard directory is invalid".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound && !create => Ok(false),
        Err(_) => Err("无法读取空间隐私保护状态 / Could not read bucket privacy state".into()),
    }
}
fn marker(root: &Path, config: &qiniu::QiniuConfig, bucket: &str) -> Result<PathBuf, String> {
    Ok(root.join(marker_name(config,bucket)?))
}
fn mark_at(root: &Path, config: &qiniu::QiniuConfig, bucket: &str) -> Result<(), String> {
    check_directory(root,true)?;
    let path=marker(root,config,bucket)?;
    match fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => { file.write_all(b"pending\n").and_then(|_|file.sync_all())
            .map_err(|_|"无法完成空间隐私保护记录 / Could not persist bucket privacy guard".to_string())?; Ok(()) },
        Err(error) if error.kind()==io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err("无法创建空间隐私保护记录 / Could not create bucket privacy guard".into()),
    }
}
fn pending_at(root:&Path,config:&qiniu::QiniuConfig,bucket:&str)->Result<bool,String>{
    if !check_directory(root,false)? {return Ok(false)}
    match fs::symlink_metadata(marker(root,config,bucket)?) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Ok(true),
        Ok(_) => Err("空间隐私保护记录无效 / Invalid bucket privacy guard".into()),
        Err(error) if error.kind()==io::ErrorKind::NotFound=>Ok(false),
        Err(_)=>Err("无法读取空间隐私保护记录 / Could not read bucket privacy guard".into()),
    }
}
fn clear_at(root:&Path,config:&qiniu::QiniuConfig,bucket:&str)->Result<(),String>{
    if !pending_at(root,config,bucket)? {return Ok(())}
    fs::remove_file(marker(root,config,bucket)?).map_err(|_|"空间已验证，但无法清除保护记录 / Bucket was verified, but its guard could not be cleared".to_string())
}
pub(crate) fn mark(config:&qiniu::QiniuConfig,bucket:&str)->Result<(),String>{mark_at(&directory()?,config,bucket)}
pub(crate) fn clear(config:&qiniu::QiniuConfig,bucket:&str)->Result<(),String>{clear_at(&directory()?,config,bucket)}
async fn ensure_verified_at(root:&Path,client:&qiniu::QiniuClient,context:&qiniu::ResolvedBucketContext)->Result<(),String>{
    // Markers are recorded against the native bucket name at creation time.
    // Never use the caller-supplied name here: it can be an S3 alias for the
    // same bucket and would otherwise bypass a pending privacy guard.
    let native_name=&context.bucket.name;
    if pending_at(root,client.config(),native_name)? {
        client.verify_private_bucket(native_name).await.map_err(|error|error.to_string())?;
        clear_at(root,client.config(),native_name)?;
    }
    Ok(())
}
pub(crate) async fn ensure_verified(client:&qiniu::QiniuClient,context:&qiniu::ResolvedBucketContext)->Result<(),String>{
    ensure_verified_at(&directory()?,client,context).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn markers_are_durable_scoped_and_do_not_contain_bucket_names() {
        let root=std::env::temp_dir().join(format!("qiniu-privacy-{}",Uuid::new_v4()));
        let config=qiniu::QiniuConfig::default();
        assert!(!pending_at(&root,&config,"private-bucket").unwrap());
        mark_at(&root,&config,"private-bucket").unwrap();
        mark_at(&root,&config,"private-bucket").unwrap();
        assert!(pending_at(&root,&config,"private-bucket").unwrap());
        assert!(!pending_at(&root,&config,"other-bucket").unwrap());
        let entries:Vec<_>=fs::read_dir(&root).unwrap().filter_map(Result::ok).collect();
        assert_eq!(entries.len(),1);
        assert!(!entries[0].file_name().to_string_lossy().contains("private-bucket"));
        assert_eq!(fs::read(entries[0].path()).unwrap(),b"pending\n");
        clear_at(&root,&config,"private-bucket").unwrap();
        assert!(!pending_at(&root,&config,"private-bucket").unwrap());
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn marker_names_do_not_allow_path_traversal() {
        let config=qiniu::QiniuConfig::default();
        assert!(marker_name(&config,"").is_err());
        let name=marker_name(&config,"../../bucket").unwrap();
        assert!(!name.contains('/')&&!name.contains('\\'));
    }
    #[test] fn resolved_alias_cannot_bypass_pending_native_bucket_guard() {
        let root=std::env::temp_dir().join(format!("qiniu-privacy-alias-{}",Uuid::new_v4()));
        let config=qiniu::QiniuConfig {
            mode:qiniu::QiniuMode::Private,
            uc_url:Some("http://127.0.0.1:1".into()),
            regions:vec![qiniu::QiniuManualRegion{id:"test-region".into(),label:None,s3_endpoint:"http://127.0.0.1:1".into()}],
            ..Default::default()
        };
        // Temporary credentials cause native management requests to fail
        // before network I/O, making this a fully isolated guard test.
        let credentials=qiniu::QiniuCredentials::new("fixture-ak".into(),"fixture-sk".into(),Some("fixture-session".into())).unwrap();
        let client=qiniu::QiniuClient::new(config.clone(),credentials).unwrap();
        let region=qiniu::QiniuRegion::manual_regions(&config).remove(0);
        let bucket=qiniu::QiniuBucket{name:"native-bucket".into(),s3_name:Some("s3-alias".into()),kodo_region_id:None,created_at:None,permission:None,remark:None};
        let mut context=qiniu::ResolvedBucketContext{bucket,region,s3_bucket_name:Some("s3-alias".into()),backend_mode:"s3".into()};
        mark_at(&root,&config,"native-bucket").unwrap();
        assert!(!pending_at(&root,&config,"s3-alias").unwrap()); // alias alone is not the marker key
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(runtime.block_on(ensure_verified_at(&root,&client,&context)).is_err());
        assert!(pending_at(&root,&config,"native-bucket").unwrap());
        context.bucket.name="another-bucket".into();
        assert!(runtime.block_on(ensure_verified_at(&root,&client,&context)).is_ok());
        clear_at(&root,&config,"native-bucket").unwrap();
        fs::remove_dir(root).unwrap();
    }
}
