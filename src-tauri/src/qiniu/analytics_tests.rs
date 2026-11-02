use super::*;
use crate::qiniu::{auth,QiniuBucket,QiniuConfig,QiniuCredentials,QiniuRegion};
use serde_json::json;
use std::{io::{Read,Write},net::{TcpListener,TcpStream},sync::{Arc,Mutex},thread,time::Instant};
use url::Url;

fn now()->DateTime<Utc>{DateTime::parse_from_rfc3339("2026-11-01T04:23:00Z").unwrap().with_timezone(&Utc)}
fn point()->i64{now().timestamp()/300*300-300}
fn context()->ResolvedBucketContext{
    ResolvedBucketContext{bucket:QiniuBucket{name:"native-name".into(),s3_name:Some("s3-alias".into()),kodo_region_id:Some("z0".into()),created_at:None,permission:None,remark:None},
        region:QiniuRegion{kodo_region_id:Some("z0".into()),s3_region_id:"cn-east-1".into(),label:None,uc_urls:vec![],up_urls:vec![],rs_urls:vec![],rsf_urls:vec![],api_urls:vec![],s3_urls:vec![],storage_classes:CLASSES.iter().map(|c|crate::qiniu::region::QiniuStorageClass{file_type:c.file_type,kodo_name:c.id.into(),s3_name:None}).collect(),ttl_seconds:60,expires_at:now().timestamp()+60,manual:false},s3_bucket_name:Some("s3-alias".into()),backend_mode:"kodo".into()}
}
fn series(time:i64,value:u64)->Result<Series,QiniuError>{Ok(BTreeMap::from([(time,value)]))}
fn good()->Vec<Result<Series,QiniuError>>{(0..12).map(|i|series(point(),if i%2==0{100}else{2})).collect()}
fn report(values:Vec<Result<Series,QiniuError>>)->AnalyticsReport{aggregate(&context(),&window(now()).unwrap(),values)}
fn runtime()->tokio::runtime::Runtime{tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()}

