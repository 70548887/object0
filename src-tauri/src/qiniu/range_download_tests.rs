//! Ephemeral loopback HTTP and UUID paths only. No application configuration,
//! user credentials or cloud account is opened by these tests.
use super::*;
use crate::qiniu::QiniuMode;
#[test]fn atomic_commit_diagnostics_distinguish_collision_from_filesystem_failure(){
    assert_eq!(commit_error(std::io::Error::from(std::io::ErrorKind::AlreadyExists)).code,"target-exists");
    let error=commit_error(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
    assert_eq!(error.code,"atomic-commit-failed");assert!(error.to_string().contains("filesystem support"));
}
use crate::qiniu::{QiniuBucket,QiniuConfig,QiniuCredentials,QiniuRegion};
use serde_json::json;
use std::{collections::HashMap,io::{Read,Write},net::TcpListener,sync::{Arc,Mutex,atomic::AtomicBool},thread,time::Instant};

const KEY:&str="folder/中文+%?#.bin";
const MODIFIED:&str="2023-11-14T22:13:20+00:00";
#[derive(Clone,Debug)]struct Request{line:String,headers:HashMap<String,String>}
struct Reply{status:u16,headers:Vec<(String,String)>,body:Vec<u8>,length:Option<usize>}
impl Reply{
    fn stat(bytes:&[u8])->Self{Self{status:200,headers:vec![("Content-Type".into(),"application/json".into())],body:serde_json::to_vec(&json!({"fsize":bytes.len(),"hash":etag(bytes),"putTime":17000000000000000_i64,"type":0})).unwrap(),length:None}}
    fn data(bytes:&[u8],offset:u64)->Self{let mut headers=vec![("ETag".into(),format!("\"{}\"",etag(bytes)))];if offset>0{headers.push(("Content-Range".into(),format!("bytes {}-{}/{}",offset,bytes.len()-1,bytes.len())))}Self{status:if offset>0{206}else{200},headers,body:bytes[offset as usize..].to_vec(),length:None}}
}
struct Server{origin:String,requests:Arc<Mutex<Vec<Request>>>,alive:Arc<AtomicBool>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server{fn drop(&mut self){self.alive.store(false,Ordering::SeqCst);if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn server(mut reply:impl FnMut(&Request)->Reply+Send+'static)->Server{
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();let origin=format!("http://{}",listener.local_addr().unwrap());
    let requests=Arc::new(Mutex::new(Vec::new()));let captured=requests.clone();let alive=Arc::new(AtomicBool::new(true));let running=alive.clone();
    let worker=thread::spawn(move||while running.load(Ordering::SeqCst){
        let mut socket=match listener.accept(){Ok((socket,_))=>socket,Err(e)if e.kind()==io::ErrorKind::WouldBlock=>{thread::sleep(Duration::from_millis(2));continue},Err(_)=>return};
        socket.set_nonblocking(false).unwrap();socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();socket.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut bytes=Vec::new();let mut buffer=[0u8;4096];let deadline=Instant::now()+Duration::from_secs(3);
        while !bytes.windows(4).any(|part|part==b"\r\n\r\n"){
            match socket.read(&mut buffer){Ok(n)if n>0=>bytes.extend_from_slice(&buffer[..n]),_=>break};assert!(bytes.len()<64*1024);if Instant::now()>deadline{break}
        }
        if bytes.is_empty(){continue}
        let text=String::from_utf8_lossy(&bytes);let request=Request{line:text.lines().next().unwrap().into(),headers:text.lines().skip(1).filter_map(|line|line.split_once(':').map(|(name,value)|(name.to_ascii_lowercase(),value.trim().into()))).collect()};
        captured.lock().unwrap().push(request.clone());let reply=reply(&request);
        let mut response=format!("HTTP/1.0 {} Fixture\r\nConnection: close\r\nContent-Length: {}\r\n",reply.status,reply.length.unwrap_or(reply.body.len())).into_bytes();
        for(name,value)in reply.headers{response.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());}response.extend_from_slice(b"\r\n");response.extend_from_slice(&reply.body);
        let _=socket.write_all(&response);let _=socket.shutdown(std::net::Shutdown::Write);
    });Server{origin,requests,alive,worker:Some(worker)}
}
fn offset(request:&Request)->u64{request.headers.get("range").map(|range|range.strip_prefix("bytes=").unwrap().strip_suffix('-').unwrap().parse().unwrap()).unwrap_or(0)}
fn etag(bytes:&[u8])->String{let mut hash=QiniuEtag::default();hash.update(bytes);hash.finish()}
fn runtime()->&'static tokio::runtime::Runtime{static RUNTIME:std::sync::OnceLock<tokio::runtime::Runtime>=std::sync::OnceLock::new();RUNTIME.get_or_init(||tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap())}
fn client(server:&Server)->QiniuClient{
    let _entered=runtime().enter();let mut client=QiniuClient::new(QiniuConfig{mode:QiniuMode::Private,uc_url:Some(server.origin.clone()),download_domain:Some(server.origin.clone()),..Default::default()},QiniuCredentials::new("range-fixture-ak".into(),"range-fixture-secret".into(),None).unwrap()).unwrap();
    client.http=reqwest::Client::builder().no_proxy().http1_only().pool_max_idle_per_host(0).redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(4)).build().unwrap();client
}
fn context(server:&Server)->ResolvedBucketContext{
    let host=server.origin.trim_start_matches("http://");let region=QiniuRegion::from_response(&json!({"region":"z0","ttl":60,"rs":{"domains":[host]},"s3":{"region_alias":"cn-east-1","domains":[host]}}),"http",chrono::Utc::now().timestamp()).unwrap();
    ResolvedBucketContext{bucket:QiniuBucket{name:"native-bucket".into(),s3_name:Some("server-id".into()),kodo_region_id:Some("z0".into()),created_at:None,permission:None,remark:None},region,s3_bucket_name:Some("server-id".into()),backend_mode:"kodo".into()}
}
struct Fixture{root:PathBuf,target:PathBuf}
impl Fixture{fn new()->Self{let root=std::env::temp_dir().join(format!("qiniu-range-fixture-{}",uuid::Uuid::new_v4()));fs::create_dir(&root).unwrap();let root=fs::canonicalize(root).unwrap();let target=root.join("download.bin");Self{root,target}}}
impl Drop for Fixture{fn drop(&mut self){
    // Only the resolved UUID directory allocated by this fixture is owned.
    // Refuse cleanup if its path has since been redirected or replaced.
    if self.root.is_absolute()&&self.root.file_name().is_some_and(|name|name.to_string_lossy().starts_with("qiniu-range-fixture-"))&&fs::canonicalize(&self.root).ok().as_ref()==Some(&self.root){let _=fs::remove_dir_all(&self.root);}
}}
fn prepared(fixture:&Fixture,client:&QiniuClient,context:&ResolvedBucketContext)->DownloadCheckpoint{runtime().block_on(client.prepare_download_checkpoint(&uuid::Uuid::new_v4().to_string(),"profile-fixture","revision-fixture",context,KEY,&fixture.target,&DownloadControl::default())).unwrap()}
fn checkpoint(fixture:&Fixture,origin:&str,bytes:&[u8],prefix:usize)->DownloadCheckpoint{
    let job_id=uuid::Uuid::new_v4().to_string();let partial=fixture.root.join(format!(".yuncang-range-{job_id}.part"));fs::write(&partial,&bytes[..prefix]).unwrap();
    DownloadCheckpoint{format_version:FORMAT_VERSION,job_id,profile_id:"profile-fixture".into(),profile_revision:"revision-fixture".into(),bucket:"native-bucket".into(),key:KEY.into(),domain:origin.into(),target_path:fixture.target.to_string_lossy().into_owned(),partial_path:partial.to_string_lossy().into_owned(),remote:RemoteIdentity{size:bytes.len()as u64,etag:etag(bytes),last_modified:MODIFIED.into()},offset:prefix as u64,prefix_sha256:hex(Sha256::digest(&bytes[..prefix])),partial_created:Some(stamp(&fs::metadata(&partial).unwrap()).unwrap()),phase:DownloadPhase::Downloading}
}
fn normal_server(bytes:Vec<u8>)->Server{server(move|request|if request.line.starts_with("GET /stat/"){Reply::stat(&bytes)}else{Reply::data(&bytes,offset(request))})}
fn interrupted_cp(outcome:DownloadOutcome)->DownloadCheckpoint{match outcome{DownloadOutcome::Interrupted{checkpoint,..}=>checkpoint,other=>panic!("expected interrupted outcome, got {other:?}")}}

#[test]fn pause_reopen_and_range_resume_preserve_exact_offset_and_commit_full_hash(){
    let bytes:Vec<u8>=(0..6*1024*1024+37).map(|i|(i%251)as u8).collect();let fixture=Fixture::new();let server=normal_server(bytes.clone());let client=client(&server);let context=context(&server);let cp=prepared(&fixture,&client,&context);let control=DownloadControl::default();let mut saved=Vec::new();
    let outcome=runtime().block_on(client.run_download_checkpoint(&context,cp,&control,|cp|{saved.push(cp.clone());Ok(())},|done,_|if done>0{control.pause()})).unwrap();
    let paused=match outcome{DownloadOutcome::Paused{checkpoint}=>checkpoint,other=>panic!("expected paused: {other:?}")};assert!(paused.offset>0&&paused.offset<bytes.len()as u64);assert_eq!(fs::metadata(&paused.partial_path).unwrap().len(),paused.offset);assert!(!fixture.target.exists());
    let reloaded:DownloadCheckpoint=serde_json::from_slice(&serde_json::to_vec(&paused).unwrap()).unwrap();
    let completed=runtime().block_on(client.run_download_checkpoint(&context,reloaded,&DownloadControl::default(),|_|Ok(()),|_,_|{})).unwrap();assert!(matches!(completed,DownloadOutcome::Completed{..}));assert_eq!(fs::read(&fixture.target).unwrap(),bytes);assert!(!Path::new(&paused.partial_path).exists());
    let requests=server.requests.lock().unwrap();let range=requests.iter().find(|request|request.headers.contains_key("range")).unwrap();assert_eq!(range.headers["range"],format!("bytes={}-",paused.offset));assert_eq!(range.headers["accept-encoding"],"identity");assert_eq!(range.headers["if-match"],format!("\"{}\"",paused.remote.etag));assert!(range.line.contains("%E4%B8%AD%E6%96%87"));assert!(range.line.contains("&token=range-fixture-ak:"));assert!(saved.iter().any(|cp|cp.partial_created.is_some()));
}

