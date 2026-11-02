//! Production coordinator + AES store + native Range integration. Every
//! account is synthetic, every endpoint loopback, every path a UUID fixture.
use super::*;
use crate::qiniu::{QiniuBucket,QiniuConfig,QiniuCredentials,QiniuMode,QiniuRegion};
use crate::qiniu::range_download::RemoteIdentity;
use sha2::{Digest,Sha256};
use std::{collections::HashMap,io::{Read,Write},net::TcpListener,thread,time::{Duration,Instant,UNIX_EPOCH}};

const KEY:[u8;32]=[0x6b;32];
const OBJECT:&str="downloads/中文+%?#.bin";
const MODIFIED:&str="2023-11-14T22:13:20+00:00";
#[derive(Clone)]struct Request{line:String,headers:HashMap<String,String>}
struct Server{origin:String,requests:Arc<Mutex<Vec<Request>>>,alive:Arc<AtomicBool>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server{fn drop(&mut self){self.alive.store(false,Ordering::SeqCst);if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn content_hash(bytes:&[u8])->String{let mut hash=qiniu::transfer::QiniuEtag::default();hash.update(bytes);hash.finish()}
fn server(bytes:Vec<u8>)->Server{
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();let origin=format!("http://{}",listener.local_addr().unwrap());
    let requests=Arc::new(Mutex::new(Vec::new()));let captures=requests.clone();let alive=Arc::new(AtomicBool::new(true));let running=alive.clone();
    let worker=thread::spawn(move||while running.load(Ordering::SeqCst){
        let mut socket=match listener.accept(){Ok((socket,_))=>socket,Err(e)if e.kind()==io::ErrorKind::WouldBlock=>{thread::sleep(Duration::from_millis(2));continue},Err(_)=>return};
        socket.set_nonblocking(false).unwrap();socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();socket.set_write_timeout(Some(Duration::from_secs(2))).unwrap();let deadline=Instant::now()+Duration::from_secs(3);
        let mut raw=Vec::new();let mut buffer=[0u8;4096];
        while !raw.windows(4).any(|part|part==b"\r\n\r\n"){
            match socket.read(&mut buffer){Ok(n)if n>0=>raw.extend_from_slice(&buffer[..n]),_=>break};assert!(raw.len()<64*1024);if Instant::now()>deadline{break}
        }
        if raw.is_empty(){continue}
        let text=String::from_utf8_lossy(&raw);let request=Request{line:text.lines().next().unwrap().into(),headers:text.lines().skip(1).filter_map(|line|line.split_once(':').map(|(name,value)|(name.to_ascii_lowercase(),value.trim().into()))).collect()};captures.lock().unwrap().push(request.clone());
        let (status,mut headers,body)=if request.line.starts_with("GET /stat/"){
            (200,vec![("Content-Type".to_string(),"application/json".to_string())],serde_json::to_vec(&json!({"fsize":bytes.len(),"hash":content_hash(&bytes),"putTime":17000000000000000_i64,"type":0})).unwrap())
        }else if request.line.starts_with("GET /downloads/"){
            let offset=request.headers.get("range").map(|value|value.strip_prefix("bytes=").unwrap().strip_suffix('-').unwrap().parse::<usize>().unwrap()).unwrap_or(0);
            let mut headers=vec![("ETag".into(),format!("\"{}\"",content_hash(&bytes)))];
            if offset>0{headers.push(("Content-Range".into(),format!("bytes {}-{}/{}",offset,bytes.len()-1,bytes.len())))}
            (if offset>0{206}else{200},headers,bytes[offset..].to_vec())
        }else{(500,Vec::new(),b"unexpected synthetic request".to_vec())};
        headers.push(("Content-Length".into(),body.len().to_string()));let mut reply=format!("HTTP/1.0 {status} Fixture\r\nConnection: close\r\n").into_bytes();for(name,value)in headers{reply.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());}reply.extend_from_slice(b"\r\n");reply.extend_from_slice(&body);let _=socket.write_all(&reply);let _=socket.shutdown(std::net::Shutdown::Write);
    });Server{origin,requests,alive,worker:Some(worker)}
}
fn runtime()->&'static tokio::runtime::Runtime{static RUNTIME:std::sync::OnceLock<tokio::runtime::Runtime>=std::sync::OnceLock::new();RUNTIME.get_or_init(||tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap())}
struct Fixture{root:PathBuf,target:PathBuf,store_root:PathBuf}
impl Fixture{
    fn new()->Self{let root=std::env::temp_dir().join(format!("native-download-runner-{}",Uuid::new_v4()));fs::create_dir(&root).unwrap();let root=fs::canonicalize(root).unwrap();Self{target:root.join("download.bin"),store_root:root.join("encrypted-records"),root}}
    fn store(&self)->Store{Store::new(&self.store_root,&KEY).unwrap()}
}
impl Drop for Fixture{fn drop(&mut self){if self.root.is_absolute()&&self.root.file_name().is_some_and(|name|name.to_string_lossy().starts_with("native-download-runner-"))&&fs::canonicalize(&self.root).ok().as_ref()==Some(&self.root){let _=fs::remove_dir_all(&self.root);}}}
fn profile()->Profile{Profile{id:Uuid::new_v4().to_string(),name:"Synthetic download account".into(),provider:S3Provider::Qiniu,access_key_id:"download-job-fixture-ak".into(),secret_access_key:"download-job-fixture-secret".into(),session_token:None,endpoint:None,region:None,default_bucket:Some("native-bucket".into()),r2_analytics_token:None,qiniu:Some(QiniuConfig::default()),created_at:now_iso(),updated_at:"download-revision-1".into()}}
fn client(server:&Server)->qiniu::QiniuClient{
    let _enter=runtime().enter();qiniu::QiniuClient::new(QiniuConfig{mode:QiniuMode::Private,uc_url:Some(server.origin.clone()),download_domain:Some(server.origin.clone()),..Default::default()},QiniuCredentials::new("download-job-fixture-ak".into(),"download-job-fixture-secret".into(),None).unwrap()).unwrap()
}
fn context(server:&Server)->qiniu::ResolvedBucketContext{let host=server.origin.trim_start_matches("http://");let region=QiniuRegion::from_response(&json!({"region":"z0","ttl":60,"rs":{"domains":[host]},"s3":{"region_alias":"cn-east-1","domains":[host]}}),"http",Utc::now().timestamp()).unwrap();qiniu::ResolvedBucketContext{bucket:QiniuBucket{name:"native-bucket".into(),s3_name:Some("s3-id".into()),kodo_region_id:Some("z0".into()),created_at:None,permission:None,remark:None},region,s3_bucket_name:Some("s3-id".into()),backend_mode:"kodo".into()}}
fn hex(bytes:impl AsRef<[u8]>)->String{bytes.as_ref().iter().map(|byte|format!("{byte:02x}")).collect()}
fn record(fixture:&Fixture,server:&Server,profile:&Profile,bytes:&[u8])->DownloadRecord{
    let id=Uuid::new_v4().to_string();let timestamp=now_iso();let checkpoint=DownloadCheckpoint{format_version:1,job_id:id.clone(),profile_id:profile.id.clone(),profile_revision:profile.updated_at.clone(),bucket:"native-bucket".into(),key:OBJECT.into(),domain:server.origin.clone(),target_path:fixture.target.to_string_lossy().into_owned(),partial_path:fixture.root.join(format!(".yuncang-range-{id}.part")).to_string_lossy().into_owned(),remote:RemoteIdentity{size:bytes.len()as u64,etag:content_hash(bytes),last_modified:MODIFIED.into()},offset:0,prefix_sha256:hex(Sha256::digest([])),partial_created:None,phase:DownloadPhase::Downloading};
    DownloadRecord{format_version:RECORD_VERSION,job_id:id,profile_id:profile.id.clone(),profile_revision:profile.updated_at.clone(),bucket:checkpoint.bucket.clone(),key:checkpoint.key.clone(),location:None,checkpoint,state:DownloadState::Running,attempt:1,cancel_requested:false,created_at:timestamp.clone(),updated_at:timestamp,error:None}
}

#[test]fn visible_download_location_preserves_saved_source_across_current_account_changes(){
    let bytes=b"location fixture";let server=server(bytes.to_vec());let mut profile=profile();let fixture=Fixture::new();let mut record=record(&fixture,&server,&profile,bytes);
    let legacy=info(&record).source.unwrap();assert_eq!(legacy.profile_id,profile.id);assert_eq!(legacy.bucket,record.bucket);
    assert_eq!(legacy.key.as_deref(),Some(record.key.as_str()));assert!(legacy.profile_name.is_none()&&legacy.provider.is_none());
    record.location=Some(job_location::from_profile(&profile,&record.bucket,Some(&record.key),None));
    let original=profile.name.clone();profile.name="Changed current account".into();profile.updated_at="changed".into();
    let visible=info(&record);assert!(visible.destination.is_none());assert_eq!(visible.source.as_ref().unwrap().profile_name.as_deref(),Some(original.as_str()));
    let event=serde_json::to_value(job_to_progress_event(&visible)).unwrap();assert_eq!(event["source"]["profileName"],original);
    let store=fixture.store();record.state=DownloadState::Queued;store.save(&record).unwrap();
    let restored=store.load(&record.job_id).unwrap().unwrap();assert_eq!(info(&restored).source,visible.source);
    let state=AppState::default();let mut runtime=DownloadRuntime::default();
    let vault=VaultRuntime{unlocked:true,data:Some(VaultData{profiles:vec![profile],..Default::default()}),..Default::default()};
    install_restored_records(&state,&mut runtime,&vault,&store,store.load_all().unwrap()).unwrap();
    assert_eq!(state.jobs.lock().unwrap().jobs[&record.job_id].source,visible.source);
    assert!(server.requests.lock().unwrap().is_empty());
}
#[cfg(unix)]fn creation(path:&Path)->String{use std::os::unix::fs::MetadataExt;let meta=fs::metadata(path).unwrap();format!("unix:{}:{}",meta.dev(),meta.ino())}
#[cfg(not(unix))]fn creation(path:&Path)->String{format!("created:{}",fs::metadata(path).unwrap().created().unwrap().duration_since(UNIX_EPOCH).unwrap().as_nanos())}
fn set_partial(record:&mut DownloadRecord,bytes:&[u8],offset:usize,phase:DownloadPhase){let cp=&mut record.checkpoint;fs::write(&cp.partial_path,&bytes[..offset]).unwrap();cp.partial_created=Some(creation(Path::new(&cp.partial_path)));cp.offset=offset as u64;cp.prefix_sha256=hex(Sha256::digest(&bytes[..offset]));cp.phase=phase;}

#[test]fn audit_download_clear_partial_failure_is_retryable_without_orphan_rows(){
    let bytes=b"clear fixture";let endpoint=server(bytes.to_vec());let fixture=Fixture::new();let p=profile();let store=fixture.store();let state=AppState::default();let mut runtime=DownloadRuntime::default();let mut ids=vec![];
    for _ in 0..3 {let mut row=record(&fixture,&endpoint,&p,bytes);row.state=DownloadState::Cancelled;row.checkpoint.phase=DownloadPhase::Cancelled;store.save(&row).unwrap();update_visible(&state,&row,false).unwrap();ids.push(row.job_id.clone());runtime.records.insert(row.job_id.clone(),row);}
    let failed=runtime.records[&ids[1]].clone();let bad=fixture.store_root.join(format!("{}.download",failed.job_id));fs::remove_file(&bad).unwrap();fs::create_dir(&bad).unwrap();
    let report=clear_terminal_records(&mut runtime,&store,ids.clone());assert_eq!(report.removed.len(),2);assert_eq!(report.errors.len(),1);assert_eq!(report.errors[0].job_id.as_deref(),Some(ids[1].as_str()));assert_eq!(runtime.records.len(),1);
    {let mut jobs=state.jobs.lock().unwrap();assert_eq!(clear_finished_rows(&mut jobs,&report.removed).len(),2);assert_eq!(jobs.jobs.len(),1);assert!(jobs.jobs.contains_key(&ids[1]));}
    fs::remove_dir(&bad).unwrap();store.save(&failed).unwrap();let retry_ids=clearable_ids(&runtime);let retry=clear_terminal_records(&mut runtime,&store,retry_ids);assert!(retry.errors.is_empty());assert!(runtime.records.is_empty());
    let mut jobs=state.jobs.lock().unwrap();assert_eq!(clear_finished_rows(&mut jobs,&retry.removed).len(),1);assert!(jobs.jobs.is_empty());
}