#[test]fn query_window_is_current_beijing_day_and_excludes_future_bound(){
    let w=window(now()).unwrap();assert_eq!(w.begin,"20261101000000");assert_eq!(w.end,"20261101122300");assert_eq!(w.start,DateTime::parse_from_rfc3339("2026-10-31T16:00:00Z").unwrap().timestamp());
    let at_midnight=DateTime::parse_from_rfc3339("2026-11-01T16:00:00Z").unwrap().with_timezone(&Utc);let w=window(at_midnight).unwrap();assert_eq!(w.begin,w.end);assert!(parse_series(json!({"times":[],"datas":[]}),&w).unwrap().is_empty());
}
#[test]fn parser_rejects_missing_malformed_unsafe_duplicate_and_wrong_time_samples(){
    let w=window(now()).unwrap();
    for value in [json!(null),json!({"times":[],"datas":[0]}),json!({"times":[point()],"datas":[null]}),json!({"times":[point()],"datas":[-1]}),json!({"times":[point()],"datas":[1.25]}),json!({"times":[point()],"datas":[MAX_SAFE+1]}),json!({"times":[point(),point()],"datas":[1,2]}),json!({"times":[w.start-300],"datas":[1]}),json!({"times":[w.finish],"datas":[1]}),json!({"times":[point()+1],"datas":[1]})]{assert!(parse_series(value,&w).is_err());}
    assert_eq!(parse_series(json!({"times":[point()],"datas":[0]}),&w).unwrap()[&point()],0);
}
#[test]fn complete_totals_require_all_six_classes_at_one_fresh_point(){
    let result=report(good());assert!(result.complete);assert_eq!(result.bytes,Some(600));assert_eq!(result.object_count,Some(12));assert_eq!(result.measured_at,Some(utc(point())));assert_eq!(result.classes.len(),6);
    let zero=report((0..12).map(|_|series(point(),0)).collect());assert!(zero.complete);assert_eq!(zero.bytes,Some(0));assert_eq!(zero.object_count,Some(0));
}
#[test]fn aggregation_selects_latest_common_point_not_each_series_latest(){
    let mut input=good();for (i,value) in input.iter_mut().enumerate(){value.as_mut().unwrap().insert(point()+if i==0{300}else{0},999);}
    let result=report(input);assert!(result.complete);assert_eq!(result.measured_at,Some(utc(point())));assert_eq!(result.bytes,Some(100+999*5));assert_eq!(result.object_count,Some(999*6));
}
#[test]fn empty_or_unaligned_class_never_becomes_a_zero_or_total(){
    let mut empty=good();empty[3]=Ok(BTreeMap::new());let result=report(empty);assert!(!result.complete);assert_eq!(result.bytes,None);assert_eq!(result.classes[1].object_count,None);assert_eq!(result.classes[1].state,"partial");
    let mut unaligned=good();unaligned[1]=series(point()-300,2);let result=report(unaligned);assert!(!result.complete);assert_eq!(result.measured_at,None);assert_eq!(result.classes[0].measured_at,None);assert_eq!(result.classes[0].bytes,None);assert_eq!(result.classes[0].object_count,None);
    let mut lone=good();lone[1]=Ok(BTreeMap::new());let result=report(lone);assert_eq!(result.classes[0].bytes,Some(100));assert_eq!(result.classes[0].object_count,None);assert_eq!(result.classes[0].measured_at,Some(utc(point())));
    let missing=report(vec![]);assert!(!missing.complete);assert_eq!(missing.classes.len(),6);assert_eq!(missing.bytes,None);
}
#[test]fn forbidden_unsupported_and_network_failures_remain_distinct_without_server_details(){
    for(error,state)in[(QiniuError::http(403),"forbidden"),(QiniuError::http(404),"unsupported"),(QiniuError::new(CapabilityState::Unavailable,"network","固定安全错误 / Fixed safe error"),"unavailable")]{
        let mut values=good();values[4]=Err(error);let result=report(values);assert!(!result.complete);assert_eq!(result.classes[2].state,state);assert_eq!(result.classes[2].bytes,None);assert!(result.warning.is_some());
    }
}
#[test]fn stale_unknown_and_overflow_metrics_do_not_claim_bucket_coverage(){
    let stale=report((0..12).map(|_|series(point()-3600,1)).collect());assert!(!stale.complete);assert_eq!(stale.classes[0].state,"partial");
    let mut ctx=context();for _ in 0..2{ctx.region.storage_classes.push(crate::qiniu::region::QiniuStorageClass{file_type:99,kodo_name:"future-secret-class".into(),s3_name:None});}let unknown=aggregate(&ctx,&window(now()).unwrap(),good());assert!(!unknown.complete);assert_eq!(unknown.classes.last().unwrap().storage_class,"unknown:99");assert_eq!(unknown.classes.iter().filter(|row|row.storage_class=="unknown:99").count(),1);
    let overflow=report((0..12).map(|_|series(point(),MAX_SAFE)).collect());assert!(!overflow.complete);assert_eq!(overflow.bytes,None);assert_eq!(overflow.object_count,None);
}

