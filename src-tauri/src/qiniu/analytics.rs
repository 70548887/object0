//! Read-only classified public-cloud statistics. Every series retains its
//! timestamp; missing metrics are never represented as zero or a bucket total.
use super::{CapabilityState,QiniuClient,QiniuError,QiniuMode,ResolvedBucketContext};
use chrono::{DateTime,FixedOffset,TimeZone,Utc};
use futures_util::{future::BoxFuture,stream,StreamExt};
use serde::Serialize;
use serde_json::Value;
use std::{collections::{BTreeMap,BTreeSet},time::Duration};

pub const PUBLIC_ANALYTICS_ORIGIN:&str="https://api.qiniuapi.com";
const MAX_SAFE:u64=9_007_199_254_740_991;
const MAX_POINTS:usize=300;
const MAX_AGE:i64=30*60;

#[derive(Clone,Copy)]
struct Class {id:&'static str,file_type:u8,suffix:&'static str,no_predel:bool}
const CLASSES:[Class;6]=[
    Class{id:"standard",file_type:0,suffix:"",no_predel:false},
    Class{id:"line",file_type:1,suffix:"_line",no_predel:true},
    Class{id:"intelligent_tiering",file_type:5,suffix:"_intelligent_tiering",no_predel:false},
    Class{id:"archive_ir",file_type:4,suffix:"_archive_ir",no_predel:true},
    Class{id:"archive",file_type:2,suffix:"_archive",no_predel:true},
    Class{id:"deep_archive",file_type:3,suffix:"_deep_archive",no_predel:true},
];

#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ClassUsage {
    pub storage_class:String,pub bytes:Option<u64>,pub object_count:Option<u64>,
    pub measured_at:Option<String>,pub state:&'static str,
    #[serde(skip_serializing_if="Option::is_none")] pub reason:Option<String>,
}
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct AnalyticsReport {
    pub bytes:Option<u64>,pub object_count:Option<u64>,pub measured_at:Option<String>,
    pub complete:bool,pub classes:Vec<ClassUsage>,
    #[serde(skip_serializing_if="Option::is_none")] pub warning:Option<String>,
}

#[derive(Clone)]
struct Window {begin:String,end:String,start:i64,finish:i64}
fn invalid()->QiniuError{QiniuError::invalid("七牛统计时间或数值格式无效 / Invalid Qiniu analytics timestamps or values")}
fn window(now:DateTime<Utc>)->Result<Window,QiniuError>{
    let zone=FixedOffset::east_opt(8*3600).ok_or_else(invalid)?;let local=now.with_timezone(&zone);
    let midnight=local.date_naive().and_hms_opt(0,0,0).ok_or_else(invalid)?;
    let start=zone.from_local_datetime(&midnight).single().ok_or_else(invalid)?;
    Ok(Window{begin:start.format("%Y%m%d%H%M%S").to_string(),end:local.format("%Y%m%d%H%M%S").to_string(),start:start.timestamp(),finish:now.timestamp()})
}
type Series=BTreeMap<i64,u64>;
fn parse_series(value:Value,window:&Window)->Result<Series,QiniuError>{
    let times=value.get("times").and_then(Value::as_array).ok_or_else(invalid)?;
    let datas=value.get("datas").and_then(Value::as_array).ok_or_else(invalid)?;
    if times.len()!=datas.len()||times.len()>MAX_POINTS{return Err(invalid())}
    let mut series=BTreeMap::new();
    for (time,data) in times.iter().zip(datas){
        let timestamp=time.as_i64().ok_or_else(invalid)?;
        let number=data.as_u64().filter(|n|*n<=MAX_SAFE).ok_or_else(invalid)?;
        if timestamp<window.start||timestamp>=window.finish||timestamp%300!=0||series.insert(timestamp,number).is_some(){return Err(invalid())}
    }
    Ok(series)
}
fn utc(timestamp:i64)->String{DateTime::<Utc>::from_timestamp(timestamp,0).expect("validated timestamp").to_rfc3339()}
fn state(error:&QiniuError)->&'static str{match error.state{CapabilityState::Forbidden=>"forbidden",CapabilityState::Unsupported=>"unsupported",_=>"unavailable"}}
fn series_latest(series:&Result<Series,QiniuError>)->Option<(i64,u64)>{series.as_ref().ok().and_then(|v|v.last_key_value()).map(|(t,n)|(*t,*n))}

