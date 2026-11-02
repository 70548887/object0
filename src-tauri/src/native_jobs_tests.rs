//! Production native-upload runner plus encrypted-store integration. Every
//! endpoint is a fresh loopback server and every path is a disposable fixture.
//! No AppHandle, application config, real vault, or cloud account is used.
use super::*;
use crate::qiniu::multipart::{fingerprint_source,MultipartCheckpoint,MultipartPart,DEFAULT_PART_SIZE};
use serde_json::{json,Value};
use std::{collections::VecDeque,io::{Read,Write},net::TcpListener,thread,time::{Duration,Instant}};

const FIXTURE_KEY:[u8;32]=[0x37;32];
const OBJECT_KEY:&str="integration/中文+%?#.bin";
struct Reply{status:u16,value:Value}
fn ok(value:Value)->Reply{Reply{status:200,value}}
#[derive(Clone)]
struct Request{line:String,body:Vec<u8>,headers:String}
struct Server{origin:String,requests:Arc<Mutex<Vec<Request>>>,alive:Arc<AtomicBool>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server{fn drop(&mut self){self.alive.store(false,Ordering::SeqCst);if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn server(replies:Vec<Reply>)->Server{
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
    let origin=format!("http://{}",listener.local_addr().unwrap());
    let requests=Arc::new(Mutex::new(Vec::new()));let captured=requests.clone();
    let alive=Arc::new(AtomicBool::new(true));let running=alive.clone();
    let worker=thread::spawn(move||{
        let mut replies=VecDeque::from(replies);
        while running.load(Ordering::SeqCst){
            let mut socket=match listener.accept(){Ok((socket,_))=>socket,Err(error)if error.kind()==std::io::ErrorKind::WouldBlock=>{thread::sleep(Duration::from_millis(2));continue;},Err(_)=>return};
            socket.set_nonblocking(false).unwrap();socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let deadline=Instant::now()+Duration::from_secs(3);let mut bytes=Vec::new();let mut buffer=[0u8;16*1024];let mut split=None;
            loop{
                let count=match socket.read(&mut buffer){Ok(count)if count>0=>count,_=>break};bytes.extend_from_slice(&buffer[..count]);
                assert!(bytes.len()<70*1024*1024,"fixture received an oversized request");
                if let Some(index)=bytes.windows(4).position(|part|part==b"\r\n\r\n"){
                    let headers=String::from_utf8_lossy(&bytes[..index]);
                    let length=headers.lines().find_map(|line|{let(name,value)=line.split_once(':')?;if name.eq_ignore_ascii_case("content-length"){value.trim().parse::<usize>().ok()}else{None}}).unwrap_or(0);
                    if bytes.len()>=index+4+length{split=Some(index);break;}
                }
                if Instant::now()>deadline{break;}
            }
            // A speculative connection abandoned before any request does not
            // consume a fixture. Extra real requests remain captured and get
            // an explicit 500, so "no later write" assertions are meaningful.
            if bytes.is_empty(){continue;}
            let Some(split)=split else{continue};
            let headers=String::from_utf8_lossy(&bytes[..split]).into_owned();
            let line=headers.lines().next().unwrap().to_string();
            captured.lock().unwrap().push(Request{line,body:bytes[split+4..].to_vec(),headers});
            let reply=replies.pop_front().unwrap_or_else(||Reply{status:500,value:json!({"error":"unexpected fixture request"})});
            let body=serde_json::to_vec(&reply.value).unwrap();
            let mut response=format!("HTTP/1.0 {} Fixture\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",reply.status,body.len()).into_bytes();response.extend_from_slice(&body);
            let _=socket.write_all(&response);let _=socket.shutdown(std::net::Shutdown::Write);
        }
    });
    Server{origin,requests,alive,worker:Some(worker)}
}
fn runtime()->&'static tokio::runtime::Runtime{
    static RUNTIME:std::sync::OnceLock<tokio::runtime::Runtime>=std::sync::OnceLock::new();
    RUNTIME.get_or_init(||tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap())
}
struct Fixture{root:PathBuf,canonical_root:PathBuf,path:PathBuf,store_root:PathBuf}
impl Fixture{
    fn new(bytes:&[u8])->Self{
        let root=std::env::temp_dir().join(format!("yuncang-native-job-integration-{}",Uuid::new_v4()));
        fs::create_dir(&root).unwrap();let canonical_root=fs::canonicalize(&root).unwrap();
        let path=root.join("source.bin");fs::write(&path,bytes).unwrap();let store_root=root.join("encrypted-jobs");
        Self{root,canonical_root,path,store_root}
    }
    fn store(&self)->Store{Store::new(&self.store_root,&FIXTURE_KEY).unwrap()}
}
impl Drop for Fixture{fn drop(&mut self){
    // Only remove the same UUID directory allocated above, never a changed
    // path, parent, application config, runtime junction or external source.
    if self.root.is_absolute()&&fs::canonicalize(&self.root).ok().as_ref()==Some(&self.canonical_root){let _=fs::remove_dir_all(&self.root);}
}}
fn profile(server:&Server)->Profile{
    Profile{id:Uuid::new_v4().to_string(),name:"Synthetic native upload".into(),provider:S3Provider::Qiniu,
        access_key_id:"job-fixture-ak".into(),secret_access_key:"job-fixture-secret".into(),session_token:None,
        endpoint:None,region:None,default_bucket:Some("native-fixture".into()),r2_analytics_token:None,
        qiniu:Some(qiniu::QiniuConfig{mode:qiniu::QiniuMode::Private,uc_url:Some(server.origin.clone()),..Default::default()}),
        created_at:now_iso(),updated_at:"fixture-revision-1".into()}
}
fn client(profile:&Profile)->qiniu::QiniuClient{let _enter=runtime().enter();storage_backend::qiniu_client(profile).unwrap()}
fn context(server:&Server)->qiniu::ResolvedBucketContext{
    let host=server.origin.trim_start_matches("http://");
    let region=qiniu::QiniuRegion::from_response(&json!({"region":"z0","ttl":60,"up":{"domains":[host]},"rs":{"domains":[host]},"s3":{"region_alias":"cn-east-1","domains":[host]}}),"http",Utc::now().timestamp()).unwrap();
    qiniu::ResolvedBucketContext{bucket:qiniu::QiniuBucket{name:"native-fixture".into(),s3_name:Some("s3-fixture".into()),kodo_region_id:Some("z0".into()),created_at:None,permission:None,remark:None},region,s3_bucket_name:Some("s3-fixture".into()),backend_mode:"kodo".into()}
}
fn record(fixture:&Fixture,profile:&Profile,options:MultipartOptions)->UploadRecord{
    let source=runtime().block_on(fingerprint_source(&fixture.path,&MultipartControl::default())).unwrap();let timestamp=now_iso();
    UploadRecord{format_version:RECORD_VERSION,job_id:Uuid::new_v4().to_string(),profile_id:profile.id.clone(),profile_revision:profile.updated_at.clone(),bucket:"native-fixture".into(),key:OBJECT_KEY.into(),location:None,local_path:source.canonical_path.clone(),source,options,checkpoint:None,state:UploadState::Running,attempt:1,cancel_requested:false,created_at:timestamp.clone(),updated_at:timestamp,error:None}
}

#[test]fn visible_upload_location_uses_saved_label_and_legacy_records_show_only_known_identity(){
    let server=server(vec![]);let mut profile=profile(&server);let fixture=Fixture::new(b"location fixture");
    let mut record=record(&fixture,&profile,MultipartOptions::default());
    let legacy=info(&record).destination.unwrap();
    assert_eq!(legacy.profile_id,profile.id);assert_eq!(legacy.bucket,record.bucket);assert_eq!(legacy.key.as_deref(),Some(record.key.as_str()));
    assert!(legacy.profile_name.is_none()&&legacy.provider.is_none());
    record.location=Some(job_location::from_profile(&profile,&record.bucket,Some(&record.key),None));
    let original=profile.name.clone();profile.name="Changed current account".into();profile.updated_at="different revision".into();
    let visible=info(&record);assert!(visible.source.is_none());assert_eq!(visible.destination.as_ref().unwrap().profile_name.as_deref(),Some(original.as_str()));
    assert_eq!(visible.destination.as_ref().unwrap().provider,Some(S3Provider::Qiniu));
    let event=serde_json::to_value(job_to_progress_event(&visible)).unwrap();
    assert_eq!(event["destination"]["profileName"],original);
    let store=fixture.store();record.state=UploadState::Queued;store.save(&record).unwrap();
    let restored=store.load(&record.job_id).unwrap().unwrap();
    assert_eq!(info(&restored).destination,visible.destination);
    let state=AppState::default();let mut runtime=NativeRuntime::default();
    let vault=VaultRuntime{unlocked:true,data:Some(VaultData{profiles:vec![profile],..Default::default()}),..Default::default()};
    install_restored_records(&state,&mut runtime,&vault,&store,store.load_all().unwrap()).unwrap();
    assert_eq!(state.jobs.lock().unwrap().jobs[&record.job_id].destination,visible.destination);
    assert!(server.requests.lock().unwrap().is_empty());
}
fn checkpoint(record:&UploadRecord,server:&Server,phase:MultipartPhase)->MultipartCheckpoint{
    MultipartCheckpoint{format_version:1,profile_id:record.profile_id.clone(),profile_revision:record.profile_revision.clone(),bucket:record.bucket.clone(),key:record.key.clone(),endpoint:server.origin.clone(),region:"cn-east-1".into(),source:record.source.clone(),options:record.options.clone(),upload_id:"fixture-upload".into(),expire_at:Utc::now().timestamp()+3600,part_size:record.options.part_size.unwrap_or(DEFAULT_PART_SIZE),parts:vec![],phase}
}
fn list(expiry:i64,parts:Value)->Reply{ok(json!({"uploadId":"fixture-upload","expireAt":expiry,"parts":parts,"partNumberMarker":0}))}
fn assert_upload_session_only(request:&Request,verb:&str){
    assert!(request.line.starts_with(&format!("{verb} /buckets/native-fixture/objects/")));assert!(request.line.contains("/uploads/fixture-upload "));
}

#[test]fn cancellation_survives_lock_and_cannot_be_overwritten_by_an_old_runner(){
    let server=server(vec![]);let fixture=Fixture::new(b"fixture");let profile=profile(&server);
    let mut row=record(&fixture,&profile,MultipartOptions::default());row.checkpoint=Some(checkpoint(&row,&server,MultipartPhase::Uploading));let stale=row.clone();row.cancel_requested=true;
    let store=fixture.store();store.save(&row).unwrap();let state=AppState::default();let mut runtime=NativeRuntime::default();runtime.records.insert(row.job_id.clone(),row.clone());
    suspend_runtime(&state,&mut runtime,Some(&store));let restored=store.load(&row.job_id).unwrap().unwrap();assert!(restored.cancel_requested);assert_eq!(restored.state,UploadState::Interrupted);
    assert!(merge_durable_intent(&restored,&stale).unwrap().cancel_requested);
    let mut would_complete=stale.clone();would_complete.checkpoint.as_mut().unwrap().phase=MultipartPhase::Completing;
    assert!(merge_durable_intent(&restored,&would_complete).is_err());
    let mut already_committing=restored;already_committing.checkpoint.as_mut().unwrap().phase=MultipartPhase::Completing;
    would_complete.checkpoint.as_mut().unwrap().phase=MultipartPhase::Completed;would_complete.state=UploadState::Completed;
    assert!(merge_durable_intent(&already_committing,&would_complete).unwrap().cancel_requested);
}