struct Response{status:u16,body:String,location:Option<String>}
struct Server{origin:String,requests:Arc<Mutex<Vec<String>>>,worker:Option<thread::JoinHandle<()>>}
impl Drop for Server{fn drop(&mut self){if let Some(worker)=self.worker.take(){worker.join().unwrap();}}}
fn server(count:usize,reply:impl Fn(&str)->Response+Send+'static)->Server{
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();let origin=format!("http://{}",listener.local_addr().unwrap());let requests=Arc::new(Mutex::new(vec![]));let captures=requests.clone();
    let worker=thread::spawn(move||for _ in 0..count{
        let until=Instant::now()+Duration::from_secs(5);
        let (mut socket,request)=loop{
            let mut socket:TcpStream=loop{match listener.accept(){Ok((socket,_))=>break socket,Err(e)if e.kind()==std::io::ErrorKind::WouldBlock&&Instant::now()<until=>thread::sleep(Duration::from_millis(2)),_=>return}};
            socket.set_nonblocking(false).unwrap();socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();let mut bytes=vec![];let mut chunk=[0u8;8192];
            while !bytes.windows(4).any(|v|v==b"\r\n\r\n"){let n=socket.read(&mut chunk).unwrap_or(0);if n==0{break}bytes.extend_from_slice(&chunk[..n]);}
            if bytes.is_empty(){if Instant::now()>=until{return}continue}break(socket,String::from_utf8(bytes).unwrap())
        };
        let target=request.lines().next().unwrap().split_whitespace().nth(1).unwrap().to_string();captures.lock().unwrap().push(request);let response=reply(&target);
        let location=response.location.map(|v|format!("Location: {v}\r\n")).unwrap_or_default();let wire=format!("HTTP/1.1 {} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{location}\r\n{}",response.status,response.body.len(),response.body);let _=socket.write_all(wire.as_bytes());let _=socket.shutdown(std::net::Shutdown::Write);
    });Server{origin,requests,worker:Some(worker)}
}
fn client(origin:&str)->QiniuClient{
    let mut client=QiniuClient::new(QiniuConfig{mode:QiniuMode::Private,uc_url:Some(origin.into()),..Default::default()},QiniuCredentials::new("fixture-ak".into(),"fixture-sk".into(),None).unwrap()).unwrap();
    client.http=reqwest::Client::builder().no_proxy().http1_only().pool_max_idle_per_host(0).redirect(reqwest::redirect::Policy::none()).build().unwrap();client
}
#[test]fn production_scope_refuses_private_temporary_and_binding_identities_before_network(){runtime().block_on(async{
    let private=client("http://127.0.0.1:9");assert!(private.classified_usage(&context(),now()).await.is_err());
    let temporary=QiniuClient::new(QiniuConfig::default(),QiniuCredentials::new("fixture-ak".into(),"fixture-sk".into(),Some("temporary-token".into())).unwrap()).unwrap();assert!(temporary.classified_usage(&context(),now()).await.is_err());
    let public=QiniuClient::new(QiniuConfig::default(),QiniuCredentials::new("fixture-ak".into(),"fixture-sk".into(),None).unwrap()).unwrap();let mut ctx=context();ctx.backend_mode="s3".into();assert!(public.classified_usage(&ctx,now()).await.is_err());
})}
#[test]fn http_contract_uses_native_bucket_dated_signature_and_exact_class_parameters(){runtime().block_on(async{
    let fixture=server(12,|target|Response{status:200,body:json!({"times":[point()],"datas":[if target.starts_with("/v6/space"){100}else{2}]}).to_string(),location:None});let client=client(&fixture.origin);
    let result=client.classified_usage_at(&context(),now(),&fixture.origin).await.unwrap();assert!(result.complete);assert_eq!(result.bytes,Some(600));
    let requests=fixture.requests.lock().unwrap();assert_eq!(requests.len(),12);
    for request in requests.iter(){
        let target=request.lines().next().unwrap().split_whitespace().nth(1).unwrap();let url=Url::parse(&format!("{}{target}",fixture.origin)).unwrap();let q=url.query_pairs().collect::<BTreeMap<_,_>>();assert_eq!(q.get("bucket").unwrap(),"native-name");assert_eq!(q.get("g").unwrap(),"5min");assert!(!q.contains_key("tier"));assert!(!q.contains_key("region"));
        let path=url.path();let exclude=path.starts_with("/v6/space_")&&!path.ends_with("intelligent_tiering");assert_eq!(q.get("no_predel").map(|v|v.as_ref()),exclude.then_some("1"));
        let header=|name:&str|request.lines().find_map(|line|{let(k,v)=line.split_once(':')?;k.eq_ignore_ascii_case(name).then(||v.trim().to_string())}).unwrap();
        let stamp=header("x-qiniu-date");let headers=BTreeMap::from([("X-Qiniu-Date".into(),stamp)]);let expected=auth::access_token_v2("fixture-ak","fixture-sk","GET",&url,Some("application/x-www-form-urlencoded"),&headers,&[]).unwrap();assert_eq!(header("authorization"),expected);assert!(!request.contains("fixture-sk"));assert!(!request.contains("s3-alias"));
    }
})}
#[test]fn http_partial_failures_are_not_zero_filled_and_redirects_are_not_followed(){runtime().block_on(async{
    let sink=TcpListener::bind("127.0.0.1:0").unwrap();sink.set_nonblocking(true).unwrap();let location=format!("http://{}/steal",sink.local_addr().unwrap());
    let fixture=server(12,move|target|if target.starts_with("/v6/space_line?"){Response{status:403,body:"{\"error\":\"remote-secret\"}".into(),location:None}}else if target.starts_with("/v6/count_archive?"){Response{status:302,body:String::new(),location:Some(location.clone())}}else{Response{status:200,body:json!({"times":[point()],"datas":[0]}).to_string(),location:None}});
    let result=client(&fixture.origin).classified_usage_at(&context(),now(),&fixture.origin).await.unwrap();assert!(!result.complete);assert_eq!(result.classes[1].state,"forbidden");assert_eq!(result.classes[1].bytes,None);assert!(!serde_json::to_string(&result).unwrap().contains("remote-secret"));assert!(sink.accept().is_err());
})}
