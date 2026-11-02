//! Synthetic, loopback-only coverage of the real RPC/private-environment boundary.
use super::*;
use std::{io::{Read,Write},net::{TcpListener,TcpStream},thread,time::{Duration,Instant}};

struct Reply {status:u16,body:Vec<u8>,headers:Vec<(String,String)>,head:bool,delay_ms:u64}
impl Reply {
    fn json(body:Value)->Self {Self{status:200,body:body.to_string().into_bytes(),headers:vec![("Content-Type".into(),"application/json".into())],head:false,delay_ms:0}}
    fn listing(body:&str)->Self {Self{status:200,body:format!("<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>s3-alias</Name>{body}</ListBucketResult>").into_bytes(),headers:vec![("Content-Type".into(),"application/xml".into())],head:false,delay_ms:0}}
    fn object(bytes:&[u8],head:bool)->Self {Self{status:200,body:if head{vec![]}else{bytes.to_vec()},headers:vec![("Content-Length".into(),bytes.len().to_string()),("ETag".into(),"\"shared-etag\"".into()),("Last-Modified".into(),"Sun, 01 Nov 2026 00:00:00 GMT".into())],head,delay_ms:0}}
}
struct Server {origin:String,requests:Arc<Mutex<Vec<String>>>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server {fn drop(&mut self){if let Some(worker)=self.worker.take(){worker.join().unwrap();}}}
fn server(make:impl FnOnce(&str)->Vec<Reply>)->Server {
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();let origin=format!("http://{}",listener.local_addr().unwrap());let replies=make(&origin);
    let requests=Arc::new(Mutex::new(Vec::new()));let captures=requests.clone();
    let worker=thread::spawn(move||{for reply in replies {
        let deadline=Instant::now()+Duration::from_secs(4);
        let (mut socket,bytes)=loop {
            let mut socket:TcpStream=loop {match listener.accept(){Ok((socket,_))=>break socket,Err(e)if e.kind()==io::ErrorKind::WouldBlock&&Instant::now()<deadline=>thread::sleep(Duration::from_millis(2)),_=>return}};
            socket.set_nonblocking(false).unwrap();socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();let mut bytes=vec![];let mut buffer=[0u8;8192];
            loop {let n=socket.read(&mut buffer).unwrap_or(0);if n==0{break}bytes.extend_from_slice(&buffer[..n]);if let Some(split)=bytes.windows(4).position(|v|v==b"\r\n\r\n") {
                let headers=String::from_utf8_lossy(&bytes[..split]);let length=headers.lines().find_map(|line|{let(k,v)=line.split_once(':')?;k.eq_ignore_ascii_case("content-length").then(||v.trim().parse::<usize>().ok()).flatten()}).unwrap_or(0);if bytes.len()>=split+4+length{break}
            }}
            if bytes.is_empty(){if Instant::now()>=deadline{return}continue}break(socket,bytes)
        };
        captures.lock().unwrap().push(String::from_utf8(bytes).unwrap());if reply.delay_ms>0{thread::sleep(Duration::from_millis(reply.delay_ms))}
        let length=reply.headers.iter().find(|(k,_)|k.eq_ignore_ascii_case("content-length")).map(|(_,v)|v.clone()).unwrap_or_else(||reply.body.len().to_string());
        let headers=reply.headers.iter().filter(|(k,_)|!k.eq_ignore_ascii_case("content-length")).map(|(k,v)|format!("{k}: {v}\r\n")).collect::<String>();
        let _=socket.write_all(format!("HTTP/1.1 {} Fixture\r\nContent-Length: {length}\r\nConnection: close\r\n{headers}\r\n",reply.status).as_bytes());if !reply.head{let _=socket.write_all(&reply.body);}let _=socket.shutdown(std::net::Shutdown::Write);
    }});
    Server {origin,requests,worker:Some(worker)}
}
fn runtime()->tokio::runtime::Runtime {tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()}
fn config(origin:&str)->qiniu::QiniuConfig {qiniu::QiniuConfig{mode:qiniu::QiniuMode::Private,uc_url:Some(origin.into()),share_portal:Some(origin.into()),share_api_url:Some(origin.into()),regions:vec![qiniu::QiniuManualRegion{id:"private-region".into(),label:None,s3_endpoint:origin.into()}],..Default::default()}}
fn state(config:qiniu::QiniuConfig)->AppState {
    let profile:Profile=serde_json::from_value(json!({"id":"private-env","name":"Private fixture","provider":"qiniu","accessKeyId":"owner-permanent-ak","secretAccessKey":"owner-permanent-sk","sessionToken":"owner-session-token","qiniu":config,"createdAt":"t","updatedAt":"revision-1"})).unwrap();
    let state=AppState::default();{let mut vault=state.vault.lock().unwrap();vault.unlocked=true;vault.data=Some(VaultData{profiles:vec![profile],..Default::default()});}state
}
fn verification(origin:&str)->Reply {Reply::json(json!({"endpoint":origin,"region":"private-region","bucket_name":"native-name","bucket_id":"s3-alias","prefix":"shared/","federated_ak":"temporary-ak","federated_sk":"temporary-sk","session_token":"temporary-token","permission":"READWRITE","expires":(Utc::now()+chrono::Duration::seconds(3600)).to_rfc3339()}))}
fn input(origin:&str)->Value {json!({"url":format!("{origin}/kodo-shares/verify?id=fixture&token=share-link-token"),"extractionCode":"Ab12Cd","privateEnvironmentId":"private-env","expectedPrivateEnvironmentRevision":"revision-1"})}
async fn login(state:&AppState,origin:&str)->Value {dispatch(state,RpcMethod::QiniuShareLogin,input(origin)).await.unwrap()}
async fn wait_for_request(requests:&Arc<Mutex<Vec<String>>>) {
    let deadline=Instant::now()+Duration::from_secs(3);
    while requests.lock().unwrap().is_empty(){assert!(Instant::now()<deadline,"Fixture request never started");tokio::time::sleep(Duration::from_millis(2)).await;}
}

#[test]
fn private_login_requires_an_exact_nonempty_saved_revision() {
    let state=state(config("http://127.0.0.1:9"));
    for revision in [None,Some(""),Some(" "),Some("old-revision")] {assert!(login_environment(&state,Some("private-env"),revision).is_err());}
    assert!(login_environment(&state,Some("missing"),Some("revision-1")).is_err());
    assert!(login_environment(&state,None,Some("revision-1")).is_err());
    assert!(login_environment(&state,Some("private-env"),Some("revision-1")).is_ok());
}

#[test]
fn private_preflight_requires_explicit_sharing_and_region_trust_without_network() {
    let origin="http://127.0.0.1:9";
    let mut cases=vec![];
    let mut value=config(origin);value.share_api_url=None;cases.push(value);
    let mut value=config(origin);value.share_portal=None;cases.push(value);
    let mut value=config(origin);value.regions.clear();cases.push(value);
    let mut value=config(origin);value.regions[0].id="invalid region".into();cases.push(value);
    let mut value=config(origin);value.share_api_url=Some("http://user:fixture-secret@127.0.0.1:9".into());cases.push(value);
    let mut value=config(origin);value.trusted_ca_path=Some(std::env::temp_dir().join(format!("nonexistent-{}.pem",Uuid::new_v4())).to_string_lossy().to_string());cases.push(value);
    for config in cases {let state=state(config);let error=login_environment(&state,Some("private-env"),Some("revision-1")).err().unwrap();assert!(!error.contains("fixture-secret"));}
}

#[test]
fn rpc_private_login_list_and_native_download_use_only_temporary_credentials() {runtime().block_on(async {
    let bytes=b"private share payload";
    let fixture=server(|origin|vec![verification(origin),Reply::listing("<IsTruncated>false</IsTruncated><Contents><Key>shared/file.txt</Key><Size>21</Size></Contents>"),Reply::object(bytes,true),Reply::object(bytes,false),Reply::object(bytes,true)]);
    let state=state(config(&fixture.origin));let session=login(&state,&fixture.origin).await;
    assert_eq!(session.as_object().unwrap().len(),5);assert_eq!(session["readOnly"],true);assert_eq!(session["bucketName"],"native-name");
    let id=session["sessionId"].as_str().unwrap();
    let page=dispatch(&state,RpcMethod::QiniuShareList,json!({"sessionId":id,"prefix":"shared/"})).await.unwrap();assert_eq!(page["objects"][0]["key"],"shared/file.txt");
    assert!(dispatch(&state,RpcMethod::QiniuShareList,json!({"sessionId":id,"prefix":"outside/"})).await.is_err());
    let dir=std::env::temp_dir().join(format!("yuncang-private-rpc-{}",Uuid::new_v4()));fs::create_dir(&dir).unwrap();let target=dir.join("file.txt");
    let result=state.share_sessions.download(id,"shared/file.txt",&target).await.unwrap();assert_eq!(result.bytes,bytes.len()as i64);assert_eq!(fs::read(&target).unwrap(),bytes);
    dispatch(&state,RpcMethod::QiniuShareClose,json!({"sessionId":id})).await.unwrap();assert!(state.share_sessions.info(id).is_err());
    let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),5);assert!(!requests[0].to_ascii_lowercase().contains("authorization:"));assert!(requests[1].to_ascii_lowercase().contains("x-amz-security-token: temporary-token"));
    for request in requests.iter(){for secret in ["owner-permanent-ak","owner-permanent-sk","owner-session-token","temporary-sk"]{assert!(!request.contains(secret));}}
    for secret in ["temporary-ak","temporary-sk","temporary-token","s3-alias"]{assert!(!session.to_string().contains(secret));}drop(requests);
    fs::remove_file(target).unwrap();fs::remove_dir(dir).unwrap();
})}