#[test]fn reopened_cancellation_manifest_can_only_continue_abort_not_upload(){
    let server=server(vec![ok(Value::Null)]);let fixture=Fixture::new(b"fixture");let profile=profile(&server);let client=client(&profile);let context=context(&server);
    let mut row=record(&fixture,&profile,MultipartOptions::default());row.checkpoint=Some(checkpoint(&row,&server,MultipartPhase::Uploading));row.state=UploadState::Interrupted;row.cancel_requested=true;
    let store=fixture.store();store.save(&row).unwrap();let mut restored=store.load(&row.job_id).unwrap().unwrap();restored.state=UploadState::Running;restored.attempt+=1;store.save(&restored).unwrap();fs::remove_file(&fixture.path).unwrap();
    runtime().block_on(execute_record(&mut restored,&client,&context,&MultipartControl::default(),false,|candidate|store.save(candidate),|_,_|panic!("cancel cleanup must not upload"))).unwrap();
    assert_eq!(restored.state,UploadState::Cancelled);assert!(restored.cancel_requested);let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),1);assert_upload_session_only(&requests[0],"DELETE");
}

#[test]fn clearing_cannot_remove_a_terminal_record_before_its_runner_releases_the_slot(){
    let server=server(vec![]);let fixture=Fixture::new(b"fixture");let profile=profile(&server);let mut row=record(&fixture,&profile,MultipartOptions::default());row.state=UploadState::Completed;
    let id=row.job_id.clone();let mut runtime=NativeRuntime::default();runtime.records.insert(id.clone(),row);runtime.controls.insert(id.clone(),Arc::new(MultipartControl::default()));
    assert!(clearable_ids(&runtime).is_empty());runtime.controls.remove(&id);assert_eq!(clearable_ids(&runtime),vec![id]);
}

