use super::*;
use zip::write::SimpleFileOptions;
struct Fixture(PathBuf);
impl Fixture {fn new()->Self{let p=std::env::temp_dir().join(format!("yuncang-portable-fixture-{}",uuid::Uuid::new_v4()));fs::create_dir(&p).unwrap();Self(p)}fn dir(&self,name:&str)->PathBuf{let p=self.0.join(name);fs::create_dir(&p).unwrap();p}}
impl Drop for Fixture {fn drop(&mut self){if self.0.file_name().is_some_and(|n|n.to_string_lossy().starts_with("yuncang-portable-fixture-")) && self.0.parent()==Some(std::env::temp_dir().as_path()){let _=fs::remove_dir_all(&self.0);}}}
fn write(path:&Path,data:&[u8]){fs::create_dir_all(path.parent().unwrap()).unwrap();fs::write(path,data).unwrap()}
fn metadata(version:&str)->Vec<u8>{serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"identifier":IDENTIFIER,"version":version,"platform":PLATFORM,"kind":"portable"})).unwrap()}
fn zip_file(path:&Path,entries:&[(&str,Vec<u8>)]){
    let mut z=zip::ZipWriter::new(fs::File::create(path).unwrap());
    for (name,bytes) in entries{z.start_file(*name,SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).unwrap();z.write_all(bytes).unwrap();}z.finish().unwrap();
}
#[test]fn archive_paths_reject_traversal_ads_windows_aliases_and_accept_unicode(){
    for n in ["../x","/root","C:/x","a\\b","a/../b","a//b","a/CON.txt","Lpt1.dll","a/last.","a/last ","file:stream","a\0b"] {assert!(safe_relative(n).is_err(),"{n}");}
    assert_eq!(safe_relative("WebView2Runtime/中文+%/file.dll").unwrap(),PathBuf::from("WebView2Runtime/中文+%/file.dll"));
}
#[test]fn portable_package_extracts_allowlist_and_validates_identity_before_swap(){
    let fixture=Fixture::new();let archive=fixture.0.join("package.zip");let stage=fixture.dir("stage");
    let prefix="object0_2.0.0_windows_x64_portable/";
    zip_file(&archive,&[("object0_2.0.0_windows_x64_portable/object0.exe",b"fixture-exe".to_vec()),("object0_2.0.0_windows_x64_portable/WebView2Runtime/msedgewebview2.exe",b"fixture-runtime".to_vec()),("object0_2.0.0_windows_x64_portable/yuncang-package.json",metadata("2.0.0"))]);
    let expected=unpack(&archive,&stage,"2.0.0").unwrap();assert!(!expected.is_empty());assert_eq!(expected,tree_hashes(&stage).unwrap());assert!(validate_package(&stage,"2.0.0",|_|Ok("2.0.0".into())).is_ok());
    assert!(validate_package(&stage,"2.0.0",|_|Ok("1.0.0".into())).is_err());
    assert!(validate_package(&stage,"3.0.0",|_|Ok("3.0.0".into())).is_err());
    assert!(!stage.join(prefix).exists());
}
#[test]fn unexpected_config_members_and_case_collisions_are_rejected(){
    for entries in [vec![("object0_2.0.0_windows_x64_portable/accounts.local.json",vec![1])],vec![("object0_2.0.0_windows_x64_portable/WebView2Runtime/A.dll",vec![1]),("object0_2.0.0_windows_x64_portable/WebView2Runtime/a.dll",vec![2])],vec![("object0_2.0.0_windows_x64_portable/../escape",vec![3])]]{
        let f=Fixture::new();let zip=f.0.join("bad.zip");zip_file(&zip,&entries);assert!(unpack(&zip,&f.dir("stage"),"2.0.0").is_err());assert!(!f.0.join("escape").exists());
    }
}
#[test]fn atomic_member_swap_preserves_unrelated_data_and_retains_old_backup(){
    let f=Fixture::new();let target=f.dir("app");let stage=f.dir("stage");let backup=f.0.join("backup");
    write(&target.join("object0.exe"),b"old");write(&target.join("WebView2Runtime/runtime"),b"old-runtime");write(&target.join("accounts.local.json"),b"fixture-user-data");write(&target.join("LICENSE"),b"keep-when-not-shipped");
    write(&stage.join("object0.exe"),b"new");write(&stage.join("WebView2Runtime/runtime"),b"new-runtime");write(&stage.join("yuncang-package.json"),&metadata("2.0.0"));
    let journal=swap_files(&target,&stage,&backup,None).unwrap();
    assert_eq!(fs::read(target.join("object0.exe")).unwrap(),b"new");assert_eq!(fs::read(backup.join("object0.exe")).unwrap(),b"old");
    assert_eq!(fs::read(target.join("accounts.local.json")).unwrap(),b"fixture-user-data");
    restore_successful_swap(&target,&stage,&backup,&journal).unwrap();
    assert_eq!(fs::read(target.join("object0.exe")).unwrap(),b"old");assert_eq!(fs::read(target.join("WebView2Runtime/runtime")).unwrap(),b"old-runtime");
    assert_eq!(fs::read(target.join("LICENSE")).unwrap(),b"keep-when-not-shipped");assert!(!target.join("yuncang-package.json").exists());
    println!("PORTABLE_TRANSACTION baseline=old modified=new rollback=old unrelated_user_file=unchanged real_install=false");
}
#[test]fn failure_mid_swap_restores_every_already_moved_member(){
    for fail in [1,2] {let f=Fixture::new();let target=f.dir("app");let stage=f.dir("stage");let backup=f.0.join("backup");
        write(&target.join("object0.exe"),b"old");write(&target.join("WebView2Runtime/runtime"),b"old-runtime");write(&stage.join("object0.exe"),b"new");write(&stage.join("WebView2Runtime/runtime"),b"new-runtime");
        assert!(swap_files(&target,&stage,&backup,Some(fail)).unwrap_err().contains("Previous files restored"));
        assert_eq!(fs::read(target.join("object0.exe")).unwrap(),b"old");assert_eq!(fs::read(target.join("WebView2Runtime/runtime")).unwrap(),b"old-runtime");
    }
}
#[test]fn same_path_handles_windows_extended_prefix_without_prefix_confusion(){
    assert!(same_path(Path::new(r"\\?\C:\Apps\云仓\object0.exe"),Path::new(r"c:\apps\云仓\object0.exe")));
    assert!(!same_path(Path::new(r"C:\Apps\Yuncang2\object0.exe"),Path::new(r"C:\Apps\Yuncang\object0.exe")));
}
#[test]fn staged_member_change_is_detected_before_launch(){
    let f=Fixture::new();let stage=f.dir("stage");write(&stage.join("object0.exe"),b"verified");
    let expected=tree_hashes(&stage).unwrap();write(&stage.join("object0.exe"),b"tampered");
    assert_ne!(tree_hashes(&stage).unwrap(),expected);assert!(lock_verified_tree(&stage,&expected).is_err());
}
#[cfg(windows)]
#[test]fn windows_verification_lease_prevents_write_and_path_replacement(){
    let f=Fixture::new();let file=f.0.join("package.bin");write(&file,b"verified");
    let lease=lock_read(&file).unwrap();
    assert!(fs::OpenOptions::new().write(true).open(&file).is_err());
    assert!(fs::rename(&file,f.0.join("replaced.bin")).is_err());
    assert_eq!(fs::read(&file).unwrap(),b"verified");
    drop(lease);assert!(fs::OpenOptions::new().write(true).open(&file).is_ok());
}
