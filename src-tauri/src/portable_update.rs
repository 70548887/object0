//! The current trusted executable is copied outside the installation and run
//! as a narrowly scoped helper. No downloaded script or unsigned helper runs.
use crate::github_updates::{self, PreparedUpdate};
use serde::{Deserialize,Serialize};
use sha2::{Digest,Sha256};
use std::{collections::HashSet,fs,io::{Read,Write},path::{Component,Path,PathBuf},process::{Command,Stdio},thread,time::{Duration,Instant}};

const IDENTIFIER:&str="dev.object0.app";
const PLATFORM:&str="windows-x86_64";
const TOP_FILES:[&str;7]=["object0.exe","WebView2Runtime","yuncang-package.json","LICENSE","README.zh-CN.md","README.en.md","WEBVIEW2-LICENSE.html"];
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Plan {schema_version:u32,nonce:String,target:PathBuf,archive:PathBuf,version:String,sha256:String,signature:String,old_sha256:String}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct PackageInfo {schema_version:u32,identifier:String,version:String,platform:String,kind:String}

fn error(text:&str)->String {format!("便携更新未完成：{text} / Portable update did not complete: {text}")}
fn hash_file(path:&Path)->Result<String,String>{
    let mut file=fs::File::open(path).map_err(|_|error("cannot read file"))?;let mut hash=Sha256::new();let mut buf=[0;65536];
    loop {let n=file.read(&mut buf).map_err(|_|error("cannot read file"))?;if n==0{break}hash.update(&buf[..n]);}
    Ok(format!("{:x}",hash.finalize()))
}
fn lock_read(path:&Path)->Result<fs::File,String>{
    no_links(path)?;let mut options=fs::OpenOptions::new();options.read(true);
    #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.share_mode(1);}
    options.open(path).map_err(|_|error("cannot lock verified file against changes"))
}
fn tree_hashes(root:&Path)->Result<std::collections::BTreeMap<PathBuf,String>,String>{
    let mut hashes=std::collections::BTreeMap::new();
    for entry in walkdir::WalkDir::new(root).follow_links(false){let entry=entry.map_err(|_|error("cannot inspect staged files"))?;no_links(entry.path())?;
        if entry.file_type().is_file(){hashes.insert(entry.path().strip_prefix(root).map_err(|_|error("staging boundary error"))?.to_path_buf(),hash_file(entry.path())?);}
    }Ok(hashes)
}
fn lock_verified_tree(root:&Path,expected:&std::collections::BTreeMap<PathBuf,String>)->Result<Vec<fs::File>,String>{
    let mut locks=Vec::new();for (relative,digest) in expected{let path=root.join(relative);let file=lock_read(&path)?;if hash_file(&path)?!=*digest{return Err(error("staged or installed member changed"))}locks.push(file);}Ok(locks)
}
fn no_links(path:&Path)->Result<(),String>{
    for item in path.ancestors() {
        if !item.exists(){continue}
        let meta=fs::symlink_metadata(item).map_err(|_|error("cannot inspect path"))?;
        if meta.file_type().is_symlink(){return Err(error("links are not allowed"))}
        #[cfg(windows)] {use std::os::windows::fs::MetadataExt;if meta.file_attributes()&0x400!=0{return Err(error("reparse points are not allowed"))}}
    }Ok(())
}
fn canonical(path:&Path)->Result<PathBuf,String>{
    if !path.is_absolute(){return Err(error("absolute path required"))}no_links(path)?;
    let value=fs::canonicalize(path).map_err(|_|error("path is unavailable"))?;
    #[cfg(windows)] {
        use std::path::Prefix;
        if !matches!(value.components().next(),Some(Component::Prefix(p)) if matches!(p.kind(),Prefix::Disk(_)|Prefix::VerbatimDisk(_))){return Err(error("local disk required"))}
    }Ok(value)
}
fn cache()->Result<PathBuf,String>{
    let path=crate::config_paths::object0_config_dir()?.join("updates-cache");
    fs::create_dir_all(&path).map_err(|_|error("cache unavailable"))?;canonical(&path)
}
fn safe_relative(name:&str)->Result<PathBuf,String>{
    if name.is_empty() || name.contains('\\') || name.contains(':') || name.starts_with('/') || name.chars().any(char::is_control){return Err(error("unsafe archive path"))}
    let name=name.trim_end_matches('/');
    for part in name.split('/') {
        let stem=part.split('.').next().unwrap_or_default().to_ascii_uppercase();
        if part.is_empty() || part=="." || part==".." || part.ends_with(['.',' ']) || matches!(stem.as_str(),"CON"|"PRN"|"AUX"|"NUL")
            || (stem.len()==4 && (stem.starts_with("COM")||stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit()) {
            return Err(error("unsafe archive component"))
        }
    }
    let path=PathBuf::from(name);if path.components().any(|p|!matches!(p,Component::Normal(_))){return Err(error("unsafe archive path"))}Ok(path)
}
fn unpack(archive:&Path,stage:&Path,version:&str)->Result<std::collections::BTreeMap<PathBuf,String>,String>{
    let file=fs::File::open(archive).map_err(|_|error("package unavailable"))?;
    let mut zip=zip::ZipArchive::new(file).map_err(|_|error("invalid ZIP"))?;
    if zip.len()>5000{return Err(error("too many package entries"))}
    let mut required_space=0u64;
    for index in 0..zip.len(){let entry=zip.by_index(index).map_err(|_|error("invalid ZIP entry"))?;required_space=required_space.checked_add(entry.size()).ok_or_else(||error("oversized package"))?;if entry.size()>768*1024*1024 || required_space>4*1024*1024*1024{return Err(error("oversized package"))}}
    check_free_space(stage,required_space.saturating_add(64*1024*1024))?;
    let prefix=format!("object0_{version}_windows_x64_portable/");let mut seen=HashSet::new();let mut total=0u64;let mut hashes=std::collections::BTreeMap::new();
    for index in 0..zip.len(){
        let mut entry=zip.by_index(index).map_err(|_|error("invalid ZIP entry"))?;
        if entry.name()==prefix {continue}
        let name=entry.name().strip_prefix(&prefix).ok_or_else(||error("unexpected ZIP root"))?;
        let relative=safe_relative(name)?;let key=relative.to_string_lossy().replace('\\',"/").to_lowercase();
        if !seen.insert(key){return Err(error("duplicate package entry"))}
        if entry.unix_mode().is_some_and(|mode|mode&0o170000==0o120000){return Err(error("archive links are forbidden"))}
        let first=relative.components().next().unwrap().as_os_str().to_string_lossy();
        if !TOP_FILES.contains(&first.as_ref()) || (first!="WebView2Runtime" && relative.components().count()!=1){return Err(error("unexpected package member"))}
        total=total.checked_add(entry.size()).ok_or_else(||error("oversized package"))?;
        if entry.size()>768*1024*1024 || total>4*1024*1024*1024{return Err(error("oversized package"))}
        let destination=stage.join(&relative);no_links(&destination)?;
        if entry.is_dir(){fs::create_dir_all(destination).map_err(|_|error("cannot create staging directory"))?;continue}
        fs::create_dir_all(destination.parent().unwrap()).map_err(|_|error("cannot create staging directory"))?;
        let mut target=fs::OpenOptions::new().write(true).create_new(true).open(destination).map_err(|_|error("cannot create staged file"))?;
        let expected=entry.size();let mut copied=0u64;let mut hash=Sha256::new();let mut buffer=[0u8;65536];
        loop {let n=entry.read(&mut buffer).map_err(|_|error("package extraction failed"))?;if n==0{break}copied+=n as u64;if copied>expected{return Err(error("ZIP size mismatch"))}hash.update(&buffer[..n]);target.write_all(&buffer[..n]).map_err(|_|error("staging write failed"))?;}
        if copied!=expected{return Err(error("ZIP size mismatch"))}target.sync_all().map_err(|_|error("cannot flush staged file"))?;
        hashes.insert(relative,format!("{:x}",hash.finalize()));
    }Ok(hashes)
}
fn validate_package(stage:&Path,version:&str,read_version:impl Fn(&Path)->Result<String,String>)->Result<(),String>{
    for required in ["object0.exe","WebView2Runtime/msedgewebview2.exe","yuncang-package.json"] {
        if !stage.join(required).is_file(){return Err(error("required package member missing"))}
    }
    let marker=stage.join("yuncang-package.json");if marker.metadata().map_err(|_|error("metadata unavailable"))?.len()>4096{return Err(error("invalid metadata"))}
    let info:PackageInfo=serde_json::from_slice(&fs::read(marker).map_err(|_|error("metadata unavailable"))?).map_err(|_|error("invalid metadata"))?;
    if info.schema_version!=1 || info.identifier!=IDENTIFIER || info.version!=version || info.platform!=PLATFORM || info.kind!="portable" {return Err(error("package identity mismatch"))}
    if read_version(&stage.join("object0.exe"))?!=version {return Err(error("executable version mismatch"))}Ok(())
}
/// Only allowlisted distribution members move; unrelated user files stay put.
/// The journal also handles failure halfway through a top-level directory swap.
#[derive(Debug)]
struct Swapped { name:String, had_original:bool }
fn swap_files(target:&Path,stage:&Path,backup:&Path,fail_after:Option<usize>)->Result<Vec<Swapped>,String>{
    no_links(target)?;no_links(stage)?;no_links(backup)?;
    fs::create_dir(backup).map_err(|_|error("cannot create backup"))?;
    let mut moved:Vec<(String,bool,bool)>=Vec::new();
    let work=(||{
        for name in TOP_FILES {
            if !stage.join(name).exists(){continue}
            let to=target.join(name);no_links(&to)?;
            if to.exists() && fs::symlink_metadata(&to).map_err(|_|error("cannot inspect existing entry"))?.is_dir() && name!="WebView2Runtime" {return Err(error("unexpected existing directory"))}
            let had=to.exists();
            if had {fs::rename(&to,backup.join(name)).map_err(|_|error("file is busy or backup failed"))?;}
            moved.push((name.to_string(),had,false));
            if fail_after==Some(moved.len()){return Err(error("injected swap failure"))}
            fs::rename(stage.join(name),&to).map_err(|_|error("cannot install staged member"))?;
            moved.last_mut().unwrap().2=true;
        }Ok(())
    })();
    if let Err(cause)=work {
        let mut restored=true;
        for (name,had,installed) in moved.iter().rev(){
            if *installed && fs::rename(target.join(name),stage.join(name)).is_err(){restored=false;continue}
            if *had && fs::rename(backup.join(name),target.join(name)).is_err(){restored=false}
        }
        return Err(if restored{format!("{cause}; 已恢复旧程序 / Previous files restored")}else{format!("{cause}; 备份已保留，请手动恢复 / Backup retained; manual recovery required")})
    }
    Ok(moved.into_iter().map(|(name,had,_)|Swapped{name,had_original:had}).collect())
}
fn restore_successful_swap(target:&Path,stage:&Path,backup:&Path,original:&[Swapped])->Result<(),String>{
    for moved in original.iter().rev(){
        let name=&moved.name;
        let current=target.join(name);if current.exists() && !stage.join(name).exists(){no_links(&current)?;fs::rename(&current,stage.join(name)).map_err(|_|error("rollback file is busy"))?;}
        if moved.had_original{fs::rename(backup.join(name),current).map_err(|_|error("rollback failed; backup retained"))?;}
    }Ok(())
}
fn write_result(root:&Path,plan:&Plan,status:&str,message:&str){
    let value=serde_json::json!({"version":plan.version,"releaseId":plan.nonce,"status":status,"message":message,"target":plan.target});
    let tmp=root.join(format!("result-{}.tmp",plan.nonce));let final_path=root.join(format!("result-{}.json",plan.nonce));
    if let Ok(bytes)=serde_json::to_vec(&value){if fs::write(&tmp,bytes).is_ok(){let _=fs::rename(tmp,final_path);}}
    let summary=serde_json::json!({"version":plan.version,"status":status,"message":message});
    let last=root.join("last-portable-result.json");
    if no_links(&last).is_ok(){if let Ok(bytes)=serde_json::to_vec(&summary){let _=crate::write_atomic(&last,&bytes);}}
}
pub(crate) fn other_instances_running()->Result<bool,String>{
    // Editions in different directories still share the user's config. Be
    // conservative about another object0 executable; never kill it ourselves.
    Ok(process_paths()?.iter().any(|(pid,path)|*pid!=std::process::id() && path.file_name().is_some_and(|name|name.to_string_lossy().eq_ignore_ascii_case("object0.exe"))))
}
fn normalized_path(path:&Path)->String{path.to_string_lossy().to_lowercase().trim_start_matches("\\\\?\\").to_string()}
fn same_path(a:&Path,b:&Path)->bool {normalized_path(a)==normalized_path(b)}
fn target_busy(target:&Path)->Result<bool,String>{
    let exe=target.join("object0.exe");let runtime=normalized_path(&target.join("WebView2Runtime"));
    Ok(process_paths()?.iter().any(|(_,p)|same_path(p,&exe) || normalized_path(p).starts_with(&(runtime.clone()+"\\"))))
}
fn helper(plan_path:&Path,nonce:&str)->Result<(),String>{
    let root=cache()?;let path=canonical(plan_path)?;
    if path.parent()!=Some(root.as_path()) || path.file_name().and_then(|s|s.to_str())!=Some(format!("portable-{nonce}.json").as_str()) || uuid::Uuid::parse_str(nonce).is_err(){return Err(error("invalid helper request"))}
    if path.metadata().map_err(|_|error("plan unavailable"))?.len()>32*1024{return Err(error("oversized helper request"))}
    let plan:Plan=serde_json::from_slice(&fs::read(path).map_err(|_|error("plan unavailable"))?).map_err(|_|error("invalid helper request"))?;
    if plan.schema_version!=1 || plan.nonce!=nonce {return Err(error("helper request mismatch"))}
    let _claim=fs::OpenOptions::new().write(true).create_new(true).open(root.join(format!("claimed-{nonce}"))).map_err(|_|error("update already claimed"))?;
    let work=(||{
        let key=github_updates::pinned_public_key().ok_or_else(||error("signing not configured"))?;
        let target=canonical(&plan.target)?;let archive=canonical(&plan.archive)?;
        let config=canonical(&crate::config_paths::object0_config_dir()?)?;
        if target.components().count()<4 || target.starts_with(&config) || config.starts_with(&target) || !archive.starts_with(&root){return Err(error("unsafe target or archive location"))}
        let _package_lock=lock_read(&archive)?;
        if hash_file(&target.join("object0.exe"))?!=plan.old_sha256 || hash_file(&archive)?!=plan.sha256{return Err(error("file changed since confirmation"))}
        github_updates::verify_signed_file(&archive,&plan.signature,&key)?;
        let parent=target.parent().ok_or_else(||error("invalid target"))?;let stage=parent.join(format!(".yuncang-stage-{nonce}"));let backup=parent.join(format!(".yuncang-backup-{nonce}"));
        no_links(parent)?;fs::create_dir(&stage).map_err(|_|error("cannot create same-volume staging"))?;
        let staged_hashes=unpack(&archive,&stage,&plan.version)?;
        if tree_hashes(&stage)?!=staged_hashes{return Err(error("staged bytes differ from signed package"))}
        validate_package(&stage,&plan.version,executable_version)?;
        let until=Instant::now()+Duration::from_secs(120);
        while target_busy(&target)? {if Instant::now()>=until{return Err(error("program still running; old version preserved"))}thread::sleep(Duration::from_millis(200));}
        if hash_file(&target.join("object0.exe"))?!=plan.old_sha256{return Err(error("program changed while waiting"))}
        if tree_hashes(&stage)?!=staged_hashes{return Err(error("staged files changed while waiting"))}
        let original=swap_files(&target,&stage,&backup,None)?;
        let installed_locks=match lock_verified_tree(&target,&staged_hashes){Ok(locks)=>locks,Err(cause)=>{restore_successful_swap(&target,&stage,&backup,&original)?;return Err(cause)}};
        write_result(&root,&plan,"launching","程序文件已校验，正在启动新版 / Verified program files; starting the new version");
        let mut command=Command::new(target.join("object0.exe"));command.current_dir(&target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        match command.spawn(){
            Ok(mut child)=>{
                thread::sleep(Duration::from_secs(2));
                if child.try_wait().map_err(|_|error("cannot inspect launched version"))?.is_some(){
                    drop(installed_locks);
                    if target_busy(&target)?{return Err(error("new launch exited; backup retained because files remain busy"))}
                    restore_successful_swap(&target,&stage,&backup,&original)?;
                    let _=Command::new(target.join("object0.exe")).current_dir(&target).spawn();
                    return Err(error("new version exited early; previous version restored"))
                }
                write_result(&root,&plan,"installed-awaiting-ui-confirmation","程序文件已更新并发出启动请求，备份保留 / Files updated and process launched; backup retained");Ok(())
            }
            Err(_)=>{drop(installed_locks);restore_successful_swap(&target,&stage,&backup,&original)?;let _=Command::new(target.join("object0.exe")).current_dir(&target).spawn();Err(error("launch failed; previous version restored"))}
        }
    })();
    if let Err(ref message)=work{write_result(&root,&plan,"failed",message);}work
}
pub(crate) fn apply(app:&tauri::AppHandle,prepared:&PreparedUpdate)->Result<(),String>{
    if !cfg!(target_os="windows") || prepared.platform!=PLATFORM || prepared.kind!=github_updates::PackageKind::Portable{return Err(error("unsupported portable platform"))}
    let root=cache()?;let current=canonical(&std::env::current_exe().map_err(|_|error("current executable unavailable"))?)?;
    let target=current.parent().ok_or_else(||error("target unavailable"))?.to_path_buf();
    let config=canonical(&crate::config_paths::object0_config_dir()?)?;
    let archive=canonical(&prepared.path)?;
    if target.components().count()<4 || target.starts_with(&config) || config.starts_with(&target) || !archive.starts_with(&root){return Err(error("unsafe update location"))}
    let key=github_updates::pinned_public_key().ok_or_else(||error("signing not configured"))?;
    let _package_lock=lock_read(&archive)?;
    if hash_file(&archive)?!=prepared.sha256{return Err(error("package changed"))}
    github_updates::verify_signed_file(&archive,&prepared.signature,&key)?;
    let nonce=uuid::Uuid::new_v4().to_string();let helper_path=root.join(format!("yuncang-helper-{nonce}.exe"));
    let old_sha256=hash_file(&current)?;
    fs::copy(&current,&helper_path).map_err(|_|error("cannot prepare update helper"))?;
    if hash_file(&helper_path)?!=old_sha256{return Err(error("helper copy verification failed"))}
    let plan=Plan{schema_version:1,nonce:nonce.clone(),target,archive:canonical(&prepared.path)?,version:prepared.version.clone(),sha256:prepared.sha256.clone(),signature:prepared.signature.clone(),old_sha256};
    let plan_path=root.join(format!("portable-{nonce}.json"));
    let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&plan_path).map_err(|_|error("cannot write helper plan"))?;
    file.write_all(&serde_json::to_vec(&plan).map_err(|_|error("cannot encode helper plan"))?).map_err(|_|error("cannot write helper plan"))?;file.sync_all().map_err(|_|error("cannot flush helper plan"))?;
    let mut command=Command::new(helper_path);command.args(["--yuncang-portable-update",plan_path.to_str().ok_or_else(||error("invalid helper path"))?,&nonce]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x0800_0000);}
    command.spawn().map_err(|_|error("cannot launch update helper"))?;app.exit(0);Ok(())
}
pub fn run_helper_from_args()->Option<i32>{
    let args:Vec<_>=std::env::args_os().collect();
    if args.get(1).and_then(|s|s.to_str())==Some("--yuncang-verify-update-file") {
        if args.len()!=4{return Some(2)}
        let verify=(||{
            let key=github_updates::pinned_public_key().ok_or_else(||error("signing not configured"))?;
            let signature_path=Path::new(&args[3]);
            if signature_path.metadata().map_err(|_|error("signature missing"))?.len()>16384{return Err(error("signature too large"))}
            let signature=fs::read_to_string(signature_path).map_err(|_|error("signature unavailable"))?;
            github_updates::verify_signed_file(Path::new(&args[2]),&signature,&key)
        })();
        return Some(if verify.is_ok(){0}else{1});
    }
    if args.get(1).and_then(|s|s.to_str())!=Some("--yuncang-portable-update"){return None}
    if args.len()!=4{return Some(2)}
    Some(match args[3].to_str().ok_or_else(||error("invalid nonce")).and_then(|nonce|helper(Path::new(&args[2]),nonce)){Ok(())=>0,Err(_)=>1})
}

