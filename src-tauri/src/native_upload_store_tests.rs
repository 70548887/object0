//! Synthetic disposable records and directories only; no app configuration,
//! vault, real credentials, network or upload execution is used here.
use super::*;
use crate::qiniu::multipart::MultipartPart;

struct Fixture(PathBuf);

#[test]fn display_location_roundtrips_and_old_upload_records_remain_readable_without_guessing_names(){
    let fixture=Fixture::new();let store=fixture.store();let mut record=fixture.record();
    let legacy=serde_json::to_value(&record).unwrap();
    assert!(legacy.get("location").is_none());
    let restored:UploadRecord=serde_json::from_value(legacy).unwrap();
    assert!(restored.location.is_none());store.save(&restored).unwrap();
    record.location=Some(crate::JobLocation{profile_id:record.profile_id.clone(),profile_name:Some("Historical account label".into()),provider:Some(crate::S3Provider::Qiniu),bucket:record.bucket.clone(),key:Some(record.key.clone()),prefix:None});
    store.save(&record).unwrap();let loaded=store.load(&record.job_id).unwrap().unwrap();
    assert_eq!(loaded.location,record.location);
    assert!(!String::from_utf8_lossy(&fs::read(store.path(&record.job_id).unwrap()).unwrap()).contains("Historical account label"));
    let mut bad=record.clone();bad.location.as_mut().unwrap().bucket="other-bucket".into();assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.location.as_mut().unwrap().profile_id="other-profile".into();assert!(store.save(&bad).is_err());
    let mut bad=record.clone();bad.location.as_mut().unwrap().key=Some("other-key".into());assert!(store.save(&bad).is_err());
    record.location.as_mut().unwrap().profile_name=None;record.location.as_mut().unwrap().provider=None;store.save(&record).unwrap();
    assert!(store.load(&record.job_id).unwrap().unwrap().location.unwrap().profile_name.is_none());
}
impl Fixture {
    fn new()->Self{
        let root=std::env::temp_dir().join(format!("yuncang-native-store-test-{}",uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();Self(root.canonicalize().unwrap())
    }
    fn store(&self)->Store{Store::new(&self.0.join("records"),&[7;32]).unwrap()}
    fn record(&self)->UploadRecord{
        let path=self.0.join("source-not-opened.bin").to_string_lossy().into_owned();
        UploadRecord{format_version:RECORD_VERSION,job_id:uuid::Uuid::new_v4().to_string(),profile_id:"fixture-profile-id".into(),profile_revision:"fixture-revision".into(),
            bucket:"fixture-bucket".into(),key:"private/中文+%secret-object.bin".into(),location:None,local_path:path.clone(),
            source:SourceFingerprint{canonical_path:path,size:5,modified_nanos:"1700000000000000000".into(),sha256:"a".repeat(64),qiniu_etag:"Fqr0xh3cxeii2r7eDztILNmuqUNN".into()},
            options:MultipartOptions::default(),checkpoint:None,state:UploadState::Queued,attempt:1,cancel_requested:false,created_at:"2026-10-31T00:00:00Z".into(),updated_at:"2026-10-31T00:00:00Z".into(),error:None}
    }
    fn checkpoint(&self,record:&UploadRecord)->MultipartCheckpoint{
        MultipartCheckpoint{format_version:1,profile_id:record.profile_id.clone(),profile_revision:record.profile_revision.clone(),bucket:record.bucket.clone(),key:record.key.clone(),source:record.source.clone(),options:record.options.clone(),
            endpoint:"https://upload-fixture.example".into(),region:"cn-east-1".into(),upload_id:"fixture-upload-id".into(),expire_at:1900000000,part_size:MIN_PART_SIZE,
            parts:vec![MultipartPart{part_number:1,etag:"fixture-part-id".into(),size:5,sha256:"b".repeat(64)}],phase:MultipartPhase::Uploading}
    }
}
impl Drop for Fixture{
    fn drop(&mut self){
        // This exact canonical UUID directory was just created by Fixture.
        let expected=std::env::temp_dir().canonicalize().unwrap();
        if self.0.parent()==Some(expected.as_path())&&self.0.file_name().unwrap().to_string_lossy().starts_with("yuncang-native-store-test-"){let _=fs::remove_dir_all(&self.0);}
    }
}

#[test]
fn encrypted_roundtrip_has_no_plaintext_task_path_object_endpoint_or_metadata(){
    let fixture=Fixture::new();let store=fixture.store();let mut record=fixture.record();record.checkpoint=Some(fixture.checkpoint(&record));record.state=UploadState::Paused;
    record.options.metadata.insert("note".into(),"fixture-private-value".into());record.checkpoint.as_mut().unwrap().options=record.options.clone();
    store.save(&record).unwrap();let bytes=fs::read(store.path(&record.job_id).unwrap()).unwrap();let text=String::from_utf8_lossy(&bytes);
    for private in [record.local_path.as_str(),record.key.as_str(),record.bucket.as_str(),record.profile_id.as_str(),record.profile_revision.as_str(),"https://upload-fixture.example","fixture-upload-id","fixture-private-value"]{assert!(!text.contains(private));}
    let restored=store.load(&record.job_id).unwrap().unwrap();assert_eq!(restored.state,UploadState::Paused);assert_eq!(restored.attempt,1);
    assert_eq!(serde_json::to_value(restored).unwrap(),serde_json::to_value(record).unwrap());
}

#[test]
fn tamper_wrong_key_wrong_job_and_unsupported_envelope_are_rejected(){
    let fixture=Fixture::new();let store=fixture.store();let record=fixture.record();store.save(&record).unwrap();let path=store.path(&record.job_id).unwrap();let original=fs::read(&path).unwrap();
    let wrong=Store::new(&store.root,&[8;32]).unwrap();assert!(wrong.load(&record.job_id).is_err());
    let other_id=uuid::Uuid::new_v4().to_string();fs::write(store.path(&other_id).unwrap(),&original).unwrap();assert!(store.load(&other_id).is_err());
    let mut envelope:serde_json::Value=serde_json::from_slice(&original).unwrap();let ciphertext=envelope["ciphertext"].as_str().unwrap();let mut decoded=STANDARD.decode(ciphertext).unwrap();decoded[0]^=1;envelope["ciphertext"]=STANDARD.encode(decoded).into();
    fs::write(&path,serde_json::to_vec(&envelope).unwrap()).unwrap();assert!(store.load(&record.job_id).is_err());
    let mut envelope:serde_json::Value=serde_json::from_slice(&original).unwrap();envelope["version"]=99.into();fs::write(&path,serde_json::to_vec(&envelope).unwrap()).unwrap();assert!(store.load(&record.job_id).is_err());
    envelope["version"]=1.into();envelope["sessionToken"]="not-a-real-token".into();fs::write(&path,serde_json::to_vec(&envelope).unwrap()).unwrap();assert!(store.load(&record.job_id).is_err());
}

#[test]
fn record_and_checkpoint_identity_options_source_and_phase_must_match(){
    let fixture=Fixture::new();let store=fixture.store();let mut original=fixture.record();original.checkpoint=Some(fixture.checkpoint(&original));
    let mut wrong=original.clone();wrong.checkpoint.as_mut().unwrap().profile_revision="wrong-revision".into();assert!(store.save(&wrong).is_err());
    let mut wrong=original.clone();wrong.checkpoint.as_mut().unwrap().bucket="wrong".into();assert!(store.save(&wrong).is_err());
    let mut wrong=original.clone();wrong.checkpoint.as_mut().unwrap().key="wrong".into();assert!(store.save(&wrong).is_err());
    let mut wrong=original.clone();wrong.checkpoint.as_mut().unwrap().source.sha256="c".repeat(64);assert!(store.save(&wrong).is_err());
    let mut wrong=original.clone();wrong.checkpoint.as_mut().unwrap().options.overwrite=true;assert!(store.save(&wrong).is_err());
    let mut wrong=original.clone();wrong.checkpoint.as_mut().unwrap().endpoint="https://upload.example?token=secret".into();assert!(store.save(&wrong).is_err());
    let mut wrong=original.clone();let duplicated=wrong.checkpoint.as_ref().unwrap().parts[0].clone();wrong.checkpoint.as_mut().unwrap().parts.push(duplicated);assert!(store.save(&wrong).is_err());
    let mut wrong=original.clone();wrong.state=UploadState::Completed;assert!(store.save(&wrong).is_err());
    let mut wrong=original.clone();wrong.state=UploadState::Cancelled;assert!(store.save(&wrong).is_err());
    let mut wrong=original.clone();wrong.state=UploadState::Paused;wrong.checkpoint.as_mut().unwrap().phase=MultipartPhase::Completing;assert!(store.save(&wrong).is_err());
    let mut wrong=original;wrong.format_version=99;assert!(store.save(&wrong).is_err());
}

#[test]
fn failed_atomic_commit_preserves_previous_ciphertext_and_removes_own_temp(){
    let fixture=Fixture::new();let store=fixture.store();let mut record=fixture.record();store.save(&record).unwrap();let path=store.path(&record.job_id).unwrap();let original=fs::read(&path).unwrap();
    record.state=UploadState::Paused;
    assert!(store.save_before_commit(&record,||Err("synthetic commit failure".into())).is_err());
    assert_eq!(fs::read(&path).unwrap(),original);assert_eq!(store.load(&record.job_id).unwrap().unwrap().state,UploadState::Queued);
    assert_eq!(fs::read_dir(&store.root).unwrap().count(),1);
    store.save(&record).unwrap();assert_eq!(store.load(&record.job_id).unwrap().unwrap().state,UploadState::Paused);
}

#[test]
fn restoration_never_reads_sources_or_changes_disk_or_schedules_work(){
    let fixture=Fixture::new();let store=fixture.store();let mut record=fixture.record();assert!(!Path::new(&record.local_path).exists());record.state=UploadState::Running;record.attempt=4;store.save(&record).unwrap();
    let path=store.path(&record.job_id).unwrap();let before=fs::read(&path).unwrap();let report=store.load_all().unwrap();assert_eq!(report.records.len(),1);assert_eq!(report.unreadable_count,0);
    assert_eq!(report.records[0].state,UploadState::Running);assert_eq!(report.records[0].state.after_restart(),UploadState::Interrupted);assert_eq!(report.records[0].attempt,4);
    assert_eq!(fs::read(&path).unwrap(),before);assert!(!Path::new(&record.local_path).exists());
    assert_eq!(UploadState::Paused.after_restart(),UploadState::Paused);assert_eq!(UploadState::Completed.after_restart(),UploadState::Completed);
}

#[test]
fn unreadable_records_are_counted_and_valid_records_are_retained(){
    let fixture=Fixture::new();let store=fixture.store();let record=fixture.record();store.save(&record).unwrap();
    fs::write(store.root.join(format!("{}.upload",uuid::Uuid::new_v4())),b"broken envelope").unwrap();fs::write(store.root.join("not-a-uuid.upload"),b"bad identity").unwrap();
    let report=store.load_all().unwrap();assert_eq!(report.records.len(),1);assert_eq!(report.unreadable_count,2);assert_eq!(report.records[0].job_id,record.job_id);
    let wrong=Store::new(&store.root,&[9;32]).unwrap().load_all().unwrap();assert!(wrong.records.is_empty());assert_eq!(wrong.unreadable_count,3);
}

#[test]
fn immutable_bindings_terminal_states_and_completion_uncertainty_cannot_be_reset(){
    let fixture=Fixture::new();let store=fixture.store();let mut record=fixture.record();store.save(&record).unwrap();
    let mut wrong=record.clone();wrong.profile_revision="new-credentials".into();assert!(store.save(&wrong).is_err());
    let mut wrong=record.clone();wrong.local_path.push('x');wrong.source.canonical_path=wrong.local_path.clone();assert!(store.save(&wrong).is_err());
    record.checkpoint=Some(fixture.checkpoint(&record));record.state=UploadState::Running;store.save(&record).unwrap();
    record.checkpoint.as_mut().unwrap().phase=MultipartPhase::Completing;record.state=UploadState::Interrupted;store.save(&record).unwrap();
    let mut wrong=record.clone();wrong.checkpoint=None;assert!(store.save(&wrong).is_err());
    let mut wrong=record.clone();wrong.checkpoint.as_mut().unwrap().phase=MultipartPhase::Uploading;assert!(store.save(&wrong).is_err());
    record.checkpoint.as_mut().unwrap().phase=MultipartPhase::Completed;record.state=UploadState::Completed;store.save(&record).unwrap();
    record.state=UploadState::Interrupted;assert!(store.save(&record).is_err());
}

#[test]
fn retry_attempt_never_rolls_back_or_increments_on_load(){
    let fixture=Fixture::new();let store=fixture.store();let mut record=fixture.record();store.save(&record).unwrap();
    record.attempt=2;record.state=UploadState::Interrupted;store.save(&record).unwrap();
    assert_eq!(store.load(&record.job_id).unwrap().unwrap().attempt,2);record.attempt=1;assert!(store.save(&record).is_err());
    let mut plain=serde_json::to_value(fixture.record()).unwrap();plain.as_object_mut().unwrap().remove("attempt");assert_eq!(serde_json::from_value::<UploadRecord>(plain).unwrap().attempt,1);
}

#[test]
fn cancellation_intent_survives_reopen_and_cannot_be_cleared_by_a_stale_writer(){
    let fixture=Fixture::new();let store=fixture.store();let mut record=fixture.record();record.checkpoint=Some(fixture.checkpoint(&record));store.save(&record).unwrap();
    record.cancel_requested=true;store.save(&record).unwrap();let path=store.path(&record.job_id).unwrap();let confirmed_cancel=fs::read(&path).unwrap();
    let reopened=Store::new(&store.root,&[7;32]).unwrap();let loaded=reopened.load(&record.job_id).unwrap().unwrap();
    assert!(loaded.cancel_requested);assert_eq!(loaded.attempt,1);assert_eq!(loaded.state.after_restart(),UploadState::Interrupted);
    record.cancel_requested=false;record.attempt=2;record.state=UploadState::Running;assert!(reopened.save(&record).is_err());assert_eq!(fs::read(&path).unwrap(),confirmed_cancel);
    let mut legacy=serde_json::to_value(fixture.record()).unwrap();legacy.as_object_mut().unwrap().remove("cancelRequested");assert!(!serde_json::from_value::<UploadRecord>(legacy).unwrap().cancel_requested);
}

#[test]
fn invalid_paths_ids_diagnostics_and_oversize_files_fail_closed(){
    let fixture=Fixture::new();let store=fixture.store();let mut record=fixture.record();
    for id in ["../escape","fixture-job","","00000000-0000-0000-0000-000000000000/child"]{assert!(store.load(id).is_err());assert!(store.remove(id).is_err());}
    assert!(Store::new(Path::new("relative-store"),&[7;32]).is_err());
    record.error=Some("https://example.test/?token=fixture-secret".into());assert!(store.save(&record).is_err());record.error=None;
    let path=store.path(&record.job_id).unwrap();let file=fs::File::create(path).unwrap();file.set_len(MAX_RECORD_BYTES+1).unwrap();drop(file);assert!(store.load(&record.job_id).is_err());
    let debug=format!("{store:?} {record:?}");for private in [record.local_path.as_str(),record.key.as_str(),record.profile_id.as_str(),"fixture-secret"]{assert!(!debug.contains(private));}
}

#[test]
fn record_count_is_bounded_and_remove_only_removes_selected_managed_record(){
    let fixture=Fixture::new();let store=fixture.store();let record=fixture.record();store.save(&record).unwrap();
    for _ in 1..MAX_RECORDS{fs::write(store.root.join(format!("{}.upload",uuid::Uuid::new_v4())),b"unreadable").unwrap();}
    let another=fixture.record();assert!(store.save(&another).is_err());assert!(store.load(&record.job_id).unwrap().is_some());
    store.remove(&record.job_id).unwrap();assert!(store.load(&record.job_id).unwrap().is_none());assert_eq!(fs::read_dir(&store.root).unwrap().count(),MAX_RECORDS-1);
}

#[test]
fn keyless_record_count_does_not_create_or_read_manifest_content(){
    let fixture=Fixture::new();let root=fixture.0.join("not-created");
    assert_eq!(Store::record_count(&root).unwrap(),0);assert!(!root.exists());
    fs::create_dir(&root).unwrap();assert_eq!(Store::record_count(&root).unwrap(),0);
    // Arbitrary invalid ciphertext still counts as a retained manifest. No key
    // or decryption is needed to prevent a reset vault from treating it as empty.
    let id=uuid::Uuid::new_v4();let path=root.join(format!("{id}.upload"));fs::write(&path,b"not decrypted").unwrap();
    fs::write(root.join(".uncommitted.tmp"),b"not a task").unwrap();fs::write(root.join("note.txt"),b"ignored").unwrap();
    assert_eq!(Store::record_count(&root).unwrap(),1);assert_eq!(fs::read(path).unwrap(),b"not decrypted");
}

#[test]
fn keyless_record_count_refuses_invalid_paths_entries_and_excess_records(){
    let fixture=Fixture::new();let root=fixture.0.join("records");fs::create_dir(&root).unwrap();
    assert!(Store::record_count(Path::new("relative-records")).is_err());
    fs::write(root.join("not-a-uuid.upload"),b"broken").unwrap();assert!(Store::record_count(&root).is_err());fs::remove_file(root.join("not-a-uuid.upload")).unwrap();
    let directory=root.join(format!("{}.upload",uuid::Uuid::new_v4()));fs::create_dir(&directory).unwrap();assert!(Store::record_count(&root).is_err());fs::remove_dir(directory).unwrap();
    for _ in 0..=MAX_RECORDS{fs::write(root.join(format!("{}.upload",uuid::Uuid::new_v4())),b"").unwrap();}
    assert!(Store::record_count(&root).is_err());
    let non_directory=fixture.0.join("file");fs::write(&non_directory,b"untouched").unwrap();assert!(Store::record_count(&non_directory).is_err());
}

#[cfg(unix)]
#[test]
fn symbolic_links_are_not_followed_for_root_or_record(){
    use std::os::unix::fs::symlink;
    let fixture=Fixture::new();let real=fixture.0.join("real");fs::create_dir(&real).unwrap();let link=fixture.0.join("link");symlink(&real,&link).unwrap();assert!(Store::new(&link,&[7;32]).is_err());assert!(Store::record_count(&link).is_err());
    let store=fixture.store();let record=fixture.record();let target=fixture.0.join("other");fs::write(&target,b"untouched").unwrap();symlink(&target,store.root.join(format!("{}.upload",record.job_id))).unwrap();
    assert!(store.save(&record).is_err());assert!(store.load(&record.job_id).is_err());assert!(store.remove(&record.job_id).is_err());assert!(Store::record_count(&store.root).is_err());assert_eq!(fs::read(target).unwrap(),b"untouched");
}
