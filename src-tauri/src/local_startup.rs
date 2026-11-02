//! Default keyless local accounts, with an explicit one-time legacy import.
//! Only fixed paths supplied by the RPC may be used in production. No legacy
//! ciphertext is modified and no secret fields enter this response DTO.
use super::*;

const CHANGED:&str="账号文件或当前会话已变化，请重新打开后导入 / Account files or the current session changed; reopen before importing";
const INVALID:&str="本地账号文件无法读取，未回退到旧密码库或创建空库 / Local accounts could not be read; no old-vault fallback or empty replacement was used";

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct LocalOpenReport {
    pub(crate) ready:bool,
    pub(crate) legacy_import_required:bool,
    pub(crate) legacy_available:bool,
    pub(crate) storage_mode:&'static str,
    pub(crate) config_path:String,
    pub(crate) profiles:Vec<ProfileInfo>,
    pub(crate) version:u8,
    pub(crate) has_recovery_key:bool,
}

fn report(plain:&Path,vault:&VaultRuntime,ready:bool,legacy:bool)->LocalOpenReport {
    LocalOpenReport {ready,legacy_import_required:!ready&&legacy,legacy_available:legacy,storage_mode:"plaintext",config_path:plain.to_string_lossy().into_owned(),profiles:if ready{profile_infos(vault)}else{vec![]},version:5,has_recovery_key:false}
}
fn present(path:&Path)->Result<bool,String>{
    match fs::symlink_metadata(path) {
        Ok(metadata)=>{
            if !metadata.is_file()||metadata.file_type().is_symlink(){return Err(INVALID.into())}
            Ok(true)
        },
        Err(error)if error.kind()==io::ErrorKind::NotFound=>Ok(false),
        Err(_)=>Err(INVALID.into()),
    }
}
fn same_data(a:&VaultData,b:&VaultData)->Result<bool,String>{
    Ok(serde_json::to_value(a).map_err(|_|INVALID.to_string())?==serde_json::to_value(b).map_err(|_|INVALID.to_string())?)
}
fn fresh(vault:&VaultRuntime)->bool {
    !vault.unlocked&&!vault.plaintext&&vault.data.is_none()&&vault.key.is_none()&&vault.salt.is_none()&&vault.recovery_key.is_none()&&vault.recovery_salt.is_none()
}

/// Normal startup has no password/recovery gate. A locked legacy file is an
/// optional import source, not permission to silently discard old accounts.
pub(crate) fn open_local(encrypted:&Path,plain:&Path,vault:&mut VaultRuntime,skip_legacy_import:bool)->Result<LocalOpenReport,String>{
    if present(plain)? {
        let candidate=plaintext_accounts::load(plain)?;
        if vault.unlocked {
            if !vault.plaintext||!same_data(vault.data.as_ref().ok_or(INVALID)?,candidate.data.as_ref().ok_or(INVALID)?)?{return Err(CHANGED.into())}
        }
        *vault=candidate;
        // The active account file was validated successfully. A broken or
        // inaccessible optional legacy import source must not block it.
        let legacy=present(encrypted).unwrap_or(false);
        return Ok(report(plain,vault,true,legacy));
    }
    let legacy=present(encrypted)?;
    if vault.plaintext{return Err(INVALID.into())}
    if legacy&&vault.unlocked {
        // Existing enable validates current primary key/salt/data and preserves
        // the exact encrypted file. It never asks for a recovery key.
        plaintext_accounts::enable(encrypted,plain,vault,true)?;
        return Ok(report(plain,vault,true,true));
    }
    if legacy&&!skip_legacy_import {
        return Ok(report(plain,vault,false,true));
    }
    if !fresh(vault){return Err(CHANGED.into())}
    let candidate=VaultRuntime {plaintext:true,unlocked:true,data:Some(VaultData::default()),..Default::default()};
    plaintext_accounts::commit_import(plain,&candidate,None)?;
    *vault=candidate;
    Ok(report(plain,vault,true,legacy))
}

