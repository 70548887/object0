use super::{auth,endpoint::{EndpointPolicy,PUBLIC_UC},region::{parse_buckets,QiniuRegion,ResolvedBucketContext},Capability,CapabilityState,ConnectionReport,QiniuBucket,QiniuConfig,QiniuError,QiniuMode};
use reqwest::{Client,Method};
use serde::{Deserialize,Serialize};
use serde_json::Value;
use std::{collections::{BTreeMap,HashMap},fmt,sync::{Arc,Mutex},time::Duration};
use url::Url;

const MAX_JSON_BYTES:usize=4*1024*1024;

#[derive(Clone)]
pub struct QiniuCredentials {access_key:String,secret_key:String,session_token:Option<String>}
impl fmt::Debug for QiniuCredentials {
    fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result {f.debug_struct("QiniuCredentials").field("access_key",&"[redacted]").field("secret_key",&"[redacted]").field("temporary",&self.session_token.is_some()).finish()}
}
impl QiniuCredentials {
    pub fn new(access_key:String,secret_key:String,session_token:Option<String>)->Result<Self,QiniuError> {
        let valid=|value:&str|!value.trim().is_empty()&&value.len()<=4096&&!value.contains(['\r','\n','\0']);
        if !valid(&access_key)||!valid(&secret_key)||session_token.as_ref().is_some_and(|value|!valid(value)) {return Err(QiniuError::invalid("七牛凭据为空或格式无效 / Missing or invalid Qiniu credentials"));}
        Ok(Self {access_key,secret_key,session_token})
    }
    pub fn is_temporary(&self)->bool {self.session_token.is_some()}
}
#[derive(Default)]
struct DiscoveryCache {regions:Vec<QiniuRegion>,buckets:Option<(i64,Vec<QiniuBucket>)>,bucket_regions:HashMap<String,QiniuRegion>}

