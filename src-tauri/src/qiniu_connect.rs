//! One signed account-list read, followed by one revision-bound local commit.
//! The request registry contains no plaintext credentials or signed URLs.
use super::*;
use futures_util::future::{AbortHandle,AbortRegistration,Abortable};
use sha2::{Digest,Sha256};

const MAX_REQUESTS:usize=64;
const CANCELLED:&str="连接请求已取消或账号状态已变化，未保存新账号 / Connection cancelled or account state changed; no new account was saved";
const STALE:&str="本地账号库已变化，请重新连接 / Local account store changed; connect again";
const INVALID:&str="七牛连接参数无效 / Invalid Qiniu connection input";

// Never derive Debug: this is the only credential-bearing request DTO.
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct ConnectInput {
    pub(crate) request_id:String,
    pub(crate) access_key_id:String,
    pub(crate) secret_access_key:String,
    pub(crate) name:Option<String>,
}

#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct ConnectedBucket {
    name:String,
    #[serde(skip_serializing_if="Option::is_none")] creation_date:Option<String>,
    #[serde(skip_serializing_if="Option::is_none")] region_id:Option<String>,
    #[serde(skip_serializing_if="Option::is_none")] s3_name:Option<String>,
    #[serde(skip_serializing_if="Option::is_none")] permission:Option<String>,
}
#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct ConnectOutput {
    pub(crate) profile:ProfileInfo,
    pub(crate) buckets:Vec<ConnectedBucket>,
    account_connected:bool,
    bucket_reads_verified:bool,
    download_verified:bool,
}
enum RequestState {Pending{nonce:Uuid,abort:AbortHandle},Completed(ConnectOutput),Failed,Cancelled}
struct Entry {fingerprint:Option<[u8;32]>,state:RequestState,at:Instant}
pub(crate) struct ConnectRuntime {epoch:u64,salt:[u8;32],entries:HashMap<String,Entry>}
impl Default for ConnectRuntime {fn default()->Self{Self{epoch:0,salt:random_bytes::<32>(),entries:HashMap::new()}}}
impl ConnectRuntime {
    fn prune(&mut self){self.entries.retain(|_,entry|matches!(entry.state,RequestState::Pending{..})||entry.at.elapsed()<StdDuration::from_secs(600));}
    fn clear(&mut self){
        // Revocation forgets safe output/fingerprints, not known cancellation
        // intent. Otherwise an already-cancelled request delayed until after a
        // reopen could silently register again under the same request ID.
        self.prune();
        for entry in self.entries.values_mut(){
            if let RequestState::Pending{abort,..}=&entry.state{abort.abort();}
            entry.state=RequestState::Cancelled;entry.fingerprint=None;entry.at=Instant::now();
        }
        self.epoch=self.epoch.wrapping_add(1);
    }
}
fn valid_id(value:&str)->bool{!value.is_empty()&&value.len()<=128&&value.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'-'|b'_'))}
fn valid_key(value:&str)->bool{!value.trim().is_empty()&&value.len()<=4096&&!value.chars().any(char::is_control)}
fn validate(input:&ConnectInput)->Result<(),String>{
    if !valid_id(&input.request_id)||!valid_key(&input.access_key_id)||!valid_key(&input.secret_access_key)
        ||input.name.as_ref().is_some_and(|n|n.len()>256||n.chars().any(char::is_control)){return Err(INVALID.into())}Ok(())
}
fn digest(bytes:&[u8])->[u8;32]{Sha256::digest(bytes).into()}
fn data_digest(vault:&VaultRuntime)->Result<[u8;32],String>{
    ensure_unlocked(vault)?;
    if !vault.plaintext{return Err("请先打开本地账号模式 / Open local account mode first".into())}
    serde_json::to_vec(vault.data.as_ref().ok_or(STALE)?).map(|v|digest(&v)).map_err(|_|STALE.into())
}
fn disk_digest(path:&Path,vault:&VaultRuntime)->Result<[u8;32],String>{
    if !plaintext_accounts::is_path(path){return Err(STALE.into())}
    let disk=plaintext_accounts::load(path)?;
    if data_digest(&disk)?!=data_digest(vault)?{return Err(STALE.into())}
    fs::read(path).map(|v|digest(&v)).map_err(|_|STALE.into())
}
fn fingerprint(runtime:&ConnectRuntime,input:&ConnectInput)->[u8;32]{
    let mut hash=Sha256::new();hash.update(runtime.salt);
    for value in [input.access_key_id.as_str(),input.secret_access_key.as_str(),input.name.as_deref().unwrap_or("")]{hash.update((value.len()as u64).to_be_bytes());hash.update(value.as_bytes());}hash.finalize().into()
}
struct Ticket {epoch:u64,nonce:Uuid,data:[u8;32],disk:[u8;32]}
struct PendingGuard<'a>{state:&'a AppState,id:&'a str,ticket:&'a Ticket}
impl Drop for PendingGuard<'_>{fn drop(&mut self){fail(self.state,self.id,self.ticket);}}
enum Begin {Replay(ConnectOutput),New(Ticket,AbortRegistration)}
fn begin(state:&AppState,path:&Path,input:&ConnectInput)->Result<Begin,String>{
    validate(input)?;
    let vault=lock_state(&state.vault)?;let snapshot=data_digest(&vault)?;let disk=disk_digest(path,&vault)?;
    let mut runtime=lock_state(&state.qiniu_connections)?;runtime.prune();let fp=fingerprint(&runtime,input);
    if let Some(entry)=runtime.entries.get(&input.request_id){
        if matches!(entry.state,RequestState::Cancelled){return Err(CANCELLED.into())}
        if entry.fingerprint!=Some(fp){return Err("连接请求标识已用于其他输入，请重新连接 / Connection request ID belongs to different input; connect again".into())}
        match &entry.state {
            RequestState::Completed(output)=>{
                let current=vault.data.as_ref().and_then(|d|d.profiles.iter().find(|p|p.id==output.profile.id));
                if !current.is_some_and(|p|p.updated_at==output.profile.updated_at&&p.access_key_id==input.access_key_id&&p.secret_access_key==input.secret_access_key&&p.session_token.is_none()&&p.qiniu.as_ref()==Some(&qiniu::QiniuConfig::default())&&serde_json::to_value(to_profile_info(p)).ok()==serde_json::to_value(&output.profile).ok()){return Err(STALE.into())}
                return Ok(Begin::Replay(output.clone()))
            },
            RequestState::Pending{..}=>return Err("连接请求正在进行中，请稍候 / Connection request is already running".into()),
            _=>{},
        }
    }else if runtime.entries.len()>=MAX_REQUESTS{return Err("连接请求过多，请稍后重试 / Too many connection requests; retry later".into())}
    let nonce=Uuid::new_v4();let(epoch,(abort,registration))=(runtime.epoch,AbortHandle::new_pair());
    runtime.entries.insert(input.request_id.clone(),Entry{fingerprint:Some(fp),state:RequestState::Pending{nonce,abort},at:Instant::now()});
    Ok(Begin::New(Ticket{epoch,nonce,data:snapshot,disk},registration))
}
fn current(runtime:&ConnectRuntime,id:&str,ticket:&Ticket)->bool{
    runtime.epoch==ticket.epoch&&runtime.entries.get(id).is_some_and(|e|matches!(&e.state,RequestState::Pending{nonce,..}if *nonce==ticket.nonce))
}
fn fail(state:&AppState,id:&str,ticket:&Ticket){if let Ok(mut runtime)=state.qiniu_connections.lock(){if current(&runtime,id,ticket){if let Some(entry)=runtime.entries.get_mut(id){entry.state=RequestState::Failed;entry.at=Instant::now();}}}}
fn output(profile:&Profile,buckets:Vec<qiniu::QiniuBucket>)->ConnectOutput{
    ConnectOutput{profile:to_profile_info(profile),buckets:buckets.into_iter().map(|b|ConnectedBucket{name:b.name,creation_date:b.created_at,region_id:b.kodo_region_id,s3_name:b.s3_name,permission:b.permission}).collect(),account_connected:true,bucket_reads_verified:false,download_verified:false}
}