#[test]fn invalid_range_responses_do_not_append_or_replace_targets(){
    for mode in ["full-200","wrong-start","wrong-total","wrong-etag","compressed","precondition","range-416"]{
        let bytes=b"hello world".to_vec();let fixture=Fixture::new();let body=bytes.clone();let server=server(move|request|{
            if request.line.starts_with("GET /stat/"){return Reply::stat(&body)}
            let mut reply=Reply::data(&body,offset(request));match mode{
                "full-200"=>reply=Reply::data(&body,0),
                "wrong-start"=>{reply.headers.retain(|(name,_)|name!="Content-Range");reply.headers.push(("Content-Range".into(),"bytes 4-9/11".into()));},
                "wrong-total"=>{reply.headers.retain(|(name,_)|name!="Content-Range");reply.headers.push(("Content-Range".into(),"bytes 5-10/999".into()));},
                "wrong-etag"=>reply.headers[0].1="\"other\"".into(),
                "compressed"=>reply.headers.push(("Content-Encoding".into(),"gzip".into())),
                "precondition"=>reply.status=412,"range-416"=>reply.status=416,_=>unreachable!(),
            }reply
        });let cp=checkpoint(&fixture,&server.origin,&bytes,5);let before=fs::read(&cp.partial_path).unwrap();let client=client(&server);let context=context(&server);
        let outcome=runtime().block_on(client.run_download_checkpoint(&context,cp.clone(),&DownloadControl::default(),|_|Ok(()),|_,_|{})).unwrap();assert!(matches!(outcome,DownloadOutcome::Interrupted{..}));assert_eq!(fs::read(&cp.partial_path).unwrap(),before);assert!(!fixture.target.exists());
    }
}