/// A complete total is selected at one point common to all twelve successful
/// series. Per-class data may remain useful even when no complete total exists.
fn aggregate(context:&ResolvedBucketContext,window:&Window,mut series:Vec<Result<Series,QiniuError>>)->AnalyticsReport{
    let shape_valid=series.len()==12;
    // Transport currently always supplies twelve results. Still fail closed if
    // an incomplete future caller accidentally omits a metric result.
    while series.len()<12{series.push(Err(invalid()));}
    series.truncate(12);
    let unknown=context.region.storage_classes.iter().any(|class|!CLASSES.iter().any(|known|known.file_type==class.file_type));
    let all=shape_valid&&series.iter().all(Result::is_ok);
    let common=if all {
        let mut candidates: BTreeSet<i64>=series[0].as_ref().unwrap().keys().copied().collect();
        for next in series.iter().skip(1){candidates.retain(|time|next.as_ref().unwrap().contains_key(time));}
        candidates.last().copied().filter(|time|window.finish.saturating_sub(*time)<=MAX_AGE)
    }else{None};
    let mut classes=Vec::new();
    for (index,class) in CLASSES.iter().enumerate(){
        let bytes=&series[index*2];let count=&series[index*2+1];
        let pair=match (bytes,count){(Ok(a),Ok(b))=>a.keys().rev().find(|time|b.contains_key(time)).copied(),_=>None};
        let point=common.or(pair);
        let mut row=ClassUsage{storage_class:class.id.into(),bytes:None,object_count:None,measured_at:None,state:"partial",reason:None};
        if let Some(time)=point {
            row.bytes=bytes.as_ref().ok().and_then(|v|v.get(&time)).copied();row.object_count=count.as_ref().ok().and_then(|v|v.get(&time)).copied();row.measured_at=Some(utc(time));
            if window.finish.saturating_sub(time)<=MAX_AGE {row.state="available"}else{row.reason=Some("官方分类快照已延迟，不作为当前完整用量 / Official class snapshot is stale and is not a current complete total".into())}
        }else{
            // Preserve provenance for a lone metric. Two nonempty but
            // disjoint series cannot share this row's single timestamp, so do
            // not display their unrelated latest numbers side by side.
            match (series_latest(bytes),series_latest(count)) {
                (Some((time,value)),None)=>{row.bytes=Some(value);row.measured_at=Some(utc(time));}
                (None,Some((time,value)))=>{row.object_count=Some(value);row.measured_at=Some(utc(time));}
                _=>{},
            }
            row.reason=Some("分类指标缺项、为空或时间未对齐，未计入全桶总量 / Class metrics are missing, empty or unaligned and were not counted as a bucket total".into());
        }
        if let Some(error)=bytes.as_ref().err().or_else(||count.as_ref().err()) {row.state=state(error);row.reason=Some(error.to_string());}
        classes.push(row);
    }
    let unknown_types:BTreeSet<u8>=context.region.storage_classes.iter().filter(|c|!CLASSES.iter().any(|known|known.file_type==c.file_type)).map(|c|c.file_type).collect();
    for file_type in unknown_types {
        classes.push(ClassUsage{storage_class:format!("unknown:{file_type}"),bytes:None,object_count:None,measured_at:None,state:"unsupported",reason:Some("该区域返回未知存储类型，无法确认统计覆盖完整 / Region returned an unknown storage class; complete coverage is unconfirmed".into())});
    }
    let totals=common.filter(|_|!unknown).and_then(|_|{
        let bytes=classes.iter().try_fold(0u64,|sum,c|sum.checked_add(c.bytes?).filter(|v|*v<=MAX_SAFE))?;
        let count=classes.iter().try_fold(0u64,|sum,c|sum.checked_add(c.object_count?).filter(|v|*v<=MAX_SAFE))?;Some((bytes,count))
    });
    AnalyticsReport{bytes:totals.map(|v|v.0),object_count:totals.map(|v|v.1),measured_at:if totals.is_some(){common.map(utc)}else{None},complete:totals.is_some(),classes,
        warning:if totals.is_some(){None}else{Some("官方统计分类不完整、未对齐、延迟或超出安全数值范围；未生成全桶总量 / Official class statistics are incomplete, unaligned, delayed or outside safe numeric limits; no bucket total was generated".into())}}
}

