use super::*;
use crate::qiniu::{QiniuMode,QiniuManualRegion};
use std::{io::{Read,Write},net::{TcpListener,TcpStream},thread,time::{Instant,SystemTime,UNIX_EPOCH}};

struct Response{status:u16,body:Vec<u8>,headers:Vec<(String,String)>,head:bool,delay_ms:u64,hook:Option<Box<dyn FnOnce()+Send>>}
impl Response{
    fn json(body:String)->Self{Self{status:200,body:body.into_bytes(),headers:vec![("Content-Type".into(),"application/json".into())],head:false,delay_ms:0,hook:None}}
    fn xml(body:&str)->Self{Self{status:200,body:body.as_bytes().to_vec(),headers:vec![("Content-Type".into(),"application/xml".into())],head:false,delay_ms:0,hook:None}}
    fn object(data:&[u8],head:bool)->Self{Self{status:200,body:if head{vec![]}else{data.to_vec()},headers:vec![("Content-Length".into(),data.len().to_string()),("ETag".into(),"\"object-etag\"".into()),("Last-Modified".into(),"Sun, 01 Nov 2026 00:00:00 GMT".into())],head,delay_ms:0,hook:None}}
}
struct Server{origin:String,requests:Arc<Mutex<Vec<String>>>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server{fn drop(&mut self){if let Some(worker)=self.worker.take(){worker.join().unwrap();}}}
fn server(make:impl FnOnce(&str)->Vec<Response>)->Server{
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
    let origin=format!("http://{}",listener.local_addr().unwrap());let responses=make(&origin);
    let requests=Arc::new(Mutex::new(vec![]));let captured=requests.clone();
    let worker=thread::spawn(move||{for mut response in responses{
        let deadline=Instant::now()+Duration::from_secs(4);
        let (mut socket,bytes)=loop{
            let mut socket:TcpStream=loop{match listener.accept(){Ok((s,_))=>break s,Err(e)if e.kind()==std::io::ErrorKind::WouldBlock&&Instant::now()<deadline=>thread::sleep(Duration::from_millis(2)),_=>return}};
            socket.set_nonblocking(false).unwrap();socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();let mut bytes=vec![];let mut buffer=[0u8;8192];
            loop{let n=socket.read(&mut buffer).unwrap_or(0);if n==0{break}bytes.extend_from_slice(&buffer[..n]);if let Some(split)=bytes.windows(4).position(|v|v==b"\r\n\r\n"){
                let headers=String::from_utf8_lossy(&bytes[..split]);let length=headers.lines().find_map(|line|{let(name,value)=line.split_once(':')?;name.eq_ignore_ascii_case("content-length").then(||value.trim().parse::<usize>().ok()).flatten()}).unwrap_or(0);if bytes.len()>=split+4+length{break}
            }}
            if bytes.is_empty(){if Instant::now()>=deadline{return}continue}break(socket,bytes)
        };
        captured.lock().unwrap().push(String::from_utf8(bytes).unwrap());if let Some(hook)=response.hook.take(){hook()}
        if response.delay_ms>0{thread::sleep(Duration::from_millis(response.delay_ms))}
        let length=response.headers.iter().find(|(key,_)|key.eq_ignore_ascii_case("content-length")).map(|(_,value)|value.clone()).unwrap_or_else(||response.body.len().to_string());
        let headers=response.headers.iter().filter(|(key,_)|!key.eq_ignore_ascii_case("content-length")).map(|(key,value)|format!("{key}: {value}\r\n")).collect::<String>();
        let wire=format!("HTTP/1.1 {} Fixture\r\nContent-Length: {length}\r\nConnection: close\r\n{headers}\r\n",response.status);
        let _=socket.write_all(wire.as_bytes());if !response.head{let _=socket.write_all(&response.body);}let _=socket.shutdown(std::net::Shutdown::Write);
    }});
    Server{origin,requests,worker:Some(worker)}
}
fn runtime()->tokio::runtime::Runtime{tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()}
fn config(origin:&str)->QiniuConfig{QiniuConfig{mode:QiniuMode::Private,uc_url:Some(origin.into()),share_portal:Some(origin.into()),share_api_url:Some(origin.into()),regions:vec![QiniuManualRegion{id:"private-region".into(),label:None,s3_endpoint:origin.into()}],..Default::default()}}
fn verification(origin:&str,prefix:&str,ttl:i64)->Response{
    Response::json(serde_json::json!({"endpoint":origin,"region":"private-region","bucket_name":"native-name","bucket_id":"s3-alias","prefix":prefix,"federated_ak":"temporary-ak","federated_sk":"temporary-secret","session_token":"temporary-token","permission":"READWRITE","expires":chrono::DateTime::<Utc>::from_timestamp(Utc::now().timestamp()+ttl,0).unwrap().to_rfc3339()}).to_string())
}
async fn login(rt:&ShareRuntime,server:&Server)->SessionInfo{
    rt.login(rt.begin_operation().unwrap(),config(&server.origin),&format!("{}/kodo-shares/verify?id=fixture&token=link-secret",server.origin),"Ab12Cd").await.unwrap()
}
fn tempdir()->PathBuf{let path=std::env::temp_dir().join(format!("yuncang-share-test-{}-{}",SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),uuid::Uuid::new_v4()));fs::create_dir(&path).unwrap();path}
fn listing(extra:&str)->Response{Response::xml(&format!("<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>s3-alias</Name>{extra}</ListBucketResult>"))}

