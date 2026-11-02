use super::*;
use std::{io::{Read,Write},net::{TcpListener,TcpStream},thread};
struct Fixture{root:PathBuf,state:AppState}
impl Fixture{
    fn new()->Self{let root=std::env::temp_dir().join(format!("yuncang-one-connect-{}",Uuid::new_v4()));fs::create_dir(&root).unwrap();let state=AppState::default();{let mut vault=state.vault.lock().unwrap();vault.plaintext=true;vault.unlocked=true;vault.data=Some(VaultData::default());save_vault(&root.join("accounts.local.json"),&vault).unwrap();}Self{root,state}}
    fn path(&self)->PathBuf{self.root.join("accounts.local.json")}
    fn count(&self)->usize{self.state.vault.lock().unwrap().data.as_ref().unwrap().profiles.len()}
}
impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
fn runtime()->tokio::runtime::Runtime{tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()}
fn input(id:&str)->ConnectInput{ConnectInput{request_id:id.into(),access_key_id:"fixture-permanent-ak".into(),secret_access_key:"fixture-permanent-sk".into(),name:None}}
fn bucket()->qiniu::QiniuBucket{qiniu::QiniuBucket{name:"native-space".into(),s3_name:Some("server-alias".into()),kodo_region_id:Some("z0".into()),created_at:None,permission:Some("readonly".into()),remark:Some("not-for-ui".into())}}
async fn connect_fixture(f:&Fixture,id:&str,buckets:Vec<qiniu::QiniuBucket>)->Result<ConnectOutput,String>{connect_verified(&f.state,input(id),&f.path(),async{Ok(buckets)},save_vault).await}

#[test]fn zero_bucket_account_connects_once_without_claiming_object_or_download_access(){runtime().block_on(async{
    let f=Fixture::new();let result=connect_fixture(&f,"zero",vec![]).await.unwrap();assert_eq!(f.count(),1);assert!(result.account_connected);assert!(!result.bucket_reads_verified&&!result.download_verified);assert!(result.buckets.is_empty());assert_eq!(result.profile.name,"七牛账号 1");
    let safe=serde_json::to_string(&result).unwrap();for secret in ["fixture-permanent-ak","fixture-permanent-sk","accessKeyId","secretAccessKey","sessionToken"]{assert!(!safe.contains(secret));}
    let text=fs::read_to_string(f.path()).unwrap();assert!(text.contains("fixture-permanent-ak")&&text.contains("fixture-permanent-sk"));let restored=plaintext_accounts::load(&f.path()).unwrap();assert_eq!(restored.data.unwrap().profiles.len(),1);
})}

#[test]fn request_replay_is_idempotent_and_a_changed_payload_or_removed_profile_is_refused(){runtime().block_on(async{
    let f=Fixture::new();let first=connect_fixture(&f,"same",vec![bucket()]).await.unwrap();let again=connect_verified(&f.state,input("same"),&f.path(),async{panic!("replay must not contact cloud")},|_,_|panic!("replay must not persist")).await.unwrap();assert_eq!(first.profile.id,again.profile.id);assert_eq!(f.count(),1);
    let mut changed=input("same");changed.secret_access_key="different-secret".into();assert!(connect_verified(&f.state,changed,&f.path(),async{panic!("changed request must not verify")},save_vault).await.is_err());
    // A new request after reopening/retry for the same credentials reuses the
    // saved account, not another alias with identical credentials.
    let same_identity=connect_fixture(&f,"fresh-id",vec![]).await.unwrap();assert_eq!(same_identity.profile.id,first.profile.id);assert_eq!(f.count(),1);
    {let mut vault=f.state.vault.lock().unwrap();vault.data.as_mut().unwrap().profiles.clear();save_vault(&f.path(),&vault).unwrap();}
    assert!(connect_fixture(&f,"same",vec![]).await.is_err());assert_eq!(f.count(),0);
})}

