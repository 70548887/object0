//! Disposable synthetic records only; no app vault, target file or network.
use super::*;
use crate::qiniu::range_download::RemoteIdentity;

struct Fixture(PathBuf);

#[test]fn display_location_roundtrips_and_old_download_records_remain_readable_without_current_account_lookup(){
    let fixture=Fixture::new();let store=fixture.store();let mut record=fixture.record();
    let legacy=serde_json::to_value(&record).unwrap();assert!(legacy.get("location").is_none());
    let restored:DownloadRecord=serde_json::from_value(legacy).unwrap();assert!(restored.location.is_none());store.save(&restored).unwrap();
    record.location=Some(crate::JobLocation{profile_id:record.profile_id.clone(),profile_name:Some("Historical download account".into()),provider:Some(crate::S3Provider::Qiniu),bucket:record.bucket.clone(),key:Some(record.key.clone()),prefix:None});
    store.save(&record).unwrap();assert_eq!(store.load(&record.job_id).unwrap().unwrap().location,record.location);
    assert!(!String::from_utf8_lossy(&fs::read(store.path(&record.job_id).unwrap()).unwrap()).contains("Historical download account"));
    let mut bad=record.clone();bad.location.as_mut().unwrap().bucket="other".into();assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.location.as_mut().unwrap().profile_id="other".into();assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.location.as_mut().unwrap().key=Some("other".into());assert!(store.save(&bad).is_err());
    record.location.as_mut().unwrap().profile_name=None;record.location.as_mut().unwrap().provider=None;store.save(&record).unwrap();
    assert!(store.load(&record.job_id).unwrap().unwrap().location.unwrap().provider.is_none());
}
impl Fixture{
    fn new()->Self{let path=std::env::temp_dir().join(format!("yuncang-download-store-test-{}",uuid::Uuid::new_v4()));fs::create_dir(&path).unwrap();Self(path.canonicalize().unwrap())}
    fn store(&self)->Store{Store::new(&self.0.join("records"),&[0x71;32]).unwrap()}
    fn record(&self)->DownloadRecord{
        let id=uuid::Uuid::new_v4().to_string();
        let cp=DownloadCheckpoint{format_version:1,job_id:id.clone(),profile_id:"fixture-profile".into(),profile_revision:"fixture-revision".into(),bucket:"fixture-bucket".into(),key:"private/中文+%fixture-key.bin".into(),
            domain:"https://fixture-download.example".into(),target_path:self.0.join("not-opened-target.bin").to_string_lossy().into_owned(),partial_path:self.0.join(format!(".yuncang-range-{id}.part")).to_string_lossy().into_owned(),
            remote:RemoteIdentity{size:5,etag:"Fqr0xh3cxeii2r7eDztILNmuqUNN".into(),last_modified:"2026-10-31T00:00:00Z".into()},offset:0,prefix_sha256:EMPTY_SHA256.into(),partial_created:None,phase:DownloadPhase::Downloading};
        DownloadRecord{format_version:1,job_id:id,profile_id:cp.profile_id.clone(),profile_revision:cp.profile_revision.clone(),bucket:cp.bucket.clone(),key:cp.key.clone(),location:None,checkpoint:cp,state:DownloadState::Queued,attempt:1,cancel_requested:false,created_at:"2026-10-31T00:00:00Z".into(),updated_at:"2026-10-31T00:00:00Z".into(),error:None}
    }
}
impl Drop for Fixture{fn drop(&mut self){let parent=std::env::temp_dir().canonicalize().unwrap();if self.0.parent()==Some(parent.as_path())&&self.0.file_name().unwrap().to_string_lossy().starts_with("yuncang-download-store-test-"){let _=fs::remove_dir_all(&self.0);}}}

#[test]fn encrypted_roundtrip_does_not_expose_paths_identity_domain_or_hash(){
    let fixture=Fixture::new();let store=fixture.store();let record=fixture.record();store.save(&record).unwrap();let bytes=fs::read(store.path(&record.job_id).unwrap()).unwrap();let text=String::from_utf8_lossy(&bytes);
    for value in [record.checkpoint.target_path.as_str(),record.checkpoint.partial_path.as_str(),record.profile_id.as_str(),record.profile_revision.as_str(),record.bucket.as_str(),record.key.as_str(),record.checkpoint.domain.as_str(),record.checkpoint.remote.etag.as_str()]{assert!(!text.contains(value));}
    let loaded=store.load(&record.job_id).unwrap().unwrap();assert_eq!(serde_json::to_value(loaded).unwrap(),serde_json::to_value(record).unwrap());
}

