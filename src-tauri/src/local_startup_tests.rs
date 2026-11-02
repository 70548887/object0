//! Synthetic fixtures only; never point these helpers at the real account DB.
use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new()->Self{let root=std::env::temp_dir().join(format!("yuncang-local-startup-{}",Uuid::new_v4()));fs::create_dir(&root).unwrap();Self(root)}
    fn old(&self)->PathBuf{self.0.join("vault.enc")}
    fn plain(&self)->PathBuf{self.0.join("accounts.local.json")}
}
impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
fn profile(id:&str)->Profile{serde_json::from_value(json!({"id":id,"name":id,"provider":"custom","accessKeyId":"synthetic-ak","secretAccessKey":"synthetic-sk","createdAt":"t","updatedAt":"revision-1"})).unwrap()}
fn old_runtime()->VaultRuntime {
    let salt=vec![7;SALT_BYTES];VaultRuntime {unlocked:true,data:Some(VaultData {profiles:vec![profile("legacy")],..Default::default()}),key:Some(derive_key("synthetic-primary",&salt)),salt:Some(salt),..Default::default()}
}
fn saved_old(f:&Fixture)->VaultRuntime{let live=old_runtime();save_vault(&f.old(),&live).unwrap();live}
fn data(v:&VaultRuntime)->Value{serde_json::to_value(v.data.as_ref().unwrap()).unwrap()}
fn save_profile(f:&Fixture,live:&mut VaultRuntime,id:&str){live.data.as_mut().unwrap().profiles.push(profile(id));plaintext_accounts::save(&f.plain(),live).unwrap();}

#[test]fn fresh_local_startup_needs_neither_password_nor_confirmation_and_reopens(){
    let f=Fixture::new();let mut live=VaultRuntime::default();let report=open_local(&f.old(),&f.plain(),&mut live,false).unwrap();
    assert!(report.ready&&!report.legacy_import_required&&!report.legacy_available);assert_eq!(report.storage_mode,"plaintext");assert_eq!(report.version,5);assert!(live.plaintext&&live.unlocked);assert!(live.key.is_none()&&live.recovery_key.is_none());assert!(!f.old().exists());
    save_profile(&f,&mut live,"new-account");let mut reopened=VaultRuntime::default();assert!(open_local(&f.old(),&f.plain(),&mut reopened,false).unwrap().ready);assert_eq!(data(&live),data(&reopened));
    let safe=serde_json::to_string(&report).unwrap();for secret in ["synthetic-ak","synthetic-sk","transfer_master_key"]{assert!(!safe.contains(secret));}
}

#[test]fn locked_legacy_is_optional_import_not_an_empty_replacement(){
    let f=Fixture::new();saved_old(&f);let old=fs::read(f.old()).unwrap();let mut live=VaultRuntime::default();let report=open_local(&f.old(),&f.plain(),&mut live,false).unwrap();
    assert!(!report.ready&&report.legacy_import_required&&report.legacy_available);assert!(!live.unlocked);assert!(!f.plain().exists());assert_eq!(fs::read(f.old()).unwrap(),old);
    let report=open_local(&f.old(),&f.plain(),&mut live,true).unwrap();assert!(report.ready&&report.legacy_available);assert!(live.data.as_ref().unwrap().profiles.is_empty());assert_eq!(fs::read(f.old()).unwrap(),old);
}

#[test]fn unlocked_legacy_migrates_current_primary_data_without_recovery_key(){
    let f=Fixture::new();let mut live=saved_old(&f);let stable=ensure_transfer_master_key(&f.old(),&mut live,None).unwrap();live.data.as_mut().unwrap().profiles[0].name="latest account".into();save_vault(&f.old(),&live).unwrap();let old=fs::read(f.old()).unwrap();let before=data(&live);
    assert!(open_local(&f.old(),&f.plain(),&mut live,false).unwrap().ready);assert_eq!(data(&live),before);assert_eq!(existing_transfer_master_key(&live).unwrap(),Some(stable));assert_eq!(fs::read(f.old()).unwrap(),old);assert_eq!(plaintext_accounts::load(&f.plain()).unwrap().data.unwrap().profiles[0].name,"latest account");
}