#[test]fn cancellation_before_begin_and_during_verification_never_saves(){runtime().block_on(async{
    let f=Fixture::new();cancel(&f.state,"early").unwrap();assert!(connect_verified(&f.state,input("early"),&f.path(),async{panic!("pre-cancel must not contact cloud")},save_vault).await.is_err());
    let path=f.path();let verify=async{tokio::time::sleep(StdDuration::from_millis(100)).await;Ok(vec![bucket()])};
    let action=connect_verified(&f.state,input("late"),&path,verify,save_vault);let cancel_action=async{tokio::time::sleep(StdDuration::from_millis(10)).await;cancel(&f.state,"late").unwrap()};let(result,_)=futures_util::future::join(action,cancel_action).await;assert!(result.err().unwrap().contains("cancelled"));assert_eq!(f.count(),0);
})}

#[test]fn locked_or_changed_account_snapshot_cannot_publish_a_late_verified_account(){runtime().block_on(async{
    for lock in [false,true]{let f=Fixture::new();let path=f.path();let action=connect_verified(&f.state,input("pending"),&path,async{tokio::time::sleep(StdDuration::from_millis(60)).await;Ok(vec![])},save_vault);
        let change=async{tokio::time::sleep(StdDuration::from_millis(10)).await;let mut vault=f.state.vault.lock().unwrap();if lock{vault.unlocked=false;clear(&f.state);}else{vault.data.as_mut().unwrap().transfer_master_key=Some(serde_json::from_value(json!(vec![7u8;32])).unwrap());save_vault(&path,&vault).unwrap();}};
        let(result,_)=futures_util::future::join(action,change).await;assert!(result.is_err());assert_eq!(f.count(),0);
    }
})}

#[test]fn clear_preserves_known_cancelled_request_ids_after_reopen_and_forgets_outputs(){runtime().block_on(async{
    let f=Fixture::new();let done=connect_fixture(&f,"completed",vec![bucket()]).await.unwrap();assert_eq!(f.count(),1);
    cancel(&f.state,"cancel-before-begin").unwrap();clear(&f.state);
    {let runtime=f.state.qiniu_connections.lock().unwrap();assert!(runtime.entries.values().all(|e|e.fingerprint.is_none()&&matches!(e.state,RequestState::Cancelled)));}
    for id in ["completed","cancel-before-begin"] {
        assert!(connect_verified(&f.state,input(id),&f.path(),async{panic!("revoked ID must not verify")},save_vault).await.is_err());
    }
    assert_eq!(f.state.vault.lock().unwrap().data.as_ref().unwrap().profiles[0].id,done.profile.id);
    let new=connect_fixture(&f,"new-after-reopen",vec![]).await.unwrap();assert_eq!(new.profile.id,done.profile.id);assert_eq!(f.count(),1);
})}

#[test]fn concurrent_duplicate_is_refused_and_distinct_stale_commit_does_not_overwrite(){runtime().block_on(async{
    let f=Fixture::new();let path=f.path();let action=connect_verified(&f.state,input("pending"),&path,async{tokio::time::sleep(StdDuration::from_millis(40)).await;Ok(vec![])},save_vault);
    let duplicate=async{tokio::time::sleep(StdDuration::from_millis(5)).await;let result=connect_fixture(&f,"pending",vec![]).await;assert!(result.err().unwrap().contains("already running"));};let(result,_)=futures_util::future::join(action,duplicate).await;assert!(result.is_ok());assert_eq!(f.count(),1);
})}

#[test]fn failed_authentication_and_failed_durable_commit_leave_original_bytes_and_runtime(){runtime().block_on(async{
    let f=Fixture::new();let original=fs::read(f.path()).unwrap();let failed=connect_verified(&f.state,input("denied"),&f.path(),async{Err("Fixed permission-denied error".into())},save_vault).await;assert!(failed.is_err());assert_eq!(fs::read(f.path()).unwrap(),original);assert_eq!(f.count(),0);
    let failed=connect_verified(&f.state,input("disk"),&f.path(),async{Ok(vec![bucket()])},|_,_|Err("Synthetic disk failure".into())).await;assert!(failed.is_err());assert_eq!(fs::read(f.path()).unwrap(),original);assert_eq!(f.count(),0);
    let result=connect_fixture(&f,"disk",vec![bucket()]).await.unwrap();assert_eq!(f.count(),1);assert_eq!(result.buckets[0].name,"native-space");assert_eq!(result.buckets[0].s3_name.as_deref(),Some("server-alias"));assert!(!serde_json::to_string(&result).unwrap().contains("not-for-ui"));
})}

