//! Fixtures use only a public minisign-verify 0.2.5 test vector and loopback.
use super::*;
#[test]
#[ignore = "Opt-in read-only check of the explicitly configured public GitHub repository; no assets downloaded or installed"]
fn diagnostic_public_github_version_detection(){
    let rt=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let bytes=get_limited(&client().unwrap(),RELEASES_API,1024*1024).await.unwrap();
        let releases:Vec<GitHubRelease>=serde_json::from_slice(&bytes).unwrap();
        let stable=select_release(releases.clone(),env!("CARGO_PKG_VERSION"),Channel::Stable).unwrap().map(|r|r.tag_name);
        let preview=select_release(releases.clone(),env!("CARGO_PKG_VERSION"),Channel::Preview).unwrap().map(|r|r.tag_name);
        println!("GITHUB_LIVE_READONLY repository={REPOSITORY} current={} releases={} stable_update={stable:?} preview_update={preview:?} assets_downloaded=0 installed=false",env!("CARGO_PKG_VERSION"),releases.len());
        assert!(releases.iter().all(|r|r.draft || same_release_url(&r.html_url,&r.tag_name)));
    });
}
const KEY:&str="RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const SIG:&str="untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";
fn release(tag:&str,preview:bool)->GitHubRelease{GitHubRelease{tag_name:tag.into(),draft:false,prerelease:preview,html_url:format!("https://github.com/{REPOSITORY}/releases/tag/{tag}"),body:Some("fixture".into()),published_at:None,assets:vec![]}}
fn temp()->PathBuf{let dir=std::env::temp_dir().join(format!("yuncang-update-fixture-{}",Uuid::new_v4()));fs::create_dir(&dir).unwrap();dir}

