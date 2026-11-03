//! Repository-pinned, signed update discovery and disk downloads. The release
//! selected by the user is immutable throughout download and installation.
use super::*;
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use sha2::{Digest, Sha256};
use std::io::Read;

pub(crate) const REPOSITORY: &str = "70548887/object0";
const RELEASES_API: &str = "https://api.github.com/repos/70548887/object0/releases";
const RELEASES_PAGE: &str = "https://github.com/70548887/object0/releases";
const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const SIGNING_BLOCK: &str = "尚未配置云仓专用更新签名，当前仅支持检测版本和手动下载 / Dedicated Yuncang update signing is not configured; version checks and manual downloads remain available";
const STALE: &str = "更新目标或任务已变化，请重新检查 / Update selection changed; check again";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Channel { Stable, Preview }
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PackageKind { Installer, Portable, Unknown }
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LastUpdateResult { pub version:String, pub status:String, pub message:String }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Info {
    pub current_version: String, pub build_hash: String, pub development: bool,
    pub package_kind: PackageKind, pub platform: String, pub repository: String,
    pub release_url: String, pub signing_configured: bool, pub blocked_reason: Option<String>,
    #[serde(skip_serializing_if="Option::is_none")]
    pub last_update_result: Option<LastUpdateResult>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Release {
    pub id: String, pub version: String, pub channel: Channel, pub published_at: String,
    pub notes: String, pub release_url: String, pub package_kind: PackageKind,
    pub asset_name: Option<String>, pub size: Option<u64>, pub can_download: bool,
    pub blocked_reason: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckResult { pub info: Info, pub channel: Channel, pub checked_at: String, pub release: Option<Release>, pub message: String }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub release_id: Option<String>, pub attempt: u64, pub stage: String,
    pub downloaded: u64, pub total: Option<u64>, pub error: Option<String>,
}
impl Default for Snapshot { fn default()->Self { Self{release_id:None,attempt:0,stage:"idle".into(),downloaded:0,total:None,error:None} } }
#[derive(Clone)]
struct Descriptor {
    release: Release, package: Package, manifest_url: String,
    installer: Option<tauri_plugin_updater::Update>,
}
#[derive(Default)]
pub(crate) struct Runtime {
    selected: Option<Descriptor>, snapshot: Snapshot, cancel: Option<Arc<AtomicBool>>,
    prepared: Option<PreparedUpdate>, check_generation: u64,
    next_attempt: u64,
}
#[derive(Clone)]
pub(crate) struct PreparedUpdate {
    pub path: PathBuf, pub version: String, pub sha256: String, pub signature: String,
    pub release_id: String, pub kind: PackageKind, pub platform: String,
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct CheckInput { pub channel: Channel }
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct SelectionInput { pub release_id: String }
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct ApplyInput { pub release_id: String, pub exit_confirmed: bool, pub drafts_saved: bool }

#[derive(Clone, Deserialize)]
struct GitHubAsset { name:String, size:u64, browser_download_url:String }
#[derive(Clone, Deserialize)]
struct GitHubRelease {
    tag_name:String, draft:bool, prerelease:bool, html_url:String,
    #[serde(default)] body:Option<String>, #[serde(default)] published_at:Option<String>,
    #[serde(default)] assets:Vec<GitHubAsset>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Package { url:String, size:u64, sha256:String, signature:String }
#[derive(Deserialize)]
struct SignedManifest {
    #[serde(rename="schemaVersion")] schema_version:u32,
    version:String, channel:Channel,
    packages:HashMap<String,HashMap<String,Package>>,
    platforms:HashMap<String,TauriAsset>,
}
#[derive(Deserialize)]
struct TauriAsset { url:String, signature:String }

pub(crate) fn pinned_public_key()->Option<String> {
    option_env!("YUNCANG_UPDATER_PUBLIC_KEY").map(str::trim).filter(|s|!s.is_empty()).map(str::to_string)
}
fn platform()->String { format!("{}-{}",std::env::consts::OS,match std::env::consts::ARCH {"x86_64"=>"x86_64",other=>other}) }
fn version(value:&str)->Result<Version,String>{Version::parse(value.strip_prefix('v').unwrap_or(value)).map_err(|_|"版本号无效 / Invalid version".into())}
fn package_kind_at(exe:&Path,current:&str)->PackageKind {
    if let Some(parent)=exe.parent() {
        let marker=parent.join("yuncang-package.json");
        if let Ok(data)=fs::read(&marker) { if data.len()<4096 { if let Ok(value)=serde_json::from_slice::<Value>(&data) {
            if value.get("schemaVersion").and_then(Value::as_u64)==Some(1)
                && value.get("identifier").and_then(Value::as_str)==Some("dev.object0.app")
                && value.get("version").and_then(Value::as_str)==Some(current)
                && value.get("platform").and_then(Value::as_str)==Some(platform().as_str())
                && value.get("kind").and_then(Value::as_str)==Some("portable") {return PackageKind::Portable;}
        } } }
    }
    PackageKind::Unknown
}
fn linked_metadata(metadata:&fs::Metadata)->bool {
    if metadata.file_type().is_symlink(){return true}
    #[cfg(windows)] {use std::os::windows::fs::MetadataExt;if metadata.file_attributes()&0x400!=0{return true}}
    false
}
fn last_result_at(cache:&Path,current:&str)->Option<LastUpdateResult> {
    let path=cache.join("last-portable-result.json");
    // This is optional, bounded diagnostics, never a source of install paths,
    // public keys or authorization. Reject links in every existing component.
    for component in path.ancestors() {if linked_metadata(&fs::symlink_metadata(component).ok()?){return None}}
    let mut options=fs::OpenOptions::new();options.read(true);
    #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.custom_flags(0x0020_0000);}
    let file=options.open(&path).ok()?;let metadata=file.metadata().ok()?;
    if !metadata.is_file() || linked_metadata(&metadata) || metadata.len()>16*1024{return None}
    let mut bytes=Vec::new();Read::take(file,16*1024+1).read_to_end(&mut bytes).ok()?;
    if bytes.len()>16*1024{return None}
    let mut result:LastUpdateResult=serde_json::from_slice(&bytes).ok()?;
    if result.version.len()>128 || version(&result.version).is_err() || result.message.len()>12*1024 || !matches!(result.status.as_str(),"launching"|"installed-awaiting-ui-confirmation"|"failed"|"completed"){return None}
    if result.version==current && matches!(result.status.as_str(),"launching"|"installed-awaiting-ui-confirmation") {
        result.status="completed".into();
        result.message="新版本已启动 / The new version has started".into();
    }
    Some(result)
}
pub(crate) fn info()->Info {
    let kind=match tauri::utils::platform::bundle_type() {
        Some(tauri::utils::config::BundleType::Nsis)=>PackageKind::Installer,
        _=>if option_env!("YUNCANG_PACKAGE_KIND")==Some("portable"){PackageKind::Portable}else{std::env::current_exe().ok().map(|exe|package_kind_at(&exe,env!("CARGO_PKG_VERSION"))).unwrap_or(PackageKind::Unknown)},
    };
    let key=pinned_public_key();
    let valid_key=key.as_deref().is_some_and(|value|decode_public_key(value).is_ok());
    let blocked=if !valid_key {Some(SIGNING_BLOCK.to_string())}
        else if platform()!="windows-x86_64" {Some("当前平台暂无自动升级包 / Automatic updates are not available for this platform".into())}
        else if kind==PackageKind::Unknown {Some("无法确认安装类型，请手动下载新版 / Package type is unknown; download a new version manually".into())}else{None};
    Info {current_version:env!("CARGO_PKG_VERSION").into(),build_hash:option_env!("YUNCANG_BUILD_HASH").unwrap_or("").into(),
        development:option_env!("YUNCANG_BUILD_KIND")!=Some("release"),package_kind:kind,platform:platform(),repository:REPOSITORY.into(),
        release_url:RELEASES_PAGE.into(),signing_configured:valid_key,blocked_reason:blocked,
        last_update_result:config_paths::object0_config_dir().ok().and_then(|directory| {
            last_result_at(&directory.join("updates-cache"),env!("CARGO_PKG_VERSION"))
        })}
}

fn allowed_url(url:&Url)->bool {
    if url.scheme()!="https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some_and(|p|p!=443) || url.fragment().is_some() {return false;}
    match url.host_str() {
        Some("api.github.com")=>url.path().starts_with("/repos/70548887/object0/"),
        Some("github.com")=>url.path().starts_with("/70548887/object0/releases/"),
        Some("release-assets.githubusercontent.com"|"objects.githubusercontent.com")=>true,
        _=>false,
    }
}
fn checked_url(value:&str)->Result<Url,String>{let url=Url::parse(value).map_err(|_|"更新地址无效 / Invalid update URL".to_string())?;if !allowed_url(&url){return Err("拒绝非本仓库或非 HTTPS 更新地址 / Update URL is not trusted HTTPS for this repository".into())}Ok(url)}
fn client()->Result<reqwest::Client,String>{reqwest::Client::builder().user_agent("Yuncang-Updater/1").connect_timeout(StdDuration::from_secs(15)).read_timeout(StdDuration::from_secs(45)).redirect(redirect_policy()).build().map_err(|_|"无法初始化更新连接 / Could not initialize updater connection".into())}
fn redirect_policy()->reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt|if attempt.previous().len()<8 && allowed_url(attempt.url()){attempt.follow()}else{attempt.error("Untrusted update redirect")})
}
fn network_error(status:Option<reqwest::StatusCode>)->String {
    match status.map(|s|s.as_u16()) {
        Some(403|429)=>"GitHub 限流或拒绝访问，请稍后重试 / GitHub rate limit or access denied; retry later".into(),
        Some(404)=>"更新文件尚未发布 / The update file has not been published".into(),
        _=>"无法连接 GitHub 更新服务，请检查网络后重试 / Could not reach GitHub updates; check the connection and retry".into(),
    }
}
async fn get_limited(client:&reqwest::Client,url:&str,limit:usize)->Result<Vec<u8>,String> {
    let mut response=client.get(checked_url(url)?).timeout(StdDuration::from_secs(45)).send().await.map_err(|_|network_error(None))?;
    if !response.status().is_success(){return Err(network_error(Some(response.status())))}
    if response.content_length().is_some_and(|n|n>limit as u64){return Err("更新元数据过大 / Update metadata exceeds its size limit".into())}
    let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|network_error(None))?{if chunk.len()>limit.saturating_sub(bytes.len()){return Err("更新元数据过大 / Update metadata exceeds its size limit".into())}bytes.extend_from_slice(&chunk);}
    Ok(bytes)
}
fn decoded_text(value:&str)->Result<String,String>{
    if value.starts_with("untrusted comment:"){return Ok(value.to_string())}
    let data=base64::engine::general_purpose::STANDARD.decode(value.trim()).map_err(|_|"更新签名格式无效 / Invalid update signature encoding".to_string())?;
    String::from_utf8(data).map_err(|_|"更新签名格式无效 / Invalid update signature encoding".into())
}
fn decode_public_key(value:&str)->Result<PublicKey,String>{
    if let Ok(key)=PublicKey::from_base64(value.trim()){return Ok(key)}
    PublicKey::decode(&decoded_text(value)?).map_err(|_|"更新公钥无效 / Invalid update public key".into())
}
fn decode_signature(value:&str)->Result<Signature,String>{Signature::decode(&decoded_text(value)?).map_err(|_|"更新签名无效 / Invalid update signature".into())}
fn verify_bytes(data:&[u8],signature:&str,key:&str)->Result<(),String>{decode_public_key(key)?.verify(data,&decode_signature(signature)?,false).map_err(|_|"更新签名校验失败，已拒绝更新 / Update signature verification failed; update refused".into())}
pub(crate) fn verify_signed_file(path:&Path,signature:&str,key:&str)->Result<(),String>{
    let pk=decode_public_key(key)?;let sig=decode_signature(signature)?;
    let mut verifier=pk.verify_stream(&sig).map_err(|_|"更新包需要可流式验证的签名 / A stream-verifiable update signature is required".to_string())?;
    let mut file=fs::File::open(path).map_err(|_|"无法读取更新缓存 / Could not read update cache".to_string())?;let mut buf=[0u8;65536];
    loop {let n=file.read(&mut buf).map_err(|_|"无法读取更新缓存 / Could not read update cache".to_string())?;if n==0{break}verifier.update(&buf[..n]);}
    verifier.finalize().map_err(|_|"更新签名校验失败，已拒绝更新 / Update signature verification failed; update refused".into())
}

