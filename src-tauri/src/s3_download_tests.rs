//! Local HTTP and filesystem regression tests for safe S3 download commit.
//! All paths are unique disposable fixtures; no cloud or user account is used.
use super::*;
use std::{io::{Read,Write},net::TcpListener,thread,time::{Duration,Instant}};

struct Reply {headers:Vec<(String,String)>,body:Vec<u8>}
fn head(etag:&str,size:usize)->Reply{Reply{headers:vec![("Content-Length".into(),size.to_string()),("ETag".into(),etag.into()),("Last-Modified".into(),"Tue, 14 Nov 2023 22:13:20 GMT".into())],body:vec![]}}
fn get(etag:&str,declared_size:usize,bytes:&[u8])->Reply{let mut reply=head(etag,declared_size);reply.body=bytes.to_vec();reply}
struct Server {origin:String,requests:Arc<Mutex<Vec<String>>>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server{fn drop(&mut self){if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn server(replies:Vec<Reply>)->Server{
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
    let origin=format!("http://{}",listener.local_addr().unwrap());let requests=Arc::new(Mutex::new(vec![]));let captured=requests.clone();
    let worker=thread::spawn(move||{
        for reply in replies {
            let deadline=Instant::now()+Duration::from_secs(5);
            let mut connection=loop{match listener.accept(){Ok((connection,_))=>break connection,Err(error)if error.kind()==io::ErrorKind::WouldBlock&&Instant::now()<deadline=>thread::sleep(Duration::from_millis(5)),_=>return}};
            connection.set_nonblocking(false).unwrap();connection.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut request=Vec::new();let mut buffer=[0u8;4096];
            while !request.windows(4).any(|bytes|bytes==b"\r\n\r\n") {
                match connection.read(&mut buffer){Ok(count)if count>0=>request.extend_from_slice(&buffer[..count]),_=>return}
                assert!(request.len()<64*1024);
            }
            captured.lock().unwrap().push(String::from_utf8_lossy(&request).to_string());
            let mut bytes=b"HTTP/1.0 200 OK\r\nConnection: close\r\n".to_vec();
            for(name,value)in reply.headers {bytes.extend_from_slice(format!("{name}: {value}\r\n").as_bytes());}
            bytes.extend_from_slice(b"\r\n");bytes.extend_from_slice(&reply.body);
            let _=connection.write_all(&bytes);let _=connection.shutdown(std::net::Shutdown::Write);
        }
    });Server{origin,requests,worker:Some(worker)}
}
fn runtime()->&'static tokio::runtime::Runtime{static RUNTIME:std::sync::OnceLock<tokio::runtime::Runtime>=std::sync::OnceLock::new();RUNTIME.get_or_init(||tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap())}
fn client(server:&Server)->S3Client{
    let _enter=runtime().enter();
    S3Client::from_conf(aws_sdk_s3::config::Builder::new().behavior_version_latest().region(Region::new("fixture-region"))
        .endpoint_url(&server.origin).force_path_style(true).credentials_provider(Credentials::new("mock-ak","mock-sk",None,None,"fixture"))
        .request_checksum_calculation(aws_sdk_s3::config::RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(aws_sdk_s3::config::ResponseChecksumValidation::WhenRequired)
        .retry_config(aws_sdk_s3::config::retry::RetryConfig::standard().with_max_attempts(1))
        .timeout_config(aws_sdk_s3::config::timeout::TimeoutConfig::builder().connect_timeout(Duration::from_secs(2)).read_timeout(Duration::from_secs(2)).build()).build())
}
struct Fixture {root:PathBuf,target:PathBuf}
impl Fixture {
    fn new(original:Option<&[u8]>)->Self{let root=std::env::temp_dir().join(format!("yuncang-safe-download-{}",Uuid::new_v4().simple()));fs::create_dir(&root).unwrap();let target=root.join("target.bin");if let Some(bytes)=original{fs::write(&target,bytes).unwrap();}Self{root,target}}
    fn assert_no_parts(&self){assert!(!fs::read_dir(&self.root).unwrap().any(|entry|entry.unwrap().file_name().to_string_lossy().ends_with(".part")));}
}
impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
fn download(server:&Server,fixture:&Fixture,cancel:&AtomicBool,progress:impl FnMut(i64,i64))->Result<i64,String>{runtime().block_on(s3_download_file(&client(server),"fixture-bucket","中文/file.bin",&fixture.target,cancel,progress))}

#[test]fn successful_download_atomically_replaces_existing_target(){
    let server=server(vec![head("\"v1\"",5),get("\"v1\"",5,b"hello"),head("\"v1\"",5)]);let fixture=Fixture::new(Some(b"original"));let mut progress=vec![];
    assert_eq!(download(&server,&fixture,&AtomicBool::new(false),|done,total|progress.push((done,total))).unwrap(),5);
    assert_eq!(fs::read(&fixture.target).unwrap(),b"hello");fixture.assert_no_parts();assert_eq!(progress.first(),Some(&(0,5)));assert_eq!(progress.last(),Some(&(5,5)));
    let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),3);assert!(requests[1].to_ascii_lowercase().contains("if-match: \"v1\""));
}
#[test]fn interrupted_stream_keeps_original_and_removes_only_its_partial(){
    let server=server(vec![head("\"v1\"",5),get("\"v1\"",5,b"he")]);let fixture=Fixture::new(Some(b"original"));
    assert!(download(&server,&fixture,&AtomicBool::new(false),|_,_|{}).is_err());assert_eq!(fs::read(&fixture.target).unwrap(),b"original");fixture.assert_no_parts();
}
#[test]fn declared_length_mismatch_never_truncates_the_target(){
    let server=server(vec![head("\"v1\"",5),get("\"v1\"",4,b"hell")]);let fixture=Fixture::new(Some(b"original"));
    assert!(download(&server,&fixture,&AtomicBool::new(false),|_,_|{}).is_err());assert_eq!(fs::read(&fixture.target).unwrap(),b"original");fixture.assert_no_parts();
}
#[test]fn cancellation_after_bytes_keeps_the_original(){
    let server=server(vec![head("\"v1\"",5),get("\"v1\"",5,b"hello")]);let fixture=Fixture::new(Some(b"original"));let cancel=AtomicBool::new(false);
    assert_eq!(download(&server,&fixture,&cancel,|done,_|{if done>0{cancel.store(true,Ordering::SeqCst)}}).unwrap_err(),JOB_CANCELLED);assert_eq!(fs::read(&fixture.target).unwrap(),b"original");fixture.assert_no_parts();
}
#[test]fn target_modified_during_download_is_not_replaced(){
    let server=server(vec![head("\"v1\"",5),get("\"v1\"",5,b"hello"),head("\"v1\"",5)]);let fixture=Fixture::new(Some(b"original"));
    let result=download(&server,&fixture,&AtomicBool::new(false),|done,_|{if done>0{fs::write(&fixture.target,b"someone-elses-edits").unwrap();}});
    assert!(result.unwrap_err().contains("destination changed"));assert_eq!(fs::read(&fixture.target).unwrap(),b"someone-elses-edits");fixture.assert_no_parts();
}
#[test]fn concurrently_created_target_is_not_overwritten(){
    let server=server(vec![head("\"v1\"",5),get("\"v1\"",5,b"hello"),head("\"v1\"",5)]);let fixture=Fixture::new(None);
    assert!(download(&server,&fixture,&AtomicBool::new(false),|done,_|{if done>0{fs::write(&fixture.target,b"new-user-file").unwrap();}}).is_err());assert_eq!(fs::read(&fixture.target).unwrap(),b"new-user-file");fixture.assert_no_parts();
}
#[test]fn remote_version_change_refuses_commit(){
    let server=server(vec![head("\"v1\"",5),get("\"v1\"",5,b"hello"),head("\"v2\"",5)]);let fixture=Fixture::new(Some(b"original"));
    assert!(download(&server,&fixture,&AtomicBool::new(false),|_,_|{}).unwrap_err().contains("Remote object changed"));assert_eq!(fs::read(&fixture.target).unwrap(),b"original");fixture.assert_no_parts();
}
#[test]fn pre_cancelled_download_has_no_filesystem_or_network_side_effect(){
    let server=server(vec![]);let fixture=Fixture::new(Some(b"original"));assert_eq!(download(&server,&fixture,&AtomicBool::new(true),|_,_|{}).unwrap_err(),JOB_CANCELLED);assert_eq!(fs::read(&fixture.target).unwrap(),b"original");fixture.assert_no_parts();assert!(server.requests.lock().unwrap().is_empty());
}
#[test]fn empty_remote_file_commits_as_zero_bytes_not_fabricated_progress(){
    let server=server(vec![head("\"empty\"",0),get("\"empty\"",0,b""),head("\"empty\"",0)]);let fixture=Fixture::new(None);
    assert_eq!(download(&server,&fixture,&AtomicBool::new(false),|_,_|{}).unwrap(),0);assert_eq!(fs::metadata(&fixture.target).unwrap().len(),0);fixture.assert_no_parts();
}