#[test]fn wrong_key_job_ciphertext_version_and_unknown_fields_fail_closed(){
    let fixture=Fixture::new();let store=fixture.store();let record=fixture.record();store.save(&record).unwrap();let path=store.path(&record.job_id).unwrap();let original=fs::read(&path).unwrap();
    assert!(Store::new(&store.root,&[0x72;32]).unwrap().load(&record.job_id).is_err());
    let other=uuid::Uuid::new_v4().to_string();fs::write(store.path(&other).unwrap(),&original).unwrap();assert!(store.load(&other).is_err());
    let mut envelope:serde_json::Value=serde_json::from_slice(&original).unwrap();let mut bytes=STANDARD.decode(envelope["ciphertext"].as_str().unwrap()).unwrap();bytes[0]^=1;envelope["ciphertext"]=STANDARD.encode(bytes).into();fs::write(&path,serde_json::to_vec(&envelope).unwrap()).unwrap();assert!(store.load(&record.job_id).is_err());
    let mut envelope:serde_json::Value=serde_json::from_slice(&original).unwrap();envelope["version"]=99.into();fs::write(&path,serde_json::to_vec(&envelope).unwrap()).unwrap();assert!(store.load(&record.job_id).is_err());
    let mut envelope:serde_json::Value=serde_json::from_slice(&original).unwrap();envelope["sessionToken"]="fixture-not-a-real-token".into();fs::write(&path,serde_json::to_vec(&envelope).unwrap()).unwrap();assert!(store.load(&record.job_id).is_err());
    let mut plain=serde_json::to_value(&record).unwrap();plain["checkpoint"]["sessionToken"]="fixture".into();fs::write(&path,store.seal(&record.job_id,&serde_json::to_vec(&plain).unwrap()).unwrap()).unwrap();assert!(store.load(&record.job_id).is_err());
}

#[test]fn upload_domain_ciphertext_cannot_be_replayed_as_download_manifest(){
    let fixture=Fixture::new();let store=fixture.store();let record=fixture.record();let nonce=[0x31;12];let plain=serde_json::to_vec(&record).unwrap();
    let ciphertext=Aes256Gcm::new_from_slice(&[0x71;32]).unwrap().encrypt(Nonce::from_slice(&nonce),Payload{msg:&plain,aad:format!("yuncang-native-upload-v1:{}",record.job_id).as_bytes()}).unwrap();
    let bytes=serde_json::to_vec(&Envelope{version:1,nonce:STANDARD.encode(nonce),ciphertext:STANDARD.encode(ciphertext)}).unwrap();fs::write(store.path(&record.job_id).unwrap(),bytes).unwrap();assert!(store.load(&record.job_id).is_err());
}

#[test]fn record_binding_paths_and_range_identity_are_validated_without_opening_targets(){
    let fixture=Fixture::new();let store=fixture.store();let record=fixture.record();
    let mut bad=record.clone();bad.checkpoint.profile_revision="wrong".into();assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.checkpoint.job_id=uuid::Uuid::new_v4().to_string();assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.checkpoint.partial_path=fixture.0.join("other.part").to_string_lossy().into_owned();assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.checkpoint.target_path="relative.bin".into();assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.checkpoint.domain="https://fixture-download.example?token=fixture".into();assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.checkpoint.remote.etag="not-a-qiniu-hash".into();assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.checkpoint.offset=6;bad.checkpoint.partial_created=Some("stamp".into());bad.checkpoint.prefix_sha256="a".repeat(64);assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.state=DownloadState::Completed;assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.checkpoint.phase=DownloadPhase::Committing;assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.error=Some("https://fixture.example/?token=not-real".into());assert!(store.save(&bad).is_err());
    assert!(!Path::new(&record.checkpoint.target_path).exists());assert!(!Path::new(&record.checkpoint.partial_path).exists());
}