#[test]fn remote_version_changes_and_partial_tampering_fail_before_a_download_get(){
    let original=b"original bytes".to_vec();let fixture=Fixture::new();let server=normal_server(b"changed contents".to_vec());let client=client(&server);let context=context(&server);let cp=checkpoint(&fixture,&server.origin,&original,5);
    let outcome=runtime().block_on(client.run_download_checkpoint(&context,cp.clone(),&DownloadControl::default(),|_|Ok(()),|_,_|{})).unwrap();assert!(matches!(outcome,DownloadOutcome::Interrupted{..}));assert_eq!(server.requests.lock().unwrap().len(),1);assert_eq!(fs::read(&cp.partial_path).unwrap(),&original[..5]);
    let fixture=Fixture::new();let server=normal_server(original.clone());let client=self::client(&server);let context=self::context(&server);let cp=checkpoint(&fixture,&server.origin,&original,5);fs::write(&cp.partial_path,b"WRONG").unwrap();
    let outcome=runtime().block_on(client.run_download_checkpoint(&context,cp.clone(),&DownloadControl::default(),|_|Ok(()),|_,_|{})).unwrap();assert!(matches!(outcome,DownloadOutcome::Interrupted{..}));assert_eq!(server.requests.lock().unwrap().len(),1);assert_eq!(fs::read(&cp.partial_path).unwrap(),b"WRONG");assert!(!fixture.target.exists());
}