#[test]fn production_coordinator_pauses_reopens_encrypted_record_and_resumes_exact_range(){
    let bytes:Vec<u8>=(0..6*1024*1024+37).map(|i|(i%251)as u8).collect();let server=server(bytes.clone());let fixture=Fixture::new();let profile=profile();let client=client(&server);let context=context(&server);let mut row=record(&fixture,&server,&profile,&bytes);let store=fixture.store();store.save(&row).unwrap();let control=DownloadControl::default();
    runtime().block_on(execute_record(&mut row,Some(&client),Some(&context),&control,|candidate|store.save(candidate),|done,_|if done>0{control.pause()})).unwrap();
    assert_eq!(row.state,DownloadState::Paused);assert!(row.checkpoint.offset>0&&row.checkpoint.offset<bytes.len()as u64);let offset=row.checkpoint.offset;assert!(!fixture.target.exists());
    let ciphertext=fs::read(fixture.store_root.join(format!("{}.download",row.job_id))).unwrap();let text=String::from_utf8_lossy(&ciphertext);for sensitive in [row.checkpoint.target_path.as_str(),row.checkpoint.domain.as_str(),OBJECT,"download-job-fixture-ak","download-job-fixture-secret"]{assert!(!text.contains(sensitive));}
    drop(store);let reopened=fixture.store();let mut restored=reopened.load(&row.job_id).unwrap().unwrap();assert_eq!(restored.state,DownloadState::Paused);restored.attempt+=1;restored.state=DownloadState::Running;reopened.save(&restored).unwrap();
    runtime().block_on(execute_record(&mut restored,Some(&client),Some(&context),&DownloadControl::default(),|candidate|reopened.save(candidate),|_,_|{})).unwrap();
    assert_eq!(restored.state,DownloadState::Completed);assert_eq!(restored.attempt,2);assert_eq!(reopened.load(&row.job_id).unwrap().unwrap().state,DownloadState::Completed);assert_eq!(fs::read(&fixture.target).unwrap(),bytes);assert!(!Path::new(&restored.checkpoint.partial_path).exists());assert_eq!(info(&restored).status,JobStatus::Completed);
    let requests=server.requests.lock().unwrap();let resumed=requests.iter().find(|request|request.headers.contains_key("range")).unwrap();assert_eq!(resumed.headers["range"],format!("bytes={offset}-"));assert!(requests.iter().all(|request|request.line.starts_with("GET ")));
}

