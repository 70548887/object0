//! Qiniu private-S3 transfer routing, tested only with disposable local files
//! and a loopback service. No real credentials or cloud account are used.
use super::*;
use std::{io::{Read,Write},net::TcpListener,thread,time::{Duration,Instant}};

struct Server {origin:String,requests:Arc<Mutex<Vec<String>>>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server {fn drop(&mut self){if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn server(count:usize)->Server {
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin=format!("http://{}",listener.local_addr().unwrap());
    let requests=Arc::new(Mutex::new(Vec::new()));let captured=requests.clone();
    let worker=thread::spawn(move||{
        for _ in 0..count {
            let deadline=Instant::now()+Duration::from_secs(5);
            let mut connection=loop {match listener.accept(){
                Ok((connection,_))=>break connection,
                Err(error) if error.kind()==io::ErrorKind::WouldBlock && Instant::now()<deadline=>thread::sleep(Duration::from_millis(5)),
                _=>return,
            }};
            connection.set_nonblocking(false).unwrap();
            connection.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut bytes=Vec::new();let mut buffer=[0u8;4096];
            while !bytes.windows(4).any(|part|part==b"\r\n\r\n") {
                match connection.read(&mut buffer){Ok(n) if n>0=>bytes.extend_from_slice(&buffer[..n]),_=>return};
                assert!(bytes.len()<64*1024);
            }
            let request=String::from_utf8_lossy(&bytes).to_string();
            let get=request.starts_with("GET ");
            captured.lock().unwrap().push(request);
            let mut response=b"HTTP/1.0 200 OK\r\nConnection: close\r\nContent-Length: 5\r\nETag: \"v1\"\r\nLast-Modified: Tue, 14 Nov 2023 22:13:20 GMT\r\n\r\n".to_vec();
            if get {response.extend_from_slice(b"hello");}
            let _=connection.write_all(&response);
            let _=connection.shutdown(std::net::Shutdown::Write);
        }
    });
    Server{origin,requests,worker:Some(worker)}
}
fn runtime()->tokio::runtime::Runtime{tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()}
fn bridge(origin:&str)->qiniu::s3_bridge::QiniuS3Bridge {
    let config=qiniu::QiniuConfig {mode:qiniu::QiniuMode::Private,uc_url:Some(origin.into()),regions:vec![qiniu::QiniuManualRegion{id:"fixture-region".into(),label:None,s3_endpoint:origin.into()}],..Default::default()};
    let region=qiniu::QiniuRegion::manual_regions(&config).remove(0);
    let bucket=qiniu::QiniuBucket{name:"native-space".into(),s3_name:Some("server-s3-alias".into()),kodo_region_id:None,created_at:None,permission:None,remark:None};
    let context=qiniu::ResolvedBucketContext {bucket,region,s3_bucket_name:Some("server-s3-alias".into()),backend_mode:"s3".into()};
    qiniu::s3_bridge::from_context("fixture-profile","fixture-revision",&config,&context,"fixture-ak","fixture-sk",Some("fixture-session")).unwrap()
}
struct Fixture {root:PathBuf,target:PathBuf}
impl Fixture {fn new(existing:bool)->Self{let root=std::env::temp_dir().join(format!("qiniu-s3-job-{}",Uuid::new_v4().simple()));fs::create_dir(&root).unwrap();let target=root.join("download.bin");if existing {fs::write(&target,b"old-data").unwrap();}Self{root,target}}}
impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_file(&self.target);let _=fs::remove_dir(&self.root);}}

#[test]
fn private_s3_download_uses_resolved_alias_and_atomic_s3_pipeline() {
    let server=server(3);let fixture=Fixture::new(false);let runtime=runtime();
    let bridge={let _guard=runtime.enter();bridge(&server.origin)};
    let result=runtime.block_on(qiniu_s3_download(&bridge,"folder/hello.txt",&fixture.target,&AtomicBool::new(false),|_,_|{}));
    assert_eq!(result.unwrap(),5);assert_eq!(fs::read(&fixture.target).unwrap(),b"hello");
    let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),3);
    assert!(requests.iter().all(|request|request.lines().next().unwrap().contains("/server-s3-alias/folder/hello.txt")));
    assert!(requests.iter().all(|request|!request.lines().next().unwrap().contains("native-space")));
    assert!(requests[1].to_ascii_lowercase().contains("if-match: \"v1\""));
    assert!(requests.iter().all(|request|request.to_ascii_lowercase().contains("x-amz-security-token: fixture-session")));
}

#[test]
fn cancelled_private_s3_download_preserves_existing_file_without_request() {
    let server=server(0);let fixture=Fixture::new(true);let runtime=runtime();
    let bridge={let _guard=runtime.enter();bridge(&server.origin)};
    let result=runtime.block_on(qiniu_s3_download(&bridge,"hello.txt",&fixture.target,&AtomicBool::new(true),|_,_|{}));
    assert_eq!(result.unwrap_err(),JOB_CANCELLED);assert_eq!(fs::read(&fixture.target).unwrap(),b"old-data");
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]
fn private_s3_download_rejects_an_existing_destination_before_network() {
    let server=server(0);let fixture=Fixture::new(true);let runtime=runtime();
    let bridge={let _guard=runtime.enter();bridge(&server.origin)};
    let result=runtime.block_on(qiniu_s3_download(&bridge,"hello.txt",&fixture.target,&AtomicBool::new(false),|_,_|{}));
    assert!(result.unwrap_err().contains("already exists"));assert_eq!(fs::read(&fixture.target).unwrap(),b"old-data");
    assert!(server.requests.lock().unwrap().is_empty());
}