#[test]fn authenticated_prefix_allows_trimming_only_an_unconfirmed_owned_tail(){
    let bytes=b"complete expected object".to_vec();let fixture=Fixture::new();let server=normal_server(bytes.clone());let client=client(&server);let context=context(&server);let cp=checkpoint(&fixture,&server.origin,&bytes,5);
    let mut file=fs::OpenOptions::new().append(true).open(&cp.partial_path).unwrap();file.write_all(b"unconfirmed").unwrap();drop(file);
    assert!(matches!(runtime().block_on(client.run_download_checkpoint(&context,cp,&DownloadControl::default(),|_|Ok(()),|_,_|{})).unwrap(),DownloadOutcome::Completed{..}));assert_eq!(fs::read(&fixture.target).unwrap(),bytes);
}

#[test]fn existing_and_concurrently_created_targets_are_never_overwritten(){
    let fixture=Fixture::new();let server=normal_server(b"hello".to_vec());let client=client(&server);let context=context(&server);fs::write(&fixture.target,b"user original").unwrap();
    assert!(runtime().block_on(client.prepare_download_checkpoint(&uuid::Uuid::new_v4().to_string(),"p","r",&context,KEY,&fixture.target,&DownloadControl::default())).is_err());assert!(server.requests.lock().unwrap().is_empty());assert_eq!(fs::read(&fixture.target).unwrap(),b"user original");
    let fixture=Fixture::new();let server=normal_server(b"hello".to_vec());let client=self::client(&server);let context=self::context(&server);let cp=prepared(&fixture,&client,&context);let target=fixture.target.clone();
    let outcome=runtime().block_on(client.run_download_checkpoint(&context,cp,&DownloadControl::default(),|cp|{if cp.phase==DownloadPhase::Committing{fs::write(&target,b"someone else's file").unwrap();}Ok(())},|_,_|{})).unwrap();assert!(matches!(outcome,DownloadOutcome::Interrupted{..}));assert_eq!(fs::read(&fixture.target).unwrap(),b"someone else's file");
}