fn select_release(releases:Vec<GitHubRelease>,current:&str,channel:Channel)->Result<Option<GitHubRelease>,String>{
    let current=version(current)?;
    let mut candidates:Vec<_>=releases.into_iter().filter_map(|release| {
        if release.draft || (channel==Channel::Stable&&release.prerelease){return None}
        let parsed=version(&release.tag_name).ok()?;
        if channel==Channel::Stable&&!parsed.pre.is_empty(){return None}
        if !parsed.cmp_precedence(&current).is_gt(){return None}Some((parsed,release))
    }).collect();
    candidates.sort_by(|a,b|b.0.cmp_precedence(&a.0));Ok(candidates.into_iter().next().map(|(_,r)|r))
}
fn same_release_url(value:&str,tag:&str)->bool {Url::parse(value).ok().is_some_and(|url|allowed_url(&url)&&url.host_str()==Some("github.com")&&url.path()==format!("/{REPOSITORY}/releases/tag/{tag}"))}
fn validated_package(data:&[u8],release:&GitHubRelease,kind:PackageKind,target:&str)->Result<Package,String>{
    let manifest:SignedManifest=serde_json::from_slice(data).map_err(|_|"更新清单格式无效 / Invalid signed update manifest".to_string())?;
    if manifest.schema_version!=1 || version(&manifest.version)?!=version(&release.tag_name)? || (manifest.channel==Channel::Stable&&release.prerelease) || (manifest.channel==Channel::Preview&&!release.prerelease) {return Err("更新清单与发布版本不一致 / Signed manifest does not match its release".into())}
    let key=match kind {PackageKind::Installer=>"installer",PackageKind::Portable=>"portable",PackageKind::Unknown=>return Err("无法确认安装类型 / Unknown package type".into())};
    let package=manifest.packages.get(target).and_then(|p|p.get(key)).cloned().ok_or_else(||"该版本没有匹配的升级包 / No matching update package in this release".to_string())?;
    let url=checked_url(&package.url)?;
    if url.host_str()!=Some("github.com") || !url.path().starts_with(&format!("/{REPOSITORY}/releases/download/{}/",release.tag_name)) || url.query().is_some(){return Err("更新包地址与发布版本不一致 / Update package URL does not match its release".into())}
    if package.size==0 || package.size>MAX_PACKAGE_BYTES || package.sha256.len()!=64 || !package.sha256.bytes().all(|b|b.is_ascii_hexdigit()) || decode_signature(&package.signature).is_err(){return Err("更新包校验信息无效 / Invalid update package integrity data".into())}
    let asset=release.assets.iter().find(|a|a.browser_download_url==package.url).ok_or_else(||"发布附件缺少指定升级包 / The specified update asset is missing".to_string())?;
    if asset.size!=package.size{return Err("更新包大小与发布附件不一致 / Update package size does not match the release asset".into())}
    if kind==PackageKind::Installer {
        let tauri=manifest.platforms.get(target).ok_or_else(||"安装版更新清单缺少平台项 / Installer manifest has no platform entry".to_string())?;
        if tauri.url!=package.url || tauri.signature!=package.signature {return Err("安装版更新描述不一致 / Installer update descriptors differ".into())}
    }
    Ok(package)
}

