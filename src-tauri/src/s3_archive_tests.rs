//! Disposable local files and loopback HTTP only; never real cloud data.
use super::*;
use std::{io::{Read,Write},net::TcpListener,thread,time::{Duration,Instant}};

struct Server {origin:String,requests:Arc<Mutex<Vec<String>>>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server {fn drop(&mut self){if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn server(body:Option<&[u8]>,declared:usize)->Server {
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
    let origin=format!("http://{}",listener.local_addr().unwrap());let requests=Arc::new(Mutex::new(vec![]));let captured=requests.clone();
    let body=body.map(<[u8]>::to_vec);
    let worker=thread::spawn(move||{
        let Some(body)=body else{return};
        let deadline=Instant::now()+Duration::from_secs(5);
        let mut socket=loop {match listener.accept(){Ok((socket,_))=>break socket,Err(error)if error.kind()==io::ErrorKind::WouldBlock&&Instant::now()<deadline=>thread::sleep(Duration::from_millis(5)),_=>return}};
        socket.set_nonblocking(false).unwrap();socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut request=vec![];let mut bytes=[0u8;4096];
        while !request.windows(4).any(|value|value==b"\r\n\r\n") {match socket.read(&mut bytes){Ok(n)if n>0=>request.extend_from_slice(&bytes[..n]),_=>return};assert!(request.len()<64*1024);}
        captured.lock().unwrap().push(String::from_utf8_lossy(&request).into_owned());
        let mut response=format!("HTTP/1.0 200 OK\r\nConnection: close\r\nContent-Length: {declared}\r\nETag: \"fixture\"\r\n\r\n").into_bytes();response.extend_from_slice(&body);
        let _=socket.write_all(&response);let _=socket.shutdown(std::net::Shutdown::Write);
    });Server{origin,requests,worker:Some(worker)}
}
fn runtime()->&'static tokio::runtime::Runtime {static RUNTIME:std::sync::OnceLock<tokio::runtime::Runtime>=std::sync::OnceLock::new();RUNTIME.get_or_init(||tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap())}
fn client(server:&Server)->S3Client {
    let _guard=runtime().enter();
    S3Client::from_conf(aws_sdk_s3::config::Builder::new().behavior_version_latest().region(Region::new("fixture-region")).endpoint_url(&server.origin).force_path_style(true)
        .credentials_provider(Credentials::new("mock-ak","mock-sk",None,None,"fixture"))
        .request_checksum_calculation(aws_sdk_s3::config::RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(aws_sdk_s3::config::ResponseChecksumValidation::WhenRequired)
        .retry_config(aws_sdk_s3::config::retry::RetryConfig::standard().with_max_attempts(1))
        .timeout_config(aws_sdk_s3::config::timeout::TimeoutConfig::builder().connect_timeout(Duration::from_secs(2)).read_timeout(Duration::from_secs(2)).build()).build())
}
struct Fixture {root:PathBuf,target:PathBuf}
impl Fixture {fn new(existing:bool)->Self{let root=std::env::temp_dir().join(format!("yuncang-archive-audit-{}",Uuid::new_v4().simple()));fs::create_dir(&root).unwrap();let target=root.join("target.tar.gz");if existing{fs::write(&target,b"original-archive").unwrap();}Self{root,target}}
    fn no_parts(&self){assert!(!fs::read_dir(&self.root).unwrap().any(|entry|entry.unwrap().file_name().to_string_lossy().ends_with(".part")));}}
impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
fn archive(server:&Server,fixture:&Fixture,keys:&[String],cancel:&AtomicBool,progress:impl FnMut(i64,i64))->Result<i64,String>{runtime().block_on(s3_download_archive_tar_gz(&client(server),"fixture-bucket",keys,"",&fixture.target,cancel,progress))}

#[test]
fn existing_archive_is_never_truncated_or_deleted_on_failure() {
    let server=server(None,0);let fixture=Fixture::new(true);
    let error=archive(&server,&fixture,&["../invalid".into()],&AtomicBool::new(false),|_,_|{}).unwrap_err();
    assert_eq!(fs::read(&fixture.target).unwrap(),b"original-archive");
    assert!(error.contains("already exists"));assert!(server.requests.lock().unwrap().is_empty());fixture.no_parts();
}
#[test]
fn concurrent_archive_target_is_preserved_instead_of_replaced() {
    let server=server(Some(b"hello"),5);let fixture=Fixture::new(false);
    let result=archive(&server,&fixture,&["hello.txt".into()],&AtomicBool::new(false),|done,_|{if done==0{fs::write(&fixture.target,b"concurrent-user-file").unwrap();}});
    assert!(result.is_err());assert_eq!(fs::read(&fixture.target).unwrap(),b"concurrent-user-file");fixture.no_parts();
}
#[test]
fn completed_archive_is_committed_with_valid_gzip_and_tar_contents() {
    let server=server(Some(b"hello"),5);let fixture=Fixture::new(false);
    assert_eq!(archive(&server,&fixture,&["hello.txt".into()],&AtomicBool::new(false),|_,_|{}).unwrap(),5);
    let mut archive=tar::Archive::new(flate2::read::GzDecoder::new(fs::File::open(&fixture.target).unwrap()));
    let mut entries=archive.entries().unwrap();let mut entry=entries.next().unwrap().unwrap();
    assert_eq!(entry.path().unwrap().to_string_lossy(),"hello.txt");let mut bytes=vec![];entry.read_to_end(&mut bytes).unwrap();assert_eq!(bytes,b"hello");assert!(entries.next().is_none());fixture.no_parts();
}
#[test]
fn interrupted_archive_stream_removes_only_its_temporary_file() {
    let server=server(Some(b"he"),5);let fixture=Fixture::new(false);
    assert!(archive(&server,&fixture,&["hello.txt".into()],&AtomicBool::new(false),|_,_|{}).is_err());
    assert!(!fixture.target.exists());fixture.no_parts();
}
#[test]
fn cancelled_archive_does_not_commit_partial_output() {
    let server=server(Some(b"hello"),5);let fixture=Fixture::new(false);let cancel=AtomicBool::new(false);
    assert_eq!(archive(&server,&fixture,&["hello.txt".into()],&cancel,|done,_|{if done>0{cancel.store(true,Ordering::SeqCst);}}).unwrap_err(),JOB_CANCELLED);
    assert!(!fixture.target.exists());fixture.no_parts();
}
#[test]
fn precancelled_archive_preserves_existing_file_without_request() {
    let server=server(None,0);let fixture=Fixture::new(true);
    assert_eq!(archive(&server,&fixture,&["hello.txt".into()],&AtomicBool::new(true),|_,_|{}).unwrap_err(),JOB_CANCELLED);
    assert_eq!(fs::read(&fixture.target).unwrap(),b"original-archive");assert!(server.requests.lock().unwrap().is_empty());fixture.no_parts();
}