#[test]fn restore_does_not_rewrite_the_observed_completion_time(){
    let server=server(vec![]);let fixture=Fixture::new(b"fixture");let mut profile=profile(&server);profile.qiniu=Some(qiniu::QiniuConfig::default());
    let mut row=record(&fixture,&profile,MultipartOptions::default());row.state=UploadState::Completed;row.checkpoint=Some(checkpoint(&row,&server,MultipartPhase::Completed));row.updated_at="2026-10-01T12:00:00Z".into();
    let store=fixture.store();store.save(&row).unwrap();let state=AppState::default();let vault=VaultRuntime{unlocked:true,data:Some(VaultData{profiles:vec![profile],..Default::default()}),..Default::default()};let mut runtime=NativeRuntime::default();
    install_restored_records(&state,&mut runtime,&vault,&store,store.load_all().unwrap()).unwrap();assert_eq!(runtime.records[&row.job_id].updated_at,row.updated_at);assert_eq!(state.jobs.lock().unwrap().jobs[&row.job_id].completed_at.as_deref(),Some("2026-10-01T12:00:00Z"));
}

#[test]fn stale_queue_entries_cannot_revive_paused_cancelled_or_newer_attempts(){
    let server=server(vec![]);let fixture=Fixture::new(b"fixture");let profile=profile(&server);
    let mut row=record(&fixture,&profile,MultipartOptions::default());row.state=UploadState::Queued;
    assert!(can_start(&row,1,false));assert!(!can_start(&row,1,true));
    row.attempt=2;assert!(!can_start(&row,1,false));assert!(can_start(&row,2,false));
    for state in [UploadState::Paused,UploadState::Interrupted,UploadState::Cancelled,UploadState::Completed]{row.state=state;assert!(!can_start(&row,2,false));}
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]fn replacing_a_popped_upload_attempt_releases_its_obsolete_running_slot(){
    let server=server(vec![]);let fixture=Fixture::new(b"fixture");let profile=profile(&server);let mut row=record(&fixture,&profile,MultipartOptions::default());row.state=UploadState::Queued;
    let state=AppState::default();update_visible(&state,&row,true).unwrap();
    {let mut jobs=state.jobs.lock().unwrap();jobs.queue.clear();jobs.running.insert(row.job_id.clone());jobs.concurrency=1;}
    row.attempt+=1;row.cancel_requested=true;update_visible(&state,&row,true).unwrap();let jobs=state.jobs.lock().unwrap();
    assert!(!jobs.running.contains(&row.job_id));assert_eq!(jobs.queue.len(),1);assert!(matches!(jobs.queue[0].kind,JobTaskKind::NativeUpload{attempt:2}));assert!(!can_start(&row,1,false));
}

