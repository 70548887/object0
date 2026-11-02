//! Synthetic coordinator regressions; no actual vault or cloud account.
use super::*;
use std::{io::{Read,Write},net::{TcpListener,TcpStream},thread};

struct Server {origin:String,requests:Arc<Mutex<Vec<String>>>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server {fn drop(&mut self){if let Some(worker)=self.worker.take(){worker.join().unwrap();}}}
fn server(responses:Vec<(u16,String)>)->Server {
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();let origin=format!("http://{}",listener.local_addr().unwrap());
    let requests=Arc::new(Mutex::new(vec![]));let captured=requests.clone();
    let worker=thread::spawn(move||{for(status,body)in responses {
        let deadline=Instant::now()+StdDuration::from_secs(4);
        let(mut socket,bytes)=loop{
            let mut socket:TcpStream=loop{match listener.accept(){Ok((s,_))=>break s,Err(e)if e.kind()==io::ErrorKind::WouldBlock&&Instant::now()<deadline=>thread::sleep(StdDuration::from_millis(2)),_=>return}};
            socket.set_nonblocking(false).unwrap();socket.set_read_timeout(Some(StdDuration::from_secs(2))).unwrap();let mut bytes=vec![];let mut buffer=[0u8;8192];
            loop{let n=socket.read(&mut buffer).unwrap_or(0);if n==0{break}bytes.extend_from_slice(&buffer[..n]);if bytes.windows(4).any(|v|v==b"\r\n\r\n"){break}}
            if bytes.is_empty(){if Instant::now()>=deadline{return}continue}break(socket,bytes)
        };
        captured.lock().unwrap().push(String::from_utf8(bytes).unwrap());
        let wire=format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());let _=socket.write_all(wire.as_bytes());let _=socket.shutdown(std::net::Shutdown::Write);
    }});Server{origin,requests,worker:Some(worker)}
}
fn runtime()->tokio::runtime::Runtime {tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()}
fn profile(origin:&str)->Profile {serde_json::from_value(json!({"id":"fixture-profile","name":"Usage fixture","provider":"qiniu","accessKeyId":"fixture-ak","secretAccessKey":"fixture-sk","qiniu":{"mode":"private","ucUrl":origin},"createdAt":"t","updatedAt":"v1"})).unwrap()}
fn context(origin:&str)->qiniu::ResolvedBucketContext {
    serde_json::from_value(json!({"bucket":{"name":"native-name","s3Name":"s3-alias"},"s3BucketName":"s3-alias","backendMode":"kodo","region":{"kodoRegionId":"z0","s3RegionId":"cn-east-1","ucUrls":[origin],"upUrls":[],"rsUrls":[origin],"rsfUrls":[origin],"apiUrls":[origin],"s3Urls":[origin],"storageClasses":[],"ttlSeconds":300,"expiresAt":0,"manual":false}})).unwrap()
}
fn report(complete:bool)->qiniu::analytics::AnalyticsReport {
    let time=(Utc::now()-Duration::minutes(10)).to_rfc3339();
    let classes=["standard","line","intelligent_tiering","archive_ir","archive","deep_archive"].iter().enumerate().map(|(i,name)|qiniu::analytics::ClassUsage {
        storage_class:(*name).into(),bytes:if complete||i==0{Some(i as u64+1)}else{None},object_count:if complete||i==0{Some(1)}else{None},
        measured_at:if complete||i==0{Some(time.clone())}else{None},state:if complete||i==0{"available"}else{"forbidden"},reason:if complete||i==0{None}else{Some("permission denied fixture".into())},
    }).collect();
    qiniu::analytics::AnalyticsReport{bytes:complete.then_some(21),object_count:complete.then_some(6),measured_at:complete.then_some(time),complete,classes,warning:(!complete).then(||"Official metrics incomplete fixture".into())}
}
fn page(size:u64,marker:Option<&str>)->String {
    let mut v=json!({"items":[{"key":"nested/file","fsize":size,"hash":"fixture-hash","putTime":17000000000000000i64}]});if let Some(marker)=marker{v["marker"]=json!(marker);}v.to_string()
}

#[test]fn audit_native_error_payload_does_not_become_complete_zero_usage(){runtime().block_on(async{
    let fixture=server(vec![(200,"{\"error\":\"private-provider-detail\",\"code\":503}".into())]);
    let profile=profile(&fixture.origin);let client=storage_backend::qiniu_client(&profile).unwrap();
    let result=finish_qiniu_usage(&profile,"native-name",Instant::now(),&client,&context(&fixture.origin),Ok(report(false))).await.unwrap();
    assert_eq!(result.source,"qiniu");assert!(!result.complete);assert_eq!(result.bytes,None);assert_eq!(result.object_count,None);
    assert!(!serde_json::to_string(&result).unwrap().contains("private-provider-detail"));
})}