#[test]fn persisted_cancellation_reopens_and_cleans_only_partial_without_a_cloud_client(){
    let bytes=b"expected payload";let server=server(bytes.to_vec());let fixture=Fixture::new();let profile=profile();let mut row=record(&fixture,&server,&profile,bytes);set_partial(&mut row,bytes,5,DownloadPhase::Downloading);row.state=DownloadState::Interrupted;row.cancel_requested=true;let store=fixture.store();store.save(&row).unwrap();drop(store);
    fs::write(&fixture.target,b"preserved existing user file").unwrap();let reopened=fixture.store();let mut restored=reopened.load(&row.job_id).unwrap().unwrap();restored.attempt+=1;restored.state=DownloadState::Running;reopened.save(&restored).unwrap();
    runtime().block_on(execute_record(&mut restored,None,None,&DownloadControl::default(),|candidate|reopened.save(candidate),|_,_|panic!("cancel cleanup cannot download bytes"))).unwrap();
    assert_eq!(restored.state,DownloadState::Cancelled);assert!(restored.cancel_requested);assert!(!Path::new(&restored.checkpoint.partial_path).exists());assert_eq!(fs::read(&fixture.target).unwrap(),b"preserved existing user file");assert!(server.requests.lock().unwrap().is_empty());
}

#[test]fn committing_record_reopens_and_finishes_locally_without_resolving_cloud_metadata(){
    let bytes=b"fully verified local content";let server=server(bytes.to_vec());let fixture=Fixture::new();let profile=profile();let mut row=record(&fixture,&server,&profile,bytes);set_partial(&mut row,bytes,bytes.len(),DownloadPhase::Committing);row.state=DownloadState::Interrupted;let store=fixture.store();store.save(&row).unwrap();drop(store);let reopened=fixture.store();let mut restored=reopened.load(&row.job_id).unwrap().unwrap();restored.attempt+=1;restored.state=DownloadState::Running;reopened.save(&restored).unwrap();
    runtime().block_on(execute_record(&mut restored,None,None,&DownloadControl::default(),|candidate|reopened.save(candidate),|_,_|panic!("local reconciliation cannot download bytes"))).unwrap();
    assert_eq!(restored.state,DownloadState::Completed);assert_eq!(fs::read(&fixture.target).unwrap(),bytes);assert!(!Path::new(&restored.checkpoint.partial_path).exists());assert!(server.requests.lock().unwrap().is_empty());assert_eq!(reopened.load(&row.job_id).unwrap().unwrap().checkpoint.phase,DownloadPhase::Completed);
}