#[test]
fn untrusted_link_origin_is_rejected_before_the_share_request() {runtime().block_on(async {
    let state=state(config("http://127.0.0.1:9"));let mut payload=input("https://untrusted.invalid");payload["url"]=json!("https://untrusted.invalid/kodo-shares/verify?id=fixture&token=do-not-send");
    let error=dispatch(&state,RpcMethod::QiniuShareLogin,payload).await.unwrap_err();assert!(error.contains("configured portal"));assert!(!error.contains("do-not-send"));
})}

#[test]
fn private_verification_cannot_expand_storage_origin_or_region() {runtime().block_on(async {
    for wrong_region in [false,true] {
        let fixture=server(|origin|{let mut response=verification(origin);let mut value:Value=serde_json::from_slice(&response.body).unwrap();if wrong_region{value["region"]=json!("other-region");}else{value["endpoint"]=json!("https://untrusted.invalid");}response.body=value.to_string().into_bytes();vec![response]});
        let state=state(config(&fixture.origin));let error=dispatch(&state,RpcMethod::QiniuShareLogin,input(&fixture.origin)).await.unwrap_err();
        assert!(error.contains(if wrong_region{"do not match"}else{"not trusted"}),"{error}");assert!(!error.contains("temporary-sk"));assert_eq!(fixture.requests.lock().unwrap().len(),1);
    }
})}