#[test]fn audit_native_invalid_marker_cannot_claim_complete_bucket_usage(){runtime().block_on(async{
    for marker in [json!(42),json!({}),json!(null)] {
        let body=json!({"items":[{"key":"file","fsize":5,"hash":"fixture-hash","putTime":17000000000000000i64}],"marker":marker}).to_string();
        let fixture=server(vec![(200,body)]);let profile=profile(&fixture.origin);let client=storage_backend::qiniu_client(&profile).unwrap();
        let result=scan_qiniu_objects(&profile,"native-name",Instant::now(),&client,&context(&fixture.origin),None).await;
        assert!(result.is_err(),"An invalid native marker is not proof that pagination has ended");
    }
})}

#[test]fn audit_native_marker_failure_retains_only_confirmed_page_lower_bound(){runtime().block_on(async{
    let invalid=json!({"items":[{"key":"unconfirmed","fsize":99,"hash":"fixture-hash","putTime":17000000000000000i64}],"marker":42}).to_string();
    let fixture=server(vec![(200,page(8,Some("next"))),(200,invalid)]);let profile=profile(&fixture.origin);let client=storage_backend::qiniu_client(&profile).unwrap();
    let result=finish_qiniu_usage(&profile,"native-name",Instant::now(),&client,&context(&fixture.origin),Ok(report(false))).await.unwrap();
    assert_eq!(result.source,"scan");assert!(!result.complete);assert_eq!(result.bytes,Some(8));assert_eq!(result.object_count,Some(1));assert_eq!(result.scanned_pages,Some(1));assert!(result.qiniu_analytics.is_some());
    assert!(result.warning.unwrap().contains("continuation marker"));
})}

#[test]fn aligned_official_report_does_not_scan_or_guess_an_alias(){runtime().block_on(async{
    let fixture=server(vec![]);let profile=profile(&fixture.origin);let client=storage_backend::qiniu_client(&profile).unwrap();
    let result=finish_qiniu_usage(&profile,"native-name",Instant::now(),&client,&context(&fixture.origin),Ok(report(true))).await.unwrap();
    assert_eq!(result.source,"qiniu");assert_eq!(result.bytes,Some(21));assert_eq!(result.object_count,Some(6));assert!(result.complete);assert_eq!(result.scanned_pages,None);assert!(fixture.requests.lock().unwrap().is_empty());
    let dto=serde_json::to_value(&result).unwrap();assert_eq!(dto["qiniuAnalytics"]["classes"].as_array().unwrap().len(),6);assert!(dto["qiniuAnalytics"].get("bytes").is_none());
})}

#[test]fn incomplete_official_data_falls_back_to_scan_without_mixing_class_values(){runtime().block_on(async{
    let fixture=server(vec![(200,page(12,None))]);let profile=profile(&fixture.origin);let client=storage_backend::qiniu_client(&profile).unwrap();
    let result=finish_qiniu_usage(&profile,"native-name",Instant::now(),&client,&context(&fixture.origin),Ok(report(false))).await.unwrap();
    assert_eq!(result.source,"scan");assert_eq!(result.bytes,Some(12));assert_eq!(result.object_count,Some(1));assert!(result.complete);
    assert!(result.warning.unwrap().contains("falling back"));let diagnostics=result.qiniu_analytics.unwrap();assert!(!diagnostics.complete);assert_eq!(diagnostics.classes[0].bytes,Some(1));
    let requests=fixture.requests.lock().unwrap();assert!(requests[0].contains("bucket=native-name"));assert!(!requests[0].contains("s3-alias"));
})}

#[test]fn failure_of_official_and_first_scan_page_is_unknown_not_zero(){runtime().block_on(async{
    let fixture=server(vec![(403,"{\"error\":\"secret-provider-body\"}".into())]);let profile=profile(&fixture.origin);let client=storage_backend::qiniu_client(&profile).unwrap();
    let result=finish_qiniu_usage(&profile,"native-name",Instant::now(),&client,&context(&fixture.origin),Ok(report(false))).await.unwrap();
    assert_eq!(result.source,"qiniu");assert_eq!(result.bytes,None);assert_eq!(result.object_count,None);assert_eq!(result.measured_at,None);assert!(!result.complete);
    assert!(!serde_json::to_string(&result).unwrap().contains("secret-provider-body"));assert!(result.warning.unwrap().contains("permission-denied"));
})}