pub(crate) async fn check(app:&AppHandle,channel:Channel)->Result<CheckResult,String>{
    let state=app.state::<AppState>();
    let generation={let mut runtime=lock_state(&state.github_updates)?;
        if matches!(runtime.snapshot.stage.as_str(),"downloading"|"verifying"|"installing"){return Err("更新任务进行中，请先完成或取消 / An update is in progress; finish or cancel it first".into())}
        runtime.check_generation=runtime.check_generation.wrapping_add(1);
        runtime.selected=None;runtime.prepared=None;runtime.cancel=None;runtime.snapshot=Snapshot::default();
        runtime.check_generation};
    let info=info();let http=client()?;let mut releases=Vec::new();
    for page in 1..=10 {
        let data=get_limited(&http,&format!("{RELEASES_API}?per_page=100&page={page}"),2*1024*1024).await?;
        let entries:Vec<GitHubRelease>=serde_json::from_slice(&data).map_err(|_|"GitHub 返回了无效版本列表 / GitHub returned an invalid release list".to_string())?;
        let done=entries.len()<100;releases.extend(entries);if done{break}
        if page==10{return Err("版本列表过长，未完成检查 / Release enumeration is incomplete".into())}
    }
    let selected=select_release(releases,&info.current_version,channel)?;
    let mut descriptor=None;
    let result=if let Some(github)=selected {
        if !same_release_url(&github.html_url,&github.tag_name){return Err("发布地址不属于云仓仓库 / Release URL is outside the Yuncang repository".into())}
        let mut public=Release{id:Uuid::new_v4().to_string(),version:version(&github.tag_name)?.to_string(),channel:if github.prerelease{Channel::Preview}else{Channel::Stable},published_at:github.published_at.clone().unwrap_or_default(),notes:github.body.clone().unwrap_or_default(),release_url:github.html_url.clone(),package_kind:info.package_kind,asset_name:None,size:None,can_download:false,blocked_reason:info.blocked_reason.clone()};
        // Untrusted release metadata is useful for display/manual download,
        // but never authorizes installation without the signed descriptor.
        let suffix=match info.package_kind{PackageKind::Installer=>Some("_windows_x64_setup.exe"),PackageKind::Portable=>Some("_windows_x64_portable.zip"),PackageKind::Unknown=>None};
        if let Some(asset)=suffix.and_then(|suffix|github.assets.iter().find(|asset|asset.name.ends_with(suffix))){public.asset_name=Some(asset.name.clone());public.size=Some(asset.size);}
        if public.blocked_reason.is_none() {
            let preparation:Result<Descriptor,String>=async {
                let manifest=github.assets.iter().find(|a|a.name=="yuncang-update.json").ok_or_else(||"该版本未提供签名升级清单，可使用手动下载 / This release has no signed update manifest; manual download is available".to_string())?;
                let signature=github.assets.iter().find(|a|a.name=="yuncang-update.json.sig").ok_or_else(||"该版本缺少更新清单签名 / This release has no manifest signature".to_string())?;
                let data=get_limited(&http,&manifest.browser_download_url,MAX_MANIFEST_BYTES).await?;
                let signature=String::from_utf8(get_limited(&http,&signature.browser_download_url,16*1024).await?).map_err(|_|"更新清单签名无效 / Invalid manifest signature".to_string())?;
                let key=pinned_public_key().ok_or_else(||SIGNING_BLOCK.to_string())?;verify_bytes(&data,signature.trim(),&key)?;
                let package=validated_package(&data,&github,info.package_kind,&info.platform)?;
                let mut hash=Sha256::new();hash.update(&data);hash.update(package.url.as_bytes());hash.update(format!("{:?}",channel).as_bytes());public.id=format!("{:x}",hash.finalize());
                public.asset_name=github.assets.iter().find(|a|a.browser_download_url==package.url).map(|a|a.name.clone());public.size=Some(package.size);public.can_download=true;
                let installer=if info.package_kind==PackageKind::Installer {
                    let updater=app.updater_builder().pubkey(key).endpoints(vec![checked_url(&manifest.browser_download_url)?]).map_err(|_|"无法配置安装版升级 / Could not configure installer update".to_string())?.configure_client(|builder|builder.redirect(redirect_policy())).build().map_err(|_|"无法配置安装版升级 / Could not configure installer update".to_string())?;
                    let update=updater.check().await.map_err(|_|"无法固定安装版升级描述 / Could not bind the installer update descriptor".to_string())?.ok_or_else(||STALE.to_string())?;
                    if update.version!=public.version || update.download_url.as_str()!=package.url || update.signature!=package.signature {return Err("安装版更新描述已变化 / Installer update descriptor changed".into())}Some(update)
                }else{None};
                Ok(Descriptor{release:public.clone(),package,manifest_url:manifest.browser_download_url.clone(),installer})
            }.await;
            match preparation {Ok(value)=>descriptor=Some(value),Err(error)=>{public.can_download=false;public.blocked_reason=Some(error);}}
        }
        Some(public)
    }else{None};
    let mut runtime=lock_state(&state.github_updates)?;if runtime.check_generation!=generation{return Err(STALE.into())}
    runtime.selected=descriptor;runtime.prepared=None;runtime.cancel=None;runtime.snapshot=Snapshot::default();
    Ok(CheckResult{info,channel,checked_at:now_iso(),message:if result.is_some(){"发现更高版本 / A newer release is available".into()}else{"此通道暂无高于当前版本的发布；不会自动降级 / No newer release in this channel; automatic downgrades are disabled".into()},release:result})
}