#[test]fn failed_atomic_commit_preserves_previous_record_and_cleans_own_temp(){
    let fixture=Fixture::new();let store=fixture.store();let mut record=fixture.record();store.save(&record).unwrap();let path=store.path(&record.job_id).unwrap();let before=fs::read(&path).unwrap();record.state=DownloadState::Paused;
    assert!(store.save_before_commit(&record,||Err("synthetic disk error".into())).is_err());assert_eq!(fs::read(&path).unwrap(),before);assert_eq!(store.load(&record.job_id).unwrap().unwrap().state,DownloadState::Queued);assert_eq!(fs::read_dir(&store.root).unwrap().count(),1);
    store.save(&record).unwrap();assert_eq!(store.load(&record.job_id).unwrap().unwrap().state,DownloadState::Paused);
}

#[test]fn restore_is_read_only_and_reports_bad_records_instead_of_empty_queue(){
    let fixture=Fixture::new();let store=fixture.store();let mut record=fixture.record();record.state=DownloadState::Running;record.attempt=3;store.save(&record).unwrap();let path=store.path(&record.job_id).unwrap();let before=fs::read(&path).unwrap();
    fs::write(store.root.join(format!("{}.download",uuid::Uuid::new_v4())),b"bad ciphertext").unwrap();fs::write(store.root.join("invalid-id.download"),b"bad name").unwrap();
    let report=store.load_all().unwrap();assert_eq!(report.records.len(),1);assert_eq!(report.unreadable_count,2);assert_eq!(report.records[0].state,DownloadState::Running);assert_eq!(report.records[0].state.after_restart(),DownloadState::Interrupted);assert_eq!(report.records[0].attempt,3);assert_eq!(fs::read(&path).unwrap(),before);
    let wrong=Store::new(&store.root,&[0x72;32]).unwrap().load_all().unwrap();assert!(wrong.records.is_empty());assert_eq!(wrong.unreadable_count,3);assert!(!Path::new(&record.checkpoint.target_path).exists());
    assert_eq!(DownloadState::Paused.after_restart(),DownloadState::Paused);assert_eq!(DownloadState::Completed.after_restart(),DownloadState::Completed);
}

#[test]fn identity_progress_partial_creation_and_completion_phase_never_roll_back(){
    let fixture=Fixture::new();let store=fixture.store();let mut record=fixture.record();store.save(&record).unwrap();
    for change in 0..4{let mut bad=record.clone();match change{0=>bad.checkpoint.remote.size=6,1=>bad.checkpoint.domain="https://other.example".into(),2=>bad.checkpoint.remote.last_modified="2026-10-30T00:00:00Z".into(),_=>bad.checkpoint.target_path=fixture.0.join("other-target.bin").to_string_lossy().into_owned()};assert!(store.save(&bad).is_err());}
    record.checkpoint.partial_created=Some("created-stamp".into());record.checkpoint.offset=2;record.checkpoint.prefix_sha256="a".repeat(64);record.state=DownloadState::Running;store.save(&record).unwrap();
    let mut bad=record.clone();bad.checkpoint.offset=0;bad.checkpoint.prefix_sha256=EMPTY_SHA256.into();assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.checkpoint.prefix_sha256="b".repeat(64);assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.checkpoint.partial_created=None;assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.checkpoint.partial_created=Some("another-created-stamp".into());assert!(store.save(&bad).is_err());
    record.checkpoint.offset=5;record.checkpoint.prefix_sha256="c".repeat(64);record.checkpoint.phase=DownloadPhase::Committing;record.state=DownloadState::Interrupted;store.save(&record).unwrap();
    let mut bad=record.clone();bad.checkpoint.phase=DownloadPhase::Downloading;assert!(store.save(&bad).is_err());
    record.checkpoint.phase=DownloadPhase::Completed;record.state=DownloadState::Completed;store.save(&record).unwrap();
    let mut bad=record.clone();bad.state=DownloadState::Interrupted;assert!(store.save(&bad).is_err());let mut bad=record;bad.checkpoint.phase=DownloadPhase::Cancelled;assert!(store.save(&bad).is_err());
}

