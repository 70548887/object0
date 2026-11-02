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
