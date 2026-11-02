//! Real HTTP contract tests against an ephemeral loopback server. No cloud
//! accounts or external network connections are used by these tests.
use super::*;
use serde_json::{json,Value};
use std::{io::{Read,Write},net::TcpListener,sync::{Arc,Mutex,atomic::AtomicBool},thread,time::{Duration,Instant}};

struct Response {status:u16,body:Vec<u8>,headers:Vec<(String,String)>}
impl Response {fn json(value:Value)->Self{Self{status:200,body:serde_json::to_vec(&value).unwrap(),headers:vec![("Content-Type".into(),"application/json".into())]}}}
struct Server {origin:String,requests:Arc<Mutex<Vec<Vec<u8>>>>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server{fn drop(&mut self){if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn server(responses:Vec<Response>)->Server {
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
    let origin=format!("http://{}",listener.local_addr().unwrap());let requests=Arc::new(Mutex::new(vec![]));let captures=requests.clone();
    let worker=thread::spawn(move||{
        for response in responses {
            let deadline=Instant::now()+Duration::from_secs(8);
            let (mut connection,request)=loop {
            let mut connection=loop{match listener.accept(){Ok((connection,_))=>break connection,Err(error)if error.kind()==std::io::ErrorKind::WouldBlock&&Instant::now()<deadline=>thread::sleep(Duration::from_millis(5)),_=>return}};
            // Windows accepted sockets inherit the listener's nonblocking
            // mode; read_timeout alone does not restore blocking reads.
            connection.set_nonblocking(false).unwrap();
            connection.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
            let mut request=Vec::new();let mut chunk=[0u8;8192];
            loop{
                let size=match connection.read(&mut chunk){Ok(size)if size>0=>size,_=>break};request.extend_from_slice(&chunk[..size]);
                if let Some(split)=request.windows(4).position(|bytes|bytes==b"\r\n\r\n"){
                    let text=String::from_utf8_lossy(&request[..split]);
                    let length=text.lines().find_map(|line|{let(name,value)=line.split_once(':')?;if name.eq_ignore_ascii_case("content-length"){value.trim().parse::<usize>().ok()}else{None}}).unwrap_or(0);
                    if request.len()>=split+4+length{break}
                }
                assert!(request.len()<=6*1024*1024,"mock request unexpectedly large");
            }
            // TCP clients may open then abandon a speculative connection. An
            // empty connection is not an HTTP request and consumes no fixture.
            if request.is_empty(){if Instant::now()>=deadline{return;}continue;}
            break (connection,request);
            };
            captures.lock().unwrap().push(request);
            let mut headers=format!("HTTP/1.0 {} Mock\r\nContent-Length: {}\r\nConnection: close\r\n",response.status,response.body.len());
            for(name,value)in response.headers {headers.push_str(&format!("{name}: {value}\r\n"));}headers.push_str("\r\n");
            let mut wire=headers.into_bytes();wire.extend_from_slice(&response.body);
            connection.write_all(&wire).unwrap();
            // A graceful half-close avoids Windows emitting a TCP reset while
            // the client is consuming a small error or download response.
            let _=connection.shutdown(std::net::Shutdown::Write);
            connection.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
            let mut remaining=[0u8;1024];while matches!(connection.read(&mut remaining),Ok(size) if size>0){}
        }
    });Server{origin,requests,worker:Some(worker)}
}
fn runtime()->&'static tokio::runtime::Runtime{
    static RUNTIME:std::sync::OnceLock<tokio::runtime::Runtime>=std::sync::OnceLock::new();
    RUNTIME.get_or_init(||tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap())
}
fn client(server:&Server,download:bool)->QiniuClient{
    let _runtime=runtime().enter();
    let mut client=QiniuClient::new(QiniuConfig{mode:QiniuMode::Private,uc_url:Some(server.origin.clone()),download_domain:download.then(||server.origin.clone()),..Default::default()},QiniuCredentials::new("mock-ak".into(),"mock-secret".into(),None).unwrap()).unwrap();
    // The fixture is deliberately a single-request HTTP/1 server, not a proxy
    // or keep-alive implementation. Test only the protocol being asserted.
    client.http=reqwest::Client::builder().no_proxy().http1_only().pool_max_idle_per_host(0).redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(5)).build().unwrap();
    client
}
fn region(origin:&str,id:&str)->Value{let host=origin.trim_start_matches("http://");json!({"region":id,"ttl":60,"up":{"domains":[host]},"uc":{"domains":[host]},"rs":{"domains":[host]},"rsf":{"domains":[host]},"s3":{"region_alias":format!("s3-{id}"),"domains":[host]},"extra":{"file_types":[{"file_type":0,"storage_class":"standard","s3_storage_class":"STANDARD"}]}})}
fn context(server:&Server)->ResolvedBucketContext{
    ResolvedBucketContext{bucket:QiniuBucket{name:"native-name".into(),s3_name:Some("s3-alias".into()),kodo_region_id:Some("z0".into()),created_at:None,permission:None,remark:None},region:QiniuRegion::from_response(&region(&server.origin,"z0"),"http",chrono::Utc::now().timestamp()).unwrap(),s3_bucket_name:Some("s3-alias".into()),backend_mode:"kodo".into()}
}

#[test]fn signed_http_discovery_preserves_alias_and_separates_permission_states(){
    let fixture=server(vec![Response::json(json!([{"tbl":"native-name","id":"s3-alias","region":"z0","perm":1}]))]);let client=client(&fixture,false);
    let buckets=runtime().block_on(client.list_buckets()).unwrap();assert_eq!(buckets[0].name,"native-name");assert_eq!(buckets[0].s3_name.as_deref(),Some("s3-alias"));
    let captures=fixture.requests.lock().unwrap();let request=String::from_utf8_lossy(&captures[0]);assert!(request.starts_with("GET /v2/buckets?shared=rd HTTP/1.1"));assert!(request.to_ascii_lowercase().contains("authorization: qiniu mock-ak:"));assert!(!request.contains("mock-secret"));
}
#[test]fn request_status_does_not_turn_denied_or_missing_api_into_success(){
    for(status,expected)in[(403,CapabilityState::Forbidden),(404,CapabilityState::Unsupported),(500,CapabilityState::Unavailable)]{
        let fixture=server(vec![Response{status,body:br#"{"error":"secret-server-detail"}"#.to_vec(),headers:vec![]}]);let error=runtime().block_on(client(&fixture,false).list_buckets()).unwrap_err();assert_eq!(error.state,expected);assert!(!format!("{error:?}").contains("secret-server-detail"));
    }
}
#[test]fn redirect_is_not_followed_with_credentials(){
    let sink=TcpListener::bind("127.0.0.1:0").unwrap();sink.set_nonblocking(true).unwrap();
    let fixture=server(vec![Response{status:302,body:vec![],headers:vec![("Location".into(),format!("http://{}/steal",sink.local_addr().unwrap()))]}]);
    let error=runtime().block_on(client(&fixture,false).list_buckets()).unwrap_err();assert_eq!(error.status,Some(302));assert!(sink.accept().is_err());
}
#[test]fn origin_certificate_lookup_uses_the_configured_uc_service(){
    let fixture=server(vec![Response::json(json!([{"domain":"files.example"}]))]);
    let result=runtime().block_on(client(&fixture,false).certificate_bindings()).unwrap();
    assert_eq!(result,json!([{"domain":"files.example"}]));
    let captures=fixture.requests.lock().unwrap();assert_eq!(captures.len(),1);
    let request=String::from_utf8_lossy(&captures[0]);assert!(request.starts_with("GET /cert/bindings HTTP/1.1"));
    assert!(request.to_ascii_lowercase().contains("authorization: qiniu mock-ak:"));
}
#[test]fn server_upload_response_is_verified_against_local_content(){
    let fixture=server(vec![Response::json(json!({"key":"中文/+%?#.txt","hash":"Fqr0xh3cxeii2r7eDztILNmuqUNN"}))]);let client=client(&fixture,false);let context=context(&fixture);
    let file=std::env::temp_dir().join(format!("qiniu-upload-{}",uuid::Uuid::new_v4().simple()));std::fs::write(&file,b"hello").unwrap();let mut progress=vec![];
    let result=runtime().block_on(client.upload_file(&context,"中文/+%?#.txt",&file,false,Some(0),&AtomicBool::new(false),|done,total|progress.push((done,total))));std::fs::remove_file(&file).unwrap();assert_eq!(result.unwrap(),5);assert_eq!(progress,vec![(0,5),(5,5)]);
    let captures=fixture.requests.lock().unwrap();let request=String::from_utf8_lossy(&captures[0]);assert!(request.starts_with("POST / HTTP/1.1"));assert!(request.contains("name=\"token\""));assert!(request.contains("hello"));assert!(!request.contains("mock-secret"));
}
#[test]fn failed_download_integrity_preserves_original_and_cleans_partial(){
    let fixture=server(vec![Response::json(json!({"fsize":5,"hash":"Fqr0xh3cxeii2r7eDztILNmuqUNN","putTime":17000000000000000i64,"type":0})),Response{status:200,body:b"WRONG".to_vec(),headers:vec![]}]);let client=client(&fixture,true);let context=context(&fixture);
    let dir=std::env::temp_dir().join(format!("qiniu-download-{}",uuid::Uuid::new_v4().simple()));std::fs::create_dir(&dir).unwrap();let file=dir.join("destination");std::fs::write(&file,b"original").unwrap();
    let error=runtime().block_on(client.download_file(&context,"folder/中文.txt",&file,true,&AtomicBool::new(false),|_,_|{})).unwrap_err();assert_eq!(error.code,"integrity-mismatch");assert_eq!(std::fs::read(&file).unwrap(),b"original");assert_eq!(std::fs::read_dir(&dir).unwrap().count(),1);std::fs::remove_file(file).unwrap();std::fs::remove_dir(dir).unwrap();
}
#[test]fn verified_download_uses_token_last_and_atomically_creates_target(){
    let fixture=server(vec![Response::json(json!({"fsize":5,"hash":"Fqr0xh3cxeii2r7eDztILNmuqUNN","putTime":17000000000000000i64,"type":0})),Response{status:200,body:b"hello".to_vec(),headers:vec![]}]);let client=client(&fixture,true);let context=context(&fixture);
    let dir=std::env::temp_dir().join(format!("qiniu-success-{}",uuid::Uuid::new_v4().simple()));std::fs::create_dir(&dir).unwrap();let file=dir.join("destination");
    assert_eq!(runtime().block_on(client.download_file(&context,"folder/中文+%?#.txt",&file,false,&AtomicBool::new(false),|_,_|{})).unwrap(),5);assert_eq!(std::fs::read(&file).unwrap(),b"hello");
    let captures=fixture.requests.lock().unwrap();let request=String::from_utf8_lossy(&captures[1]);let first=request.lines().next().unwrap();assert!(first.contains("%E4%B8%AD%E6%96%87"));assert!(first.contains("&token=mock-ak:"));assert!(!first.contains("mock-secret"));assert!(request.to_ascii_lowercase().contains("if-match:"));std::fs::remove_file(file).unwrap();std::fs::remove_dir(dir).unwrap();
}
#[test]fn bucket_creation_is_ready_only_after_private_readback(){
    let fixture=server(vec![Response::json(json!({"regions":[{"id":"z0","ttl":60,"s3":{"region_alias":"cn-east-1","domains":[]}}]})),Response::json(Value::Null),Response::json(Value::Null),Response::json(json!({"private":1,"protected":0}))]);
    let result=runtime().block_on(client(&fixture,false).create_private_bucket("new-bucket","cn-east-1")).unwrap();assert!(result.private_verified);
    let captures=fixture.requests.lock().unwrap();assert_eq!(captures.len(),4);let lines=captures.iter().map(|bytes|String::from_utf8_lossy(bytes).lines().next().unwrap().to_string()).collect::<Vec<_>>();
    assert!(lines[0].starts_with("GET /regions "));assert!(lines[1].starts_with("POST /mkbucketv3/new-bucket/region/z0 "));assert!(lines[2].contains("/private?bucket=new-bucket&private=1"));assert!(lines[3].contains("/v2/bucketInfo?bucket=new-bucket"));
}
#[test]fn failed_private_readback_is_not_reported_as_created_success(){
    let fixture=server(vec![Response::json(json!({"regions":[{"id":"z0","ttl":60,"s3":{"region_alias":"cn-east-1","domains":[]}}]})),Response::json(Value::Null),Response::json(Value::Null),Response::json(json!({"private":0}))]);
    let error=runtime().block_on(client(&fixture,false).create_private_bucket("new-bucket","cn-east-1")).unwrap_err();assert_eq!(error.code,"created-privacy-unverified");
}
#[test]fn deleting_nonempty_bucket_never_sends_drop(){
    let fixture=server(vec![Response::json(json!({"items":[{"key":"keep","fsize":0,"hash":"native"}]}))]);let context=context(&fixture);
    assert!(runtime().block_on(client(&fixture,false).delete_empty_bucket(&context)).is_err());let captures=fixture.requests.lock().unwrap();assert_eq!(captures.len(),1);assert!(String::from_utf8_lossy(&captures[0]).starts_with("GET /list?"),"mock request line: {:?}",String::from_utf8_lossy(&captures[0]).lines().next());
}
#[test]fn oversize_upload_and_cancel_are_local_preflight_failures(){
    let fixture=server(vec![]);let context=context(&fixture);let client=client(&fixture,false);let file=std::env::temp_dir().join(format!("qiniu-oversize-{}",uuid::Uuid::new_v4().simple()));let source=std::fs::File::create(&file).unwrap();source.set_len(super::transfer::FORM_UPLOAD_LIMIT+1).unwrap();drop(source);
    let error=runtime().block_on(client.upload_file(&context,"large",&file,false,None,&AtomicBool::new(false),|_,_|{})).unwrap_err();assert_eq!(error.state,CapabilityState::Unsupported);
    let error=runtime().block_on(client.upload_file(&context,"cancelled",&file,false,None,&AtomicBool::new(true),|_,_|{})).unwrap_err();assert_eq!(error.code,"cancelled");std::fs::remove_file(file).unwrap();assert!(fixture.requests.lock().unwrap().is_empty());
}
#[test]fn empty_directory_marker_is_uploaded_without_local_source_files(){
    let fixture=server(vec![Response::json(json!({"key":"中文目录/","hash":"Fto5o-5ea0sNMlW_75VgGJCv2AcJ"}))]);let context=context(&fixture);
    runtime().block_on(client(&fixture,false).upload_empty_marker(&context,"中文目录/",&AtomicBool::new(false))).unwrap();
    let captures=fixture.requests.lock().unwrap();let request=String::from_utf8_lossy(&captures[0]);assert!(request.contains("中文目录/"));assert!(request.contains("name=\"file\""));assert!(!request.contains("mock-secret"));assert!(!request.contains("D:\\"));
}
#[test]fn selected_configured_domain_is_rechecked_and_used_for_native_download(){
    let fixture=server(vec![
        Response::json(json!({"private":1})),Response::json(json!([])),
        Response::json(json!({"fsize":5,"hash":"Fqr0xh3cxeii2r7eDztILNmuqUNN","putTime":17000000000000000i64,"type":0})),
        Response{status:200,body:b"hello".to_vec(),headers:vec![]},
    ]);
    let client=client(&fixture,true);let context=context(&fixture);
    let root=std::env::temp_dir().join(format!("qiniu-selected-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&root).unwrap();let path=root.join("file");
    let result=runtime().block_on(async {
        let domain=crate::qiniu_download::resolve_domain(&client,&context,Some(&fixture.origin)).await.unwrap();
        let selected=client.for_validated_download_domain(&domain).unwrap();
        assert_eq!(client.config().download_domain.as_deref(),Some(fixture.origin.as_str()));
        let url=endpoint::object_url(&domain,"nested/中文.txt",true).unwrap();
        let ttl=crate::qiniu_download::validate_share_ttl(8*86400,crate::qiniu_download::ShareProtocol::QiniuNative).unwrap();
        let signed=selected.signed_download_url(&url,chrono::Utc::now().timestamp()+ttl).unwrap();
        assert_eq!(signed.origin(),url.origin());assert!(signed.query().unwrap().contains("token=mock-ak:"));
        selected.download_file(&context,"nested/中文.txt",&path,false,&AtomicBool::new(false),|_,_|{}).await
    });
    assert_eq!(result.unwrap(),5);assert_eq!(std::fs::read(&path).unwrap(),b"hello");
    let captures=fixture.requests.lock().unwrap();assert_eq!(captures.len(),4);
    assert!(String::from_utf8_lossy(&captures[3]).starts_with("GET /nested/%E4%B8%AD%E6%96%87.txt?"));
    std::fs::remove_file(path).unwrap();std::fs::remove_dir(root).unwrap();
}
#[test]fn unlisted_download_origin_is_rejected_without_contacting_it(){
    let sink=TcpListener::bind("127.0.0.1:0").unwrap();sink.set_nonblocking(true).unwrap();
    let unknown=format!("http://{}",sink.local_addr().unwrap());
    let fixture=server(vec![Response::json(json!({"private":1})),Response::json(json!([]))]);
    let client=client(&fixture,true);let context=context(&fixture);
    assert!(runtime().block_on(crate::qiniu_download::resolve_domain(&client,&context,Some(&unknown))).is_err());
    assert!(sink.accept().is_err());assert_eq!(fixture.requests.lock().unwrap().len(),2);
}
#[test]fn discovered_http_kodo_domain_is_explicit_and_does_not_gain_management_trust(){
    let sink=TcpListener::bind("127.0.0.1:0").unwrap();sink.set_nonblocking(true).unwrap();
    let name=sink.local_addr().unwrap().to_string();let origin=format!("http://{name}");
    let fixture=server(vec![Response::json(json!({"private":0,"protected":0})),Response::json(json!([{"domain":name,"protocol":"http","api_scope":0}]))]);
    let client=client(&fixture,false);let context=context(&fixture);
    let option=runtime().block_on(crate::qiniu_download::resolve_download_option(&client,&context,Some(&origin))).unwrap();
    assert!(option.available);assert_eq!(option.url,origin);assert_eq!(option.access_mode,Some(crate::qiniu_download::DownloadAccessMode::Public));assert!(option.reason.as_deref().unwrap().contains("HTTP"));
    let selected=client.for_validated_download_domain(&origin).unwrap();assert!(client.config().download_domain.is_none());
    assert!(selected.validate_s3_endpoint(&origin).is_err());
    let result=crate::qiniu_download::share_link_result(&selected,&option,"folder/中文 +%?#.txt",chrono::Utc::now()+chrono::Duration::hours(1)).unwrap();
    assert!(result["expiresAt"].is_null());assert_eq!(result["accessMode"],"public");assert!(!result["url"].as_str().unwrap().contains("token="));
    assert!(runtime().block_on(selected.management_json(reqwest::Method::GET,&origin,"forbidden",&[],None)).is_err());
    assert!(sink.accept().is_err());assert_eq!(fixture.requests.lock().unwrap().len(),2);
}
#[test]fn missing_protected_metadata_never_promotes_a_domain_to_public_access(){
    let fixture=server(vec![Response::json(json!({"private":0})),Response::json(json!([{"domain":"download.example","protocol":"https","api_scope":0}]))]);
    let client=client(&fixture,false);let context=context(&fixture);
    let options=runtime().block_on(crate::qiniu_download::download_options(&client,&context)).unwrap();
    assert_eq!(options.domains.len(),1);assert!(options.domains[0].available);
    assert_eq!(options.domains[0].access_mode,Some(crate::qiniu_download::DownloadAccessMode::Signed));
    assert_eq!(fixture.requests.lock().unwrap().len(),2);
}
