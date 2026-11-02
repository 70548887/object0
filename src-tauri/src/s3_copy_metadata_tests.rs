//! Loopback-only regression for temp-relay copy metadata and source identity.
use super::*;
use std::{io::{Read,Write},net::TcpListener,thread,time::Duration};

struct Reply {headers:Vec<(String,String)>,body:Vec<u8>}
struct Server {origin:String,requests:Arc<Mutex<Vec<Vec<u8>>>>,stop:Arc<AtomicBool>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server {fn drop(&mut self){self.stop.store(true,Ordering::SeqCst);if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn server(mut respond:impl FnMut(&[u8])->Reply+Send+'static)->Server {
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
    let origin=format!("http://{}",listener.local_addr().unwrap());let requests=Arc::new(Mutex::new(Vec::new()));let captures=requests.clone();
    let stop=Arc::new(AtomicBool::new(false));let stopping=stop.clone();
    let worker=thread::spawn(move||while !stopping.load(Ordering::SeqCst){
        let mut stream=match listener.accept(){Ok((stream,_))=>stream,Err(error)if error.kind()==io::ErrorKind::WouldBlock=>{thread::sleep(Duration::from_millis(3));continue},_=>break};
        stream.set_nonblocking(false).unwrap();stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut request=Vec::new();let mut buffer=vec![0u8;64*1024];
        loop {
            let count=match stream.read(&mut buffer){Ok(count)if count>0=>count,_=>break};request.extend_from_slice(&buffer[..count]);
            if let Some(split)=request.windows(4).position(|value|value==b"\r\n\r\n"){
                let headers=String::from_utf8_lossy(&request[..split]);
                let length=headers.lines().find_map(|line|{let(name,value)=line.split_once(':')?;name.eq_ignore_ascii_case("content-length").then(||value.trim().parse::<usize>().ok()).flatten()}).unwrap_or(0);
                if request.len()>=split+4+length{break;}
            }
            assert!(request.len()<20*1024*1024);
        }
        if request.is_empty(){continue;}
        let reply=respond(&request);captures.lock().unwrap().push(request);
        let mut response=b"HTTP/1.0 200 OK\r\nConnection: close\r\n".to_vec();
        for(name,value)in reply.headers{response.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());}
        response.extend_from_slice(b"\r\n");response.extend(reply.body);let _=stream.write_all(&response);let _=stream.shutdown(std::net::Shutdown::Write);
    });Server{origin,requests,stop,worker:Some(worker)}
}
fn runtime()->&'static tokio::runtime::Runtime{static RUNTIME:std::sync::OnceLock<tokio::runtime::Runtime>=std::sync::OnceLock::new();RUNTIME.get_or_init(||tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap())}
fn client(server:&Server)->S3Client {
    let _enter=runtime().enter();
    S3Client::from_conf(aws_sdk_s3::config::Builder::new().behavior_version_latest().region(Region::new("fixture-region"))
        .endpoint_url(&server.origin).force_path_style(true).credentials_provider(Credentials::new("mock-ak","mock-sk",None,None,"fixture"))
        .request_checksum_calculation(aws_sdk_s3::config::RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(aws_sdk_s3::config::ResponseChecksumValidation::WhenRequired)
        .retry_config(aws_sdk_s3::config::retry::RetryConfig::standard().with_max_attempts(1))
        .timeout_config(aws_sdk_s3::config::timeout::TimeoutConfig::builder().connect_timeout(Duration::from_secs(2)).read_timeout(Duration::from_secs(3)).build()).build())
}
fn headers(request:&[u8])->String{String::from_utf8_lossy(request).split("\r\n\r\n").next().unwrap().to_ascii_lowercase()}
fn source(size:usize,change_identity:bool,change_metadata:bool)->Server {
    let mut calls=0;
    server(move|request|{
        calls+=1;let version=if change_identity&&calls>1{"\"v2\""}else{"\"v1\""};
        let note=if change_metadata&&calls>1{"updated-note"}else{"original-note"};
        let get=request.starts_with(b"GET ");
        Reply{headers:vec![("Content-Length".into(),size.to_string()),("ETag".into(),version.into()),("Last-Modified".into(),"Tue, 14 Nov 2023 22:13:20 GMT".into()),("Content-Type".into(),"text/plain; charset=utf-8".into()),("x-amz-meta-description".into(),note.into())],body:if get{vec![b'x';size]}else{vec![]}}
    })
}
fn destination()->Server {
    server(move|request|{
        let line=String::from_utf8_lossy(request).lines().next().unwrap().to_string();
        let body=if line.starts_with("POST ")&&line.contains("uploads") {
            b"<InitiateMultipartUploadResult><Bucket>dest</Bucket><Key>copy.txt</Key><UploadId>fixture-upload</UploadId></InitiateMultipartUploadResult>".to_vec()
        }else if line.starts_with("POST ") {
            b"<CompleteMultipartUploadResult><Location>fixture</Location><Bucket>dest</Bucket><Key>copy.txt</Key><ETag>&quot;completed&quot;</ETag></CompleteMultipartUploadResult>".to_vec()
        }else{vec![]};
        Reply{headers:vec![("Content-Length".into(),body.len().to_string()),("ETag".into(),"\"part1\"".into()),("Content-Type".into(),"application/xml".into())],body}
    })
}
fn copy(source:&Server,destination:&Server)->Result<i64,String>{runtime().block_on(s3_copy_object_via_temp_file(&client(source),"source","original.txt",&client(destination),"dest","copy.txt",&AtomicBool::new(false),|_,_|{}))}

#[test]fn relay_small_copy_preserves_mime_and_user_metadata(){
    let source=source(5,false,false);let destination=destination();assert_eq!(copy(&source,&destination).unwrap(),5);
    let requests=destination.requests.lock().unwrap();let upload=requests.iter().find(|request|request.starts_with(b"PUT ")).unwrap();let headers=headers(upload);
    assert!(headers.contains("content-type: text/plain; charset=utf-8"));assert!(headers.contains("x-amz-meta-description: original-note"));
}
#[test]fn relay_multipart_copy_sets_mime_and_metadata_at_initialization(){
    let source=source(6*1024*1024,false,false);let destination=destination();assert_eq!(copy(&source,&destination).unwrap(),6*1024*1024);
    let requests=destination.requests.lock().unwrap();let init=requests.iter().find(|request|request.starts_with(b"POST ")&&headers(request).contains("uploads")).unwrap();let headers=headers(init);
    assert!(headers.contains("content-type: text/plain; charset=utf-8"));assert!(headers.contains("x-amz-meta-description: original-note"));
}
#[test]fn relay_refuses_changed_source_identity_before_writing_destination(){
    let source=source(5,true,false);let destination=destination();assert!(copy(&source,&destination).is_err());assert!(destination.requests.lock().unwrap().is_empty());
}
#[test]fn relay_refuses_changed_source_metadata_before_writing_destination(){
    let source=source(5,false,true);let destination=destination();assert!(copy(&source,&destination).is_err());assert!(destination.requests.lock().unwrap().is_empty());
}