#[test]fn manual_import_verifies_old_password_without_recovery_and_preserves_old_bytes(){
    let f=Fixture::new();saved_old(&f);let old=fs::read(f.old()).unwrap();let mut live=VaultRuntime::default();
    assert!(import_legacy(&f.old(),&f.plain(),&mut live,"wrong").is_err());assert!(!f.plain().exists());assert!(!live.unlocked);assert_eq!(fs::read(f.old()).unwrap(),old);
    let report=import_legacy(&f.old(),&f.plain(),&mut live,"synthetic-primary").unwrap();assert!(report.ready);assert_eq!(live.data.as_ref().unwrap().profiles.len(),1);assert_eq!(fs::read(f.old()).unwrap(),old);let safe=serde_json::to_string(&report).unwrap();assert!(!safe.contains("synthetic-ak")&&!safe.contains("synthetic-sk"));
}

#[test]fn import_after_skip_is_additive_and_idempotent_not_a_snapshot_replacement(){
    let f=Fixture::new();saved_old(&f);let old=fs::read(f.old()).unwrap();let mut live=VaultRuntime::default();open_local(&f.old(),&f.plain(),&mut live,true).unwrap();save_profile(&f,&mut live,"local-new");
    import_legacy(&f.old(),&f.plain(),&mut live,"synthetic-primary").unwrap();assert_eq!(live.data.as_ref().unwrap().profiles.iter().map(|p|p.id.as_str()).collect::<Vec<_>>(),vec!["local-new","legacy"]);
    import_legacy(&f.old(),&f.plain(),&mut live,"synthetic-primary").unwrap();assert_eq!(live.data.as_ref().unwrap().profiles.len(),2);assert_eq!(fs::read(f.old()).unwrap(),old);
}

#[test]fn import_id_conflict_preserves_both_files_and_runtime(){
    let f=Fixture::new();saved_old(&f);let old=fs::read(f.old()).unwrap();let mut live=VaultRuntime::default();open_local(&f.old(),&f.plain(),&mut live,true).unwrap();save_profile(&f,&mut live,"legacy");live.data.as_mut().unwrap().profiles[0].name="newer local account".into();plaintext_accounts::save(&f.plain(),&live).unwrap();let before=fs::read(f.plain()).unwrap();let runtime=data(&live);
    assert!(import_legacy(&f.old(),&f.plain(),&mut live,"synthetic-primary").err().unwrap().contains("IDs conflict"));assert_eq!(fs::read(f.plain()).unwrap(),before);assert_eq!(data(&live),runtime);assert_eq!(fs::read(f.old()).unwrap(),old);
}

#[test]fn import_preserves_one_transfer_identity_and_refuses_two_different_keys(){
    let f=Fixture::new();let mut old=saved_old(&f);let old_key=ensure_transfer_master_key(&f.old(),&mut old,None).unwrap();let mut live=VaultRuntime::default();open_local(&f.old(),&f.plain(),&mut live,true).unwrap();import_legacy(&f.old(),&f.plain(),&mut live,"synthetic-primary").unwrap();assert_eq!(existing_transfer_master_key(&live).unwrap(),Some(old_key));
    let f=Fixture::new();let mut old=saved_old(&f);let old_key=ensure_transfer_master_key(&f.old(),&mut old,None).unwrap();let old_bytes=fs::read(f.old()).unwrap();let mut live=VaultRuntime::default();open_local(&f.old(),&f.plain(),&mut live,true).unwrap();let local_key=ensure_transfer_master_key(&f.plain(),&mut live,None).unwrap();assert_ne!(old_key,local_key);let before=fs::read(f.plain()).unwrap();
    assert!(import_legacy(&f.old(),&f.plain(),&mut live,"synthetic-primary").err().unwrap().contains("Transfer keys differ"));assert_eq!(fs::read(f.plain()).unwrap(),before);assert_eq!(existing_transfer_master_key(&live).unwrap(),Some(local_key));assert_eq!(fs::read(f.old()).unwrap(),old_bytes);
}

