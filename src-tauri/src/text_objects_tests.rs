//! Real AWS SDK calls against loopback fixtures only. No user credentials.
use super::*;
use std::{io::{Read,Write},net::TcpListener,thread,time::Duration};

struct Reply {status:u16,headers:Vec<(String,String)>,body:Vec<u8>}
struct Server {origin:String,requests:Arc<Mutex<Vec<Vec<u8>>>>,stop:Arc<AtomicBool>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server {fn drop(&mut self){self.stop.store(true,Ordering::SeqCst);if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn server(mut reply:impl FnMut(&[u8])->Reply+Send+'static)->Server {
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
    let origin=format!("http://{}",listener.local_addr().unwrap());let requests=Arc::new(Mutex::new(Vec::new()));let captured=requests.clone();
    let stop=Arc::new(AtomicBool::new(false));let stopping=stop.clone();
    let worker=thread::spawn(move||while !stopping.load(Ordering::SeqCst){
        let mut stream=match listener.accept(){Ok((stream,_))=>stream,Err(error)if error.kind()==io::ErrorKind::WouldBlock=>{thread::sleep(Duration::from_millis(2));continue},_=>break};
        stream.set_nonblocking(false).unwrap();stream.set_read_timeout(Some(Duration::from_secs(4))).unwrap();
        let mut request=Vec::new();let mut buffer=vec![0u8;64*1024];
        loop {
            let count=match stream.read(&mut buffer){Ok(count)if count>0=>count,_=>break};request.extend_from_slice(&buffer[..count]);
            if let Some(split)=request.windows(4).position(|value|value==b"\r\n\r\n"){
                let headers=String::from_utf8_lossy(&request[..split]);
                let length=headers.lines().find_map(|line|{let(name,value)=line.split_once(':')?;name.eq_ignore_ascii_case("content-length").then(||value.trim().parse::<usize>().ok()).flatten()}).unwrap_or(0);
                if request.len()>=split+4+length{break;}
            }
            assert!(request.len()<3*1024*1024);
        }
        if request.is_empty(){continue;}
        let result=reply(&request);captured.lock().unwrap().push(request);
        let mut response=format!("HTTP/1.0 {} Fixture\r\nConnection: close\r\n",result.status).into_bytes();
        for(name,value)in result.headers{response.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());}
        response.extend_from_slice(b"\r\n");response.extend(result.body);let _=stream.write_all(&response);let _=stream.shutdown(std::net::Shutdown::Write);
    });
    Server{origin,requests,stop,worker:Some(worker)}
}
fn runtime()->&'static tokio::runtime::Runtime {
    static RUNTIME:std::sync::OnceLock<tokio::runtime::Runtime>=std::sync::OnceLock::new();
    RUNTIME.get_or_init(||tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap())
}
fn client(server:&Server)->S3Client {
    let _enter=runtime().enter();
    S3Client::from_conf(aws_sdk_s3::config::Builder::new().behavior_version_latest().region(Region::new("fixture-region"))
        .endpoint_url(&server.origin).force_path_style(true).credentials_provider(Credentials::new("fixture-ak","fixture-sk",None,None,"fixture"))
        .request_checksum_calculation(aws_sdk_s3::config::RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(aws_sdk_s3::config::ResponseChecksumValidation::WhenRequired)
        .retry_config(aws_sdk_s3::config::retry::RetryConfig::standard().with_max_attempts(1))
        .timeout_config(aws_sdk_s3::config::timeout::TimeoutConfig::builder().connect_timeout(Duration::from_secs(2)).read_timeout(Duration::from_secs(4)).build()).build())
}
fn reply(body:Vec<u8>)->Reply {Reply{status:200,headers:vec![("Content-Length".into(),body.len().to_string()),("ETag".into(),"\"version-1\"".into()),("Content-Type".into(),"text/plain; charset=utf-8".into())],body}}
fn header(request:&[u8],name:&str)->Option<String> {
    let split=request.windows(4).position(|value|value==b"\r\n\r\n").unwrap();
    String::from_utf8_lossy(&request[..split]).lines().find_map(|line|{let(key,value)=line.split_once(':')?;key.eq_ignore_ascii_case(name).then(||value.trim().to_string())})
}
fn body(request:&[u8])->&[u8] {let split=request.windows(4).position(|value|value==b"\r\n\r\n").unwrap();&request[split+4..]}

#[test]fn creates_utf8_markdown_with_atomic_absence_condition_and_encoded_key(){
    let fixture=server(|_|reply(Vec::new()));let content="# 标题\r\nhello + % ? #";
    let result=runtime().block_on(write(&client(&fixture),"bucket","目录/a+%?#.md",content,true,None)).unwrap();
    assert_eq!(result.byte_length,content.len());assert_eq!(result.etag.as_deref(),Some("\"version-1\""));
    let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),1);
    let request=&requests[0];let line=String::from_utf8_lossy(request).lines().next().unwrap().to_string();
    assert!(line.contains("%E7%9B%AE%E5%BD%95/a%2B%25%3F%23.md"),"{line}");
    assert_eq!(header(request,"if-none-match").as_deref(),Some("*"));assert!(header(request,"if-match").is_none());
    assert_eq!(header(request,"content-type").as_deref(),Some("text/markdown; charset=utf-8"));assert_eq!(body(request),content.as_bytes());
}