fn emit(app:&AppHandle,snapshot:&Snapshot){let _=app.emit("updates:progress",snapshot);}
fn progress(app:&AppHandle,attempt:u64,release_id:&str,stage:&str,downloaded:u64,total:Option<u64>,error:Option<String>)->Result<Snapshot,String>{
    let state=app.state::<AppState>();let mut runtime=lock_state(&state.github_updates)?;
    if runtime.snapshot.attempt!=attempt || runtime.snapshot.release_id.as_deref()!=Some(release_id){return Err(STALE.into())}
    if runtime.snapshot.stage=="cancelled" && stage!="cancelled"{return Err("更新下载已取消 / Update download cancelled".into())}
    runtime.snapshot=Snapshot{release_id:Some(release_id.into()),attempt,stage:stage.into(),downloaded,total,error};let snapshot=runtime.snapshot.clone();drop(runtime);emit(app,&snapshot);Ok(snapshot)
}
fn cache_root()->Result<PathBuf,String>{let path=config_paths::object0_config_dir()?.join("updates-cache");fs::create_dir_all(&path).map_err(|_|"无法创建 C 盘更新缓存 / Could not create the local update cache".to_string())?;let metadata=fs::symlink_metadata(&path).map_err(|_|"无法检查更新缓存 / Could not inspect update cache".to_string())?;if metadata.file_type().is_symlink(){return Err("更新缓存不能是链接 / Update cache must not be a link".into())}
    #[cfg(windows)] {use std::os::windows::fs::MetadataExt;if metadata.file_attributes()&0x400!=0{return Err("更新缓存不能是重解析点 / Update cache must not be a reparse point".into())}}
    Ok(path)}