#[test]fn checkpoint_disk_failure_cannot_be_reported_completed_or_replace_a_later_user_target(){
    let bytes=vec![0x6c;5*1024*1024+31];let server=server(bytes.clone());let fixture=Fixture::new();let profile=profile();let client=client(&server);let context=context(&server);let mut row=record(&fixture,&server,&profile,&bytes);let store=fixture.store();store.save(&row).unwrap();
    runtime().block_on(execute_record(&mut row,Some(&client),Some(&context),&DownloadControl::default(),|candidate|if candidate.checkpoint.offset>0{Err("synthetic checkpoint disk failure".into())}else{store.save(candidate)},|_,_|{})).unwrap();
    assert_eq!(row.state,DownloadState::Interrupted);assert_eq!(row.checkpoint.offset,0);assert!(!fixture.target.exists());assert_eq!(store.load(&row.job_id).unwrap().unwrap().state,DownloadState::Interrupted);
    fs::write(&fixture.target,b"new user-owned target").unwrap();row.state=DownloadState::Running;row.attempt+=1;store.save(&row).unwrap();let before=server.requests.lock().unwrap().len();
    runtime().block_on(execute_record(&mut row,Some(&client),Some(&context),&DownloadControl::default(),|candidate|store.save(candidate),|_,_|{})).unwrap();assert_eq!(row.state,DownloadState::Interrupted);assert_eq!(fs::read(&fixture.target).unwrap(),b"new user-owned target");assert_eq!(server.requests.lock().unwrap().len(),before);
}

