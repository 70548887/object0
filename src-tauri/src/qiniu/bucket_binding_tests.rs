//! Scoped S3 bindings use only ephemeral loopback services and fixture keys.
use super::*;
use std::{io::{Read,Write},net::TcpListener,sync::{Arc,Mutex},thread,time::{Duration,Instant}};

const LIST:&str=r#"<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>explicit-s3-id</Name><Prefix></Prefix><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>"#;
struct Reply{status:u16,body:String}
struct Server{origin:String,requests:Arc<Mutex<Vec<String>>>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server{fn drop(&mut self){if let Some(worker)=self.worker.take(){let _=worker.join();}}}
fn server(replies:Vec<Reply>)->Server{
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
    let origin=format!("http://{}",listener.local_addr().unwrap());let requests=Arc::new(Mutex::new(vec![]));let captured=requests.clone();
    let worker=thread::spawn(move||{for reply in replies{
        let deadline=Instant::now()+Duration::from_secs(5);
        let (mut socket,bytes)=loop{
            let mut socket=loop{match listener.accept(){Ok((socket,_))=>break socket,Err(error)if error.kind()==std::io::ErrorKind::WouldBlock&&Instant::now()<deadline=>thread::sleep(Duration::from_millis(5)),_=>return}};
            socket.set_nonblocking(false).unwrap();socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut bytes=Vec::new();let mut buffer=[0u8;4096];
            while !bytes.windows(4).any(|part|part==b"\r\n\r\n"){
                match socket.read(&mut buffer){Ok(count)if count>0=>bytes.extend_from_slice(&buffer[..count]),_=>break};assert!(bytes.len()<64*1024);
            }
            if bytes.is_empty(){if Instant::now()>=deadline{return}continue;}
            break(socket,bytes);
        };
        captured.lock().unwrap().push(String::from_utf8(bytes).unwrap());
        let response=format!("HTTP/1.0 {} Fixture\r\nConnection: close\r\nContent-Type: application/xml\r\nContent-Length: {}\r\n\r\n{}",reply.status,reply.body.len(),reply.body);
        let _=socket.write_all(response.as_bytes());let _=socket.shutdown(std::net::Shutdown::Write);
    }});Server{origin,requests,worker:Some(worker)}
}
fn ok()->Reply{Reply{status:200,body:LIST.into()}}
fn runtime()->tokio::runtime::Runtime{tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()}
fn binding(origin:&str,native:&str,s3:&str,region:&str)->QiniuBucketBinding{QiniuBucketBinding{native_name:native.into(),s3_name:s3.into(),s3_region_id:region.into(),s3_endpoint:origin.into(),kodo_region_id:None}}
fn config(origin:&str)->QiniuConfig{QiniuConfig{mode:QiniuMode::Private,uc_url:Some(origin.into()),bucket_bindings:vec![binding(origin,"native-space","explicit-s3-id","region-a")],..Default::default()}}
fn client(config:QiniuConfig,temporary:bool)->QiniuClient{QiniuClient::new(config,QiniuCredentials::new("fixture-ak".into(),"fixture-sk".into(),temporary.then(||"fixture-session".into())).unwrap()).unwrap()}

#[test]fn temporary_scoped_list_and_resolution_never_call_native_management(){
    let server=server(vec![ok(),ok()]);let client=client(config(&server.origin),true);let runtime=runtime();
    let buckets=runtime.block_on(client.list_buckets()).unwrap();assert_eq!(buckets.len(),1);assert_eq!(buckets[0].name,"native-space");assert_eq!(buckets[0].permission,None);
    let context=runtime.block_on(client.resolve_named_bucket("explicit-s3-id")).unwrap();assert_eq!(context.backend_mode,"s3");assert_eq!(context.bucket.name,"native-space");assert_eq!(context.region.s3_region_id,"region-a");
    let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),2);
    for request in requests.iter(){
        let line=request.lines().next().unwrap();let parts=line.split_whitespace().collect::<Vec<_>>();
        assert_eq!(parts.len(),3,"Unexpected fixture request line: {line}");assert_eq!(parts[0],"GET");assert_eq!(parts[2],"HTTP/1.1");
        // SDK 1.137 serializes this bucket operation's URI base as '/' and
        // prefixes the explicit path-style S3 bucket ID at the endpoint stage.
        // Assert the exact resulting bucket resource, not a string prefix that
        // also accidentally accepts a sibling bucket or native-name route.
        let url=url::Url::parse(&format!("{}{}",server.origin,parts[1])).unwrap();
        assert_eq!(url.path(),"/explicit-s3-id/");
        let query=url.query_pairs().collect::<std::collections::HashMap<_,_>>();
        assert_eq!(query.get("max-keys").map(|value|value.as_ref()),Some("1"));
        assert_eq!(query.get("list-type").map(|value|value.as_ref()),Some("2"));
        assert!(!line.contains("native-space"));assert!(!line.contains("v2/buckets"));assert!(request.to_ascii_lowercase().contains("x-amz-security-token: fixture-session"));
    }
}

#[test]fn restricted_permanent_credentials_can_use_explicit_scope_without_account_listing(){
    let server=server(vec![ok()]);let client=client(config(&server.origin),false);
    let context=runtime().block_on(client.resolve_named_bucket("native-space")).unwrap();assert_eq!(context.s3_bucket_name.as_deref(),Some("explicit-s3-id"));
    let requests=server.requests.lock().unwrap();assert_eq!(requests.len(),1);assert!(!requests[0].to_ascii_lowercase().contains("x-amz-security-token:"));
}

