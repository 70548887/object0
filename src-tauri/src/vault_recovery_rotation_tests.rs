//! Every file and credential in this suite is a freshly allocated synthetic fixture.
use super::*;

const PASSWORD:&str="rotation-fixture-password";
const OLD_RECOVERY:&str="rotation-fixture-old-recovery";
struct Fixture{root:PathBuf}
impl Fixture{
    fn new()->Self{let root=std::env::temp_dir().join(format!("yuncang-recovery-rotation-{}",Uuid::new_v4()));fs::create_dir(&root).unwrap();Self{root}}
    fn path(&self)->PathBuf{self.root.join("vault.enc")}
    fn count(&self)->usize{fs::read_dir(&self.root).unwrap().count()}
}
impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
fn fixture_runtime(v4:bool)->VaultRuntime{
    let profile:Profile=serde_json::from_value(json!({"id":"fixture-profile","name":"Preserved account","provider":if v4{"qiniu"}else{"custom"},"accessKeyId":"fixture-access-id","secretAccessKey":"fixture-secret-key","qiniu":if v4{json!({})}else{Value::Null},"createdAt":"t","updatedAt":"revision-1"})).unwrap();
    let salt=vec![17;SALT_BYTES];let recovery_salt=vec![23;SALT_BYTES];
    VaultRuntime{plaintext:false,unlocked:true,data:Some(VaultData{profiles:vec![profile],transfer_master_key:if v4{Some(TransferMasterKey([31;KEY_BYTES]))}else{None}}),key:Some(derive_key(PASSWORD,&salt)),salt:Some(salt),recovery_key:Some(derive_key(OLD_RECOVERY,&recovery_salt)),recovery_salt:Some(recovery_salt)}
}
fn reopen(path:&Path)->VaultRuntime{
    let payload=unlock_with_passphrase(path,PASSWORD).unwrap();
    VaultRuntime{plaintext:false,unlocked:true,data:Some(payload.data),key:Some(payload.key),salt:Some(payload.salt),recovery_key:None,recovery_salt:payload.recovery_salt}
}
fn runtime_snapshot(vault:&VaultRuntime)->Value{
    json!({"unlocked":vault.unlocked,"data":vault.data,"key":vault.key,"salt":vault.salt,"recoveryKey":vault.recovery_key,"recoverySalt":vault.recovery_salt})
}
fn assert_rotation(v4:bool){
    let fixture=Fixture::new();let path=fixture.path();save_vault(&path,&fixture_runtime(v4)).unwrap();let mut live=reopen(&path);let old=fs::read(&path).unwrap();let before:Value=serde_json::from_slice(&old).unwrap();let data=serde_json::to_value(live.data.as_ref().unwrap()).unwrap();let primary=live.key;let salt=live.salt.clone();
    let result=rotate_recovery_key(&path,&mut live,PASSWORD,true).unwrap();let after:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(fs::read(&result.backup_path).unwrap(),old);assert_eq!(fixture.count(),2);
    for field in ["version","salt","iv","data"]{assert_eq!(after[field],before[field],"primary envelope field changed: {field}");}
    assert_ne!(after["recovery"],before["recovery"]);assert_eq!(after["version"],if v4{4}else{3});
    assert_eq!(live.key,primary);assert_eq!(live.salt,salt);assert_eq!(serde_json::to_value(live.data.as_ref().unwrap()).unwrap(),data);
    assert_eq!(serde_json::to_value(unlock_with_passphrase(&path,PASSWORD).unwrap().data).unwrap(),data);
    assert!(unlock_with_recovery_key(&path,OLD_RECOVERY).is_err());
    assert_eq!(serde_json::to_value(unlock_with_recovery_key(&path,&result.recovery_key).unwrap().data).unwrap(),data);
    // The encrypted backup is intentional rollback evidence; its old recovery
    // key remains valid for that backup, never the rotated live file.
    assert!(unlock_with_recovery_key(Path::new(&result.backup_path),OLD_RECOVERY).is_ok());
    let encrypted=String::from_utf8(fs::read(&path).unwrap()).unwrap();assert!(!encrypted.contains(&result.recovery_key));assert!(!encrypted.contains(PASSWORD));assert!(!encrypted.contains("fixture-secret-key"));
    if v4{assert_eq!(existing_transfer_master_key(&live).unwrap(),Some([31;KEY_BYTES]));}
}

#[test]fn rotation_preserves_v3_primary_envelope_accounts_and_password(){assert_rotation(false)}
#[test]fn rotation_preserves_v4_primary_envelope_and_durable_transfer_identity(){assert_rotation(true)}