#[test]fn reads_empty_exact_limit_and_utf8_bom_without_loss(){
    for bytes in [Vec::new(),vec![b'x';MAX_TEXT_BYTES],"\u{feff}中文\r\n".as_bytes().to_vec()] {
        let expected=bytes.clone();let fixture=server(move |_|reply(bytes.clone()));
        let result=runtime().block_on(read(&client(&fixture),"bucket","file.txt")).unwrap();
        assert_eq!(result.content.as_bytes(),expected);assert_eq!(result.byte_length,expected.len());assert_eq!(result.etag,"\"version-1\"");
    }
}

#[test]fn bounded_read_refuses_declared_or_streamed_oversize(){
    for declared in [true,false] {
        let fixture=server(move |_|{let mut result=reply(vec![b'x';MAX_TEXT_BYTES+1]);if !declared{result.headers.retain(|(name,_)|name!="Content-Length");}result});
        assert!(runtime().block_on(read(&client(&fixture),"bucket","large.md")).is_err());
        assert_eq!(fixture.requests.lock().unwrap().len(),1);
    }
}

#[test]fn rejects_binary_non_utf8_compression_charset_or_unreliable_etag(){
    for case in ["invalid-utf8","binary","gzip","charset","weak-etag","missing-etag"] {
        let fixture=server(move |_|{
            let bytes=match case{"invalid-utf8"=>vec![0xff],"binary"=>vec![0],_=>b"plain".to_vec()};let mut result=reply(bytes);
            match case {
                "gzip"=>result.headers.push(("Content-Encoding".into(),"gzip".into())),
                "charset"=>{result.headers.retain(|(name,_)|name!="Content-Type");result.headers.push(("Content-Type".into(),"text/plain; charset=gbk".into()));}
                "weak-etag"=>{result.headers.retain(|(name,_)|name!="ETag");result.headers.push(("ETag".into(),"W/\"version-1\"".into()));}
                "missing-etag"=>result.headers.retain(|(name,_)|name!="ETag"),_=>{},
            }result
        });
        assert!(runtime().block_on(read(&client(&fixture),"bucket","notes.txt")).is_err(),"{case}");
    }
}

fn head_with_metadata()->Reply {
    Reply{status:200,headers:vec![
        ("Content-Length".into(),"5".into()),("ETag".into(),"\"version-1\"".into()),("Content-Type".into(),"text/markdown; charset=utf-8".into()),
        ("Content-Disposition".into(),"inline; filename=note.md".into()),("Content-Language".into(),"zh-CN".into()),("Cache-Control".into(),"private, max-age=60".into()),
        ("Expires".into(),"Wed, 21 Oct 2037 07:28:00 GMT".into()),("x-amz-meta-description".into(),"retained-note".into()),
    ],body:Vec::new()}
}

#[test]fn edit_preserves_metadata_and_uses_matching_conditions_on_head_and_put(){
    let fixture=server(|request|if request.starts_with(b"HEAD "){head_with_metadata()}else{let mut response=reply(Vec::new());response.headers.retain(|(name,_)|name!="ETag");response.headers.push(("ETag".into(),"\"version-2\"".into()));response});
    let result=runtime().block_on(write(&client(&fixture),"bucket","note.md","updated 中文",false,Some("\"version-1\""))).unwrap();
    assert_eq!(result.etag.as_deref(),Some("\"version-2\""));
    let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),2);
    for request in requests.iter(){assert_eq!(header(request,"if-match").as_deref(),Some("\"version-1\""));}
    let request=&requests[1];assert!(request.starts_with(b"PUT "));assert!(header(request,"if-none-match").is_none());
    assert_eq!(header(request,"content-type").as_deref(),Some("text/markdown; charset=utf-8"));
    assert_eq!(header(request,"content-disposition").as_deref(),Some("inline; filename=note.md"));
    assert_eq!(header(request,"content-language").as_deref(),Some("zh-CN"));assert_eq!(header(request,"cache-control").as_deref(),Some("private, max-age=60"));
    assert_eq!(header(request,"x-amz-meta-description").as_deref(),Some("retained-note"));assert_eq!(header(request,"expires").as_deref(),Some("Wed, 21 Oct 2037 07:28:00 GMT"));
    assert_eq!(body(request),"updated 中文".as_bytes());
}