#[test]fn restart_installs_rows_as_interrupted_without_enqueuing_or_cloud_requests(){
    let server=server(vec![]);let fixture=Fixture::new(b"fixture");let mut profile=profile(&server);
    profile.qiniu=Some(qiniu::QiniuConfig::default());
    let row=record(&fixture,&profile,MultipartOptions::default());let store=fixture.store();store.save(&row).unwrap();
    let state=AppState::default();let vault=VaultRuntime{unlocked:true,data:Some(VaultData{profiles:vec![profile],..Default::default()}),..Default::default()};let mut runtime=NativeRuntime::default();
    let result=install_restored_records(&state,&mut runtime,&vault,&store,store.load_all().unwrap()).unwrap();
    assert_eq!(result.restored,1);assert_eq!(result.unreadable,0);assert!(state.jobs.lock().unwrap().queue.is_empty());
    assert_eq!(runtime.records[&row.job_id].state,UploadState::Interrupted);assert_eq!(store.load(&row.job_id).unwrap().unwrap().state,UploadState::Interrupted);
    assert!(runtime.controls.is_empty());assert!(server.requests.lock().unwrap().is_empty());
}

#[test]fn locking_preserves_encrypted_checkpoint_clears_runtime_and_never_aborts(){
    let server=server(vec![]);let fixture=Fixture::new(b"fixture");let profile=profile(&server);
    let mut row=record(&fixture,&profile,MultipartOptions::default());row.checkpoint=Some(checkpoint(&row,&server,MultipartPhase::Uploading));
    let store=fixture.store();store.save(&row).unwrap();let state=AppState::default();let mut runtime=NativeRuntime::default();let control=Arc::new(MultipartControl::default());
    runtime.controls.insert(row.job_id.clone(),control.clone());runtime.records.insert(row.job_id.clone(),row.clone());runtime.loaded=true;
    update_visible(&state,&row,true).unwrap();suspend_runtime(&state,&mut runtime,Some(&store));
    assert!(control.is_paused());assert!(runtime.records.is_empty());assert!(runtime.controls.is_empty());assert!(!runtime.loaded);assert_eq!(runtime.epoch,1);
    assert!(state.jobs.lock().unwrap().queue.is_empty());assert!(state.jobs.lock().unwrap().jobs.is_empty());
    let restored=store.load(&row.job_id).unwrap().unwrap();assert_eq!(restored.state,UploadState::Interrupted);assert_eq!(restored.checkpoint.unwrap().phase,MultipartPhase::Uploading);
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]fn changed_profile_restores_only_a_blocked_row_not_a_write(){
    let server=server(vec![]);let fixture=Fixture::new(b"fixture");let mut profile=profile(&server);profile.qiniu=Some(qiniu::QiniuConfig::default());
    let row=record(&fixture,&profile,MultipartOptions::default());let store=fixture.store();store.save(&row).unwrap();profile.updated_at="changed".into();
    let state=AppState::default();let vault=VaultRuntime{unlocked:true,data:Some(VaultData{profiles:vec![profile],..Default::default()}),..Default::default()};let mut runtime=NativeRuntime::default();
    install_restored_records(&state,&mut runtime,&vault,&store,store.load_all().unwrap()).unwrap();
    assert!(runtime.records[&row.job_id].error.as_deref().unwrap().contains("Account missing or changed"));
    assert!(confirm_profile(&vault,&runtime.records[&row.job_id]).is_err());assert!(state.jobs.lock().unwrap().queue.is_empty());
    let visible=serde_json::to_string(&info(&row)).unwrap();assert!(!visible.contains(&row.local_path));
}