#[test]fn external_plaintext_change_and_registry_limits_fail_closed(){runtime().block_on(async{
    let f=Fixture::new();let path=f.path();let action=connect_verified(&f.state,input("disk-change"),&path,async{tokio::time::sleep(StdDuration::from_millis(40)).await;Ok(vec![])},save_vault);
    let change=async{tokio::time::sleep(StdDuration::from_millis(5)).await;fs::write(&path,b"malformed fixture").unwrap();};let(result,_)=futures_util::future::join(action,change).await;assert!(result.is_err());assert_eq!(fs::read(&path).unwrap(),b"malformed fixture");assert_eq!(f.count(),0);
    let f=Fixture::new();for i in 0..MAX_REQUESTS{cancel(&f.state,&format!("cancel-{i}")).unwrap();}assert!(cancel(&f.state,"over-limit").is_err());assert!(connect_fixture(&f,"new",vec![]).await.is_err());
})}

#[test]fn malformed_input_and_bucket_data_do_not_save_or_expose_secrets(){runtime().block_on(async{
    let f=Fixture::new();let mut bad=input("bad");bad.access_key_id="secret\nkey".into();let error=connect_verified(&f.state,bad,&f.path(),async{panic!("invalid input not sent")},save_vault).await.err().unwrap();assert!(!error.contains("secret"));
    let mut bad_bucket=bucket();bad_bucket.name="bad\nspace".into();assert!(connect_fixture(&f,"bad-bucket",vec![bad_bucket]).await.is_err());assert_eq!(f.count(),0);
    assert!(serde_json::from_value::<ConnectInput>(json!({"requestId":"r","accessKeyId":"a","secretAccessKey":"s","endpoint":"https://untrusted.example"})).is_err());
})}

// A real QiniuClient request is used against a synthetic explicitly configured
// loopback origin. Production connect always uses the fixed public config.
#[test]fn signed_list_only_verifier_reaches_coordinator_without_region_or_domain_requests(){runtime().block_on(async{
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();let origin=format!("http://{}",listener.local_addr().unwrap());let captured=Arc::new(Mutex::new(String::new()));let capture=captured.clone();
    let worker=thread::spawn(move||{let(mut socket,_): (TcpStream,_)=listener.accept().unwrap();socket.set_read_timeout(Some(StdDuration::from_secs(3))).unwrap();let mut bytes=vec![];let mut buffer=[0u8;8192];loop{let n=socket.read(&mut buffer).unwrap();if n==0{break}bytes.extend_from_slice(&buffer[..n]);if bytes.windows(4).any(|v|v==b"\r\n\r\n"){break}}*capture.lock().unwrap()=String::from_utf8(bytes).unwrap();let body="[{\"tbl\":\"native-space\",\"id\":\"server-alias\",\"region\":\"z0\",\"perm\":1}]";socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).unwrap();});
    let client=qiniu::QiniuClient::new(qiniu::QiniuConfig{mode:qiniu::QiniuMode::Private,uc_url:Some(origin),..Default::default()},qiniu::QiniuCredentials::new("fixture-permanent-ak".into(),"fixture-permanent-sk".into(),None).unwrap()).unwrap();
    let f=Fixture::new();let result=connect_verified(&f.state,input("http"),&f.path(),async{client.list_buckets().await.map_err(|e|e.to_string())},save_vault).await.unwrap();worker.join().unwrap();
    assert_eq!(result.buckets[0].name,"native-space");let request=captured.lock().unwrap();assert!(request.starts_with("GET /v2/buckets?shared=rd "));assert!(request.to_ascii_lowercase().contains("authorization: qiniu fixture-permanent-ak:"));assert!(!request.contains("fixture-permanent-sk"));assert!(!request.contains("/regions"));assert!(result.profile.default_bucket.is_none());
})}