#[cfg(not(windows))] fn process_paths()->Result<Vec<(u32,PathBuf)>,String>{Ok(Vec::new())}
#[cfg(not(windows))] fn executable_version(_:&Path)->Result<String,String>{Err(error("Windows executable required"))}
#[cfg(not(windows))] fn check_free_space(_:&Path,_:u64)->Result<(),String>{Ok(())}

#[cfg(windows)]
mod win {
    use super::*;use std::{ffi::c_void,os::windows::ffi::{OsStrExt,OsStringExt}};
    type Handle=*mut c_void;
    #[repr(C)] struct Entry{size:u32,usage:u32,pid:u32,heap:usize,module:u32,threads:u32,parent:u32,priority:i32,flags:u32,exe:[u16;260]}
    #[link(name="kernel32")] unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags:u32,pid:u32)->Handle;fn Process32FirstW(snapshot:Handle,entry:*mut Entry)->i32;fn Process32NextW(snapshot:Handle,entry:*mut Entry)->i32;
        fn OpenProcess(access:u32,inherit:i32,pid:u32)->Handle;fn QueryFullProcessImageNameW(process:Handle,flags:u32,name:*mut u16,len:*mut u32)->i32;fn CloseHandle(handle:Handle)->i32;
        fn GetDiskFreeSpaceExW(path:*const u16,available:*mut u64,total:*mut u64,free:*mut u64)->i32;
    }
    #[link(name="version")] unsafe extern "system" {
        fn GetFileVersionInfoSizeW(file:*const u16,handle:*mut u32)->u32;fn GetFileVersionInfoW(file:*const u16,handle:u32,len:u32,data:*mut c_void)->i32;
        fn VerQueryValueW(block:*const c_void,sub:*const u16,value:*mut *mut c_void,len:*mut u32)->i32;
    }
    fn wide(path:&std::ffi::OsStr)->Vec<u16>{path.encode_wide().chain(Some(0)).collect()}
    pub(super) fn process_paths()->Result<Vec<(u32,PathBuf)>,String>{unsafe{
        let snapshot=CreateToolhelp32Snapshot(2,0);if snapshot as isize == -1{return Err(error("cannot enumerate running processes"))}
        let mut entry:Entry=std::mem::zeroed();entry.size=std::mem::size_of::<Entry>() as u32;let mut result=Vec::new();let mut more=Process32FirstW(snapshot,&mut entry)!=0;
        while more{let name=String::from_utf16_lossy(&entry.exe[..entry.exe.iter().position(|c|*c==0).unwrap_or(260)]);let process=OpenProcess(0x1000,0,entry.pid);let mut resolved=false;if !process.is_null(){let mut buffer=vec![0u16;32768];let mut len=buffer.len() as u32;if QueryFullProcessImageNameW(process,0,buffer.as_mut_ptr(),&mut len)!=0{result.push((entry.pid,PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len as usize]))));resolved=true;}CloseHandle(process);}if !resolved && name.eq_ignore_ascii_case("object0.exe"){CloseHandle(snapshot);return Err(error("cannot inspect another object0 process; close it normally before updating"))}more=Process32NextW(snapshot,&mut entry)!=0;}
        CloseHandle(snapshot);Ok(result)
    }}
    pub(super) fn check_free_space(parent:&Path,needed:u64)->Result<(),String>{unsafe{let mut available=0;let path=wide(parent.as_os_str());if GetDiskFreeSpaceExW(path.as_ptr(),&mut available,std::ptr::null_mut(),std::ptr::null_mut())==0 || available<needed{return Err(error("insufficient disk space"))}Ok(())}}
    pub(super) fn executable_version(path:&Path)->Result<String,String>{unsafe{
        let path=wide(path.as_os_str());let mut handle=0;let size=GetFileVersionInfoSizeW(path.as_ptr(),&mut handle);if size==0 || size>16*1024*1024{return Err(error("executable has no version resource"))}
        let mut data=vec![0u8;size as usize];if GetFileVersionInfoW(path.as_ptr(),0,size,data.as_mut_ptr().cast())==0{return Err(error("cannot read executable version"))}
        let mut translations=std::ptr::null_mut();let mut len=0;let sub=wide(std::ffi::OsStr::new("\\VarFileInfo\\Translation"));
        if VerQueryValueW(data.as_ptr().cast(),sub.as_ptr(),&mut translations,&mut len)==0 || len<4{return Err(error("version translation missing"))}
        let pairs=std::slice::from_raw_parts(translations.cast::<u16>(),len as usize/2);
        for pair in pairs.chunks_exact(2){let query=format!("\\StringFileInfo\\{:04x}{:04x}\\ProductVersion",pair[0],pair[1]);let sub=wide(std::ffi::OsStr::new(&query));let mut value=std::ptr::null_mut();let mut chars=0;
            if VerQueryValueW(data.as_ptr().cast(),sub.as_ptr(),&mut value,&mut chars)!=0 && chars>1 && chars<1024 {let text=String::from_utf16_lossy(std::slice::from_raw_parts(value.cast::<u16>(),chars as usize));return Ok(text.trim_end_matches('\0').trim().to_string())}
        }Err(error("product version missing"))
    }}
}
#[cfg(windows)] use win::{process_paths,executable_version,check_free_space};

#[cfg(test)]
#[path="portable_update_tests.rs"]
mod tests;