#[test]
fn production_runner_pauses_persists_reopens_and_resumes_a_large_native_upload(){
    let bytes=vec![0x5au8;6*1024*1024+17];let expiry=Utc::now().timestamp()+3600;
    let fixture=Fixture::new(&bytes);let part_size=2*1024*1024u64;
    let mut expected=qiniu::transfer::QiniuEtag::default();expected.update(&bytes);let expected_hash=expected.finish();
    let server=server(vec![ok(json!({"uploadId":"fixture-upload","expireAt":expiry})),list(expiry,json!([])),ok(json!({"etag":"server-part-1"})),list(expiry,json!([{"partNumber":1,"size":part_size,"etag":"server-part-1"}])),ok(json!({"etag":"server-part-2"})),ok(json!({"etag":"server-part-3"})),ok(json!({"etag":"server-part-4"})),ok(json!({"key":OBJECT_KEY,"hash":expected_hash}))]);
    let profile=profile(&server);let client=client(&profile);let context=context(&server);
    let options=MultipartOptions{part_size:Some(part_size),mime_type:Some("application/octet-stream".into()),..Default::default()};
    let mut record=record(&fixture,&profile,options);let store=fixture.store();store.save(&record).unwrap();let control=MultipartControl::default();
    runtime().block_on(execute_record(&mut record,&client,&context,&control,false,|candidate|store.save(candidate),|done,_|{if done>=part_size{control.pause();}})).unwrap();
    assert_eq!(record.state,UploadState::Paused);assert_eq!(record.checkpoint.as_ref().unwrap().parts.len(),1);assert_eq!(record.checkpoint.as_ref().unwrap().phase,MultipartPhase::Uploading);
    let path=fixture.store_root.join(format!("{}.upload",record.job_id));let encrypted=fs::read(&path).unwrap();let text=String::from_utf8_lossy(&encrypted);
    for sensitive in [record.local_path.as_str(),OBJECT_KEY,"job-fixture-ak","job-fixture-secret","fixture-upload"]{assert!(!text.contains(sensitive));}
    drop(store);let reopened=fixture.store();let mut restored=reopened.load(&record.job_id).unwrap().unwrap();assert_eq!(restored.state,UploadState::Paused);
    restored.attempt+=1;restored.state=UploadState::Running;restored.updated_at=now_iso();reopened.save(&restored).unwrap();let resumed=MultipartControl::default();let mut progress=Vec::new();
    runtime().block_on(execute_record(&mut restored,&client,&context,&resumed,false,|candidate|reopened.save(candidate),|done,total|progress.push((done,total)))).unwrap();
    assert_eq!(restored.state,UploadState::Completed);assert_eq!(restored.attempt,2);assert_eq!(restored.checkpoint.as_ref().unwrap().phase,MultipartPhase::Completed);assert_eq!(restored.checkpoint.as_ref().unwrap().source.qiniu_etag,expected_hash);
    assert_eq!(progress.last(),Some(&(bytes.len() as u64,bytes.len() as u64)));assert_eq!(info(&restored).status,JobStatus::Completed);assert_eq!(info(&restored).bytes_transferred,bytes.len() as i64);
    let persisted=reopened.load(&record.job_id).unwrap().unwrap();assert_eq!(persisted.state,UploadState::Completed);
    let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),8);assert_eq!(requests.iter().filter(|request|request.line.starts_with("PUT ")&&request.line.contains("/fixture-upload/1 ")).count(),1);assert!(!requests.iter().any(|request|request.line.starts_with("DELETE ")));
    let complete:Value=serde_json::from_slice(&requests.last().unwrap().body).unwrap();assert_eq!(complete["parts"].as_array().unwrap().len(),4);assert_eq!(complete["parts"][0]["etag"],"server-part-1");assert!(requests.iter().all(|request|!request.headers.contains("job-fixture-secret")));
}