#[test]fn audit_share_listing_preserves_empty_directory_segments(){runtime().block_on(async{
    let data=b"literal child";
    let fixture=server(|origin|vec![verification(origin,"shared/",3600),
        listing("<IsTruncated>false</IsTruncated><Contents><Key>shared/visible.txt</Key><Size>5</Size></Contents><CommonPrefixes><Prefix>shared//</Prefix></CommonPrefixes>"),
        listing("<IsTruncated>false</IsTruncated><Contents><Key>shared//中文+%?#.txt</Key><Size>13</Size></Contents>"),
        Response::object(data,true),Response::object(data,false),Response::object(data,true)]);
    let rt=ShareRuntime::default();let info=login(&rt,&fixture).await;
    let page=rt.list(&info.session_id,"shared/",None).await.expect("A literal empty path segment must not make the whole directory unreadable");
    assert_eq!(page.prefixes,vec!["shared//"]);assert_eq!(page.objects[0].key,"shared/visible.txt");
    let child=rt.list(&info.session_id,"shared//",None).await.unwrap();assert_eq!(child.objects[0].key,"shared//中文+%?#.txt");
    let dir=tempdir();let target=dir.join("literal.txt");let result=rt.download(&info.session_id,&child.objects[0].key,&target).await.unwrap();
    assert_eq!(result.bytes,data.len()as i64);assert_eq!(fs::read(&target).unwrap(),data);
    let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),6);assert!(requests[4].starts_with("GET /s3-alias/shared//"),"The literal empty segment was changed in the download request");drop(requests);
    fs::remove_file(target).unwrap();fs::remove_dir(dir).unwrap();
})}

#[test]fn login_keeps_temporary_credentials_and_server_alias_out_of_frontend_dto(){runtime().block_on(async{
    let server=server(|origin|vec![verification(origin,"shared/",3600)]);let rt=ShareRuntime::default();let info=login(&rt,&server).await;
    let json=serde_json::to_value(&info).unwrap();assert_eq!(json.as_object().unwrap().len(),5);assert_eq!(json["bucketName"],"native-name");assert_eq!(json["readOnly"],true);
    for secret in ["temporary-ak","temporary-secret","temporary-token","s3-alias","federated_sk","sessionToken"]{assert!(!json.to_string().contains(secret));}
    assert_eq!(rt.info(&info.session_id).unwrap().prefix,"shared/");
    let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),1);assert!(!requests[0].to_ascii_lowercase().contains("authorization:"));
})}

#[test]fn lock_invalidates_pending_verification_and_cannot_publish_a_late_session(){runtime().block_on(async{
    let server=server(|origin|{let mut reply=verification(origin,"shared/",3600);reply.delay_ms=200;vec![reply]});let rt=ShareRuntime::default();
    let ticket=rt.begin_operation().unwrap();let url=format!("{}/kodo-shares/verify?id=fixture&token=link-secret",server.origin);
    let request=rt.login(ticket,config(&server.origin),&url,"Ab12Cd");let clear=async{tokio::time::sleep(Duration::from_millis(40)).await;rt.clear_all()};
    let(result,_)=futures_util::future::join(request,clear).await;assert!(result.unwrap_err().contains("closed"));assert!(rt.state.lock().unwrap().entries.is_empty());
})}