async fn stream_package(client:&reqwest::Client,url:Url,path:&Path,size:u64,digest:&str,cancel:&AtomicBool,mut notify:impl FnMut(u64)->Result<(),String>)->Result<u64,String>{
    if size==0 || size>MAX_PACKAGE_BYTES{return Err("更新包大小无效 / Invalid update package size".into())}
    let mut send=Box::pin(client.get(url).send());
    let mut response=loop {
        if cancel.load(Ordering::SeqCst){return Err("更新下载已取消 / Update download cancelled".into())}
        match futures_util::future::select(send.as_mut(),Box::pin(tokio::time::sleep(StdDuration::from_millis(100)))).await {
            futures_util::future::Either::Left((result,_))=>break result.map_err(|_|network_error(None))?,
            futures_util::future::Either::Right(_)=>{},
        }
    };
    if !response.status().is_success(){return Err(network_error(Some(response.status())))}
    if response.content_length().is_some_and(|n|n!=size){return Err("更新包大小已变化 / Update package size changed".into())}
    let mut file=tokio_fs::OpenOptions::new().create_new(true).write(true).open(path).await.map_err(|_|"无法创建更新临时文件 / Could not create the update temporary file".to_string())?;
    let mut downloaded=0u64;let mut hash=Sha256::new();
    loop {
        if cancel.load(Ordering::SeqCst){return Err("更新下载已取消 / Update download cancelled".into())}
        let next=match futures_util::future::select(Box::pin(response.chunk()),Box::pin(tokio::time::sleep(StdDuration::from_millis(100)))).await {
            futures_util::future::Either::Left((chunk,_))=>chunk.map_err(|_|"更新下载中断，请重试 / Update download interrupted; retry".to_string())?,
            futures_util::future::Either::Right(_)=>continue,
        };
        let Some(chunk)=next else{break};
        downloaded=downloaded.checked_add(chunk.len() as u64).ok_or_else(||"更新包过大 / Update package too large".to_string())?;
        if downloaded>size || downloaded>MAX_PACKAGE_BYTES{return Err("更新包大小不符 / Update package size mismatch".into())}
        hash.update(&chunk);file.write_all(&chunk).await.map_err(|_|"写入更新缓存失败，请检查磁盘空间 / Could not write update cache; check disk space".to_string())?;
        notify(downloaded)?;
    }
    if cancel.load(Ordering::SeqCst){return Err("更新下载已取消 / Update download cancelled".into())}
    file.sync_all().await.map_err(|_|"写入更新缓存失败 / Could not flush update cache".to_string())?;drop(file);
    if downloaded!=size || format!("{:x}",hash.finalize())!=digest.to_ascii_lowercase(){return Err("更新包完整性校验失败 / Update package integrity verification failed".into())}
    Ok(downloaded)
}
pub(crate) async fn download(app:&AppHandle,id:&str)->Result<Snapshot,String>{
    let state=app.state::<AppState>();
    let (descriptor,cancel,attempt)={let mut runtime=lock_state(&state.github_updates)?;
        if matches!(runtime.snapshot.stage.as_str(),"downloading"|"verifying"|"installing"){return Err("已有更新任务进行中 / An update task is already active".into())}
        let descriptor=runtime.selected.as_ref().filter(|d|d.release.id==id&&d.release.can_download).cloned().ok_or_else(||STALE.to_string())?;
        if pinned_public_key().is_none(){return Err(SIGNING_BLOCK.into())}
        let cancel=Arc::new(AtomicBool::new(false));runtime.next_attempt=runtime.next_attempt.wrapping_add(1);let attempt=runtime.next_attempt;
        runtime.prepared=None;runtime.cancel=Some(cancel.clone());runtime.snapshot=Snapshot{release_id:Some(id.into()),attempt,stage:"downloading".into(),downloaded:0,total:Some(descriptor.package.size),error:None};emit(app,&runtime.snapshot);(descriptor,cancel,attempt)};
    let root=match cache_root(){Ok(path)=>path,Err(error)=>{progress(app,attempt,id,"failed",0,Some(descriptor.package.size),Some(error.clone()))?;return Err(error)}};
    let destination=root.join(format!("{}-{}-{}.pkg",descriptor.release.id,attempt,Uuid::new_v4()));let partial=destination.with_extension("part");
    let result:Result<PreparedUpdate,String>=async {
        let http=client()?;
        let downloaded=stream_package(&http,checked_url(&descriptor.package.url)?,&partial,descriptor.package.size,&descriptor.package.sha256,&cancel,|n|{progress(app,attempt,id,"downloading",n,Some(descriptor.package.size),None)?;Ok(())}).await?;
        progress(app,attempt,id,"verifying",downloaded,Some(downloaded),None)?;
        let key=pinned_public_key().ok_or_else(||SIGNING_BLOCK.to_string())?;verify_signed_file(&partial,&descriptor.package.signature,&key)?;
        if cancel.load(Ordering::SeqCst){return Err("更新下载已取消 / Update download cancelled".into())}
        fs::rename(&partial,&destination).map_err(|_|"无法提交更新缓存 / Could not commit verified update cache".to_string())?;
        Ok(PreparedUpdate{path:destination.clone(),version:descriptor.release.version.clone(),sha256:descriptor.package.sha256.clone(),signature:descriptor.package.signature.clone(),release_id:id.into(),kind:descriptor.release.package_kind,platform:platform()})
    }.await;
    match result {
        Ok(prepared)=>{let mut runtime=lock_state(&state.github_updates)?;if runtime.snapshot.attempt!=attempt || runtime.snapshot.stage=="cancelled"{return Err(STALE.into())}runtime.prepared=Some(prepared);drop(runtime);progress(app,attempt,id,"ready",descriptor.package.size,Some(descriptor.package.size),None)},
        Err(error)=>{let _=fs::remove_file(&partial);let stage=if cancel.load(Ordering::SeqCst){"cancelled"}else{"failed"};progress(app,attempt,id,stage,0,Some(descriptor.package.size),Some(error.clone()))?;Err(error)}
    }
}
pub(crate) fn cancel(app:&AppHandle,id:&str)->Result<Snapshot,String>{
    let state=app.state::<AppState>();let mut runtime=lock_state(&state.github_updates)?;
    if runtime.snapshot.release_id.as_deref()!=Some(id) || !matches!(runtime.snapshot.stage.as_str(),"downloading"|"verifying"){return Err(STALE.into())}
    if let Some(flag)=&runtime.cancel{flag.store(true,Ordering::SeqCst)}runtime.snapshot.stage="cancelled".into();runtime.snapshot.error=None;let snapshot=runtime.snapshot.clone();drop(runtime);emit(app,&snapshot);Ok(snapshot)
}
pub(crate) fn ensure_idle(state:&AppState)->Result<(),String>{
    if state.updates_active_operations.load(Ordering::SeqCst)!=0{return Err("仍有文件或账号操作正在进行，请稍后更新 / File or account operations are in progress; update later".into())}
    let jobs=lock_state(&state.jobs)?;
    if !jobs.running.is_empty() || !jobs.queue.is_empty() || jobs.jobs.values().any(|j|matches!(j.status,JobStatus::Running|JobStatus::Queued)){return Err("仍有运行或排队传输，请完成后再更新 / Transfers are running or queued; finish them before updating".into())}
    drop(jobs);let sync=lock_state(&state.folder_sync)?;
    if sync.statuses.values().any(|s|matches!(s.status,FolderSyncStatus::Syncing|FolderSyncStatus::Watching)){return Err("实时同步仍在运行，请停止同步后再更新 / Live sync is active; stop it before updating".into())}Ok(())
}
pub(crate) fn ensure_not_installing(state:&AppState)->Result<(),String>{if state.updates_installing.load(Ordering::SeqCst){Err("正在准备升级，暂不接受新操作 / Update installation is being prepared; new operations are blocked".into())}else{Ok(())}}
pub(crate) fn apply(app:&AppHandle,input:&ApplyInput)->Result<(),String>{
    if !input.exit_confirmed || !input.drafts_saved{return Err("请先保存草稿并确认退出升级 / Save drafts and confirm exit before updating".into())}
    let state=app.state::<AppState>();
    if state.updates_installing.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_err(){return Err("正在安装更新 / An update installation is already active".into())}
    let result:Result<(),String>=(||{
        ensure_idle(&state)?;
        if crate::portable_update::other_instances_running()? {return Err("其他云仓实例仍在运行，请正常退出后再更新 / Another Yuncang instance is running; exit it normally before updating".into())}
        let (prepared,installer,attempt)={let runtime=lock_state(&state.github_updates)?;
            if runtime.snapshot.stage!="ready" || runtime.snapshot.release_id.as_deref()!=Some(&input.release_id){return Err(STALE.into())}
            let descriptor=runtime.selected.as_ref().filter(|d|d.release.id==input.release_id).ok_or_else(||STALE.to_string())?;
            (runtime.prepared.clone().ok_or_else(||STALE.to_string())?,descriptor.installer.clone(),runtime.snapshot.attempt)};
        if !version(&prepared.version)?.cmp_precedence(&version(env!("CARGO_PKG_VERSION"))?).is_gt() {return Err("拒绝自动降级或重复安装 / Automatic downgrade or reinstall refused".into())}
        let key=pinned_public_key().ok_or_else(||SIGNING_BLOCK.to_string())?;verify_signed_file(&prepared.path,&prepared.signature,&key)?;
        progress(app,attempt,&input.release_id,"installing",fs::metadata(&prepared.path).map_err(|_|STALE.to_string())?.len(),None,None)?;
        match prepared.kind {
            PackageKind::Portable=>crate::portable_update::apply(app,&prepared),
            PackageKind::Installer=>{
                let update=installer.ok_or_else(||"安装版更新描述缺失 / Installer descriptor is missing".to_string())?;
                // Tauri2 currently accepts bytes for install; downloading and
                // verification above are disk-streamed, not cached in memory.
                let data=fs::read(&prepared.path).map_err(|_|"无法读取已验证安装包 / Could not read verified installer".to_string())?;
                verify_bytes(&data,&prepared.signature,&key)?;
                update.install(&data).map_err(|_|"安装失败，当前配置和旧版本未被清理 / Installation failed; current settings and old files were not cleaned".to_string())
            },
            PackageKind::Unknown=>Err("安装类型未知，不能自动升级 / Unknown package type; automatic installation is unavailable".into()),
        }
    })();
    if let Err(ref error)=result {state.updates_installing.store(false,Ordering::SeqCst);if let Ok(mut runtime)=lock_state(&state.github_updates){runtime.snapshot.stage="failed".into();runtime.snapshot.error=Some(error.clone());emit(app,&runtime.snapshot);}}
    result
}