#[test]fn committing_reopen_finishes_local_transaction_without_cloud_requests(){
    let fixture=Fixture::new();let bytes=b"verified complete data".to_vec();let server=normal_server(bytes.clone());let cp=checkpoint(&fixture,&server.origin,&bytes,bytes.len());let mut committing=cp.clone();committing.phase=DownloadPhase::Committing;
    let client=client(&server);let complete=runtime().block_on(client.reconcile_download_checkpoint(committing,|_|Ok(()))).unwrap();assert!(matches!(complete,DownloadOutcome::Completed{..}));assert_eq!(fs::read(&fixture.target).unwrap(),bytes);assert!(!Path::new(&cp.partial_path).exists());assert!(server.requests.lock().unwrap().is_empty());
}

#[test]fn complete_prefix_in_downloading_phase_does_not_request_an_impossible_range(){
    let fixture=Fixture::new();let bytes=b"all bytes already persisted".to_vec();let server=normal_server(bytes.clone());let cp=checkpoint(&fixture,&server.origin,&bytes,bytes.len());let client=client(&server);let context=context(&server);
    assert!(matches!(runtime().block_on(client.run_download_checkpoint(&context,cp,&DownloadControl::default(),|_|Ok(()),|_,_|{})).unwrap(),DownloadOutcome::Completed{..}));assert_eq!(fs::read(&fixture.target).unwrap(),bytes);assert!(server.requests.lock().unwrap().iter().all(|request|request.line.starts_with("GET /stat/")));
}

#[test]fn local_cancellation_only_removes_a_verified_owned_partial_not_the_user_target(){
    let fixture=Fixture::new();let bytes=b"payload".to_vec();let server=normal_server(bytes.clone());let cp=checkpoint(&fixture,&server.origin,&bytes,3);fs::write(&fixture.target,b"preserve user target").unwrap();
    let outcome=runtime().block_on(cancel_download_checkpoint(cp.clone(),|_|Ok(()))).unwrap();assert!(matches!(outcome,DownloadOutcome::Cancelled{..}));assert!(!Path::new(&cp.partial_path).exists());assert_eq!(fs::read(&fixture.target).unwrap(),b"preserve user target");assert!(server.requests.lock().unwrap().is_empty());
    let fixture=Fixture::new();let cp=checkpoint(&fixture,&server.origin,&bytes,3);fs::write(&cp.partial_path,b"bad").unwrap();let outcome=runtime().block_on(cancel_download_checkpoint(cp.clone(),|_|Ok(()))).unwrap();assert!(matches!(outcome,DownloadOutcome::Interrupted{..}));assert_eq!(fs::read(&cp.partial_path).unwrap(),b"bad");
}

#[test]fn cancellation_never_recreates_a_target_removed_between_commit_checks(){
    let fixture=Fixture::new();let bytes=b"verified local content".to_vec();let server=normal_server(bytes.clone());let mut cp=checkpoint(&fixture,&server.origin,&bytes,bytes.len());cp.phase=DownloadPhase::Committing;fs::write(&fixture.target,&bytes).unwrap();let target=fixture.target.clone();
    let outcome=runtime().block_on(cancel_download_checkpoint_after_target_check(cp.clone(),|_|Ok(()),||{fs::remove_file(&target).unwrap();})).unwrap();
    assert!(matches!(outcome,DownloadOutcome::Interrupted{..}));assert!(!fixture.target.exists());assert_eq!(fs::read(&cp.partial_path).unwrap(),bytes);assert!(server.requests.lock().unwrap().is_empty());
}