#[test]fn get_rejects_explicit_sse_customer_encryption_without_exposing_content(){
    let fixture=server(|_|{
        let mut response=reply(b"not returned to the editor".to_vec());
        response.headers.push(("x-amz-server-side-encryption-customer-algorithm".into(),"AES256".into()));response
    });
    let error=runtime().block_on(read(&client(&fixture),"bucket","note.txt")).err().unwrap();
    assert!(error.contains("SSE-C"));assert!(!error.contains("not returned"));
    let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),1);assert!(requests[0].starts_with(b"GET "));
}

#[test]fn unsafe_head_attributes_or_unknown_size_refuse_edit_before_any_put(){
    for case in ["gzip","sse-c","bad-expires","oversized","negative-size","missing-size"] {
        let fixture=server(move|_|{
            let mut response=head_with_metadata();
            match case {
                "gzip"=>response.headers.push(("Content-Encoding".into(),"gzip".into())),
                "sse-c"=>response.headers.push(("x-amz-server-side-encryption-customer-algorithm".into(),"AES256".into())),
                "bad-expires"=>{response.headers.retain(|(name,_)|name!="Expires");response.headers.push(("Expires".into(),"not-a-cache-date".into()));}
                "oversized"=>{response.headers.retain(|(name,_)|name!="Content-Length");response.headers.push(("Content-Length".into(),(MAX_TEXT_BYTES+1).to_string()));}
                "negative-size"=>{response.headers.retain(|(name,_)|name!="Content-Length");response.headers.push(("Content-Length".into(),"-1".into()));}
                "missing-size"=>response.headers.retain(|(name,_)|name!="Content-Length"),
                _=>unreachable!(),
            }response
        });
        assert!(runtime().block_on(write(&client(&fixture),"bucket","note.txt","new text",false,Some("\"version-1\""))).is_err(),"{case}");
        let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),1,"{case}");
        assert!(requests.iter().all(|request|request.starts_with(b"HEAD ")),"{case}");
    }
}

#[test]fn editing_keeps_unknown_mime_and_storage_class_with_same_etag_preconditions(){
    let fixture=server(|request|{
        if request.starts_with(b"HEAD ") {
            let mut response=head_with_metadata();response.headers.retain(|(name,_)|name!="Content-Type");
            response.headers.push(("Content-Type".into(),"application/x-future-text; charset=utf-8".into()));
            response.headers.push(("x-amz-storage-class".into(),"FUTURE_CLASS".into()));
            response.headers.push(("Content-Encoding".into(),"identity".into()));response
        } else {reply(Vec::new())}
    });
    runtime().block_on(write(&client(&fixture),"bucket","note.md","new text",false,Some("\"version-1\""))).unwrap();
    let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),2);
    for request in requests.iter(){assert_eq!(header(request,"if-match").as_deref(),Some("\"version-1\""));}
    let put=&requests[1];assert!(put.starts_with(b"PUT "));
    assert_eq!(header(put,"content-type").as_deref(),Some("application/x-future-text; charset=utf-8"));
    assert_eq!(header(put,"x-amz-storage-class").as_deref(),Some("FUTURE_CLASS"));
    assert_eq!(header(put,"content-encoding").as_deref(),Some("identity"));
}

#[test]fn concurrent_change_or_collision_never_falls_back_to_unconditional_put(){
    for status in [409,412] {
        for creating in [true,false] {
            let fixture=server(move|request|{
                if request.starts_with(b"HEAD "){head_with_metadata()}
                else {let bytes=b"<Error><Code>PreconditionFailed</Code></Error>".to_vec();Reply{status,headers:vec![("Content-Length".into(),bytes.len().to_string()),("Content-Type".into(),"application/xml".into())],body:bytes}}
            });
            let result=runtime().block_on(write(&client(&fixture),"bucket","note.txt","content",creating,if creating{None}else{Some("\"version-1\"")}));
            assert_eq!(result.err().as_deref(),Some(CONFLICT));
            let requests=fixture.requests.lock().unwrap();let puts:Vec<_>=requests.iter().filter(|r|r.starts_with(b"PUT ")).collect();assert_eq!(puts.len(),1);
            assert_eq!(header(puts[0],if creating{"if-none-match"}else{"if-match"}).as_deref(),Some(if creating{"*"}else{"\"version-1\""}));
        }
    }
    let fixture=server(|_|{let mut response=head_with_metadata();response.headers.retain(|(name,_)|name!="ETag");response.headers.push(("ETag".into(),"\"changed\"".into()));response});
    assert_eq!(runtime().block_on(write(&client(&fixture),"bucket","note.txt","content",false,Some("\"version-1\""))).err().as_deref(),Some(CONFLICT));
    assert!(fixture.requests.lock().unwrap().iter().all(|request|request.starts_with(b"HEAD ")));
}