#[test]fn rotation_replaces_a_stale_legacy_recovery_snapshot_with_current_primary_data(){
    let fixture=Fixture::new();let path=fixture.path();save_vault(&path,&fixture_runtime(false)).unwrap();let mut live=reopen(&path);
    live.data.as_mut().unwrap().profiles[0].name="Newest primary account".into();save_vault(&path,&live).unwrap();
    assert_eq!(unlock_with_recovery_key(&path,OLD_RECOVERY).unwrap().data.profiles[0].name,"Preserved account");
    let result=rotate_recovery_key(&path,&mut live,PASSWORD,true).unwrap();
    assert_eq!(unlock_with_recovery_key(&path,&result.recovery_key).unwrap().data.profiles[0].name,"Newest primary account");
    assert_eq!(unlock_with_passphrase(&path,PASSWORD).unwrap().data.profiles[0].name,"Newest primary account");
}

#[test]fn rotated_legacy_key_unblocks_qiniu_migration_and_survives_reopen(){
    let fixture=Fixture::new();let path=fixture.path();save_vault(&path,&fixture_runtime(false)).unwrap();let mut live=reopen(&path);
    let rotated=rotate_recovery_key(&path,&mut live,PASSWORD,true).unwrap();
    // This is the same session that the settings dialog returns to. No old
    // recovery key is needed to authorize the subsequent first-Qiniu save.
    authorize_qiniu_migration_recovery(&path,&mut live,None).unwrap();
    let profile:Profile=serde_json::from_value(json!({"id":"new-qiniu-profile","name":"New Qiniu fixture","provider":"qiniu","accessKeyId":"qiniu-fixture-ak","secretAccessKey":"qiniu-fixture-sk","qiniu":{},"createdAt":"t","updatedAt":"revision-1"})).unwrap();
    live.data.as_mut().unwrap().profiles.push(profile);
    live.data.as_mut().unwrap().transfer_master_key=Some(TransferMasterKey([59;KEY_BYTES]));
    save_vault(&path,&live).unwrap();assert!(matches!(read_vault_file(&path).unwrap(),VaultFileDisk::V4(_)));
    let expected=serde_json::to_value(live.data.as_ref().unwrap()).unwrap();
    let recovered=unlock_with_recovery_key(&path,&rotated.recovery_key).unwrap();assert_eq!(serde_json::to_value(&recovered.data).unwrap(),expected);
    assert_eq!(recovered.data.profiles.len(),2);assert_eq!(recovered.data.transfer_master_key.as_ref().unwrap().0,[59;KEY_BYTES]);
    assert!(unlock_with_recovery_key(&path,OLD_RECOVERY).is_err());
    let mut reopened=reopen(&path);assert!(reopened.recovery_key.is_none());
    authorize_qiniu_migration_recovery(&path,&mut reopened,None).unwrap();
    save_vault(&path,&reopened).unwrap();
    assert_eq!(serde_json::to_value(unlock_with_passphrase(&path,PASSWORD).unwrap().data).unwrap(),expected);
    assert_eq!(serde_json::to_value(unlock_with_recovery_key(&path,&rotated.recovery_key).unwrap().data).unwrap(),expected);
    assert_eq!(existing_transfer_master_key(&reopened).unwrap(),Some([59;KEY_BYTES]));
}

#[test]fn rotation_wrong_password_unconfirmed_locked_and_recovery_only_never_write(){
    let fixture=Fixture::new();let path=fixture.path();save_vault(&path,&fixture_runtime(false)).unwrap();let original=fs::read(&path).unwrap();let mut live=reopen(&path);let unchanged=runtime_snapshot(&live);
    assert!(rotate_recovery_key(&path,&mut live,PASSWORD,false).err().unwrap().contains("Confirm"));
    assert!(rotate_recovery_key(&path,&mut live,"wrong-password",true).err().unwrap().contains("Current password verification failed"));
    assert!(rotate_recovery_key(&path,&mut live,"",true).is_err());assert_eq!(runtime_snapshot(&live),unchanged);assert_eq!(fs::read(&path).unwrap(),original);assert_eq!(fixture.count(),1);
    live.unlocked=false;assert!(rotate_recovery_key(&path,&mut live,PASSWORD,true).is_err());
    let recovered=unlock_with_recovery_key(&path,OLD_RECOVERY).unwrap();let mut recovery_only=VaultRuntime{plaintext:false,unlocked:true,data:Some(recovered.data),salt:Some(recovered.salt),recovery_key:Some(recovered.recovery_key),recovery_salt:Some(recovered.recovery_salt),key:None};
    assert!(rotate_recovery_key(&path,&mut recovery_only,PASSWORD,true).err().unwrap().contains("rekeyed"));assert_eq!(fs::read(&path).unwrap(),original);assert_eq!(fixture.count(),1);
}

