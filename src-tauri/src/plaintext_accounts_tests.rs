//! Only fresh UUID temporary directories and synthetic credentials are used.
use super::*;
struct Fixture(PathBuf);
impl Fixture {fn new()->Self{let path=std::env::temp_dir().join(format!("yuncang-plain-test-{}",Uuid::new_v4()));fs::create_dir(&path).unwrap();Self(path)}fn encrypted(&self)->PathBuf{self.0.join("vault.enc")}fn plain(&self)->PathBuf{self.0.join("accounts.local.json")}}
impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
fn profile()->Profile{serde_json::from_value(json!({"id":"fixture-profile","name":"Fixture","provider":"custom","accessKeyId":"synthetic-access","secretAccessKey":"synthetic-secret","createdAt":"t","updatedAt":"revision"})).unwrap()}
fn encrypted()->VaultRuntime{let salt=vec![5;SALT_BYTES];VaultRuntime{unlocked:true,data:Some(VaultData{profiles:vec![profile()],..Default::default()}),key:Some(derive_key("synthetic-password",&salt)),salt:Some(salt),..Default::default()}}
fn data(v:&VaultRuntime)->Value{serde_json::to_value(v.data.as_ref().unwrap()).unwrap()}

#[test]fn plaintext_onboarding_requires_confirmation_and_persists_no_password_or_recovery(){
    let f=Fixture::new();let mut runtime=VaultRuntime::default();assert!(enable(&f.encrypted(),&f.plain(),&mut runtime,false).is_err());assert!(!f.plain().exists());
    enable(&f.encrypted(),&f.plain(),&mut runtime,true).unwrap();assert!(runtime.plaintext&&runtime.unlocked);assert!(runtime.key.is_none()&&runtime.salt.is_none()&&runtime.recovery_key.is_none());
    let file:Value=serde_json::from_slice(&fs::read(f.plain()).unwrap()).unwrap();assert_eq!(file["version"],5);assert_eq!(file["encrypted"],false);assert!(file.get("salt").is_none());assert!(file.get("recovery").is_none());
    runtime.data.as_mut().unwrap().profiles.push(profile());save(&f.plain(),&runtime).unwrap();let text=fs::read_to_string(f.plain()).unwrap();assert!(text.contains("synthetic-access")&&text.contains("synthetic-secret"));assert_eq!(data(&load(&f.plain()).unwrap()),data(&runtime));
}
#[test]fn switching_preserves_original_encrypted_bytes_latest_profiles_and_transfer_identity(){
    let f=Fixture::new();let mut live=encrypted();save_vault(&f.encrypted(),&live).unwrap();let key=ensure_transfer_master_key(&f.encrypted(),&mut live,None).unwrap();let original=fs::read(f.encrypted()).unwrap();let before=data(&live);
    enable(&f.encrypted(),&f.plain(),&mut live,true).unwrap();assert_eq!(fs::read(f.encrypted()).unwrap(),original);assert_eq!(data(&live),before);assert_eq!(existing_transfer_master_key(&live).unwrap(),Some(key));
    let mut reloaded=load(&f.plain()).unwrap();assert_eq!(existing_transfer_master_key(&reloaded).unwrap(),Some(key));assert!(reloaded.key.is_none());assert!(ensure_writable(&reloaded).is_ok());
    authorize_qiniu_migration_recovery(&f.plain(),&mut reloaded,None).unwrap();let p=reloaded.data.as_mut().unwrap().profiles.first_mut().unwrap();p.provider=S3Provider::Qiniu;p.qiniu=Some(qiniu::QiniuConfig::default());save_vault(&f.plain(),&reloaded).unwrap();
    assert_eq!(load(&f.plain()).unwrap().data.unwrap().profiles[0].provider,S3Provider::Qiniu);assert_eq!(fs::read(f.encrypted()).unwrap(),original);assert!(unlock_with_passphrase(&f.encrypted(),"synthetic-password").is_ok());
    let safe=serde_json::to_string(&profile_infos(&reloaded)).unwrap();assert!(!safe.contains("synthetic-secret"));assert!(!safe.contains("synthetic-access"));
}
#[test]fn locked_recovery_only_or_stale_encrypted_runtime_cannot_export_accounts(){
    let f=Fixture::new();let original=encrypted();save_vault(&f.encrypted(),&original).unwrap();let bytes=fs::read(f.encrypted()).unwrap();
    for mut denied in [VaultRuntime::default(),VaultRuntime{unlocked:true,data:original.data.clone(),..Default::default()},encrypted()] {
        if denied.key.is_some(){denied.data.as_mut().unwrap().profiles[0].name="Unsaved stale memory".into();}
        assert!(enable(&f.encrypted(),&f.plain(),&mut denied,true).is_err());assert!(!f.plain().exists());assert_eq!(fs::read(f.encrypted()).unwrap(),bytes);
    }
}
#[test]fn malformed_plaintext_is_selected_and_never_falls_back_or_gets_overwritten(){
    let f=Fixture::new();save_vault(&f.encrypted(),&encrypted()).unwrap();fs::write(f.plain(),b"{not-json").unwrap();
    assert_eq!(config_paths::active_vault_path_at(&f.0).unwrap(),f.plain());assert!(load(&f.plain()).is_err());let original=fs::read(f.plain()).unwrap();
    let mut runtime=encrypted();assert!(enable(&f.encrypted(),&f.plain(),&mut runtime,true).is_err());assert_eq!(fs::read(f.plain()).unwrap(),original);
    assert!(save_vault(&f.plain(),&runtime).is_err());assert_eq!(fs::read(f.plain()).unwrap(),original);
}
#[test]fn existing_plaintext_and_invalid_encrypted_entries_cannot_be_replaced(){
    let f=Fixture::new();let mut plain=VaultRuntime::default();enable(&f.encrypted(),&f.plain(),&mut plain,true).unwrap();plain.data.as_mut().unwrap().profiles.push(profile());save(&f.plain(),&plain).unwrap();let bytes=fs::read(f.plain()).unwrap();
    assert!(enable(&f.encrypted(),&f.plain(),&mut encrypted(),true).is_err());assert_eq!(fs::read(f.plain()).unwrap(),bytes);enable(&f.encrypted(),&f.plain(),&mut plain,true).unwrap();assert_eq!(plain.data.unwrap().profiles.len(),1);
    let f=Fixture::new();fs::create_dir(f.encrypted()).unwrap();assert!(enable(&f.encrypted(),&f.plain(),&mut VaultRuntime::default(),true).is_err());assert!(!f.plain().exists());
}
#[test]fn plaintext_write_failures_keep_runtime_and_original_encrypted_file(){
    let f=Fixture::new();let mut live=encrypted();save_vault(&f.encrypted(),&live).unwrap();let original=fs::read(f.encrypted()).unwrap();let before=data(&live);let blocked=f.0.join("blocked");fs::write(&blocked,b"not-directory").unwrap();
    assert!(enable(&f.encrypted(),&blocked.join("accounts.local.json"),&mut live,true).is_err());assert!(!live.plaintext);assert_eq!(data(&live),before);assert_eq!(fs::read(f.encrypted()).unwrap(),original);
}
#[test]fn missing_encrypted_store_never_discards_an_existing_empty_runtime_transfer_identity(){
    let f=Fixture::new();let mut live=encrypted();live.data.as_mut().unwrap().profiles.clear();let expected=ensure_transfer_master_key(&f.encrypted(),&mut live,None).unwrap();fs::remove_file(f.encrypted()).unwrap();
    assert!(enable(&f.encrypted(),&f.plain(),&mut live,true).err().unwrap().contains("Original account store is missing"));assert!(!f.plain().exists());assert!(!live.plaintext);assert_eq!(existing_transfer_master_key(&live).unwrap(),Some(expected));
    let mut detached=VaultRuntime{data:Some(VaultData::default()),..Default::default()};assert!(enable(&f.encrypted(),&f.plain(),&mut detached,true).is_err());assert!(!f.plain().exists());
}
#[test]fn plaintext_can_mint_a_durable_key_without_recovery_migration_and_lock_clears_data(){
    let f=Fixture::new();let mut live=VaultRuntime::default();enable(&f.encrypted(),&f.plain(),&mut live,true).unwrap();let key=ensure_transfer_master_key(&f.plain(),&mut live,None).unwrap();assert_eq!(existing_transfer_master_key(&load(&f.plain()).unwrap()).unwrap(),Some(key));
    assert!(rotate_recovery_key(&f.plain(),&mut live,"not-used",true).is_err());lock_vault_runtime(&mut live);assert!(!live.unlocked&&live.data.is_none());let reopened=load(&f.plain()).unwrap();assert!(reopened.unlocked&&reopened.plaintext);
}
#[test]fn plaintext_format_and_confirmation_are_strict(){
    let f=Fixture::new();for value in [json!({"version":5,"encrypted":true,"data":{"profiles":[]}}),json!({"version":4,"encrypted":false,"data":{"profiles":[]}}),json!({"version":5,"encrypted":false,"data":{"profiles":[]},"password":"not-supported"})]{fs::write(f.plain(),value.to_string()).unwrap();assert!(load(&f.plain()).is_err());}
    assert!(serde_json::from_value::<EnableInput>(json!({})).is_err());assert!(serde_json::from_value::<EnableInput>(json!({"confirmPlaintext":true,"path":"user-path"})).is_err());assert_eq!(RpcMethod::parse("vault:enable-plaintext"),Some(RpcMethod::VaultEnablePlaintext));
}
#[test]fn active_mode_validation_rejects_both_external_path_switches_without_disk_access(){
    let mut plain=VaultRuntime{plaintext:true,unlocked:true,data:Some(VaultData::default()),..Default::default()};
    let encrypted=VaultRuntime{unlocked:true,data:Some(VaultData::default()),..Default::default()};
    let plain_path=Path::new("synthetic-only/accounts.local.json");let encrypted_path=Path::new("synthetic-only/vault.enc");
    assert!(validate_active_mode(&plain,plain_path).is_ok());assert!(validate_active_mode(&encrypted,encrypted_path).is_ok());
    assert!(validate_active_mode(&plain,encrypted_path).is_err());assert!(validate_active_mode(&encrypted,plain_path).is_err());
    lock_vault_runtime(&mut plain);assert!(validate_active_mode(&plain,encrypted_path).is_err());
    assert!(validate_active_mode(&VaultRuntime::default(),plain_path).is_ok());assert!(validate_active_mode(&VaultRuntime::default(),encrypted_path).is_ok());
}
