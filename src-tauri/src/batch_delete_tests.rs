//! Pure-result and ephemeral-loopback contracts. No cloud accounts, user vault,
//! system credentials, or non-fixture paths are read by these tests.
use super::*;
use aws_sdk_s3::config::{Credentials,Region,RequestChecksumCalculation,ResponseChecksumValidation,retry::RetryConfig,timeout::TimeoutConfig};
use std::{io::{Read,Write},net::TcpListener,sync::{Arc,Mutex},thread,time::{Duration,Instant}};

struct Reply {status:u16,body:String}
fn xml(body:&str)->Reply{Reply{status:200,body:body.into()}}
fn json(body:serde_json::Value)->Reply{Reply{status:200,body:body.to_string()}}
struct Server {origin:String,requests:Arc<Mutex<Vec<String>>>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server {fn drop(&mut self){if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn server(replies:Vec<Reply>)->Server {
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
    let origin=format!("http://{}",listener.local_addr().unwrap());let requests=Arc::new(Mutex::new(vec![]));let captures=requests.clone();
    let worker=thread::spawn(move||{
        for reply in replies {
            let deadline=Instant::now()+Duration::from_secs(5);
            let (mut socket,bytes)=loop {
                let mut socket=loop {match listener.accept(){
                    Ok((socket,_))=>break socket,
                    Err(error) if error.kind()==std::io::ErrorKind::WouldBlock && Instant::now()<deadline=>thread::sleep(Duration::from_millis(5)),
                    _=>return,
                }};
                socket.set_nonblocking(false).unwrap();socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut bytes=Vec::new();let mut buffer=[0u8;8192];
                loop {
                    match socket.read(&mut buffer){Ok(size) if size>0=>bytes.extend_from_slice(&buffer[..size]),_=>break};
                    if let Some(split)=bytes.windows(4).position(|bytes|bytes==b"\r\n\r\n"){
                        let headers=String::from_utf8_lossy(&bytes[..split]);
                        let length=headers.lines().find_map(|line|{let(name,value)=line.split_once(':')?;if name.eq_ignore_ascii_case("content-length"){value.trim().parse::<usize>().ok()}else{None}}).unwrap_or(0);
                        if bytes.len()>=split+4+length{break;}
                    }
                    assert!(bytes.len()<1024*1024,"fixture request unexpectedly large");
                }
                if bytes.is_empty(){if Instant::now()>=deadline{return;}continue;}
                break(socket,bytes);
            };
            captures.lock().unwrap().push(String::from_utf8(bytes).unwrap());
            let response=format!("HTTP/1.0 {} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",reply.status,reply.body.len(),reply.body);
            let _=socket.write_all(response.as_bytes());let _=socket.shutdown(std::net::Shutdown::Write);
        }
    });
    Server{origin,requests,worker:Some(worker)}
}
fn runtime()->&'static tokio::runtime::Runtime{
    static RUNTIME:std::sync::OnceLock<tokio::runtime::Runtime>=std::sync::OnceLock::new();
    RUNTIME.get_or_init(||tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap())
}
fn s3(server:&Server)->S3Client{
    let _guard=runtime().enter();
    S3Client::from_conf(aws_sdk_s3::config::Builder::new().behavior_version_latest()
        .region(Region::new("fixture-region")).endpoint_url(&server.origin).force_path_style(true)
        .credentials_provider(Credentials::new("fixture-ak","fixture-sk",None,None,"fixture"))
        .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
        .retry_config(RetryConfig::standard().with_max_attempts(1))
        .timeout_config(TimeoutConfig::builder().connect_timeout(Duration::from_secs(2)).read_timeout(Duration::from_secs(2)).build()).build())
}
fn native(server:&Server)->(qiniu::QiniuClient,qiniu::ResolvedBucketContext){
    let _guard=runtime().enter();
    let config=qiniu::QiniuConfig{mode:qiniu::QiniuMode::Private,uc_url:Some(server.origin.clone()),..Default::default()};
    let client=qiniu::QiniuClient::new(config,qiniu::QiniuCredentials::new("fixture-ak".into(),"fixture-sk".into(),None).unwrap()).unwrap();
    let host=server.origin.trim_start_matches("http://");
    let region=qiniu::QiniuRegion::from_response(&serde_json::json!({"region":"fixture","ttl":60,"rs":{"domains":[host]},"s3":{"region_alias":"fixture-s3","domains":[host]}}),"http",0).unwrap();
    let bucket=qiniu::QiniuBucket{name:"fixture-native".into(),s3_name:Some("fixture-s3-name".into()),kodo_region_id:Some("fixture".into()),created_at:None,permission:Some("readwrite".into()),remark:None};
    (client,qiniu::ResolvedBucketContext{bucket,region,s3_bucket_name:Some("fixture-s3-name".into()),backend_mode:"kodo".into()})
}
fn keys(values:&[&str])->Vec<String>{values.iter().map(|key|key.to_string()).collect()}

#[test]fn s3_reports_success_failure_and_missing_items_without_echoing_service_text(){
    let fixture=server(vec![xml("<DeleteResult><Deleted><Key>ok</Key></Deleted><Error><Key>denied</Key><Code>AccessDenied</Code><Message>private-service-secret</Message></Error></DeleteResult>")]);
    let report=runtime().block_on(s3_delete_report(&s3(&fixture),"fixture-bucket",&keys(&["ok","denied","missing"]))).unwrap();
    assert_eq!(report.results.len(),3);assert!(report.results[0].success);assert!(!report.results[1].success);assert!(!report.results[2].success);
    assert!(report.results[1].error.as_deref().unwrap().contains("Access denied"));
    assert!(!serde_json::to_string(&report).unwrap().contains("private-service-secret"));
    assert!(report.ensure_all_succeeded().is_err());
}

#[test]fn empty_deletions_have_no_network_request(){
    let fixture=server(vec![]);let(client,context)=native(&fixture);
    assert!(runtime().block_on(s3_delete_report(&s3(&fixture),"fixture-bucket",&[])).unwrap().results.is_empty());
    assert!(runtime().block_on(qiniu_delete_report(&client,&context,&[])).unwrap().results.is_empty());
    assert!(fixture.requests.lock().unwrap().is_empty());
}