#[test]fn rotation_rejects_stale_disk_data_or_recovery_envelope_before_backup(){
    let fixture=Fixture::new();let path=fixture.path();save_vault(&path,&fixture_runtime(false)).unwrap();let mut live=reopen(&path);let unchanged=runtime_snapshot(&live);
    let mut external=fixture_runtime(false);external.data.as_mut().unwrap().profiles[0].name="External update".into();save_vault(&path,&external).unwrap();let external_bytes=fs::read(&path).unwrap();
    assert!(rotate_recovery_key(&path,&mut live,PASSWORD,true).err().unwrap().contains("vault changed"));assert_eq!(fs::read(&path).unwrap(),external_bytes);assert_eq!(runtime_snapshot(&live),unchanged);assert_eq!(fixture.count(),1);
    external=fixture_runtime(false);external.recovery_salt=Some(vec![44;SALT_BYTES]);external.recovery_key=Some(derive_key("external-new-recovery",&[44;SALT_BYTES]));save_vault(&path,&external).unwrap();let external_bytes=fs::read(&path).unwrap();
    assert!(rotate_recovery_key(&path,&mut live,PASSWORD,true).err().unwrap().contains("vault changed"));assert_eq!(fs::read(&path).unwrap(),external_bytes);assert_eq!(runtime_snapshot(&live),unchanged);assert_eq!(fixture.count(),1);
}

#[test]fn rotation_backup_and_candidate_write_failures_preserve_original_and_runtime(){
    let fixture=Fixture::new();let path=fixture.path();save_vault(&path,&fixture_runtime(false)).unwrap();let original=fs::read(&path).unwrap();let mut live=reopen(&path);let unchanged=runtime_snapshot(&live);
    let result=rotate_recovery_key_with_io(&path,&mut live,PASSWORD,true,|_,_|Err("synthetic backup failure".into()),|_,_,_|panic!("must not persist without backup"));assert!(result.is_err());assert_eq!(fixture.count(),1);assert_eq!(fs::read(&path).unwrap(),original);assert_eq!(runtime_snapshot(&live),unchanged);
    let result=rotate_recovery_key_with_io(&path,&mut live,PASSWORD,true,backup_for_recovery_rotation,|_,_,_|Err("synthetic candidate write failure".into()));assert!(result.is_err());assert_eq!(fixture.count(),2);assert_eq!(fs::read(&path).unwrap(),original);assert_eq!(runtime_snapshot(&live),unchanged);assert!(unlock_with_recovery_key(&path,OLD_RECOVERY).is_ok());
}

#[test]fn rotation_rechecks_external_change_after_backup_instead_of_overwriting_it(){
    let fixture=Fixture::new();let path=fixture.path();save_vault(&path,&fixture_runtime(false)).unwrap();let original=fs::read(&path).unwrap();let mut live=reopen(&path);let unchanged=runtime_snapshot(&live);
    let mut external=fixture_runtime(false);external.data.as_mut().unwrap().profiles[0].name="changed during backup".into();
    let result=rotate_recovery_key_with_io(&path,&mut live,PASSWORD,true,|path,bytes|{let backup=backup_for_recovery_rotation(path,bytes)?;save_vault(path,&external)?;Ok(backup)},persist_recovery_rotation);
    assert!(result.err().unwrap().contains("vault changed"));assert_eq!(runtime_snapshot(&live),unchanged);let disk=unlock_with_passphrase(&path,PASSWORD).unwrap();assert_eq!(disk.data.profiles[0].name,"changed during backup");
    let backups:Vec<_>=fs::read_dir(&fixture.root).unwrap().filter_map(Result::ok).filter(|entry|entry.file_name().to_string_lossy().ends_with(".bak")).collect();assert_eq!(backups.len(),1);assert_eq!(fs::read(backups[0].path()).unwrap(),original);
}

#[test]fn rotation_rpc_requires_explicit_confirmation_and_rejects_unknown_fields(){
    assert_eq!(RpcMethod::parse("vault:rotate-recovery-key"),Some(RpcMethod::VaultRotateRecoveryKey));
    assert!(serde_json::from_value::<RotateRecoveryKeyInput>(json!({"passphrase":"fixture"})).is_err());
    assert!(serde_json::from_value::<RotateRecoveryKeyInput>(json!({"passphrase":"fixture","confirmInvalidateOldKey":true,"recoveryKey":"not-needed"})).is_err());
    let input:RotateRecoveryKeyInput=serde_json::from_value(json!({"passphrase":"fixture","confirmInvalidateOldKey":true})).unwrap();assert!(input.confirm_invalidate_old_key);
}