#[test]
fn share_api_redirect_is_not_followed_with_link_token_or_extraction_code() {runtime().block_on(async {
    let sink=TcpListener::bind("127.0.0.1:0").unwrap();sink.set_nonblocking(true).unwrap();
    let fixture=server(|_|{let mut reply=Reply::json(json!({}));reply.status=302;reply.headers.push(("Location".into(),format!("http://{}/collect",sink.local_addr().unwrap())));vec![reply]});
    let state=state(config(&fixture.origin));assert!(dispatch(&state,RpcMethod::QiniuShareLogin,input(&fixture.origin)).await.is_err());assert!(sink.accept().is_err());assert_eq!(fixture.requests.lock().unwrap().len(),1);
})}

#[test]
fn profile_edit_or_lock_during_private_verify_rejects_the_late_session() {runtime().block_on(async {
    for change_profile in [false,true] {
        let fixture=server(|origin|{let mut reply=verification(origin);reply.delay_ms=150;vec![reply]});let state=state(config(&fixture.origin));
        let operation=dispatch(&state,RpcMethod::QiniuShareLogin,input(&fixture.origin));
        let invalidate=async {wait_for_request(&fixture.requests).await;let mut vault=state.vault.lock().unwrap();if change_profile{vault.data.as_mut().unwrap().profiles[0].updated_at="revision-2".into();storage_backend::invalidate(&state,"private-env");}else{lock_vault_runtime(&mut vault);storage_backend::clear(&state);}};
        let(result,_)=futures_util::future::join(operation,invalidate).await;assert!(result.unwrap_err().contains("closed"));
        assert!(login_environment(&state,Some("private-env"),Some("revision-1")).is_err());
    }
})}

#[test]
fn private_share_service_errors_preserve_forbidden_unsupported_and_network_states() {runtime().block_on(async {
    for(status,expected)in[(403,"permission-denied"),(404,"unsupported-api"),(501,"unsupported-api")] {
        let fixture=server(|_|{let mut reply=Reply::json(json!({"error":"fixture-private-secret"}));reply.status=status;vec![reply]});let state=state(config(&fixture.origin));
        let error=dispatch(&state,RpcMethod::QiniuShareLogin,input(&fixture.origin)).await.unwrap_err();assert!(error.contains(expected),"{error}");assert!(!error.contains("fixture-private-secret"));
    }
    let fixture=server(|_|vec![]);let origin=fixture.origin.clone();drop(fixture);let state=state(config(&origin));
    let error=dispatch(&state,RpcMethod::QiniuShareLogin,input(&origin)).await.unwrap_err();assert!(error.contains("share-network"));
})}