#[test]fn cancellation_and_attempt_are_monotonic_across_reopen(){
    let fixture=Fixture::new();let store=fixture.store();let mut record=fixture.record();store.save(&record).unwrap();record.cancel_requested=true;record.attempt=2;record.state=DownloadState::Interrupted;store.save(&record).unwrap();let path=store.path(&record.job_id).unwrap();let confirmed=fs::read(&path).unwrap();
    let reopened=fixture.store();let restored=reopened.load(&record.job_id).unwrap().unwrap();assert!(restored.cancel_requested);assert_eq!(restored.attempt,2);
    let mut bad=record.clone();bad.cancel_requested=false;assert!(reopened.save(&bad).is_err());let mut bad=record.clone();bad.attempt=1;assert!(reopened.save(&bad).is_err());assert_eq!(fs::read(path).unwrap(),confirmed);
    let mut legacy=serde_json::to_value(fixture.record()).unwrap();legacy.as_object_mut().unwrap().remove("attempt");legacy.as_object_mut().unwrap().remove("cancelRequested");let parsed:DownloadRecord=serde_json::from_value(legacy).unwrap();assert_eq!(parsed.attempt,1);assert!(!parsed.cancel_requested);
    record.checkpoint.phase=DownloadPhase::Cancelled;record.state=DownloadState::Cancelled;reopened.save(&record).unwrap();let mut bad=record;bad.state=DownloadState::Interrupted;assert!(reopened.save(&bad).is_err());
}

#[test]fn size_count_path_and_debug_limits_preserve_unrelated_files(){
    let fixture=Fixture::new();let store=fixture.store();let record=fixture.record();
    for id in ["../escape","", "fixture-id"]{assert!(store.load(id).is_err());assert!(store.remove(id).is_err());}
    assert!(Store::new(Path::new("relative-store"),&[7;32]).is_err());
    let path=store.path(&record.job_id).unwrap();let file=fs::File::create(&path).unwrap();file.set_len(MAX_RECORD_BYTES+1).unwrap();drop(file);assert!(store.load(&record.job_id).is_err());fs::remove_file(path).unwrap();store.save(&record).unwrap();
    let debug=format!("{store:?} {record:?}");for private in [record.checkpoint.target_path.as_str(),record.checkpoint.partial_path.as_str(),record.key.as_str(),record.profile_id.as_str(),record.checkpoint.domain.as_str()]{assert!(!debug.contains(private));}
    for _ in 1..MAX_RECORDS{fs::write(store.root.join(format!("{}.download",uuid::Uuid::new_v4())),b"broken").unwrap();}
    assert!(store.save(&fixture.record()).is_err());store.remove(&record.job_id).unwrap();assert_eq!(fs::read_dir(&store.root).unwrap().count(),MAX_RECORDS-1);
}

#[test]fn keyless_count_never_creates_directory_or_reads_ciphertext(){
    let fixture=Fixture::new();let path=fixture.0.join("not-created");assert_eq!(Store::record_count(&path).unwrap(),0);assert!(!path.exists());fs::create_dir(&path).unwrap();assert_eq!(Store::record_count(&path).unwrap(),0);
    let record=path.join(format!("{}.download",uuid::Uuid::new_v4()));fs::write(&record,b"not decrypted").unwrap();fs::write(path.join(".pending.tmp"),b"ignored").unwrap();assert_eq!(Store::record_count(&path).unwrap(),1);assert_eq!(fs::read(record).unwrap(),b"not decrypted");
    fs::write(path.join("invalid-id.download"),b"bad name").unwrap();assert!(Store::record_count(&path).is_err());
}

#[cfg(unix)]
#[test]fn symbolic_links_are_rejected_for_root_and_managed_manifest(){
    use std::os::unix::fs::symlink;
    let fixture=Fixture::new();let target=fixture.0.join("outside");fs::create_dir(&target).unwrap();let link=fixture.0.join("linked");symlink(&target,&link).unwrap();assert!(Store::new(&link,&[7;32]).is_err());assert!(Store::record_count(&link).is_err());
    let store=fixture.store();let record=fixture.record();let unrelated=fixture.0.join("unrelated");fs::write(&unrelated,b"untouched").unwrap();symlink(&unrelated,store.root.join(format!("{}.download",record.job_id))).unwrap();assert!(store.load(&record.job_id).is_err());assert!(store.save(&record).is_err());assert!(store.remove(&record.job_id).is_err());assert!(Store::record_count(&store.root).is_err());assert_eq!(fs::read(unrelated).unwrap(),b"untouched");
}