#[test]
fn production_runner_persists_transport_failure_as_interrupted_not_completed(){
    let expiry=Utc::now().timestamp()+3600;let server=server(vec![ok(json!({"uploadId":"fixture-upload","expireAt":expiry})),list(expiry,json!([])),Reply{status:500,value:json!({"error":"unsafe fixture secret"})}]);
    let fixture=Fixture::new(b"payload");let profile=profile(&server);let mut record=record(&fixture,&profile,MultipartOptions::default());let store=fixture.store();store.save(&record).unwrap();
    runtime().block_on(execute_record(&mut record,&client(&profile),&context(&server),&MultipartControl::default(),false,|candidate|store.save(candidate),|_,_|{})).unwrap();
    assert_eq!(record.state,UploadState::Interrupted);assert_eq!(info(&record).status,JobStatus::Interrupted);assert!(record.error.as_deref().is_some_and(|error|!error.contains("unsafe fixture secret")));assert_eq!(store.load(&record.job_id).unwrap().unwrap().state,UploadState::Interrupted);
    let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),3);assert_eq!(requests.iter().filter(|request|request.line.starts_with("POST ")).count(),1);assert!(!requests.iter().any(|request|request.line.starts_with("DELETE ")));
}

#[test]
fn production_cancel_reopens_paused_record_without_source_and_only_aborts_session(){
    let server=server(vec![ok(Value::Null)]);let fixture=Fixture::new(b"payload");let profile=profile(&server);let mut record=record(&fixture,&profile,MultipartOptions::default());record.checkpoint=Some(checkpoint(&record,&server,MultipartPhase::Uploading));record.state=UploadState::Paused;
    let store=fixture.store();store.save(&record).unwrap();drop(store);fs::remove_file(&fixture.path).unwrap();let reopened=fixture.store();let mut restored=reopened.load(&record.job_id).unwrap().unwrap();
    restored.attempt+=1;restored.state=UploadState::Running;reopened.save(&restored).unwrap();
    runtime().block_on(execute_record(&mut restored,&client(&profile),&context(&server),&MultipartControl::default(),true,|candidate|reopened.save(candidate),|_,_|panic!("cancel cannot upload bytes"))).unwrap();
    assert_eq!(restored.state,UploadState::Cancelled);assert_eq!(reopened.load(&restored.job_id).unwrap().unwrap().state,UploadState::Cancelled);let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),1);assert_upload_session_only(&requests[0],"DELETE");assert!(!requests[0].line.contains("/delete/"));
}

