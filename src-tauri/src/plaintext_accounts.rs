//! Explicit opt-in local plaintext account storage. No secret data is returned
//! to frontend DTOs. The original encrypted vault is never changed or removed.
use super::*;

pub(crate) const PASSWORD_UNAVAILABLE:&str="当前为明文账号模式，不使用密码或恢复密钥 / Plaintext account mode does not use passwords or recovery keys";
const INVALID:&str="本地明文账号文件无效，未回退到旧密码库 / Invalid local plaintext account file; the old encrypted vault was not used";
const IO_ERROR:&str="无法安全保存本地明文账号文件，原文件未替换 / Could not safely save local plaintext accounts; the original file was not replaced";
const LIMIT:u64=16*1024*1024;

#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct PlainFile {version:u8,encrypted:bool,data:VaultData}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct EnableInput {pub(crate) confirm_plaintext:bool}

pub(crate) fn is_path(path:&Path)->bool {path.file_name().is_some_and(|name|name=="accounts.local.json")}
pub(crate) fn validate_active_mode(vault:&VaultRuntime,path:&Path)->Result<(),String>{
    let plain=is_path(path);
    // A locked/default process may load the explicitly selected file. A live
    // session must not switch modes because another process created/deleted a
    // file. Keep the plaintext marker after lock to forbid missing-file fallback.
    if (vault.unlocked&&vault.plaintext!=plain)||(vault.plaintext&&!plain){
        return Err("账号存储模式已变化或原文件缺失，请重新打开程序；未回退或覆盖其他账号库 / Account storage mode changed or the original file is missing; reopen the app. No other account store was used or overwritten".into())
    }
    Ok(())
}
pub(crate) fn runtime_mode(vault:&VaultRuntime)->&'static str{if vault.plaintext{"plaintext"}else{"encrypted"}}
fn bytes(path:&Path)->Result<Vec<u8>,String>{
    let meta=fs::symlink_metadata(path).map_err(|_|INVALID.to_string())?;
    if !meta.is_file()||meta.file_type().is_symlink()||meta.len()>LIMIT{return Err(INVALID.into())}
    let bytes=fs::read(path).map_err(|_|INVALID.to_string())?;
    if bytes.len()as u64>LIMIT{return Err(INVALID.into())}Ok(bytes)
}
pub(crate) fn load(path:&Path)->Result<VaultRuntime,String>{
    let file:PlainFile=serde_json::from_slice(&bytes(path)?).map_err(|_|INVALID.to_string())?;
    if file.version!=5||file.encrypted{return Err(INVALID.into())}
    let mut ids=HashSet::new();
    if file.data.profiles.iter().any(|p|p.id.is_empty()||!ids.insert(p.id.clone())){return Err(INVALID.into())}
    Ok(VaultRuntime{plaintext:true,unlocked:true,data:Some(file.data),..Default::default()})
}
fn serialize(vault:&VaultRuntime)->Result<Vec<u8>,String>{
    ensure_unlocked(vault)?;
    let data=vault.data.as_ref().ok_or("Vault is locked")?.clone();
    let payload=serde_json::to_vec_pretty(&PlainFile{version:5,encrypted:false,data}).map_err(|_|IO_ERROR.to_string())?;
    if payload.len()as u64>LIMIT{return Err(IO_ERROR.into())}Ok(payload)
}
fn write(path:&Path,payload:&[u8],create_only:bool)->Result<(),String>{
    write_checked(path,payload,create_only,None)
}
fn write_checked(path:&Path,payload:&[u8],create_only:bool,expected:Option<&[u8]>)->Result<(),String>{
    ensure_parent_dir(path)?;
    let temporary=path.with_file_name(format!(".accounts-local-{}.tmp",Uuid::new_v4()));
    let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_|IO_ERROR.to_string())?;
    let result=(||{
        file.write_all(payload).and_then(|_|file.sync_all()).map_err(|_|IO_ERROR.to_string())?;
        if fs::read(&temporary).map_err(|_|IO_ERROR.to_string())?!=payload{return Err(IO_ERROR.into())}Ok(())
    })();drop(file);
    if let Err(error)=result{let _=fs::remove_file(&temporary);return Err(error)}
    if let Some(expected)=expected {
        if bytes(path).as_deref()!=Ok(expected){let _=fs::remove_file(&temporary);return Err("本地账号文件已变化，请重新打开后导入 / Local accounts changed; reopen before importing".into())}
    }
    let commit=if create_only{fs::hard_link(&temporary,path)}else{fs::rename(&temporary,path)};
    if commit.is_err(){let _=fs::remove_file(&temporary);return Err(IO_ERROR.into())}
    if create_only{let _=fs::remove_file(&temporary);}Ok(())
}