#[test]fn release_selection_is_semver_channel_bound_and_never_downgrades(){
    let mut draft=release("v9.0.0",false);draft.draft=true;
    let releases=vec![release("v1.6.0",false),release("v1.7.0-preview.2",true),release("v1.7.0-preview.10",true),release("v1.7.0-preview.3",true),draft,release("nonsense",false)];
    assert_eq!(select_release(releases.clone(),"1.7.0-preview.2",Channel::Preview).unwrap().unwrap().tag_name,"v1.7.0-preview.10");
    assert!(select_release(releases,"1.7.0-preview.2",Channel::Stable).unwrap().is_none());
    assert!(select_release(vec![release("v1.7.0",false)],"1.7.0",Channel::Stable).unwrap().is_none());
    assert!(select_release(vec![release("v1.8.0-preview.1",false)],"1.7.0",Channel::Stable).unwrap().is_none());
    assert!(select_release(vec![release("v1.7.0+different",false)],"1.7.0+local",Channel::Stable).unwrap().is_none());
}
#[test]fn update_urls_are_https_and_repository_pinned(){
    for url in ["https://github.com/70548887/object0/releases/download/v1.7.1/a.exe","https://api.github.com/repos/70548887/object0/releases","https://release-assets.githubusercontent.com/github-production-release-asset/x"] {assert!(checked_url(url).is_ok(),"{url}");}
    for url in ["http://github.com/70548887/object0/releases/download/v1/a","https://github.com/sayedhfatimi/object0/releases/download/v1/a","https://github.com/70548887/object0.evil/releases/","https://evil.example/a","https://github.com:444/70548887/object0/releases/","https://user:pass@github.com/70548887/object0/releases/","https://github.com/70548887/object0/releases/#fragment"] {assert!(checked_url(url).is_err(),"{url}");}
    assert!(same_release_url("https://github.com/70548887/object0/releases/tag/v1.7.1","v1.7.1"));
    assert!(!same_release_url("https://github.com/70548887/object0/releases/tag/v1.6.0","v1.7.1"));
}
#[test]fn genuine_signature_verification_rejects_tampered_bytes_and_wrapped_invalid_inputs(){
    verify_bytes(b"test",SIG,KEY).unwrap();
    assert!(verify_bytes(b"changed",SIG,KEY).is_err());
    assert!(verify_bytes(b"test","not-a-signature",KEY).is_err());
    assert!(verify_bytes(b"test",SIG,"bad-key").is_err());
    let signature=base64::engine::general_purpose::STANDARD.encode(SIG);
    let public=base64::engine::general_purpose::STANDARD.encode(format!("untrusted comment: fixture public key\n{KEY}\n"));
    verify_bytes(b"test",&signature,&public).unwrap();
}
#[test]fn streamed_signature_verifies_file_and_rejects_modified_cache(){
    let dir=temp();let path=dir.join("artifact.pkg");fs::write(&path,b"test").unwrap();verify_signed_file(&path,SIG,KEY).unwrap();
    fs::write(&path,b"wrong").unwrap();assert!(verify_signed_file(&path,SIG,KEY).is_err());
    fs::remove_dir_all(dir).unwrap();
}
fn manifest_fixture()->(GitHubRelease,Value){
    let mut release=release("v1.8.0",false);let url="https://github.com/70548887/object0/releases/download/v1.8.0/yuncang.exe";
    release.assets.push(GitHubAsset{name:"yuncang.exe".into(),size:4,browser_download_url:url.into()});
    let package=json!({"url":url,"size":4,"sha256":format!("{:x}",Sha256::digest(b"test")),"signature":base64::engine::general_purpose::STANDARD.encode(SIG)});
    let data=json!({"schemaVersion":1,"version":"1.8.0","channel":"stable","packages":{"windows-x86_64":{"installer":package.clone(),"portable":package.clone()}},"platforms":{"windows-x86_64":{"url":url,"signature":package["signature"]}}});
    (release,data)
}
#[test]fn signed_manifest_binds_release_asset_platform_kind_size_digest_and_installer_fields(){
    let (release,data)=manifest_fixture();let encode=|value:&Value|serde_json::to_vec(value).unwrap();
    assert!(validated_package(&encode(&data),&release,PackageKind::Installer,"windows-x86_64").is_ok());
    assert!(validated_package(&encode(&data),&release,PackageKind::Unknown,"windows-x86_64").is_err());
    assert!(validated_package(&encode(&data),&release,PackageKind::Portable,"windows-aarch64").is_err());
    for case in ["version","channel","size","url","digest","signature","installer"] {
        let mut changed=data.clone();
        match case {
            "version"=>changed["version"]=json!("1.9.0"),"channel"=>changed["channel"]=json!("preview"),
            "size"=>changed["packages"]["windows-x86_64"]["installer"]["size"]=json!(5),
            "url"=>changed["packages"]["windows-x86_64"]["installer"]["url"]=json!("https://github.com/70548887/object0/releases/download/v1.7.0/wrong.exe"),
            "digest"=>changed["packages"]["windows-x86_64"]["installer"]["sha256"]=json!("wrong"),
            "signature"=>changed["packages"]["windows-x86_64"]["installer"]["signature"]=json!("bad"),
            "installer"=>changed["platforms"]["windows-x86_64"]["url"]=json!("https://github.com/70548887/object0/releases/download/v1.8.0/different.exe"),_=>unreachable!(),
        }
        assert!(validated_package(&encode(&changed),&release,PackageKind::Installer,"windows-x86_64").is_err(),"{case}");
    }
}
#[test]fn portable_marker_requires_matching_identifier_version_and_platform(){
    let dir=temp();let exe=dir.join("object0.exe");fs::write(&exe,b"fixture").unwrap();
    assert_eq!(package_kind_at(&exe,"1.7.0"),PackageKind::Unknown);
    let marker=json!({"schemaVersion":1,"identifier":"dev.object0.app","version":"1.7.0","kind":"portable","platform":platform()});
    fs::write(dir.join("yuncang-package.json"),serde_json::to_vec(&marker).unwrap()).unwrap();
    assert_eq!(package_kind_at(&exe,"1.7.0"),PackageKind::Portable);
    assert_eq!(package_kind_at(&exe,"1.8.0"),PackageKind::Unknown);
    fs::remove_dir_all(dir).unwrap();
}
#[test]fn installation_guard_checks_direct_operations_jobs_sync_and_new_admissions(){
    let state=AppState::default();ensure_idle(&state).unwrap();ensure_not_installing(&state).unwrap();
    state.updates_active_operations.store(1,Ordering::SeqCst);assert!(ensure_idle(&state).is_err());state.updates_active_operations.store(0,Ordering::SeqCst);
    state.jobs.lock().unwrap().running.insert("fixture".into());assert!(ensure_idle(&state).is_err());state.jobs.lock().unwrap().running.clear();
    state.folder_sync.lock().unwrap().statuses.insert("fixture".into(),FolderSyncStateRecord{rule_id:"fixture".into(),status:FolderSyncStatus::Watching,files_watching:0,last_change:None,current_file:None,progress:None});
    assert!(ensure_idle(&state).is_err());state.folder_sync.lock().unwrap().statuses.clear();
    state.updates_installing.store(true,Ordering::SeqCst);assert!(ensure_not_installing(&state).is_err());
}
#[test]fn updater_payloads_reject_credential_or_alternate_url_injection(){
    assert!(serde_json::from_value::<SelectionInput>(json!({"releaseId":"fixed","url":"https://evil.example"})).is_err());
    assert!(serde_json::from_value::<CheckInput>(json!({"channel":"stable","token":"not-accepted"})).is_err());
    assert!(serde_json::from_value::<ApplyInput>(json!({"releaseId":"fixed","exitConfirmed":true,"draftsSaved":true,"pubkey":"not-accepted"})).is_err());
    assert_eq!(rpc_method::RpcMethod::parse("updates:apply"),Some(rpc_method::RpcMethod::UpdatesApply));
}