/// One client belongs to one profile revision/environment. Do not cache it by
/// AK/SK strings; profile ID + revision is the caller's cache boundary.
#[derive(Clone)]
pub struct QiniuClient {pub(super) config:QiniuConfig,credentials:QiniuCredentials,pub(super) http:Client,pub(super) policy:EndpointPolicy,cache:Arc<Mutex<DiscoveryCache>>}
impl fmt::Debug for QiniuClient {
    fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result {f.debug_struct("QiniuClient").field("mode",&self.config.mode).field("credentials",&self.credentials).finish_non_exhaustive()}
}

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct QiniuObject {pub key:String,pub size:u64,pub etag:String,pub last_modified:String,pub mime_type:Option<String>,pub storage_type:Option<u8>,pub restore_status:Option<u8>,pub metadata:BTreeMap<String,String>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct QiniuListPage {pub objects:Vec<QiniuObject>,pub prefixes:Vec<String>,pub next_cursor:Option<String>,pub is_truncated:bool}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct QiniuBatchResult {pub key:String,pub success:bool,pub status:u16,pub error:Option<QiniuError>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct QiniuBucketDetails {pub is_private:bool,pub protected:bool,pub permission:Option<String>,pub region_id:Option<String>}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct CreatedBucket {pub name:String,pub private_verified:bool}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct QiniuDomain {pub name:String,pub protocol:String,pub kind:String,pub api_scope:String,pub is_private:Option<bool>,pub protected:Option<bool>,pub configured:bool}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct DomainReport {pub domains:Vec<QiniuDomain>,pub origins:Capability,pub cdn:Capability,pub bucket_info:Capability}

impl QiniuClient {
    pub fn new(config:QiniuConfig,credentials:QiniuCredentials)->Result<Self,QiniuError> {
        let policy=EndpointPolicy::new(&config)?;
        let mut builder=Client::builder().connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none()).user_agent("Yuncang/1 Qiniu-native");
        if let Some(bytes)=super::endpoint::read_private_ca(&config)? {
            for cert in reqwest::Certificate::from_pem_bundle(&bytes).map_err(|_|QiniuError::invalid("私有云 CA 格式无效 / Invalid private-cloud CA"))? {
                builder=builder.add_root_certificate(cert);
            }
        }
        let http=builder.build().map_err(|_|QiniuError::invalid("无法创建七牛连接 / Could not initialize Qiniu HTTP client"))?;
        Ok(Self {config,credentials,http,policy,cache:Arc::new(Mutex::new(DiscoveryCache::default()))})
    }
    pub fn config(&self)->&QiniuConfig {&self.config}
    pub(super) fn native_analytics_credentials(&self)->bool { !self.credentials.is_temporary() && self.config.bucket_bindings.is_empty() }
    /// Dedicated statistics transport: dated V2 signing, bounded JSON and no
    /// redirects (the client's common HTTP policy), never raw server errors.
    pub(super) async fn analytics_json(&self,url:Url,stamp:&str)->Result<Value,QiniuError> {
        self.policy.ensure(&url)?;
        if !self.native_analytics_credentials(){return Err(QiniuError::unsupported("此身份没有原生统计通道 / Native analytics is unavailable for this identity"));}
        let content_type="application/x-www-form-urlencoded";
        let headers=BTreeMap::from([("X-Qiniu-Date".to_string(),stamp.to_string())]);
        let authorization=auth::access_token_v2(&self.credentials.access_key,&self.credentials.secret_key,"GET",&url,Some(content_type),&headers,&[])?;
        let mut response=self.http.get(url).header(reqwest::header::CONTENT_TYPE,content_type)
            .header("X-Qiniu-Date",stamp).header(reqwest::header::AUTHORIZATION,authorization).send().await.map_err(network_error)?;
        if response.status().as_u16()!=200{return Err(QiniuError::http(response.status().as_u16()));}
        const LIMIT:usize=512*1024;
        if response.content_length().is_some_and(|n|n>LIMIT as u64){return Err(QiniuError::invalid("七牛统计响应过大 / Qiniu analytics response is too large"));}
        let mut bytes=Vec::new();
        while let Some(chunk)=response.chunk().await.map_err(network_error)? {
            if bytes.len().saturating_add(chunk.len())>LIMIT{return Err(QiniuError::invalid("七牛统计响应过大 / Qiniu analytics response is too large"));}
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_|QiniuError::invalid("七牛统计响应格式无效 / Invalid Qiniu analytics response"))
    }
    pub fn clear_cache(&self) {if let Ok(mut cache)=self.cache.lock(){*cache=DiscoveryCache::default();}}
    pub fn validate_s3_endpoint(&self,value:&str)->Result<Url,QiniuError> {
        let endpoint=super::endpoint::parse_endpoint(value,self.config.mode==QiniuMode::Private)?;self.policy.ensure(&endpoint)?;Ok(endpoint)
    }
    fn uc(&self)->Result<Url,QiniuError> {super::endpoint::parse_endpoint(self.config.uc_url.as_deref().unwrap_or(PUBLIC_UC),self.config.mode==QiniuMode::Private)}
    fn url(&self,endpoint:&Url,path:&str,query:&[(&str,&str)])->Result<Url,QiniuError> {
        let mut url=endpoint.join(path.trim_start_matches('/')).map_err(|_|QiniuError::invalid("七牛请求路径无效 / Invalid Qiniu request path"))?;
        if !query.is_empty(){url.query_pairs_mut().extend_pairs(query.iter().copied());}
        self.policy.ensure(&url)?;Ok(url)
    }
    async fn request(&self,method:Method,url:Url,content_type:Option<&str>,body:Vec<u8>,signed:bool)->Result<Value,QiniuError> {
        self.policy.ensure(&url)?;
        if signed&&!self.config.bucket_bindings.is_empty(){return Err(QiniuError::unsupported("显式空间模式仅使用已验证的 S3 绑定，不执行原生管理操作 / Explicit bucket mode uses verified S3 bindings only; native management operations are disabled"));}
        if signed&&self.credentials.is_temporary(){return Err(QiniuError::unsupported("临时凭据应使用 S3 路径；此原生管理接口未确认支持会话令牌 / Use S3 for temporary credentials"));}
        let content_type=content_type.unwrap_or("application/x-www-form-urlencoded");
        let mut request=self.http.request(method.clone(),url.as_str()).header(reqwest::header::CONTENT_TYPE,content_type);
        if signed {
            let authorization=auth::access_token_v2(&self.credentials.access_key,&self.credentials.secret_key,method.as_str(),&url,Some(content_type),&BTreeMap::new(),&body)?;
            request=request.header(reqwest::header::AUTHORIZATION,authorization);
        }
        let mut response=request.body(body).send().await.map_err(network_error)?;
        if !response.status().is_success(){return Err(QiniuError::http(response.status().as_u16()));}
        if response.content_length().is_some_and(|size|size>MAX_JSON_BYTES as u64){return Err(QiniuError::invalid("七牛响应过大 / Qiniu JSON response exceeds size limit"));}
        let mut bytes=Vec::new();
        while let Some(chunk)=response.chunk().await.map_err(network_error)? {
            if bytes.len().saturating_add(chunk.len())>MAX_JSON_BYTES{return Err(QiniuError::invalid("七牛响应过大 / Qiniu JSON response exceeds size limit"));}
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty(){return Ok(Value::Null);}
        serde_json::from_slice(&bytes).map_err(|_|QiniuError::invalid("七牛响应格式无效 / Invalid Qiniu JSON response"))
    }
    /// Available for provider extensions, but only after this client's trust
    /// policy validates the endpoint and without exposing the Authorization.
    pub async fn management_json(&self,method:Method,endpoint:&str,path:&str,query:&[(&str,&str)],body:Option<Value>)->Result<Value,QiniuError> {
        let endpoint=super::endpoint::parse_endpoint(endpoint,self.config.mode==QiniuMode::Private)?;
        let url=self.url(&endpoint,path,query)?;
        let body=body.map(|body|serde_json::to_vec(&body).map_err(|_|QiniuError::invalid("七牛请求编码失败 / Could not encode Qiniu request"))).transpose()?;
        self.request(method,url,body.as_ref().map(|_|"application/json"),body.unwrap_or_default(),true).await
    }
    pub async fn discover_regions(&self)->Result<Vec<QiniuRegion>,QiniuError> {
        if !self.config.bucket_bindings.is_empty(){
            let mut regions=Vec::new();
            for binding in &self.config.bucket_bindings {
                let context=super::bucket_binding::context(binding,&self.config)?;
                if !regions.iter().any(|region:&QiniuRegion|region.s3_region_id==context.region.s3_region_id&&region.s3_urls==context.region.s3_urls){regions.push(context.region);}
            }
            return Ok(regions);
        }
        let manual=QiniuRegion::manual_regions(&self.config);if !manual.is_empty(){return Ok(manual);}
        let now=chrono::Utc::now().timestamp();
        if let Ok(cache)=self.cache.lock(){if !cache.regions.is_empty()&&cache.regions.iter().all(|region|region.expires_at>now){return Ok(cache.regions.clone());}}
        let url=self.url(&self.uc()?,"regions",&[])?;
        let scheme=url.scheme().to_string();
        let value=self.request(Method::GET,url,None,vec![],true).await?;
        let items=value.get("regions").and_then(Value::as_array).ok_or_else(||QiniuError::invalid("七牛区域列表响应格式无效 / Invalid region list response"))?;
        let regions=items.iter().map(|item|QiniuRegion::from_response(item,&scheme,now)).collect::<Result<Vec<_>,_>>()?;
        if regions.is_empty(){return Err(QiniuError::unsupported("当前七牛环境没有可用区域，请配置私有云区域 / No regions were returned; configure private regions if applicable"));}
        if let Ok(mut cache)=self.cache.lock(){cache.regions=regions.clone();}Ok(regions)
    }
    pub async fn query_bucket_region(&self,bucket:&str)->Result<QiniuRegion,QiniuError> {
        validate_bucket(bucket)?;let now=chrono::Utc::now().timestamp();
        if let Ok(cache)=self.cache.lock(){if let Some(region)=cache.bucket_regions.get(bucket).filter(|region|region.expires_at>now){return Ok(region.clone());}}
        let url=self.url(&self.uc()?,"v4/query",&[("ak",&self.credentials.access_key),("bucket",bucket)])?;
        let scheme=url.scheme().to_string();
        // This discovery endpoint requires the AK query, not a long-lived SK.
        let value=self.request(Method::GET,url,None,vec![],false).await?;
        let item=value.get("hosts").and_then(Value::as_array).and_then(|hosts|hosts.first()).ok_or_else(||QiniuError::invalid("七牛桶区域响应缺少 hosts / Bucket discovery returned no hosts"))?;
        let region=QiniuRegion::from_response(item,&scheme,now)?;
        if let Ok(mut cache)=self.cache.lock(){cache.bucket_regions.insert(bucket.to_string(),region.clone());}Ok(region)
    }
    pub async fn list_buckets(&self)->Result<Vec<QiniuBucket>,QiniuError> {
        if !self.config.bucket_bindings.is_empty(){
            let mut buckets=Vec::with_capacity(self.config.bucket_bindings.len());
            for binding in &self.config.bucket_bindings {buckets.push(self.verify_bucket_binding(binding).await?.bucket);}
            return Ok(buckets);
        }
        if self.credentials.is_temporary(){return Err(QiniuError::unsupported("临时凭据需配置明确的空间 S3 标识、区域和地址 / Temporary credentials require explicit bucket S3 ID, region and endpoint bindings"));}
        let now=chrono::Utc::now().timestamp();
        if let Ok(cache)=self.cache.lock(){if let Some((expires,buckets))=&cache.buckets{if *expires>now{return Ok(buckets.clone());}}}
        let url=self.url(&self.uc()?,"v2/buckets",&[("shared","rd")])?;
        let buckets=parse_buckets(&self.request(Method::GET,url,None,vec![],true).await?)?;
        if let Ok(mut cache)=self.cache.lock(){cache.buckets=Some((now+60,buckets.clone()));}Ok(buckets)
    }
    pub async fn resolve_named_bucket(&self,name:&str)->Result<ResolvedBucketContext,QiniuError> {
        if !self.config.bucket_bindings.is_empty(){
            let binding=self.config.bucket_bindings.iter().find(|binding|binding.native_name==name||binding.s3_name==name)
                .ok_or_else(||QiniuError::new(CapabilityState::Forbidden,"bucket-not-bound","当前账号未配置此空间绑定 / This bucket is outside the configured binding scope"))?;
            return self.verify_bucket_binding(binding).await;
        }
        let bucket=self.list_buckets().await?.into_iter().find(|bucket|bucket.name==name||bucket.s3_name.as_deref()==Some(name)).ok_or_else(||QiniuError::new(CapabilityState::Forbidden,"bucket-not-listed","当前账号未列出此空间，请检查名称和授权 / Bucket is not listed for this account"))?;
        self.resolve_bucket(&bucket).await
    }
    pub async fn resolve_bucket(&self,bucket:&QiniuBucket)->Result<ResolvedBucketContext,QiniuError> {
        if !self.config.bucket_bindings.is_empty(){
            let binding=self.config.bucket_bindings.iter().find(|binding|binding.native_name==bucket.name&&bucket.s3_name.as_deref()==Some(binding.s3_name.as_str()))
                .ok_or_else(||QiniuError::new(CapabilityState::Forbidden,"bucket-not-bound","空间身份与显式绑定不一致 / Bucket identity does not match an explicit binding"))?;
            return self.verify_bucket_binding(binding).await;
        }
        validate_bucket(&bucket.name)?;
        let region=if !self.config.regions.is_empty() {
            let manual=QiniuRegion::manual_regions(&self.config);
            if manual.len()==1 {
                let mut region=manual[0].clone();
                region.kodo_region_id=bucket.kodo_region_id.clone();
                region
            }else if bucket.kodo_region_id.is_some(){
                // Manual IDs are S3 IDs, not assumed native IDs. Query native
                // discovery before matching instead of conflating z0/east.
                match self.query_bucket_region(&bucket.name).await {
                    Ok(queried)=>manual.into_iter().find(|region|region.s3_region_id==queried.s3_region_id).ok_or_else(||QiniuError::invalid("空间区域未出现在手工配置中 / Bucket region is missing from manual configuration"))?,
                    Err(error)=>return Err(error),
                }
            }else {
                let queried=self.query_bucket_region(&bucket.name).await?;
                manual.into_iter().find(|region|region.s3_region_id==queried.s3_region_id).ok_or_else(||QiniuError::invalid("无法匹配空间与手工区域 / Could not match bucket to configured region"))?
            }
        }else{self.query_bucket_region(&bucket.name).await?};
        for value in &region.s3_urls{self.validate_s3_endpoint(value)?;}
        Ok(ResolvedBucketContext {bucket:bucket.clone(),s3_bucket_name:bucket.s3_name.clone(),region,backend_mode:if self.config.mode==QiniuMode::Public&&!self.credentials.is_temporary(){"kodo".into()}else{"s3".into()}})
    }
    pub async fn test_connection(&self,default_bucket:Option<&str>)->ConnectionReport {
        if !self.config.bucket_bindings.is_empty(){return self.test_bound_connection(default_bucket).await;}
        let regions=self.discover_regions().await;
        let buckets=self.list_buckets().await;
        let authentication=match &buckets {Ok(_)=>Capability::supported(),Err(error)=>Capability::from_error(error)};
        let bucket_access=match (&buckets,default_bucket.filter(|name|!name.trim().is_empty())) {
            (Ok(buckets),Some(name))=>match buckets.iter().find(|bucket|bucket.name==name||bucket.s3_name.as_deref()==Some(name)) {
                Some(bucket)=>match self.resolve_bucket(bucket).await {
                    Ok(context) if context.backend_mode=="kodo"=>match self.list_objects(&context,"",Some("/"),None,1).await {Ok(_)=>Capability::supported(),Err(error)=>Capability::from_error(&error)},
                    Ok(_)=>Capability {state:CapabilityState::Unknown,reason:Some("已解析空间；需通过 S3 读取接口验证访问权限 / Bucket resolved; verify access with S3".into())},
                    Err(error)=>Capability::from_error(&error)
                },
                None=>Capability {state:CapabilityState::Forbidden,reason:Some("默认空间未出现在授权列表中 / Default bucket is not listed".into())},
            },
            (Ok(_),None)=>Capability {state:CapabilityState::Unknown,reason:Some("尚未选择空间，未验证对象列表权限 / No bucket selected; object listing permission is unverified".into())},(Err(error),_)=>Capability::from_error(error),
        };
        let download_domain=if self.config.download_domain.is_some(){Capability {state:CapabilityState::Unknown,reason:Some("域名已配置，访问能力需针对空间验证 / Domain configured; verify access for the selected bucket".into())}}else{Capability {state:CapabilityState::Unknown,reason:Some("未配置自定义下载域名；默认域名可能受文件类型限制 / No custom download domain; default domain restrictions may apply".into())}};
        ConnectionReport {authentication,bucket_access,region_discovery:match regions{Ok(_)=>Capability::supported(),Err(error)=>Capability::from_error(&error)},download_domain,buckets:buckets.unwrap_or_default()}
    }

    /// Explicit scope mode never calls account-wide native management or
    /// guesses an S3 alias. Every resolution rechecks an authenticated read, so
    /// a stale/expired token cannot be hidden by a successful discovery cache.
    async fn verify_bucket_binding(&self,binding:&super::QiniuBucketBinding)->Result<ResolvedBucketContext,QiniuError>{
        let context=super::bucket_binding::context(binding,&self.config)?;
        let bridge=super::s3_bridge::from_context("explicit-bucket-binding","client-revision",&self.config,&context,&self.credentials.access_key,&self.credentials.secret_key,self.credentials.session_token.as_deref())?;
        bridge.client.list_objects_v2().bucket(&bridge.bucket_name).max_keys(1).send().await.map_err(|error|{
            match error.raw_response().map(|response|response.status().as_u16()) {
                Some(404)=>QiniuError{state:CapabilityState::Unavailable,code:"s3-bucket-not-found".into(),message:"显式绑定空间不存在或 S3 地址无效 / The explicitly bound bucket was not found or its S3 endpoint is invalid".into(),status:Some(404)},
                Some(status) if status>=400=>QiniuError::http(status),
                Some(_)=>QiniuError::new(CapabilityState::Unavailable,"invalid-s3-response","七牛 S3 读取验证返回无效响应 / Qiniu S3 read validation returned an invalid response"),
                None=>QiniuError::new(CapabilityState::Unavailable,"s3-read-failed","七牛 S3 读取验证失败，请检查网络、证书、区域与凭据 / Qiniu S3 read validation failed; check network, TLS, region and credentials"),
            }
        })?;
        Ok(context)
    }

    async fn test_bound_connection(&self,default_bucket:Option<&str>)->ConnectionReport {
        let checked=self.list_buckets().await;
        let authentication=match &checked{Ok(_)=>Capability{state:CapabilityState::Supported,reason:Some("已通过显式空间 S3 认证读取；未探测账号级权限 / Authenticated S3 reads succeeded for explicit buckets; account-wide permissions were not probed".into())},Err(error)=>Capability::from_error(error)};
        let bucket_access=match &checked{
            Ok(buckets) if default_bucket.filter(|name|!name.trim().is_empty()).is_some_and(|name|!buckets.iter().any(|bucket|bucket.name==name||bucket.s3_name.as_deref()==Some(name)))=>Capability{state:CapabilityState::Forbidden,reason:Some("默认空间未配置在显式绑定范围内 / The default bucket is outside the explicit binding scope".into())},
            Ok(_)=>Capability{state:CapabilityState::Supported,reason:Some("已逐个验证全部配置空间的列表读取；写权限仍未知 / Listing reads were verified for all configured buckets; write permission remains unknown".into())},
            Err(error)=>Capability::from_error(error),
        };
        let region_discovery=match &checked{
            Ok(_)=>Capability{state:CapabilityState::Supported,reason:Some("已使用并验证用户提供的区域与 S3 映射；未执行自动发现 / User-supplied region/S3 mappings were verified; automatic discovery was not used".into())},
            Err(error)=>Capability::from_error(error),
        };
        let download_domain=Capability{state:CapabilityState::Unknown,reason:Some("显式空间通过 S3 下载，原生下载域名未验证 / Explicit buckets use S3 downloads; native download domains were not verified".into())};
        ConnectionReport{authentication,bucket_access,region_discovery,download_domain,buckets:checked.unwrap_or_default()}
    }
    pub(crate) fn service(&self,context:&ResolvedBucketContext,name:&str)->Result<Url,QiniuError> {
        let values=match name {"rs"=>&context.region.rs_urls,"rsf"=>&context.region.rsf_urls,"up"=>&context.region.up_urls,"api"=>&context.region.api_urls,"uc"=>&context.region.uc_urls,_=>return Err(QiniuError::invalid("未知七牛服务类型 / Unknown Qiniu service type"))};
        let value=values.first().ok_or_else(||QiniuError::unsupported("当前环境未提供此原生服务地址 / Native service endpoint is unavailable"))?;
        let url=super::endpoint::parse_endpoint(value,self.config.mode==QiniuMode::Private)?;self.policy.ensure(&url)?;Ok(url)
    }
    pub async fn list_objects(&self,context:&ResolvedBucketContext,prefix:&str,delimiter:Option<&str>,cursor:Option<&str>,limit:u16)->Result<QiniuListPage,QiniuError> {
        let limit=limit.clamp(1,1000).to_string();let mut query=vec![("bucket",context.bucket.name.as_str()),("prefix",prefix),("limit",limit.as_str())];
        if let Some(delimiter)=delimiter{query.push(("delimiter",delimiter));}if let Some(cursor)=cursor.filter(|cursor|!cursor.is_empty()){query.push(("marker",cursor));}
        let url=self.url(&self.service(context,"rsf")?,"list",&query)?;
        let value=self.request(Method::GET,url,None,vec![],true).await?;
        parse_list_page(&value)
    }
    pub async fn stat(&self,context:&ResolvedBucketContext,key:&str)->Result<QiniuObject,QiniuError> {
        let path=format!("stat/{}",auth::encoded_entry(&context.bucket.name,Some(key)));
        let value=self.request(Method::GET,self.url(&self.service(context,"rs")?,&path,&[])?,None,vec![],true).await?;
        parse_object(key,&value)
    }
    pub async fn delete_object(&self,context:&ResolvedBucketContext,key:&str)->Result<(),QiniuError> {
        ensure_writable(&context.bucket)?;
        let path=format!("delete/{}",auth::encoded_entry(&context.bucket.name,Some(key)));
        self.request(Method::POST,self.url(&self.service(context,"rs")?,&path,&[])?,None,vec![],true).await?;Ok(())
    }
    pub async fn delete_objects(&self,context:&ResolvedBucketContext,keys:&[String])->Result<Vec<QiniuBatchResult>,QiniuError> {
        ensure_writable(&context.bucket)?;let mut results=Vec::new();
        for chunk in keys.chunks(1000) {
            let body=url::form_urlencoded::Serializer::new(String::new()).extend_pairs(chunk.iter().map(|key|("op",format!("/delete/{}",auth::encoded_entry(&context.bucket.name,Some(key)))))).finish();
            let value=self.request(Method::POST,self.url(&self.service(context,"rs")?,"batch",&[])?,Some("application/x-www-form-urlencoded"),body.into_bytes(),true).await?;
            let items=value.as_array().filter(|items|items.len()==chunk.len()).ok_or_else(||QiniuError::invalid("七牛批量响应数量不匹配 / Qiniu batch result count mismatch"))?;
            for (key,item) in chunk.iter().zip(items){let status=item.get("code").and_then(Value::as_u64).and_then(|value|u16::try_from(value).ok()).ok_or_else(||QiniuError::invalid("七牛批量响应缺少状态 / Missing Qiniu batch item status"))?;let success=(200..300).contains(&status);results.push(QiniuBatchResult{key:key.clone(),success,status,error:if success{None}else{Some(QiniuError::http(status))}});}
        }Ok(results)
    }
    pub async fn copy_or_move(&self,source:&ResolvedBucketContext,key:&str,destination:&ResolvedBucketContext,new_key:&str,overwrite:bool,move_source:bool)->Result<(),QiniuError> {
        ensure_writable(&destination.bucket)?;if move_source{ensure_writable(&source.bucket)?;}
        if source.region.kodo_region_id.is_none()||source.region.kodo_region_id!=destination.region.kodo_region_id{return Err(QiniuError::unsupported("跨区域操作需要本机中转 / Cross-region transfer requires local relay"));}
        if source.bucket.name==destination.bucket.name&&key==new_key{return Err(QiniuError::invalid("来源和目标相同 / Source and target are identical"));}
        let operation=if move_source{"move"}else{"copy"};
        let path=format!("{operation}/{}/{}/force/{}",auth::encoded_entry(&source.bucket.name,Some(key)),auth::encoded_entry(&destination.bucket.name,Some(new_key)),if overwrite{"true"}else{"false"});
        self.request(Method::POST,self.url(&self.service(source,"rs")?,&path,&[])?,None,vec![],true).await?;Ok(())
    }
    pub fn upload_token(&self,bucket:&str,key:&str,deadline:i64,file_type:Option<u8>,overwrite:bool)->Result<String,QiniuError> {
        if !self.config.bucket_bindings.is_empty(){return Err(QiniuError::unsupported("显式空间模式不签发原生上传凭证 / Explicit bucket mode cannot issue native upload tokens"));}
        if self.credentials.is_temporary(){return Err(QiniuError::unsupported("临时凭据不签发原生上传凭证 / Temporary credentials cannot issue native upload tokens"));}
        auth::upload_token(&self.credentials.access_key,&self.credentials.secret_key,bucket,Some(key),deadline,file_type,!overwrite)
    }
    pub fn signed_download_url(&self,url:&Url,deadline:i64)->Result<Url,QiniuError> {
        if !self.config.bucket_bindings.is_empty(){return Err(QiniuError::unsupported("显式空间模式须使用 S3 下载签名 / Explicit bucket mode requires S3 download signing"));}
        if self.credentials.is_temporary(){return Err(QiniuError::unsupported("临时凭据请使用 S3 下载签名 / Use S3 download signing with temporary credentials"));}
        let configured=self.config.download_domain.as_deref().ok_or_else(||QiniuError::invalid("请先配置下载域名 / Configure a download domain first"))?;
        let origin=super::endpoint::parse_download_origin(configured,self.config.mode)?;
        if origin.origin()!=url.origin(){return Err(QiniuError::invalid("签名地址不属于配置的下载域名 / Download URL does not match configured domain"));}
        auth::private_download_url(&self.credentials.access_key,&self.credentials.secret_key,url,deadline)
    }
    pub async fn bucket_details(&self,bucket:&str)->Result<QiniuBucketDetails,QiniuError> {
        validate_bucket(bucket)?;
        let url=self.url(&self.uc()?,"v2/bucketInfo",&[("bucket",bucket)])?;
        let value=self.request(Method::POST,url,None,vec![],true).await?;
        let is_private=value.get("private").and_then(Value::as_u64).filter(|value|*value<=1).ok_or_else(||QiniuError::invalid("空间访问属性未返回，不能确认私有状态 / Bucket privacy could not be verified"))?==1;
        Ok(QiniuBucketDetails{is_private,protected:value.get("protected").and_then(Value::as_u64)!=Some(0),permission:match value.get("perm").and_then(Value::as_u64){Some(1)=>Some("readonly".into()),Some(2)=>Some("readwrite".into()),_=>None},region_id:value.get("region").and_then(Value::as_str).map(str::to_string)})
    }
    /// Creation is not reported successful until a read confirms private=1.
    /// On private-setting failure the empty bucket can remain on the server;
    /// the caller must keep it blocked for uploads until verification succeeds.
    pub async fn create_private_bucket(&self,name:&str,s3_region_id:&str)->Result<CreatedBucket,QiniuError> {
        validate_new_bucket(name)?;
        let region=self.discover_regions().await?.into_iter().find(|region|region.s3_region_id==s3_region_id).ok_or_else(||QiniuError::invalid("未找到选定的空间区域 / Selected bucket region not found"))?;
        let kodo_id=region.kodo_region_id.filter(|id|!id.is_empty()).ok_or_else(||QiniuError::unsupported("手工 S3 区域缺少原生区域标识，无法安全创建空间 / Native region ID is required to create a bucket"))?;
        let path=format!("mkbucketv3/{name}/region/{kodo_id}");
        self.request(Method::POST,self.url(&self.uc()?,&path,&[])?,None,vec![],true).await?;
        self.clear_cache();
        let set_private=self.request(Method::POST,self.url(&self.uc()?,"private",&[("bucket",name),("private","1")])?,None,vec![],true).await;
        if set_private.is_err(){return Err(QiniuError::new(CapabilityState::Unavailable,"created-privacy-unverified","空间已创建但私有设置未完成；禁止上传，请先修复访问属性 / Bucket created but privacy is unverified; uploads must stay blocked"));}
        self.verify_private_bucket(name).await?;
        Ok(CreatedBucket{name:name.to_string(),private_verified:true})
    }
    pub async fn verify_private_bucket(&self,name:&str)->Result<(),QiniuError> {
        match self.bucket_details(name).await {
            Ok(details) if details.is_private=>Ok(()),
            _=>Err(QiniuError::new(CapabilityState::Unavailable,"created-privacy-unverified","空间私有状态尚未生效；禁止上传，请稍后重新验证 / Bucket privacy has not been verified; uploads must stay blocked")),
        }
    }
    pub async fn delete_empty_bucket(&self,context:&ResolvedBucketContext)->Result<(),QiniuError> {
        ensure_writable(&context.bucket)?;
        let page=self.list_objects(context,"",None,None,1).await?;
        if !page.objects.is_empty()||!page.prefixes.is_empty()||page.is_truncated{return Err(QiniuError::invalid("空间非空，不能删除 / Bucket is not empty"));}
        self.request(Method::POST,self.url(&self.uc()?,&format!("drop/{}",context.bucket.name),&[])?,None,vec![],true).await?;
        self.clear_cache();Ok(())
    }
    pub async fn update_bucket_remark(&self,bucket:&str,remark:&str)->Result<(),QiniuError> {
        validate_bucket(bucket)?;
        if remark.chars().count()>100{return Err(QiniuError::invalid("空间备注最多 100 个字符 / Bucket remark is limited to 100 characters"));}
        let body=serde_json::to_vec(&serde_json::json!({"remark":remark})).map_err(|_|QiniuError::invalid("备注编码失败 / Could not encode bucket remark"))?;
        self.request(Method::PUT,self.url(&self.uc()?,&format!("buckets/{bucket}"),&[])?,Some("application/json"),body,true).await?;
        self.clear_cache();Ok(())
    }
    pub async fn change_storage_type(&self,context:&ResolvedBucketContext,key:&str,file_type:u8)->Result<(),QiniuError> {
        ensure_writable(&context.bucket)?;
        if !context.region.storage_classes.iter().any(|class|class.file_type==file_type){return Err(QiniuError::unsupported("当前区域未确认支持该存储类型 / The selected storage type is not supported by this region"));}
        let existing=self.stat(context,key).await?;
        if matches!(existing.storage_type,Some(2|3))&&existing.restore_status!=Some(2){return Err(QiniuError::invalid("归档对象必须先完成解冻 / Restore the archived object before changing its storage type"));}
        self.request(Method::POST,self.url(&self.service(context,"rs")?,&format!("chtype/{}/type/{file_type}",auth::encoded_entry(&context.bucket.name,Some(key))),&[])?,None,vec![],true).await?;Ok(())
    }
    pub async fn restore_archive(&self,context:&ResolvedBucketContext,key:&str,days:u8)->Result<(),QiniuError> {
        ensure_writable(&context.bucket)?;
        if !(1..=7).contains(&days){return Err(QiniuError::invalid("解冻有效天数必须为 1 至 7 天 / Restore duration must be 1 to 7 days"));}
        let existing=self.stat(context,key).await?;
        if !matches!(existing.storage_type,Some(2|3)){return Err(QiniuError::invalid("此对象不是待解冻的归档类型 / Object is not an archive type requiring restore"));}
        self.request(Method::POST,self.url(&self.service(context,"rs")?,&format!("restoreAr/{}/freezeAfterDays/{days}",auth::encoded_entry(&context.bucket.name,Some(key))),&[])?,None,vec![],true).await?;Ok(())
    }
    /// The pinned adapter routes origin certificate bindings to UC, not CDN's
    /// central API. Keep this on the configured environment's trusted origin.
    pub(super) async fn certificate_bindings(&self)->Result<Value,QiniuError>{
        self.request(Method::GET,self.url(&self.uc()?,"cert/bindings",&[])?,None,vec![],true).await
    }
    pub async fn list_domains(&self,bucket:&str)->DomainReport {
        let details=self.bucket_details(bucket).await;
        // The pinned adapter uses the portal's explicit default domain for
        // authorized/shared buckets; owner-only UC/CDN discovery can be denied.
        if self.config.mode==QiniuMode::Public && details.as_ref().is_ok_and(|value|value.permission.is_some()) {
            let result=self.management_json(Method::GET,super::share::DEFAULT_PORTAL_URL,"api/kodov2/domain/default/get",&[("bucket",bucket)],None).await
                .and_then(|value|parse_portal_default_domain(&value,details.as_ref().ok()));
            let capability=match &result{Ok(_)=>Capability::supported(),Err(error)=>Capability::from_error(error)};
            return DomainReport{domains:result.unwrap_or_default(),origins:capability.clone(),cdn:capability,bucket_info:Capability::supported()};
        }
        let origins=async {
            let value=self.request(Method::GET,self.url(&self.uc()?,"domain",&[("bucket",bucket),("type","source")])?,None,vec![],true).await?;
            let values=value.as_array().ok_or_else(||QiniuError::invalid("源站域名响应格式无效 / Invalid origin domain response"))?;
            let mut certificates=HashMap::new();
            if self.config.mode==QiniuMode::Public {
                if let Ok(value)=self.certificate_bindings().await {
                    if let Some(items)=value.as_array(){for item in items {if let Some(domain)=item.get("domain").and_then(Value::as_str){certificates.insert(domain.to_string(),true);}}}
                }
            }
            let mut result=Vec::new();
            for value in values {
                let Some(name)=value.get("domain").and_then(Value::as_str) else {return Err(QiniuError::invalid("源站域名缺少名称 / Origin domain name missing"))};
                let protocol=match value.get("protocol").and_then(Value::as_str){Some("https")=>"https",Some("http")=>"http",_=>if certificates.contains_key(name){"https"}else{"http"}};
                if name.contains(['/', '\\', '@', '?', '#']){return Err(QiniuError::invalid("源站域名无效 / Invalid origin domain"));}
                let api_scope=if value.get("api_scope").and_then(Value::as_u64)==Some(0){"kodo"}else{"s3"};
                result.push(QiniuDomain{name:name.to_string(),protocol:protocol.into(),kind:"origin".into(),api_scope:api_scope.into(),is_private:details.as_ref().ok().map(|d|d.is_private||api_scope=="s3"),protected:details.as_ref().ok().map(|d|d.protected),configured:false});
            }Ok::<_,QiniuError>(result)
        }.await;
        let cdn=if self.config.mode==QiniuMode::Public {
            let value=self.management_json(Method::GET,super::share::DEFAULT_CENTRAL_API_URL,"domain",&[("sourceTypes","qiniuBucket"),("sourceQiniuBucket",bucket),("operatingState","success"),("limit","100")],None).await;
            value.and_then(|value| {
                let items=value.get("domains").and_then(Value::as_array).ok_or_else(||QiniuError::invalid("CDN 域名响应格式无效 / Invalid CDN domain response"))?;
                let mut result=Vec::new();
                for item in items {
                    if !matches!(item.get("type").and_then(Value::as_str),Some("normal"|"pan"|"test")){continue;}
                    let Some(name)=item.get("name").and_then(Value::as_str) else {continue};
                    let Some(protocol @ ("https"|"http"))=item.get("protocol").and_then(Value::as_str) else {continue};
                    if name.contains(['/', '\\', '@', '?', '#','*']){continue;}
                    result.push(QiniuDomain{name:name.to_string(),protocol:protocol.into(),kind:if item.get("type").and_then(Value::as_str)==Some("test"){"test".into()}else{"cdn".into()},api_scope:"kodo".into(),is_private:details.as_ref().ok().map(|d|d.is_private),protected:details.as_ref().ok().map(|d|d.protected),configured:false});
                }Ok(result)
            })
        }else{Err(QiniuError::unsupported("私有云未配置 CDN 管理服务，保留源站域名能力 / Private CDN management is not configured"))};
        let mut domains=Vec::new();if let Ok(values)=&origins{domains.extend(values.iter().cloned());}if let Ok(values)=&cdn{domains.extend(values.iter().cloned());}
        if let Some(value)=&self.config.download_domain {
            if let Ok(url)=super::endpoint::parse_download_origin(value,self.config.mode){if let Some(host)=url.host_str(){domains.insert(0,QiniuDomain{name:match url.port(){Some(port)=>format!("{host}:{port}"),None=>host.into()},protocol:url.scheme().into(),kind:"custom".into(),api_scope:"kodo".into(),is_private:details.as_ref().ok().map(|d|d.is_private),protected:details.as_ref().ok().map(|d|d.protected),configured:true});}}
        }
        domains.sort_by_key(|domain|!domain.configured);domains.dedup_by(|a,b|a.name==b.name&&a.protocol==b.protocol&&a.api_scope==b.api_scope);
        DomainReport {domains,origins:match origins{Ok(_)=>Capability::supported(),Err(error)=>Capability::from_error(&error)},cdn:match cdn{Ok(_)=>Capability::supported(),Err(error)=>Capability::from_error(&error)},bucket_info:match details{Ok(_)=>Capability::supported(),Err(error)=>Capability::from_error(&error)}}
    }
}

/// Exact schema of kodo-s3-adapter-sdk@0.7.1 getDefaultDomains. Ineligible
/// default domains are an empty authorized result, never guessed as Kodo.
pub(super) fn parse_portal_default_domain(value:&Value,details:Option<&QiniuBucketDetails>)->Result<Vec<QiniuDomain>,QiniuError>{
    if !value.is_object(){return Err(QiniuError::invalid("默认下载域名响应格式无效 / Invalid default download-domain response"));}
    if value.get("isAvailable").and_then(Value::as_bool)!=Some(true) || value.get("apiScope").and_then(Value::as_u64)!=Some(0){return Ok(vec![]);}
    let name=value.get("domain").and_then(Value::as_str).filter(|value|!value.is_empty()).ok_or_else(||QiniuError::invalid("默认下载域名缺少名称 / Missing default download-domain name"))?;
    let protocol=value.get("protocol").and_then(Value::as_str).filter(|value|matches!(*value,"http"|"https")).ok_or_else(||QiniuError::invalid("默认下载域名协议无效 / Invalid default download-domain protocol"))?;
    if name.contains(['/', '\\', '@', '?', '#','*']){return Err(QiniuError::invalid("默认下载域名无效 / Invalid default download domain"));}
    super::endpoint::parse_download_origin(&format!("{protocol}://{name}"),QiniuMode::Public)?;
    let kind=match value.get("domainType").and_then(Value::as_u64){Some(0)=>"cdn",Some(1)=>"origin",_=>"other"};
    Ok(vec![QiniuDomain{name:name.into(),protocol:protocol.into(),kind:kind.into(),api_scope:"kodo".into(),is_private:details.map(|value|value.is_private),protected:details.map(|value|value.protected),configured:false}])
}

fn network_error(error:reqwest::Error)->QiniuError {
    // reqwest Display includes request URLs (AK query or signed token). It is
    // intentionally never passed to format!/logging or stored in this error.
    let (code,message)=if error.is_timeout(){("timeout","七牛连接超时 / Qiniu connection timed out")}else if error.is_connect(){("connection-failed","无法连接七牛服务，请检查地址、网络和 CA / Could not connect to Qiniu; check network, endpoint and CA")}else{("transport-failed","七牛响应传输失败 / Qiniu response transfer failed")};
    QiniuError::new(CapabilityState::Unavailable,code,message)
}

#[cfg(test)]
mod default_domain_tests {
    use super::*;
    #[test]fn pinned_portal_default_domain_preserves_scheme_type_and_bucket_access(){
        let details=QiniuBucketDetails{is_private:false,protected:false,permission:Some("readonly".into()),region_id:None};
        for (kind,expected) in [(0,"cdn"),(1,"origin")] {
            let value=serde_json::json!({"domain":"public.example","protocol":"http","isAvailable":true,"apiScope":0,"domainType":kind});
            let parsed=parse_portal_default_domain(&value,Some(&details)).unwrap();assert_eq!(parsed.len(),1);
            assert_eq!(parsed[0].protocol,"http");assert_eq!(parsed[0].kind,expected);assert_eq!(parsed[0].api_scope,"kodo");assert_eq!(parsed[0].is_private,Some(false));assert_eq!(parsed[0].protected,Some(false));
        }
    }
    #[test]fn unavailable_s3_malformed_or_foreign_shape_portal_defaults_never_become_native_domains(){
        for value in [serde_json::json!({"isAvailable":false}),serde_json::json!({"domain":"s3.example","protocol":"https","isAvailable":true,"apiScope":1,"domainType":1}),serde_json::json!({"domain":"unknown.example","protocol":"https","isAvailable":true})] {
            assert!(parse_portal_default_domain(&value,None).unwrap().is_empty());
        }
        for domain in ["bad.example/path","https://bad.example","bad.example?token=x","*.example"] {
            assert!(parse_portal_default_domain(&serde_json::json!({"domain":domain,"protocol":"https","isAvailable":true,"apiScope":0,"domainType":0}),None).is_err());
        }
        assert!(parse_portal_default_domain(&serde_json::json!([]),None).is_err());
    }
}
fn validate_bucket(bucket:&str)->Result<(),QiniuError>{if bucket.is_empty()||bucket.len()>255||bucket.contains(['\r','\n','\0','/']){Err(QiniuError::invalid("七牛空间名称无效 / Invalid Qiniu bucket name"))}else{Ok(())}}
fn validate_new_bucket(bucket:&str)->Result<(),QiniuError>{
    let edge=|byte:u8|byte.is_ascii_lowercase()||byte.is_ascii_digit();
    if !(3..=63).contains(&bucket.len())||!bucket.bytes().all(|byte|edge(byte)||byte==b'-')||!edge(bucket.as_bytes()[0])||!edge(bucket.as_bytes()[bucket.len()-1]){Err(QiniuError::invalid("新空间名须为 3 至 63 位小写字母、数字或短横线，且首尾为字母或数字 / Invalid new bucket name"))}else{Ok(())}
}
fn ensure_writable(bucket:&QiniuBucket)->Result<(),QiniuError>{if bucket.permission.as_deref()==Some("readonly"){Err(QiniuError::new(CapabilityState::Forbidden,"read-only","此空间只有读取权限 / This bucket is read-only"))}else{Ok(())}}
fn parse_object(key:&str,value:&Value)->Result<QiniuObject,QiniuError>{
    let size=value.get("fsize").and_then(Value::as_u64).ok_or_else(||QiniuError::invalid("对象大小缺失或无效 / Missing or invalid object size"))?;
    if size>9_007_199_254_740_991{return Err(QiniuError::invalid("对象大小超出安全显示范围 / Object size exceeds safe display range"));}
    // stat.lastModify includes metadata/storage-type changes. putTime is only
    // the upload timestamp and is a compatibility fallback for older listings.
    let timestamp=value.get("lastModify").filter(|value|!value.is_null()).or_else(||value.get("putTime").filter(|value|!value.is_null()));
    let time=match timestamp {
        Some(timestamp)=>{
            let ticks=timestamp.as_i64().filter(|time|*time>=0).ok_or_else(||QiniuError::invalid("对象修改时间格式无效 / Invalid object modification time"))?;
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ticks/10_000).ok_or_else(||QiniuError::invalid("对象修改时间超出支持范围 / Object modification time is outside the supported range"))?.to_rfc3339()
        },
        None=>String::new(),
    };
    let mut metadata=BTreeMap::new();
    // Older compatible endpoints may flatten these fields. Preserve their key
    // and value verbatim; the documented nested object takes precedence.
    if let Some(fields)=value.as_object(){for(name,value)in fields{if name.starts_with("x-qn-meta-"){if let Some(value)=value.as_str(){metadata.insert(name.clone(),value.to_string());}}}}
    if let Some(nested)=value.get("x-qn-meta").filter(|value|!value.is_null()) {
        let fields=nested.as_object().ok_or_else(||QiniuError::invalid("对象自定义元数据格式无效 / Invalid object custom metadata"))?;
        for(name,value)in fields {
            let text=value.as_str().ok_or_else(||QiniuError::invalid("对象自定义元数据值不是文本 / Object custom metadata value is not text"))?;
            metadata.insert(name.clone(),text.to_string());
        }
    }
    Ok(QiniuObject{key:key.to_string(),size,etag:value.get("hash").and_then(Value::as_str).unwrap_or_default().to_string(),last_modified:time,mime_type:value.get("mimeType").and_then(Value::as_str).map(str::to_string),storage_type:value.get("type").and_then(Value::as_u64).and_then(|value|u8::try_from(value).ok()),restore_status:value.get("restoreStatus").and_then(Value::as_u64).and_then(|value|u8::try_from(value).ok()),metadata})
}
pub fn parse_list_page(value:&Value)->Result<QiniuListPage,QiniuError>{
    let fields=value.as_object().ok_or_else(||QiniuError::invalid("七牛文件列表响应格式无效 / Invalid Qiniu object list response"))?;
    // A successful empty native list can omit all optional fields ({}), but
    // an error envelope or an unrelated nonempty object is not an empty page.
    // Never echo the body: it may contain endpoint or credential details.
    if fields.contains_key("error") || (!fields.is_empty() && !["items","commonPrefixes","marker"].iter().any(|name|fields.contains_key(*name))) {
        return Err(QiniuError::invalid("七牛文件列表返回错误或非列表响应，未确认空目录 / Qiniu returned an error or non-list response; an empty directory was not confirmed"));
    }
    let mut objects=Vec::new();if let Some(items)=value.get("items"){for item in items.as_array().ok_or_else(||QiniuError::invalid("七牛 items 字段格式无效 / Invalid Qiniu items field"))?{let key=item.get("key").and_then(Value::as_str).ok_or_else(||QiniuError::invalid("对象名称缺失 / Missing object key"))?;objects.push(parse_object(key,item)?);}}
    let prefixes=value.get("commonPrefixes").map(|items|items.as_array().ok_or_else(||QiniuError::invalid("七牛目录列表格式无效 / Invalid Qiniu prefixes field"))).transpose()?.map(|items|items.iter().map(|value|value.as_str().map(str::to_string).ok_or_else(||QiniuError::invalid("目录名称无效 / Invalid prefix"))).collect::<Result<Vec<_>,_>>()).transpose()?.unwrap_or_default();
    let next_cursor=match value.get("marker") {
        None=>None,
        Some(Value::String(marker)) if marker.len()<=65_536 && !marker.chars().any(char::is_control)=>if marker.is_empty(){None}else{Some(marker.clone())},
        Some(_)=>return Err(QiniuError::invalid("七牛分页标识格式无效，未确认列表完成 / Invalid Qiniu continuation marker; listing completion was not confirmed")),
    };
    Ok(QiniuListPage{objects,prefixes,is_truncated:next_cursor.is_some(),next_cursor})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn pure_prefix_pages_keep_the_server_marker() {let page=parse_list_page(&serde_json::json!({"items":[],"commonPrefixes":["中文/","other/"],"marker":"opaque+/token=="})).unwrap();assert!(page.objects.is_empty());assert_eq!(page.next_cursor.as_deref(),Some("opaque+/token=="));assert!(page.is_truncated);}
    #[test] fn object_keys_and_native_hash_are_not_normalized() {let page=parse_list_page(&serde_json::json!({"items":[{"key":"中文/+%?#.txt","fsize":0,"hash":"QiniuETag","putTime":17000000000000000i64,"type":4}]})).unwrap();assert_eq!(page.objects[0].key,"中文/+%?#.txt");assert_eq!(page.objects[0].storage_type,Some(4));assert_eq!(page.objects[0].size,0);assert!(!page.is_truncated);}
    #[test] fn malformed_lists_never_become_empty_success() {assert!(parse_list_page(&serde_json::json!({"items":"denied"})).is_err());assert!(parse_list_page(&serde_json::json!({"items":[{"key":"bad","fsize":-1}]})).is_err());}
    #[test] fn audit_native_error_envelopes_and_invalid_markers_are_not_complete_pages() {
        for value in [serde_json::json!({"error":"private-provider-detail","code":503}),serde_json::json!({"error":null,"items":[]}),serde_json::json!({"message":"private-provider-detail"}),serde_json::json!({"marker":42}),serde_json::json!({"marker":{}}),serde_json::json!({"marker":null}),serde_json::json!({"marker":"bad\nmarker"}),serde_json::json!({"marker":"x".repeat(65_537)})] {
            let error=parse_list_page(&value).unwrap_err();assert!(!error.to_string().contains("private-provider-detail"));
        }
        for value in [serde_json::json!({}),serde_json::json!({"items":[],"marker":""}),serde_json::json!({"commonPrefixes":[]})] {
            let page=parse_list_page(&value).unwrap();assert!(page.objects.is_empty());assert!(!page.is_truncated);assert!(page.next_cursor.is_none());
        }
        let page=parse_list_page(&serde_json::json!({"marker":"opaque-next"})).unwrap();assert!(page.objects.is_empty());assert!(page.is_truncated);assert_eq!(page.next_cursor.as_deref(),Some("opaque-next"));
    }
    #[test] fn diagnostics_never_retain_remote_response_or_credentials() {let credentials=QiniuCredentials::new("sensitive-ak".into(),"sensitive-sk".into(),None).unwrap();let text=format!("{credentials:?}");assert!(!text.contains("sensitive"));let denied=QiniuError::http(403);assert_eq!(denied.state,CapabilityState::Forbidden);assert_eq!(QiniuError::http(404).state,CapabilityState::Unsupported);assert_eq!(QiniuError::http(500).state,CapabilityState::Unavailable);}
    #[test] fn readonly_and_self_move_are_preflight_conditions() {let bucket=QiniuBucket{name:"bucket".into(),s3_name:None,kodo_region_id:None,created_at:None,permission:Some("readonly".into()),remark:None};assert_eq!(ensure_writable(&bucket).unwrap_err().state,CapabilityState::Forbidden);}
    #[test] fn unconfigured_host_is_rejected_before_network() {let client=QiniuClient::new(QiniuConfig::default(),QiniuCredentials::new("ak".into(),"sk".into(),None).unwrap()).unwrap();assert!(client.validate_s3_endpoint("https://attacker.example").is_err());}
    #[test] fn documented_nested_metadata_preserves_user_text_verbatim(){let object=parse_object("中文文件",&serde_json::json!({"fsize":1,"hash":"opaque","putTime":17000000000000000i64,"x-qn-meta":{"说明":"中文/+%?#","x-qn-meta-custom":" Keep Case "},"x-qn-meta-legacy":"legacy"})).unwrap();assert_eq!(object.metadata.get("说明").map(String::as_str),Some("中文/+%?#"));assert_eq!(object.metadata.get("x-qn-meta-custom").map(String::as_str),Some(" Keep Case "));assert_eq!(object.metadata.get("x-qn-meta-legacy").map(String::as_str),Some("legacy"));}
    #[test] fn last_modify_takes_precedence_over_upload_time_in_100ns_units(){let object=parse_object("object",&serde_json::json!({"fsize":0,"putTime":17000000000000000i64,"lastModify":17000000100000000i64})).unwrap();assert_eq!(object.last_modified,"2023-11-14T22:13:30+00:00");let fallback=parse_object("old",&serde_json::json!({"fsize":0,"putTime":17000000000000000i64})).unwrap();assert_eq!(fallback.last_modified,"2023-11-14T22:13:20+00:00");}
    #[test] fn malformed_nested_metadata_and_modification_time_are_errors(){assert!(parse_object("object",&serde_json::json!({"fsize":0,"x-qn-meta":{"key":42}})).is_err());assert!(parse_object("object",&serde_json::json!({"fsize":0,"x-qn-meta":"wrong"})).is_err());assert!(parse_object("object",&serde_json::json!({"fsize":0,"lastModify":"not-a-time"})).is_err());}
}