#[test]fn corrupt_plain_never_falls_back_or_creates_an_empty_store(){
    let f=Fixture::new();saved_old(&f);let old=fs::read(f.old()).unwrap();fs::write(f.plain(),b"not a JSON file").unwrap();let mut live=VaultRuntime::default();
    assert!(open_local(&f.old(),&f.plain(),&mut live,false).is_err());assert!(open_local(&f.old(),&f.plain(),&mut live,true).is_err());assert!(import_legacy(&f.old(),&f.plain(),&mut live,"synthetic-primary").is_err());assert_eq!(fs::read(f.plain()).unwrap(),b"not a JSON file");assert_eq!(fs::read(f.old()).unwrap(),old);assert!(!live.unlocked);
}

#[test]fn valid_plain_startup_does_not_depend_on_an_invalid_optional_legacy_path(){
    let f=Fixture::new();let mut live=VaultRuntime::default();open_local(&f.old(),&f.plain(),&mut live,false).unwrap();save_profile(&f,&mut live,"local");fs::create_dir(f.old()).unwrap();
    let mut reopened=VaultRuntime::default();let report=open_local(&f.old(),&f.plain(),&mut reopened,false).unwrap();assert!(report.ready);assert!(!report.legacy_available);assert_eq!(reopened.data.as_ref().unwrap().profiles[0].id,"local");assert!(f.old().is_dir());
    fs::remove_file(f.plain()).unwrap();assert!(open_local(&f.old(),&f.plain(),&mut VaultRuntime::default(),true).is_err());assert!(!f.plain().exists());
}

#[test]fn changed_plain_or_missing_original_does_not_drop_live_accounts(){
    let f=Fixture::new();let mut live=VaultRuntime::default();open_local(&f.old(),&f.plain(),&mut live,false).unwrap();save_profile(&f,&mut live,"live");let before=data(&live);let mut external=plaintext_accounts::load(&f.plain()).unwrap();external.data.as_mut().unwrap().profiles[0].name="external change".into();plaintext_accounts::save(&f.plain(),&external).unwrap();
    assert!(open_local(&f.old(),&f.plain(),&mut live,false).is_err());assert_eq!(data(&live),before);fs::remove_file(f.plain()).unwrap();assert!(open_local(&f.old(),&f.plain(),&mut live,true).is_err());assert!(!f.plain().exists());assert_eq!(data(&live),before);
}

#[test]fn create_only_and_checked_import_commits_reject_collisions_and_stale_bytes(){
    let f=Fixture::new();let candidate=VaultRuntime{plaintext:true,unlocked:true,data:Some(VaultData::default()),..Default::default()};plaintext_accounts::commit_import(&f.plain(),&candidate,None).unwrap();let first=fs::read(f.plain()).unwrap();assert!(plaintext_accounts::commit_import(&f.plain(),&candidate,None).is_err());assert_eq!(fs::read(f.plain()).unwrap(),first);
    let mut updated=candidate.clone();updated.data.as_mut().unwrap().profiles.push(profile("new"));plaintext_accounts::save(&f.plain(),&updated).unwrap();let changed=fs::read(f.plain()).unwrap();assert!(plaintext_accounts::commit_import(&f.plain(),&candidate,Some(&first)).is_err());assert_eq!(fs::read(f.plain()).unwrap(),changed);
    let blocked=f.0.join("blocked");fs::write(&blocked,b"not directory").unwrap();let mut fresh=VaultRuntime::default();assert!(open_local(&f.old(),&blocked.join("accounts.local.json"),&mut fresh,false).is_err());assert!(!fresh.unlocked);
}