#[test]fn restore_only_installs_interrupted_rows_without_automatically_queueing_cloud_reads(){
    let bytes=b"payload";let server=server(bytes.to_vec());let fixture=Fixture::new();let profile=profile();let row=record(&fixture,&server,&profile,bytes);let store=fixture.store();store.save(&row).unwrap();
    let state=AppState::default();let vault=VaultRuntime{unlocked:true,data:Some(VaultData{profiles:vec![profile],..Default::default()}),..Default::default()};let mut runtime=DownloadRuntime::default();let result=install_restored_records(&state,&mut runtime,&vault,&store,store.load_all().unwrap()).unwrap();
    assert_eq!(result.restored,1);assert_eq!(result.unreadable,0);assert_eq!(runtime.records[&row.job_id].state,DownloadState::Interrupted);assert!(state.jobs.lock().unwrap().queue.is_empty());assert!(runtime.controls.is_empty());assert!(server.requests.lock().unwrap().is_empty());
    let projection=serde_json::to_string(&info(&row)).unwrap();assert!(!projection.contains(&row.checkpoint.target_path));assert!(!projection.contains(&row.checkpoint.domain));
}

#[test]fn reopening_an_interrupted_download_preserves_its_specific_diagnostic(){
    let bytes=b"payload";let server=server(bytes.to_vec());let fixture=Fixture::new();let profile=profile();let mut row=record(&fixture,&server,&profile,bytes);row.state=DownloadState::Interrupted;row.error=Some("Remote object changed; select a new task".into());
    let store=fixture.store();store.save(&row).unwrap();let encrypted=fs::read(fixture.store_root.join(format!("{}.download",row.job_id))).unwrap();
    let state=AppState::default();let vault=VaultRuntime{unlocked:true,data:Some(VaultData{profiles:vec![profile],..Default::default()}),..Default::default()};let mut runtime=DownloadRuntime::default();
    install_restored_records(&state,&mut runtime,&vault,&store,store.load_all().unwrap()).unwrap();assert_eq!(runtime.records[&row.job_id].error,row.error);assert_eq!(runtime.records[&row.job_id].updated_at,row.updated_at);assert_eq!(fs::read(fixture.store_root.join(format!("{}.download",row.job_id))).unwrap(),encrypted);
}