#[test]fn scopes_are_rechecked_before_network_and_closed_sessions_stay_closed(){runtime().block_on(async{
    let server=server(|origin|vec![verification(origin,"shared/",3600)]);let rt=ShareRuntime::default();let info=login(&rt,&server).await;
    for prefix in ["","shared-other/","shared/../","/shared/","shared\\secret/"]{assert!(rt.list(&info.session_id,prefix,None).await.is_err());}
    let temp=tempdir();assert!(rt.download(&info.session_id,"sibling/file",&temp.join("file")).await.is_err());rt.close(&info.session_id);
    assert!(rt.info(&info.session_id).is_err());assert!(rt.list(&info.session_id,"shared/",None).await.is_err());assert_eq!(server.requests.lock().unwrap().len(),1);fs::remove_dir(&temp).unwrap();
})}

#[test]fn pure_directory_and_empty_pages_use_opaque_scope_bound_cursors(){runtime().block_on(async{
    let server=server(|origin|vec![verification(origin,"shared/",3600),listing("<IsTruncated>true</IsTruncated><NextContinuationToken>provider-secret</NextContinuationToken><CommonPrefixes><Prefix>shared/sub/</Prefix></CommonPrefixes>"),listing("<IsTruncated>false</IsTruncated>")]);
    let rt=ShareRuntime::default();let info=login(&rt,&server).await;let first=rt.list(&info.session_id,"shared/",None).await.unwrap();
    assert!(first.objects.is_empty());assert_eq!(first.prefixes,vec!["shared/sub/"]);assert!(first.is_truncated);let cursor=first.next_cursor.unwrap();assert!(!cursor.contains("provider-secret"));
    assert!(rt.list(&info.session_id,"shared/sub/",Some(&cursor)).await.is_err());assert!(rt.list("other-session","shared/",Some(&cursor)).await.is_err());
    let second=rt.list(&info.session_id,"shared/",Some(&cursor)).await.unwrap();assert!(!second.is_truncated);assert!(second.next_cursor.is_none());assert!(rt.state.lock().unwrap().cursors.is_empty());
    let request=server.requests.lock().unwrap();let target=request[1].lines().next().unwrap().split_whitespace().nth(1).unwrap();let path=target.split('?').next().unwrap();assert!(matches!(path,"/s3-alias"|"/s3-alias/"),"Unexpected fixture bucket path: {path}");assert!(request[2].contains("continuation-token=provider-secret"));assert!(request[1].to_ascii_lowercase().contains("x-amz-security-token: temporary-token"));assert!(!request[1].contains("temporary-secret"));
})}

#[test]fn repeated_cursor_is_an_error_not_a_successful_empty_end(){runtime().block_on(async{
    let page="<IsTruncated>true</IsTruncated><NextContinuationToken>repeat-token</NextContinuationToken>";
    let server=server(|origin|vec![verification(origin,"shared/",3600),listing(page),listing(page)]);let rt=ShareRuntime::default();let info=login(&rt,&server).await;
    let first=rt.list(&info.session_id,"shared/",None).await.unwrap();let error=rt.list(&info.session_id,"shared/",first.next_cursor.as_deref()).await.unwrap_err();assert!(error.contains("repeated"));
    assert_eq!(rt.state.lock().unwrap().cursors.len(),1);
})}

#[test]fn failed_page_is_retryable_but_success_keeps_only_one_digest_chain(){runtime().block_on(async{
    let server=server(|origin|{let mut forbidden=Response::xml("<Error><Code>AccessDenied</Code></Error>");forbidden.status=403;vec![verification(origin,"shared/",3600),listing("<IsTruncated>true</IsTruncated><NextContinuationToken>first-provider-token</NextContinuationToken>"),forbidden,listing("<IsTruncated>true</IsTruncated><NextContinuationToken>second-provider-token</NextContinuationToken>")]});
    let rt=ShareRuntime::default();let info=login(&rt,&server).await;let page=rt.list(&info.session_id,"shared/",None).await.unwrap();let old=page.next_cursor.unwrap();
    assert!(rt.list(&info.session_id,"shared/",Some(&old)).await.unwrap_err().contains("forbidden"));assert!(rt.state.lock().unwrap().cursors.contains_key(&old));
    let page=rt.list(&info.session_id,"shared/",Some(&old)).await.unwrap();let new=page.next_cursor.unwrap();assert_ne!(new,old);
    let state=rt.state.lock().unwrap();assert_eq!(state.cursors.len(),1);assert!(!state.cursors.contains_key(&old));assert_eq!(state.cursors[&new].seen.len(),2);assert_eq!(std::mem::size_of_val(state.cursors[&new].seen.iter().next().unwrap()),32);drop(state);
    assert!(rt.list(&info.session_id,"shared/",Some(&old)).await.is_err());assert_eq!(server.requests.lock().unwrap().len(),4);
})}