#[test]
fn production_restart_of_uncertain_complete_uses_only_stat_after_source_removal(){
    let bytes=b"payload";let mut hash=qiniu::transfer::QiniuEtag::default();hash.update(bytes);let expected=hash.finish();let server=server(vec![ok(json!({"fsize":bytes.len(),"hash":expected}))]);
    let fixture=Fixture::new(bytes);let profile=profile(&server);let mut record=record(&fixture,&profile,MultipartOptions::default());let mut cp=checkpoint(&record,&server,MultipartPhase::Completing);cp.parts.push(MultipartPart{part_number:1,etag:"server-part-1".into(),size:bytes.len() as u64,sha256:record.source.sha256.clone()});record.checkpoint=Some(cp);record.state=UploadState::Interrupted;
    let store=fixture.store();store.save(&record).unwrap();drop(store);fs::remove_file(&fixture.path).unwrap();let reopened=fixture.store();let mut restored=reopened.load(&record.job_id).unwrap().unwrap();
    restored.attempt+=1;restored.state=UploadState::Running;reopened.save(&restored).unwrap();
    runtime().block_on(execute_record(&mut restored,&client(&profile),&context(&server),&MultipartControl::default(),false,|candidate|reopened.save(candidate),|_,_|panic!("reconciliation cannot upload bytes"))).unwrap();
    assert_eq!(restored.state,UploadState::Completed);assert_eq!(reopened.load(&record.job_id).unwrap().unwrap().state,UploadState::Completed);let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),1);assert!(requests[0].line.starts_with("GET /stat/"));
}