#[test]fn lock_suspension_keeps_the_durable_offset_and_never_removes_the_partial(){
    let bytes=b"payload bytes";let server=server(bytes.to_vec());let fixture=Fixture::new();let profile=profile();let mut row=record(&fixture,&server,&profile,bytes);set_partial(&mut row,bytes,5,DownloadPhase::Downloading);row.cancel_requested=true;let store=fixture.store();store.save(&row).unwrap();let state=AppState::default();let mut runtime=DownloadRuntime::default();let control=Arc::new(DownloadControl::default());runtime.records.insert(row.job_id.clone(),row.clone());runtime.controls.insert(row.job_id.clone(),control.clone());runtime.loaded=true;update_visible(&state,&row,true).unwrap();
    suspend_runtime(&state,&mut runtime,Some(&store));let restored=store.load(&row.job_id).unwrap().unwrap();assert_eq!(restored.state,DownloadState::Interrupted);assert_eq!(restored.checkpoint.offset,5);assert!(restored.cancel_requested);assert_eq!(fs::read(&restored.checkpoint.partial_path).unwrap(),&bytes[..5]);assert!(control.is_paused());assert_eq!(runtime.epoch,1);assert!(runtime.records.is_empty());assert!(state.jobs.lock().unwrap().queue.is_empty());assert!(state.jobs.lock().unwrap().jobs.is_empty());assert!(server.requests.lock().unwrap().is_empty());
}