fn merge_data(current:&VaultData,legacy:&VaultData)->Result<VaultData,String>{
    let mut merged=current.clone();
    let mut seen:HashMap<String,&Profile>=current.profiles.iter().map(|profile|(profile.id.clone(),profile)).collect();
    if seen.len()!=current.profiles.len(){return Err(INVALID.into())}
    let mut legacy_ids=HashSet::new();
    for profile in &legacy.profiles {
        if profile.id.is_empty()||!legacy_ids.insert(&profile.id){return Err(INVALID.into())}
        match seen.get(&profile.id) {
            Some(existing)if serde_json::to_value(existing).map_err(|_|INVALID.to_string())?!=serde_json::to_value(profile).map_err(|_|INVALID.to_string())?=>return Err("旧账号与本地账号 ID 冲突，未覆盖任何账号 / Legacy and local account IDs conflict; no account was overwritten".into()),
            Some(_)=>{},
            None=>{merged.profiles.push(profile.clone());seen.insert(profile.id.clone(),profile);},
        }
    }
    if let (Some(a),Some(b))=(&current.transfer_master_key,&legacy.transfer_master_key) {
        if serde_json::to_value(a).map_err(|_|INVALID.to_string())?!=serde_json::to_value(b).map_err(|_|INVALID.to_string())? {
            return Err("新旧传输密钥不同，未导入以避免丢失任务恢复身份 / Transfer keys differ; import was stopped to preserve resumable-task identities".into());
        }
    }
    if merged.transfer_master_key.is_none(){merged.transfer_master_key=legacy.transfer_master_key.clone();}
    Ok(merged)
}

/// Manual import verifies the old primary passphrase once. Existing local
/// accounts are merged additively, never replaced with a legacy snapshot.
pub(crate) fn import_legacy(encrypted:&Path,plain:&Path,vault:&mut VaultRuntime,passphrase:&str)->Result<LocalOpenReport,String>{
    if passphrase.trim().is_empty()||passphrase.len()>4096{return Err("请输入旧账号库的解锁密码 / Enter the old account store's unlock passphrase".into())}
    if !present(encrypted)?{return Err("未找到旧加密账号库 / No legacy encrypted account store was found".into())}
    let original=plaintext_accounts::snapshot(encrypted)?;
    let opened=unlock_with_passphrase(encrypted,passphrase).map_err(|_|"旧账号库密码验证失败，未导入或更改任何账号 / Legacy passphrase verification failed; no account was imported or changed".to_string())?;
    if plaintext_accounts::snapshot(encrypted)?!=original{return Err(CHANGED.into())}
    let expected=if present(plain)?{Some(plaintext_accounts::snapshot(plain)?)}else{None};
    let current=if expected.is_some(){
        let loaded=plaintext_accounts::load(plain)?;
        if vault.unlocked&&(!vault.plaintext||!same_data(vault.data.as_ref().ok_or(INVALID)?,loaded.data.as_ref().ok_or(INVALID)?)?){return Err(CHANGED.into())}
        loaded.data.ok_or(INVALID)?
    }else{
        if vault.plaintext{return Err(INVALID.into())}
        if vault.unlocked {
            ensure_writable(vault)?;
            if vault.key.as_ref()!=Some(&opened.key)||vault.salt.as_ref()!=Some(&opened.salt)||!same_data(vault.data.as_ref().ok_or(INVALID)?,&opened.data)?{return Err(CHANGED.into())}
        }else if !fresh(vault){return Err(CHANGED.into())}
        VaultData::default()
    };
    let merged=merge_data(&current,&opened.data)?;
    let candidate=VaultRuntime {plaintext:true,unlocked:true,data:Some(merged),..Default::default()};
    if plaintext_accounts::snapshot(encrypted)?!=original{return Err(CHANGED.into())}
    plaintext_accounts::commit_import(plain,&candidate,expected.as_deref())?;
    *vault=candidate;
    Ok(report(plain,vault,true,true))
}

#[cfg(test)]
#[path="local_startup_tests.rs"]
mod tests;