fn profile_fixture(id:&str,name:&str,endpoint:&str,revision:&str)->Profile {
    serde_json::from_value(json!({"id":id,"name":name,"provider":"custom","endpoint":endpoint,"region":"auto","accessKeyId":"fixture-ak","secretAccessKey":"fixture-sk","createdAt":"t","updatedAt":revision})).unwrap()
}
fn queued_copy(state:&AppState,source:&Profile,dest:&Profile)->Result<i64,String> {
    let (source,dest)=confirm_transfer_profiles(state,&source.id,&source.updated_at,source.provider,&dest.id,&dest.updated_at,dest.provider)?;
    runtime().block_on(async {
        let source_client=to_s3_client(&source)?;let dest_client=to_s3_client(&dest)?;
        s3_copy_object_via_temp_file(&source_client,"source","original.txt",&dest_client,"dest","copy.txt",&AtomicBool::new(false),|_,_|{}).await
    })
}
#[test]fn queued_copy_rejects_edited_destination_before_any_request_and_keeps_old_display_snapshot(){
    let source=source(5,false,false);let before=destination();let after=destination();
    let src=profile_fixture("source-id","Source fixture",&source.origin,"source-r1");
    let original=profile_fixture("destination-id","Account A captured",&before.origin,"dest-r1");
    let replacement=profile_fixture("destination-id","Account B replacement",&after.origin,"dest-r2");
    let kind=JobTaskKind::Copy {
        source_profile_id:src.id.clone(),source_profile_revision:src.updated_at.clone(),source_provider:src.provider,
        source_bucket:"source".into(),source_key:"original.txt".into(),
        dest_profile_id:original.id.clone(),dest_profile_revision:original.updated_at.clone(),dest_provider:original.provider,
        dest_bucket:"dest".into(),dest_key:"copy.txt".into(),
    };
    let profiles=vec![src.clone(),original.clone()];let (_,snapshot)=crate::job_location::for_task(&kind,&profiles);
    let state=AppState::default();
    {let mut vault=state.vault.lock().unwrap();vault.unlocked=true;vault.data=Some(VaultData{profiles,..Default::default()});}
    state.jobs.lock().unwrap().queue.push_back(JobTask{id:"fixture-copy".into(),kind});
    state.vault.lock().unwrap().data.as_mut().unwrap().profiles[1]=replacement;
    let queued=state.jobs.lock().unwrap().queue.pop_front().unwrap();
    let JobTaskKind::Copy{source_profile_id,source_profile_revision,source_provider,dest_profile_id,dest_profile_revision,dest_provider,..}=queued.kind else{unreachable!()};
    let result:Result<i64,String>=(||{
        let (src,dst)=confirm_transfer_profiles(&state,&source_profile_id,&source_profile_revision,source_provider,&dest_profile_id,&dest_profile_revision,dest_provider)?;
        queued_copy(&state,&src,&dst)
    })();
    assert!(result.unwrap_err().contains("stale task refused"));
    assert_eq!(snapshot.unwrap().profile_name.as_deref(),Some("Account A captured"));
    assert!(source.requests.lock().unwrap().is_empty());assert!(before.requests.lock().unwrap().is_empty());assert!(after.requests.lock().unwrap().is_empty());
    println!("QUEUED_COPY_GUARD snapshot_account=A stale_task=refused source_requests=0 old_destination_puts=0 new_destination_puts=0 real_cloud=false");
}
#[test]fn queued_copy_with_unchanged_identity_still_writes_original_destination(){
    let source=source(5,false,false);let destination=destination();
    let src=profile_fixture("source-id","Source fixture",&source.origin,"source-r1");
    let dst=profile_fixture("dest-id","Destination fixture",&destination.origin,"dest-r1");
    let state=AppState::default();
    {let mut vault=state.vault.lock().unwrap();vault.unlocked=true;vault.data=Some(VaultData{profiles:vec![src.clone(),dst.clone()],..Default::default()});}
    assert_eq!(queued_copy(&state,&src,&dst).unwrap(),5);
    assert_eq!(destination.requests.lock().unwrap().iter().filter(|r|r.starts_with(b"PUT ")).count(),1);
}