impl QiniuClient {
    pub async fn classified_usage(&self,context:&ResolvedBucketContext,now:DateTime<Utc>)->Result<AnalyticsReport,QiniuError>{
        if self.config().mode!=QiniuMode::Public||!self.native_analytics_credentials()||context.backend_mode!="kodo"{
            return Err(QiniuError::unsupported("此连接尚未验证七牛官方分类统计 / Official Qiniu classified analytics is not verified for this connection"));
        }
        self.classified_usage_at(context,now,PUBLIC_ANALYTICS_ORIGIN).await
    }
    async fn classified_usage_at(&self,context:&ResolvedBucketContext,now:DateTime<Utc>,origin:&str)->Result<AnalyticsReport,QiniuError>{
        let bucket=&context.bucket.name;
        if bucket.is_empty()||bucket.len()>255||bucket.chars().any(char::is_control){return Err(invalid())}
        let window=window(now)?;
        let endpoint=super::endpoint::parse_endpoint(origin,self.config().mode==QiniuMode::Private)?;
        self.policy.ensure(&endpoint)?;
        let stamp=Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        // Owned, explicitly Send futures avoid borrowing iterator closures
        // across the async Tauri command boundary (a higher-ranked Send
        // inference failure otherwise propagates to unrelated RPC branches).
        let mut jobs:Vec<BoxFuture<'static,(usize,Result<Series,QiniuError>)>>=Vec::with_capacity(12);
        for (class_index,class) in CLASSES.into_iter().enumerate(){for (metric_index,bytes) in [true,false].into_iter().enumerate(){
            let index=class_index*2+metric_index;
            let mut url=endpoint.clone();url.set_path(&format!("/v6/{}{}",if bytes{"space"}else{"count"},class.suffix));
            {let mut query=url.query_pairs_mut();query.append_pair("bucket",bucket).append_pair("begin",&window.begin).append_pair("end",&window.end).append_pair("g","5min");
                if bytes&&class.no_predel{query.append_pair("no_predel","1");}
                // Bucket is explicit and unique within this account. Avoid an
                // undefined region parameter on count_intelligent_tiering and
                // never substitute an S3 region alias for a Kodo region ID.
            }
            let stamp=stamp.clone();let queried_window=window.clone();let client=self.clone();
            jobs.push(Box::pin(async move{let result=tokio::time::timeout(Duration::from_secs(4),client.analytics_json(url,&stamp)).await
                .map_err(|_|QiniuError::new(CapabilityState::Unavailable,"analytics-timeout","七牛分类统计请求超时 / Qiniu class statistics request timed out"))
                .and_then(|v|v).and_then(|v|parse_series(v,&queried_window));(index,result)}));
        }}
        let mut results=stream::iter(jobs).buffer_unordered(3).collect::<Vec<_>>().await;results.sort_by_key(|(index,_)|*index);
        Ok(aggregate(context,&window,results.into_iter().map(|(_,result)|result).collect()))
    }
}

#[cfg(test)]
#[path="analytics_tests.rs"]
mod tests;