/// A startup/import transaction supplies the prior bytes, or None for a
/// create-only commit. The caller holds the application's vault mutex.
pub(crate) fn snapshot(path:&Path)->Result<Vec<u8>,String>{bytes(path)}
pub(crate) fn commit_import(path:&Path,vault:&VaultRuntime,expected:Option<&[u8]>)->Result<(),String>{
    if !vault.plaintext||!is_path(path){return Err(IO_ERROR.into())}
    if expected.is_some(){load(path)?;}
    write_checked(path,&serialize(vault)?,expected.is_none(),expected)
}
pub(crate) fn save(path:&Path,vault:&VaultRuntime)->Result<(),String>{
    if !vault.plaintext||!is_path(path){return Err(IO_ERROR.into())}
    // Refuse an invalid existing entry rather than replacing it with a new DB.
    let existed=match fs::symlink_metadata(path){Ok(_)=>{load(path)?;true},Err(e)if e.kind()==io::ErrorKind::NotFound=>false,Err(_)=>return Err(IO_ERROR.into())};
    write(path,&serialize(vault)?,!existed)
}

/// Called only by the user's explicit plaintext action. This helper accepts
/// paths for synthetic tests; the RPC supplies only fixed application paths.
pub(crate) fn enable(encrypted:&Path,plain:&Path,vault:&mut VaultRuntime,confirmed:bool)->Result<(),String>{
    if !confirmed{return Err("请确认账号密钥将明文保存，任何可读取该文件的程序都能读取 AK/SK / Confirm that credentials will be plaintext and readable by any program with file access".into())}
    match fs::symlink_metadata(plain){
        Ok(_)=>{
            if !vault.plaintext{return Err("明文账号文件已存在，请重新打开程序读取；未覆盖现有文件 / A plaintext account file already exists; reopen the app to load it. Existing data was not overwritten".into())}
            *vault=load(plain)?;return Ok(())
        },
        Err(error)if error.kind()==io::ErrorKind::NotFound=>{},
        Err(_)=>return Err(IO_ERROR.into()),
    }
    let encrypted_exists=match fs::symlink_metadata(encrypted){
        Ok(metadata)=>{if !metadata.is_file()||metadata.file_type().is_symlink(){return Err(INVALID.into())}true},
        Err(error)if error.kind()==io::ErrorKind::NotFound=>false,
        Err(_)=>return Err(INVALID.into()),
    };
    if vault.plaintext{return Err("原明文账号文件缺失，请保留文件并重新打开程序 / The original plaintext account file is missing; preserve the files and reopen the app".into())}
    let data=if encrypted_exists{
        ensure_writable(vault)?;
        if vault.plaintext{return Err(INVALID.into())}
        let original=bytes(encrypted)?;
        let file=read_vault_file(encrypted).map_err(|_|INVALID.to_string())?;
        let key=vault.key.as_ref().ok_or("Vault must be rekeyed before writing")?;
        let (salt,iv,ciphertext)=match file{
            VaultFileDisk::V1(file)=>{let mut ct=decode_base64(&file.data)?;ct.extend(decode_base64(&file.auth_tag)?);(file.salt,file.iv,ct)},
            VaultFileDisk::V2(file)=>(file.salt,file.iv,decode_base64(&file.data)?),
            VaultFileDisk::V3(file)|VaultFileDisk::V4(file)=>(file.salt,file.iv,decode_base64(&file.data)?),
        };
        if vault.salt.as_ref()!=Some(&decode_base64(&salt)?){return Err("密码库已变化，请重新解锁 / Vault changed; unlock it again".into())}
        let clear=decrypt_payload(key,&decode_base64(&iv)?,&ciphertext).map_err(|_|"密码库身份验证失败 / Vault identity verification failed".to_string())?;
        let disk:VaultData=serde_json::from_slice(&clear).map_err(|_|INVALID.to_string())?;
        let data=vault.data.as_ref().ok_or("Vault is locked")?;
        if serde_json::to_value(&disk).map_err(|_|INVALID.to_string())?!=serde_json::to_value(data).map_err(|_|INVALID.to_string())?||bytes(encrypted)?!=original{return Err("密码库已变化，请重新解锁 / Vault changed; unlock it again".into())}
        data.clone()
    }else{
        if vault.unlocked||vault.data.is_some()||vault.key.is_some()||vault.salt.is_some()||vault.recovery_key.is_some()||vault.recovery_salt.is_some(){return Err("原账号库文件缺失，未创建新的空账号库 / Original account store is missing; no empty replacement was created".into())}
        VaultData::default()
    };
    let candidate=VaultRuntime{plaintext:true,unlocked:true,data:Some(data),..Default::default()};
    write(plain,&serialize(&candidate)?,true)?;
    *vault=candidate;Ok(())
}

#[cfg(test)]
#[path="plaintext_accounts_tests.rs"]
mod tests;