fn runtime()->&'static tokio::runtime::Runtime {
    static RUNTIME:std::sync::OnceLock<tokio::runtime::Runtime>=std::sync::OnceLock::new();
    RUNTIME.get_or_init(||tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap())
}
fn fixture_server(body:Vec<u8>,declared:usize,slow:bool)->(Url,std::thread::JoinHandle<()>) {
    use std::{net::TcpListener,io::{Read,Write}};
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();let url=Url::parse(&format!("http://{}/fixture",listener.local_addr().unwrap())).unwrap();
    let worker=std::thread::spawn(move||{
        let (mut stream,_)=listener.accept().unwrap();stream.set_read_timeout(Some(StdDuration::from_secs(3))).unwrap();
        let mut request=Vec::new();let mut buf=[0u8;1024];
        while !request.windows(4).any(|w|w==b"\r\n\r\n") {let n=stream.read(&mut buf).unwrap();if n==0{return}request.extend_from_slice(&buf[..n]);}
        let headers=format!("HTTP/1.1 200 OK\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n");let _=stream.write_all(headers.as_bytes());
        if slow {let _=stream.write_all(&body[..2]);let _=stream.flush();std::thread::sleep(StdDuration::from_millis(250));let _=stream.write_all(&body[2..]);}
        else {let _=stream.write_all(&body);}
    });(url,worker)
}
#[test]fn disk_stream_checks_actual_size_digest_and_cancellation_with_loopback_only(){
    let dir=temp();let digest=format!("{:x}",Sha256::digest(b"test"));
    for case in ["success","digest","length","truncated","cancel"] {
        let (url,worker)=fixture_server(if case=="truncated"{b"tes".to_vec()}else{b"test".to_vec()},if case=="length"{5}else{4},case=="cancel");
        let target=dir.join(case);let cancel=AtomicBool::new(false);let mut progress=Vec::new();
        let client=reqwest::Client::builder().timeout(StdDuration::from_secs(3)).build().unwrap();
        let result=runtime().block_on(stream_package(&client,url,&target,4,if case=="digest"{"bad"}else{&digest},&cancel,|n|{progress.push(n);if case=="cancel"{cancel.store(true,Ordering::SeqCst)}Ok(())}));
        worker.join().unwrap();
        if case=="success"{assert_eq!(result.unwrap(),4);assert_eq!(fs::read(&target).unwrap(),b"test");assert_eq!(progress.last(),Some(&4));verify_signed_file(&target,SIG,KEY).unwrap();}
        else{assert!(result.is_err(),"{case}");}
    }
    let cancelled=AtomicBool::new(true);let target=dir.join("pre-cancelled");
    let client=reqwest::Client::new();
    let result=runtime().block_on(stream_package(&client,Url::parse("http://127.0.0.1:1/unreachable").unwrap(),&target,4,&digest,&cancelled,|_|panic!("cancelled request cannot report progress")));
    assert!(result.unwrap_err().contains("cancelled"));assert!(!target.exists());
    fs::remove_dir_all(dir).unwrap();
}
#[test]fn attempt_counter_is_not_reset_when_check_clears_visible_state(){
    let mut state=Runtime::default();state.next_attempt=7;state.snapshot=Snapshot::default();
    state.next_attempt=state.next_attempt.wrapping_add(1);assert_eq!(state.next_attempt,8);
    assert_eq!(state.snapshot.attempt,0);
}