#[test]fn malformed_out_of_scope_or_deep_listing_is_never_exposed(){runtime().block_on(async{
    for body in ["<IsTruncated>false</IsTruncated><Contents><Key>sibling/secret</Key><Size>5</Size></Contents>","<IsTruncated>false</IsTruncated><Contents><Key>shared/sub/file</Key><Size>5</Size></Contents>","<IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>shared/sub/deep/</Prefix></CommonPrefixes>",""]{
        let server=server(|origin|vec![verification(origin,"shared/",3600),listing(body)]);let rt=ShareRuntime::default();let info=login(&rt,&server).await;assert!(rt.list(&info.session_id,"shared/",None).await.is_err());
    }
})}

#[test]fn current_directory_marker_is_not_a_blank_downloadable_file(){runtime().block_on(async{
    let server=server(|origin|vec![verification(origin,"shared/",3600),listing("<IsTruncated>false</IsTruncated><Contents><Key>shared/</Key><Size>0</Size></Contents><Contents><Key>shared/中文+%.txt</Key><Size>5</Size><LastModified>2026-11-01T00:00:00Z</LastModified></Contents>")]);
    let rt=ShareRuntime::default();let info=login(&rt,&server).await;let page=rt.list(&info.session_id,"shared/",None).await.unwrap();assert_eq!(page.objects.len(),1);assert_eq!(page.objects[0].key,"shared/中文+%.txt");assert!(chrono::DateTime::parse_from_rfc3339(page.objects[0].last_modified.as_deref().unwrap()).is_ok());
})}

#[test]fn permission_expired_token_and_network_errors_are_safe_and_distinct(){runtime().block_on(async{
    for(code,status,expected)in[("AccessDenied",403,"share-storage-forbidden"),("ExpiredToken",403,"share-token-expired"),("NoSuchKey",404,"share-storage-not-found"),("NotImplemented",501,"share-storage-unsupported")]{
        let server=server(|origin|{let mut response=Response::xml(&format!("<Error><Code>{code}</Code><Message>server-secret-token</Message></Error>"));response.status=status;vec![verification(origin,"shared/",3600),response]});
        let rt=ShareRuntime::default();let info=login(&rt,&server).await;let error=rt.list(&info.session_id,"shared/",None).await.unwrap_err();assert!(error.contains(expected),"{error}");assert!(!error.contains("server-secret-token"));
    }
    let server=server(|origin|vec![verification(origin,"shared/",3600)]);let rt=ShareRuntime::default();let info=login(&rt,&server).await;drop(server);let error=rt.list(&info.session_id,"shared/",None).await.unwrap_err();assert!(error.contains("share-storage-network"));
})}

#[test]fn download_uses_temporary_credentials_and_atomic_no_replace_delivery(){runtime().block_on(async{
    let data=b"hello share";let server=server(|origin|vec![verification(origin,"shared/",3600),Response::object(data,true),Response::object(data,false),Response::object(data,true)]);
    let rt=ShareRuntime::default();let info=login(&rt,&server).await;let temp=tempdir();let target=temp.join("download.txt");let result=rt.download(&info.session_id,"shared/中文+%?#.txt",&target).await.unwrap();
    assert_eq!(result.bytes,data.len()as i64);assert_eq!(fs::read(&target).unwrap(),data);assert_eq!(fs::read_dir(&temp).unwrap().count(),1);
    let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),4);assert!(requests[2].to_ascii_lowercase().contains("if-match: \"object-etag\""));assert!(requests[2].contains("/s3-alias/shared/"));assert!(!requests[2].contains("temporary-secret"));drop(requests);
    fs::remove_file(&target).unwrap();fs::remove_dir(&temp).unwrap();
})}

#[test]fn preexisting_target_is_preserved_without_a_storage_request(){runtime().block_on(async{
    let server=server(|origin|vec![verification(origin,"shared/",3600)]);let rt=ShareRuntime::default();let info=login(&rt,&server).await;let temp=tempdir();let target=temp.join("existing");fs::write(&target,b"user original").unwrap();
    assert!(rt.download(&info.session_id,"shared/file",&target).await.unwrap_err().contains("already exists"));assert_eq!(fs::read(&target).unwrap(),b"user original");assert_eq!(server.requests.lock().unwrap().len(),1);fs::remove_file(target).unwrap();fs::remove_dir(temp).unwrap();
})}