#[test]fn invalid_write_identity_extension_content_or_size_make_no_request(){
    let fixture=server(|_|reply(Vec::new()));
    for (key,content,create,etag) in [
        ("binary.zip","content",true,None),("note.txt/","content",true,None),("note.md","bad\0content",true,None),
        ("note.txt","content",false,None),("note.txt","content",false,Some("unquoted")),("note.txt","content",true,Some("\"old\"")),
    ] {assert!(runtime().block_on(write(&client(&fixture),"bucket",key,content,create,etag)).is_err());}
    assert!(runtime().block_on(write(&client(&fixture),"bucket","note.txt",&"x".repeat(MAX_TEXT_BYTES+1),true,None)).is_err());
    assert!(fixture.requests.lock().unwrap().is_empty());
}

fn state_profile(server:&Server,provider:S3Provider)->AppState {
    let state=AppState::default();let profile:Profile=serde_json::from_value(json!({"id":"fixture","name":"Fixture","provider":provider,"endpoint":server.origin,"accessKeyId":"fixture-ak","secretAccessKey":"fixture-sk","createdAt":"t","updatedAt":"revision-1"})).unwrap();
    {let mut vault=state.vault.lock().unwrap();vault.unlocked=true;vault.data=Some(VaultData{profiles:vec![profile],..Default::default()});}state
}
fn read_input(revision:&str)->ReadInput {ReadInput{profile_id:"fixture".into(),expected_profile_revision:revision.into(),bucket:"bucket".into(),key:"note.txt".into()}}
fn write_input(revision:&str,create_only:bool)->WriteInput {WriteInput{profile_id:"fixture".into(),expected_profile_revision:revision.into(),bucket:"bucket".into(),key:"note.txt".into(),content:"new text".into(),expected_etag:(!create_only).then(||"\"version-1\"".into()),create_only}}

#[test]fn state_guards_reject_changed_locked_removed_qiniu_and_non_r2_edits_without_requests(){
    let fixture=server(|_|reply(Vec::new()));
    let state=state_profile(&fixture,S3Provider::R2);
    for revision in ["", "old-revision"] {
        assert!(runtime().block_on(read_for_state(&state,&read_input(revision))).is_err());
        assert!(runtime().block_on(write_for_state(&state,&write_input(revision,true))).is_err());
    }
    state.vault.lock().unwrap().unlocked=false;
    assert!(runtime().block_on(read_for_state(&state,&read_input("revision-1"))).is_err());
    state.vault.lock().unwrap().unlocked=true;state.vault.lock().unwrap().data.as_mut().unwrap().profiles.clear();
    assert!(runtime().block_on(write_for_state(&state,&write_input("revision-1",true))).is_err());
    for provider in [S3Provider::Qiniu,S3Provider::Custom] {
        let state=state_profile(&fixture,provider);
        assert!(runtime().block_on(read_for_state(&state,&read_input("revision-1"))).is_err());
        assert!(runtime().block_on(write_for_state(&state,&write_input("revision-1",false))).is_err());
        if provider==S3Provider::Qiniu {assert!(runtime().block_on(write_for_state(&state,&write_input("revision-1",true))).is_err());}
    }
    assert!(fixture.requests.lock().unwrap().is_empty());
}

#[test]fn new_s3_text_may_return_no_etag_without_inventing_an_identity(){
    let fixture=server(|_|{let mut result=reply(Vec::new());result.headers.retain(|(name,_)|name!="ETag");result});
    let result=runtime().block_on(write(&client(&fixture),"bucket","empty.txt","",true,None)).unwrap();
    assert_eq!(result.byte_length,0);assert!(result.etag.is_none());
    let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),1);assert_eq!(body(&requests[0]),b"");
}

#[test]fn new_rpc_methods_and_payloads_are_typed_without_credentials(){
    assert_eq!(rpc_method::RpcMethod::parse("objects:read-text"),Some(rpc_method::RpcMethod::ObjectsReadText));
    assert_eq!(rpc_method::RpcMethod::parse("objects:write-text"),Some(rpc_method::RpcMethod::ObjectsWriteText));
    let value=json!({"profileId":"fixture","expectedProfileRevision":"revision-1","bucket":"bucket","key":"note.txt","content":"text","createOnly":true,"secretAccessKey":"forbidden"});
    assert!(serde_json::from_value::<WriteInput>(value).is_err());
}