#[test]
fn production_checkpoint_failure_stops_followup_remote_writes(){
    let expiry=Utc::now().timestamp()+3600;let server=server(vec![ok(json!({"uploadId":"fixture-upload","expireAt":expiry})),list(expiry,json!([])),ok(json!({"etag":"server-part-1"}))]);let fixture=Fixture::new(&vec![0x5au8;2*1024*1024+1]);let profile=profile(&server);let mut record=record(&fixture,&profile,MultipartOptions{part_size:Some(1024*1024),..Default::default()});let store=fixture.store();store.save(&record).unwrap();let control=MultipartControl::default();
    let result=runtime().block_on(execute_record(&mut record,&client(&profile),&context(&server),&control,false,|candidate|{
        if candidate.checkpoint.as_ref().is_some_and(|cp|!cp.parts.is_empty()){control.cancel();return Err("synthetic disk failure".into());}store.save(candidate)
    },|_,_|{}));
    assert!(result.is_err());assert_ne!(record.state,UploadState::Completed);let durable=store.load(&record.job_id).unwrap().unwrap();assert_eq!(durable.checkpoint.as_ref().unwrap().phase,MultipartPhase::Uploading);assert!(durable.checkpoint.as_ref().unwrap().parts.is_empty());
    let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),3);assert_eq!(requests.iter().filter(|request|request.line.starts_with("POST ")).count(),1);assert!(!requests.iter().any(|request|request.line.starts_with("DELETE ")));
}

#[test]
fn audit_upload_clear_partial_failure_is_retryable_without_orphan_rows(){
    let fixture=Fixture::new(b"clear fixture");let endpoint=server(vec![]);let p=profile(&endpoint);let store=fixture.store();let state=AppState::default();let mut runtime=NativeRuntime::default();let mut ids=vec![];
    for _ in 0..3 {let mut row=record(&fixture,&p,MultipartOptions::default());row.state=UploadState::Cancelled;store.save(&row).unwrap();update_visible(&state,&row,false).unwrap();ids.push(row.job_id.clone());runtime.records.insert(row.job_id.clone(),row);}
    let failed=runtime.records[&ids[1]].clone();let bad=fixture.store_root.join(format!("{}.upload",failed.job_id));fs::remove_file(&bad).unwrap();fs::create_dir(&bad).unwrap();
    let report=clear_terminal_records(&mut runtime,&store,ids.clone());assert_eq!(report.removed.len(),2);assert_eq!(report.errors.len(),1);assert_eq!(report.errors[0].job_id.as_deref(),Some(ids[1].as_str()));assert_eq!(runtime.records.len(),1);
    {let mut jobs=state.jobs.lock().unwrap();let removed=clear_finished_rows(&mut jobs,&report.removed);assert_eq!(removed.len(),2);assert_eq!(jobs.jobs.len(),1);assert!(jobs.jobs.contains_key(&ids[1]));}
    fs::remove_dir(&bad).unwrap();store.save(&failed).unwrap();let retry_ids=clearable_ids(&runtime);let retry=clear_terminal_records(&mut runtime,&store,retry_ids);assert!(retry.errors.is_empty());assert!(runtime.records.is_empty());
    let mut jobs=state.jobs.lock().unwrap();assert_eq!(clear_finished_rows(&mut jobs,&retry.removed).len(),1);assert!(jobs.jobs.is_empty());
}