#[test]fn partial_scan_preserves_known_lower_bound_and_official_diagnostics(){runtime().block_on(async{
    let fixture=server(vec![(200,page(8,Some("next"))),(403,"{}".into())]);let profile=profile(&fixture.origin);let client=storage_backend::qiniu_client(&profile).unwrap();
    let result=finish_qiniu_usage(&profile,"native-name",Instant::now(),&client,&context(&fixture.origin),Ok(report(false))).await.unwrap();
    assert_eq!(result.source,"scan");assert!(!result.complete);assert_eq!(result.bytes,Some(8));assert_eq!(result.scanned_pages,Some(1));assert!(result.qiniu_analytics.is_some());assert!(result.warning.unwrap().contains("permission-denied"));
})}

#[test]fn exhausted_fallback_budget_never_fabricates_empty_usage(){runtime().block_on(async{
    let fixture=server(vec![]);let profile=profile(&fixture.origin);let client=storage_backend::qiniu_client(&profile).unwrap();
    let started=Instant::now().checked_sub(SCAN_BUDGET+StdDuration::from_secs(1)).unwrap();
    let result=finish_qiniu_usage(&profile,"native-name",started,&client,&context(&fixture.origin),Err("analytics-timeout".into())).await.unwrap();
    assert_eq!(result.bytes,None);assert!(!result.complete);assert!(result.warning.unwrap().contains("analytics-timeout"));assert!(fixture.requests.lock().unwrap().is_empty());
})}

#[test]fn genuine_empty_scan_is_zero_and_missing_pagination_is_an_error(){runtime().block_on(async{
    for(valid,body)in[(false,"<ListBucketResult></ListBucketResult>"),(true,"<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")]{
        let fixture=server(vec![(200,body.into())]);let mut profile=profile(&fixture.origin);profile.provider=S3Provider::Custom;profile.endpoint=Some(fixture.origin.clone());profile.region=Some("us-east-1".into());profile.qiniu=None;
        let result=scan_bucket(&profile,"bucket",Instant::now(),None).await;
        if valid{let result=result.unwrap();assert_eq!(result.bytes,Some(0));assert_eq!(result.object_count,Some(0));assert!(result.complete);assert!(result.qiniu_analytics.is_none());}
        else{assert!(result.err().unwrap().contains("pagination status"));}
    }
})}

fn state()->AppState {let state=AppState::default();{let mut vault=state.vault.lock().unwrap();vault.unlocked=true;let mut second=profile("http://127.0.0.1:9");second.id="other".into();vault.data=Some(VaultData{profiles:vec![profile("http://127.0.0.1:9"),second],..Default::default()});}state}
fn input(id:&str,request:&str)->UsageInput {UsageInput{profile_id:id.into(),bucket:"native-name".into(),request_id:request.into()}}

#[test]fn profile_invalidation_aborts_only_its_usage_tasks_and_cleanup_releases_slots(){runtime().block_on(async{
    let state=state();let(_,registration,guard)=register_task(&state,&input("fixture-profile","request-a")).unwrap();let(_,other,other_guard)=register_task(&state,&input("other","request-b")).unwrap();
    storage_backend::invalidate(&state,"fixture-profile");
    assert!(Abortable::new(futures_util::future::pending::<()>(),registration).await.is_err());
    assert!(tokio::time::timeout(StdDuration::from_millis(20),Abortable::new(futures_util::future::pending::<()>(),other)).await.is_err());
    drop(guard);drop(other_guard);assert!(state.usage.lock().unwrap().tasks.is_empty());
})}

#[test]fn cancellation_before_registration_and_vault_lock_fail_closed(){runtime().block_on(async{
    let state=state();cancel(&state,UsageCancelInput{request_id:"cancelled-first".into()}).unwrap();assert!(register_task(&state,&input("fixture-profile","cancelled-first")).is_err());
    let(_,registration,_guard)=register_task(&state,&input("fixture-profile","active")).unwrap();{let mut vault=state.vault.lock().unwrap();lock_vault_runtime(&mut vault);cancel_all(&state);}
    assert!(Abortable::new(futures_util::future::pending::<()>(),registration).await.is_err());assert!(register_task(&state,&input("fixture-profile","after-lock")).is_err());
})}