#[test]fn duplicate_input_keys_are_sent_once_in_first_appearance_order(){
    let fixture=server(vec![xml("<DeleteResult><Deleted><Key>one</Key></Deleted><Deleted><Key>two</Key></Deleted></DeleteResult>")]);
    let report=runtime().block_on(s3_delete_report(&s3(&fixture),"fixture-bucket",&keys(&["one","one","two","one"]))).unwrap();
    assert_eq!(report.results.iter().map(|item|item.key.as_str()).collect::<Vec<_>>(),vec!["one","two"]);
    assert!(report.ensure_all_succeeded().is_ok());
    let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),1);
    assert_eq!(requests[0].matches("<Key>one</Key>").count(),1);assert_eq!(requests[0].matches("<Key>two</Key>").count(),1);
}

#[test]fn duplicate_or_unrequested_provider_entries_never_confirm_a_batch(){
    for body in [
        "<DeleteResult><Deleted><Key>one</Key></Deleted><Deleted><Key>one</Key></Deleted><Deleted><Key>two</Key></Deleted></DeleteResult>",
        "<DeleteResult><Deleted><Key>one</Key></Deleted><Deleted><Key>two</Key></Deleted><Deleted><Key>foreign-key</Key></Deleted></DeleteResult>",
        "<DeleteResult><Deleted><Key>one</Key></Deleted><Deleted></Deleted><Deleted><Key>two</Key></Deleted></DeleteResult>",
    ] {
        let fixture=server(vec![xml(body)]);let report=runtime().block_on(s3_delete_report(&s3(&fixture),"fixture-bucket",&keys(&["one","two"]))).unwrap();
        assert_eq!(report.results.len(),2);assert!(report.results.iter().all(|item|!item.success));
    }
}

#[test]fn response_with_both_success_and_error_for_one_key_is_ambiguous(){
    let fixture=server(vec![xml("<DeleteResult><Deleted><Key>one</Key></Deleted><Deleted><Key>two</Key></Deleted><Error><Key>one</Key><Code>AccessDenied</Code></Error></DeleteResult>")]);
    let report=runtime().block_on(s3_delete_report(&s3(&fixture),"fixture-bucket",&keys(&["one","two"]))).unwrap();
    assert!(report.results.iter().all(|item|!item.success));
}

#[test]fn s3_later_batch_failure_keeps_earlier_confirmations(){
    let input:Vec<_>=(0..1001).map(|i|format!("fixture-{i}")).collect();
    let first=format!("<DeleteResult>{}</DeleteResult>",(0..1000).map(|i|format!("<Deleted><Key>fixture-{i}</Key></Deleted>")).collect::<String>());
    let fixture=server(vec![xml(&first),Reply{status:503,body:"<Error><Code>ServiceUnavailable</Code><Message>private-service-secret</Message></Error>".into()}]);
    let report=runtime().block_on(s3_delete_report(&s3(&fixture),"fixture-bucket",&input)).unwrap();
    assert_eq!(report.results.len(),1001);assert!(report.results[..1000].iter().all(|item|item.success));assert!(!report.results[1000].success);
    assert_eq!(fixture.requests.lock().unwrap().len(),2);assert!(!serde_json::to_string(&report).unwrap().contains("private-service-secret"));
}

#[test]fn qiniu_mixed_results_and_later_network_failure_are_retained_per_key(){
    let input:Vec<_>=(0..1001).map(|i|format!("fixture-{i}")).collect();
    let first:Vec<_>=(0..1000).map(|i|if i==2 {serde_json::json!({"code":403,"data":{"error":"private-service-secret"}})}else{serde_json::json!({"code":200})}).collect();
    let fixture=server(vec![json(serde_json::json!(first)),Reply{status:503,body:"{\"error\":\"private-service-secret\"}".into()}]);
    let(client,context)=native(&fixture);let report=runtime().block_on(qiniu_delete_report(&client,&context,&input)).unwrap();
    assert_eq!(report.results.len(),1001);assert!(report.results[0].success);assert!(!report.results[2].success);assert!(report.results[999].success);assert!(!report.results[1000].success);
    assert!(!serde_json::to_string(&report).unwrap().contains("private-service-secret"));assert_eq!(fixture.requests.lock().unwrap().len(),2);
}

#[test]fn qiniu_missing_or_reordered_results_are_unconfirmed_and_errors_are_sanitized(){
    let item=|key:&str,status:u16|qiniu::client::QiniuBatchResult{key:key.into(),success:status==200,status,error:Some(qiniu::QiniuError::invalid("private-service-secret"))};
    for response in [vec![item("one",200)],vec![item("two",200),item("one",200)]] {
        let results=qiniu_results(&keys(&["one","two"]),response);assert_eq!(results.len(),2);assert!(results.iter().all(|item|!item.success));
    }
    let result=qiniu_results(&keys(&["one"]),vec![item("one",403)]);
    assert!(!serde_json::to_string(&result).unwrap().contains("private-service-secret"));
}