pub(crate) async fn connect(state:&AppState,input:ConnectInput)->Result<ConnectOutput,String>{
    validate(&input)?;
    let credentials=qiniu::QiniuCredentials::new(input.access_key_id.clone(),input.secret_access_key.clone(),None).map_err(|e|e.to_string())?;
    let client=qiniu::QiniuClient::new(qiniu::QiniuConfig::default(),credentials).map_err(|e|e.to_string())?;
    let path=config_paths::plaintext_accounts_path()?;
    connect_verified(state,input,&path,async move{client.list_buckets().await.map_err(|e|e.to_string())},save_vault).await
}

async fn connect_verified(
    state:&AppState,input:ConnectInput,path:&Path,
    verify:impl std::future::Future<Output=Result<Vec<qiniu::QiniuBucket>,String>>,
    persist:impl FnOnce(&Path,&VaultRuntime)->Result<(),String>,
)->Result<ConnectOutput,String>{
    let(ticket,registration)=match begin(state,path,&input)?{Begin::Replay(value)=>return Ok(value),Begin::New(ticket,registration)=>(ticket,registration)};
    let _pending_guard=PendingGuard{state,id:&input.request_id,ticket:&ticket};
    let verified=Abortable::new(tokio::time::timeout(StdDuration::from_secs(20),verify),registration).await;
    let buckets=match verified {
        Err(_)=>{fail(state,&input.request_id,&ticket);return Err(CANCELLED.into())},
        Ok(Err(_))=>{fail(state,&input.request_id,&ticket);return Err("七牛连接超时，未保存账号 / Qiniu connection timed out; account was not saved".into())},
        Ok(Ok(Err(error)))=>{fail(state,&input.request_id,&ticket);return Err(error)},
        Ok(Ok(Ok(buckets)))=>buckets,
    };
    let mut names=HashSet::new();
    let safe=|value:&str,limit:usize|!value.is_empty()&&value.len()<=limit&&!value.chars().any(char::is_control);
    if buckets.len()>10_000||buckets.iter().any(|b|!safe(&b.name,255)||!names.insert(b.name.clone())
        ||b.s3_name.as_deref().is_some_and(|v|!safe(v,255))||b.kodo_region_id.as_deref().is_some_and(|v|!safe(v,255))
        ||b.created_at.as_deref().is_some_and(|v|!safe(v,128))||b.permission.as_deref().is_some_and(|v|!matches!(v,"readonly"|"readwrite"))){return Err("七牛空间列表格式无效，未保存账号 / Invalid Qiniu bucket list; account was not saved".into())}
    let result=(||{
        // Same ordering as lock/import/profile edits: vault -> connect registry.
        // The synchronous durable commit is the cancellation linearization point.
        let mut vault=lock_state(&state.vault)?;let mut runtime=lock_state(&state.qiniu_connections)?;
        if !current(&runtime,&input.request_id,&ticket){return Err(CANCELLED.into())}
        if data_digest(&vault)?!=ticket.data||disk_digest(path,&vault)?!=ticket.disk{return Err(STALE.into())}
        let data=vault.data.as_ref().ok_or(STALE)?;
        // A fresh request for the same permanent public identity selects the
        // existing account instead of creating an unbounded series of aliases.
        let existing=data.profiles.iter().find(|p|p.provider==S3Provider::Qiniu&&p.access_key_id==input.access_key_id&&p.secret_access_key==input.secret_access_key&&p.session_token.is_none()&&p.qiniu.as_ref()==Some(&qiniu::QiniuConfig::default()));
        let response=if let Some(profile)=existing{output(profile,buckets)}else{
            let name=input.name.as_deref().map(str::trim).filter(|n|!n.is_empty()).map(str::to_string).unwrap_or_else(||{
                let mut i=1usize;loop{let name=format!("七牛账号 {i}");if !data.profiles.iter().any(|p|p.name==name){break name}i+=1;}
            });
            let timestamp=now_iso();let profile=Profile{id:Uuid::new_v4().to_string(),name,provider:S3Provider::Qiniu,access_key_id:input.access_key_id.clone(),secret_access_key:input.secret_access_key.clone(),session_token:None,endpoint:None,region:None,default_bucket:None,r2_analytics_token:None,qiniu:Some(qiniu::QiniuConfig::default()),created_at:timestamp.clone(),updated_at:timestamp};
            let response=output(&profile,buckets);let mut candidate=vault.clone();candidate.data.as_mut().ok_or(STALE)?.profiles.push(profile);
            persist(path,&candidate)?;*vault=candidate;response
        };
        runtime.entries.get_mut(&input.request_id).ok_or(CANCELLED)?.state=RequestState::Completed(response.clone());Ok(response)
    })();
    if result.is_err(){fail(state,&input.request_id,&ticket)}result
}

pub(crate) fn cancel(state:&AppState,request_id:&str)->Result<(),String>{
    if !valid_id(request_id){return Err(INVALID.into())}
    let mut runtime=lock_state(&state.qiniu_connections)?;runtime.prune();
    if let Some(entry)=runtime.entries.get_mut(request_id){
        if let RequestState::Pending{abort,..}=&entry.state{abort.abort();}
        // A completed commit cannot be undone by cancelling its UI request.
        if !matches!(entry.state,RequestState::Completed(_)){entry.state=RequestState::Cancelled;entry.at=Instant::now();}
    }else{
        if runtime.entries.len()>=MAX_REQUESTS{return Err("连接请求过多，请稍后重试 / Too many connection requests; retry later".into())}
        runtime.entries.insert(request_id.into(),Entry{fingerprint:None,state:RequestState::Cancelled,at:Instant::now()});
    }Ok(())
}
pub(crate) fn clear(state:&AppState){
    // Revocation is required even if another operation poisoned the registry.
    match state.qiniu_connections.lock(){Ok(mut runtime)=>runtime.clear(),Err(poisoned)=>poisoned.into_inner().clear()}
}

#[cfg(test)]
#[path="qiniu_connect_tests.rs"]
mod tests;