#[test]fn queued_attempt_and_cancel_intent_guards_prevent_stale_writes_or_clearing_live_runners(){
    let bytes=b"payload";let server=server(bytes.to_vec());let fixture=Fixture::new();let profile=profile();let mut row=record(&fixture,&server,&profile,bytes);row.state=DownloadState::Queued;assert!(can_start(&row,1,false));assert!(!can_start(&row,1,true));row.attempt=2;assert!(!can_start(&row,1,false));
    for state in [DownloadState::Paused,DownloadState::Interrupted,DownloadState::Completed,DownloadState::Cancelled]{row.state=state;assert!(!can_start(&row,2,false));}
    row.state=DownloadState::Interrupted;row.cancel_requested=true;let mut stale=row.clone();stale.cancel_requested=false;assert!(merge_durable_intent(&row,&stale).unwrap().cancel_requested);stale.checkpoint.phase=DownloadPhase::Committing;assert!(merge_durable_intent(&row,&stale).is_err());row.checkpoint.phase=DownloadPhase::Committing;stale.checkpoint.phase=DownloadPhase::Completed;assert!(merge_durable_intent(&row,&stale).unwrap().cancel_requested);
    row.state=DownloadState::Completed;let id=row.job_id.clone();let mut runtime=DownloadRuntime::default();runtime.records.insert(id.clone(),row);runtime.controls.insert(id.clone(),Arc::new(DownloadControl::default()));assert!(clearable_ids(&runtime).is_empty());runtime.controls.remove(&id);assert_eq!(clearable_ids(&runtime),vec![id]);
}

#[test]fn cancelling_a_popped_but_unclaimed_download_releases_the_old_scheduler_slot(){
    let bytes=b"payload";let server=server(bytes.to_vec());let fixture=Fixture::new();let profile=profile();let mut row=record(&fixture,&server,&profile,bytes);row.state=DownloadState::Queued;
    let state=AppState::default();update_visible(&state,&row,true).unwrap();
    {let mut jobs=state.jobs.lock().unwrap();jobs.queue.clear();jobs.running.insert(row.job_id.clone());jobs.concurrency=1;}
    row.attempt+=1;row.cancel_requested=true;update_visible(&state,&row,true).unwrap();
    let jobs=state.jobs.lock().unwrap();assert!(!jobs.running.contains(&row.job_id));assert_eq!(jobs.queue.len(),1);
    assert!(matches!(jobs.queue[0].kind,JobTaskKind::NativeDownload{attempt:2}));assert!(!can_start(&row,1,false));assert!(can_start(&row,2,false));
}

#[test]fn restore_preserves_terminal_completion_time_and_blocks_changed_account_versions(){
    let bytes=b"payload";let server=server(bytes.to_vec());let fixture=Fixture::new();let mut profile=profile();let mut row=record(&fixture,&server,&profile,bytes);set_partial(&mut row,bytes,bytes.len(),DownloadPhase::Completed);row.state=DownloadState::Completed;row.updated_at="2026-10-01T12:00:00Z".into();let store=fixture.store();store.save(&row).unwrap();let encrypted_before=fs::read(fixture.store_root.join(format!("{}.download",row.job_id))).unwrap();
    let state=AppState::default();let vault=VaultRuntime{unlocked:true,data:Some(VaultData{profiles:vec![profile.clone()],..Default::default()}),..Default::default()};let mut runtime=DownloadRuntime::default();install_restored_records(&state,&mut runtime,&vault,&store,store.load_all().unwrap()).unwrap();assert_eq!(runtime.records[&row.job_id].updated_at,row.updated_at);assert_eq!(state.jobs.lock().unwrap().jobs[&row.job_id].completed_at.as_deref(),Some("2026-10-01T12:00:00Z"));assert_eq!(fs::read(fixture.store_root.join(format!("{}.download",row.job_id))).unwrap(),encrypted_before);
    let mut pending=record(&fixture,&server,&profile,bytes);pending.state=DownloadState::Running;store.save(&pending).unwrap();profile.updated_at="changed-revision".into();let changed_vault=VaultRuntime{unlocked:true,data:Some(VaultData{profiles:vec![profile],..Default::default()}),..Default::default()};let mut changed_runtime=DownloadRuntime::default();install_restored_records(&state,&mut changed_runtime,&changed_vault,&store,store.load_all().unwrap()).unwrap();assert!(changed_runtime.records[&pending.job_id].error.as_deref().unwrap().contains("Account missing or changed"));assert!(confirm_profile(&changed_vault,&changed_runtime.records[&pending.job_id]).is_err());assert!(state.jobs.lock().unwrap().queue.is_empty());assert!(server.requests.lock().unwrap().is_empty());
}