#[test]fn closing_a_session_during_download_prevents_local_delivery(){runtime().block_on(async{
    let data=b"hello share";let server=server(|origin|{let mut get=Response::object(data,false);get.delay_ms=250;vec![verification(origin,"shared/",3600),Response::object(data,true),get]});
    let rt=ShareRuntime::default();let info=login(&rt,&server).await;let temp=tempdir();let target=temp.join("download");
    let operation=rt.download(&info.session_id,"shared/file",&target);let close=async{tokio::time::sleep(Duration::from_millis(70)).await;rt.close(&info.session_id)};
    let(result,_)=futures_util::future::join(operation,close).await;assert!(result.is_err());assert!(!target.exists());assert_eq!(fs::read_dir(&temp).unwrap().count(),0);fs::remove_dir(temp).unwrap();
})}

#[test]fn a_concurrently_created_target_survives_commit_failure(){runtime().block_on(async{
    let data=b"hello share";let temp=tempdir();let target=temp.join("download");let concurrent=target.clone();
    let server=server(move|origin|{let mut last=Response::object(data,true);last.hook=Some(Box::new(move||{fs::write(concurrent,b"concurrent user file").unwrap()}));vec![verification(origin,"shared/",3600),Response::object(data,true),Response::object(data,false),last]});
    let rt=ShareRuntime::default();let info=login(&rt,&server).await;assert!(rt.download(&info.session_id,"shared/file",&target).await.is_err());assert_eq!(fs::read(&target).unwrap(),b"concurrent user file");assert_eq!(fs::read_dir(&temp).unwrap().count(),1);fs::remove_file(target).unwrap();fs::remove_dir(temp).unwrap();
})}

#[test]fn changed_remote_identity_never_delivers_or_leaves_an_owned_partial(){runtime().block_on(async{
    let data=b"hello share";let server=server(|origin|{let mut last=Response::object(data,true);last.headers.retain(|(name,_)|name!="ETag");last.headers.push(("ETag".into(),"\"changed\"".into()));vec![verification(origin,"shared/",3600),Response::object(data,true),Response::object(data,false),last]});
    let rt=ShareRuntime::default();let info=login(&rt,&server).await;let temp=tempdir();let target=temp.join("download");assert!(rt.download(&info.session_id,"shared/file",&target).await.unwrap_err().contains("changed"));assert!(!target.exists());assert_eq!(fs::read_dir(&temp).unwrap().count(),0);fs::remove_dir(temp).unwrap();
})}

#[test]fn expiry_removes_session_and_temporary_credentials_without_another_read(){runtime().block_on(async{
    let server=server(|origin|vec![verification(origin,"shared/",2)]);let rt=ShareRuntime::default();let info=login(&rt,&server).await;tokio::time::sleep(Duration::from_millis(2200)).await;
    assert!(rt.state.lock().unwrap().entries.is_empty());assert!(rt.info(&info.session_id).is_err());assert!(rt.sessions.with_session(&info.session_id,"native-name","shared/",ShareOperation::List,Utc::now().timestamp(),|_|()).is_err());
})}

#[test]fn creating_a_share_returns_only_a_readonly_link_and_random_six_character_code(){runtime().block_on(async{
    let server=server(|_|vec![Response::json(serde_json::json!({"id":"fixture","token":"new-share-token","expires":chrono::DateTime::<Utc>::from_timestamp(Utc::now().timestamp()+3600,0).unwrap().to_rfc3339()}).to_string())]);
    let rt=ShareRuntime::default();let result=rt.create_share(rt.begin_operation().unwrap(),config(&server.origin),"native-name","shared/",3600,"owner-ak","owner-sk").await.unwrap();
    let json=serde_json::to_value(&result).unwrap();assert_eq!(json.as_object().unwrap().len(),6);assert_eq!(result.extraction_code.len(),6);assert!(result.read_only);assert_eq!(result.prefix,"shared/");assert!(!format!("{result:?}").contains("new-share-token"));
    let request=server.requests.lock().unwrap();assert!(request[0].contains("\"permission\":\"READONLY\""));assert!(!request[0].contains("owner-sk"));
})}