#[test]fn checkpoint_write_failure_stops_get_and_local_commit(){
    let fixture=Fixture::new();let server=normal_server(b"hello".to_vec());let client=client(&server);let context=context(&server);let cp=prepared(&fixture,&client,&context);
    let outcome=runtime().block_on(client.run_download_checkpoint(&context,cp,&DownloadControl::default(),|_|Err(local()),|_,_|{})).unwrap();assert!(matches!(outcome,DownloadOutcome::Interrupted{..}));assert!(!fixture.target.exists());assert!(server.requests.lock().unwrap().iter().all(|request|request.line.starts_with("GET /stat/")));
}

#[test]fn failed_progress_checkpoint_returns_only_the_last_durable_offset(){
    let bytes=vec![0x73;5*1024*1024+37];let fixture=Fixture::new();let server=normal_server(bytes.clone());let client=client(&server);let context=context(&server);let cp=prepared(&fixture,&client,&context);
    let result=runtime().block_on(client.run_download_checkpoint(&context,cp,&DownloadControl::default(),|cp|if cp.offset>=CHECKPOINT_BYTES{Err(local())}else{Ok(())},|_,_|{})).unwrap();
    let retained=interrupted_cp(result);assert_eq!(retained.offset,0);assert_eq!(retained.prefix_sha256,empty_digest());assert!(!fixture.target.exists());assert!(fs::metadata(&retained.partial_path).unwrap().len()>=CHECKPOINT_BYTES);
    assert!(matches!(runtime().block_on(client.run_download_checkpoint(&context,retained,&DownloadControl::default(),|_|Ok(()),|_,_|{})).unwrap(),DownloadOutcome::Completed{..}));assert_eq!(fs::read(&fixture.target).unwrap(),bytes);
}

#[test]fn truncated_stream_preserves_a_resumable_prefix_not_a_completed_target(){
    let bytes=b"long enough body for truncation".to_vec();let body=bytes.clone();let mut data_calls=0;let server=server(move|request|{
        if request.line.starts_with("GET /stat/"){return Reply::stat(&body)}let mut reply=Reply::data(&body,offset(request));data_calls+=1;if data_calls==1{reply.length=Some(reply.body.len());reply.body.truncate(5);}reply
    });let fixture=Fixture::new();let client=client(&server);let context=context(&server);let cp=prepared(&fixture,&client,&context);
    let interrupted=interrupted_cp(runtime().block_on(client.run_download_checkpoint(&context,cp,&DownloadControl::default(),|_|Ok(()),|_,_|{})).unwrap());assert!(!fixture.target.exists());assert!(interrupted.offset>0&&interrupted.offset<bytes.len()as u64);
    assert!(matches!(runtime().block_on(client.run_download_checkpoint(&context,interrupted,&DownloadControl::default(),|_|Ok(()),|_,_|{})).unwrap(),DownloadOutcome::Completed{..}));assert_eq!(fs::read(&fixture.target).unwrap(),bytes);
}

#[test]fn checkpoint_scope_shape_rejects_unsafe_paths_unknown_fields_and_weak_identity(){
    let fixture=Fixture::new();let cp=checkpoint(&fixture,"https://files.example",b"hello",2);assert!(validate_checkpoint(&cp).is_ok());
    let mut wrong=cp.clone();wrong.partial_path=fixture.root.join("user-file.bin").to_string_lossy().into_owned();assert!(validate_checkpoint(&wrong).is_err());
    let mut wrong=cp.clone();wrong.target_path="../outside".into();assert!(validate_checkpoint(&wrong).is_err());
    let mut wrong=cp.clone();wrong.remote.etag="opaque-not-a-content-hash".into();assert!(validate_checkpoint(&wrong).is_err());
    let mut json=serde_json::to_value(&cp).unwrap();json["token"]=json!("fixture-secret");assert!(serde_json::from_value::<DownloadCheckpoint>(json).is_err());
    let text=format!("{cp:?}");assert!(!text.contains(&cp.target_path));assert!(!text.contains(&cp.domain));assert!(!text.contains(KEY));
}