#[test]fn permission_errors_and_missing_buckets_do_not_fall_back_or_report_success(){
    for(status,state)in[(401,CapabilityState::Forbidden),(403,CapabilityState::Forbidden),(404,CapabilityState::Unavailable)]{
        let server=server(vec![Reply{status,body:"<Error><Code>AccessDenied</Code><Message>fixture-secret-detail</Message></Error>".into()}]);
        let client=client(config(&server.origin),true);let error=runtime().block_on(client.resolve_named_bucket("native-space")).unwrap_err();
        assert_eq!(error.state,state);assert_eq!(error.status,Some(status));assert!(!error.to_string().contains("fixture-secret-detail"));assert_eq!(server.requests.lock().unwrap().len(),1);
    }
}

#[test]fn expired_token_is_not_hidden_by_previous_successful_binding_validation(){
    let server=server(vec![ok(),Reply{status:403,body:"<Error><Code>ExpiredToken</Code><Message>fixture-secret-token</Message></Error>".into()}]);let client=client(config(&server.origin),true);let runtime=runtime();
    assert!(runtime.block_on(client.resolve_named_bucket("native-space")).is_ok());
    let error=runtime.block_on(client.resolve_named_bucket("native-space")).unwrap_err();assert_eq!(error.state,CapabilityState::Forbidden);assert!(!error.to_string().contains("fixture-secret-token"));assert_eq!(server.requests.lock().unwrap().len(),2);
}

#[test]fn configured_scope_cannot_expand_through_a_caller_supplied_bucket(){
    let server=server(vec![]);let client=client(config(&server.origin),true);let runtime=runtime();
    let error=runtime.block_on(client.resolve_named_bucket("outside-space")).unwrap_err();assert_eq!(error.code,"bucket-not-bound");
    let bucket=QiniuBucket{name:"native-space".into(),s3_name:Some("outside-alias".into()),kodo_region_id:None,created_at:None,permission:None,remark:None};
    assert!(runtime.block_on(client.resolve_bucket(&bucket)).is_err());assert!(server.requests.lock().unwrap().is_empty());
}

#[test]fn no_default_bucket_still_requires_read_validation_for_every_explicit_binding(){
    let a=server(vec![ok()]);let b=server(vec![ok()]);let mut config=config(&a.origin);
    config.bucket_bindings.push(binding(&b.origin,"another-native","another-s3-id","region-b"));
    let client=client(config,true);let report=runtime().block_on(client.test_connection(None));
    assert_eq!(report.authentication.state,CapabilityState::Supported);assert_eq!(report.bucket_access.state,CapabilityState::Supported);
    assert_eq!(report.region_discovery.state,CapabilityState::Supported);assert!(report.region_discovery.reason.unwrap().contains("automatic discovery was not used"));
    assert_eq!(report.download_domain.state,CapabilityState::Unknown);assert_eq!(report.buckets.len(),2);assert!(report.buckets.iter().all(|bucket|bucket.permission.is_none()));
    assert_eq!(a.requests.lock().unwrap().len(),1);assert_eq!(b.requests.lock().unwrap().len(),1);
}

#[test]fn unbound_default_bucket_is_not_a_complete_connection_success(){
    let server=server(vec![ok()]);let client=client(config(&server.origin),true);let report=runtime().block_on(client.test_connection(Some("outside-space")));
    assert_eq!(report.authentication.state,CapabilityState::Supported);assert_eq!(report.bucket_access.state,CapabilityState::Forbidden);
}

#[test]fn malformed_s3_response_and_network_failure_are_errors_not_empty_bucket_success(){
    let server=server(vec![Reply{status:200,body:"this is not XML".into()}]);let native=client(config(&server.origin),true);
    assert!(runtime().block_on(native.list_buckets()).is_err());
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();let origin=format!("http://{}",listener.local_addr().unwrap());drop(listener);
    let client=client(config(&origin),true);let error=runtime().block_on(client.list_buckets()).unwrap_err();assert_eq!(error.state,CapabilityState::Unavailable);assert_eq!(error.code,"s3-read-failed");
}

#[test]fn temporary_credentials_without_explicit_bindings_fail_before_native_requests(){
    let server=server(vec![]);let mut config=config(&server.origin);config.bucket_bindings.clear();let client=client(config,true);
    let error=runtime().block_on(client.list_buckets()).unwrap_err();assert_eq!(error.state,CapabilityState::Unsupported);assert!(server.requests.lock().unwrap().is_empty());
}

#[test]fn old_configuration_without_bindings_remains_deserializable(){
    let config:QiniuConfig=serde_json::from_str(r#"{"mode":"public","regions":[]}"#).unwrap();assert!(config.bucket_bindings.is_empty());assert!(!serde_json::to_string(&config).unwrap().contains("bucketBindings"));
}

#[test]fn explicit_mode_does_not_grant_native_mutations_or_native_signatures(){
    let server=server(vec![]);let mut config=config(&server.origin);config.download_domain=Some(server.origin.clone());let client=client(config,false);let runtime=runtime();
    let error=runtime.block_on(client.update_bucket_remark("native-space","fixture remark")).unwrap_err();assert_eq!(error.state,CapabilityState::Unsupported);
    assert!(client.upload_token("native-space","file",2000,None,false).is_err());
    assert!(client.signed_download_url(&url::Url::parse(&server.origin).unwrap(),2000).is_err());
    assert!(server.requests.lock().unwrap().is_empty());
}