#[cfg(test)]
#[path="github_updates_tests.rs"]
mod tests;

#[cfg(test)]
mod last_result_tests {
    use super::*;
    #[test]
    fn bounded_local_diagnostics_confirm_only_the_running_version_and_ignore_bad_records() {
        let base=std::env::temp_dir().join(format!("yuncang-update-result-fixture-{}",Uuid::new_v4()));
        fs::create_dir(&base).unwrap();let path=base.join("last-portable-result.json");
        assert!(last_result_at(&base,"1.8.0").is_none());
        for status in ["launching","installed-awaiting-ui-confirmation"] {
            fs::write(&path,serde_json::to_vec(&json!({"version":"1.8.0","status":status,"message":"Awaiting new UI"})).unwrap()).unwrap();
            let current=last_result_at(&base,"1.8.0").unwrap();assert_eq!(current.status,"completed");
            assert!(current.message.contains("has started"));
            assert_eq!(last_result_at(&base,"1.7.0").unwrap().status,status);
        }
        fs::write(&path,serde_json::to_vec(&json!({"version":"1.8.0","status":"failed","message":"The previous version was restored"})).unwrap()).unwrap();
        assert_eq!(last_result_at(&base,"1.7.0").unwrap().status,"failed");
        for value in [json!({"version":"1.8.0","status":"unknown","message":"bad"}),json!({"version":"invalid","status":"failed","message":"bad"}),json!({"version":"1.8.0","status":"failed","message":"bad","path":"not-accepted"})] {
            fs::write(&path,serde_json::to_vec(&value).unwrap()).unwrap();assert!(last_result_at(&base,"1.8.0").is_none());
        }
        fs::write(&path,vec![b'x';16*1024+1]).unwrap();assert!(last_result_at(&base,"1.8.0").is_none());
        fs::write(&path,b"not-json").unwrap();assert!(last_result_at(&base,"1.8.0").is_none());
        assert!(base.canonicalize().unwrap().starts_with(std::env::temp_dir().canonicalize().unwrap()));fs::remove_dir_all(base).unwrap();
    }
}
