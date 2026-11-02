//! Pure synthetic vault tests: no config paths, filesystem writes or network.
use super::*;

fn saved()->Profile{
    Profile{id:"saved-profile".into(),name:"Saved name".into(),provider:S3Provider::Qiniu,
        access_key_id:"fixture-saved-ak".into(),secret_access_key:"fixture-saved-secret".into(),session_token:Some("fixture-saved-session".into()),
        endpoint:Some("https://old-endpoint.example".into()),region:Some("old-region".into()),default_bucket:Some("old-bucket".into()),
        r2_analytics_token:None,qiniu:Some(qiniu::QiniuConfig{mode:qiniu::QiniuMode::Private,uc_url:Some("https://old-uc.internal".into()),download_domain:Some("https://old-download.example".into()),..Default::default()}),created_at:"created-fixture".into(),updated_at:"revision-fixture".into()}
}
fn state()->AppState{let state=AppState::default();{let mut vault=state.vault.lock().unwrap();vault.unlocked=true;vault.data=Some(VaultData{profiles:vec![saved()],..Default::default()});}state}
fn input()->ProfileTestInput{
    serde_json::from_value(json!({"profileId":"saved-profile","expectedProfileRevision":"revision-fixture","provider":"qiniu","endpoint":"https://new-endpoint.example","region":"new-region","defaultBucket":"new-bucket","accessKeyId":"","secretAccessKey":"","qiniu":{"mode":"private","ucUrl":"https://new-uc.internal","regions":[],"downloadDomain":"https://new-download.example"}})).unwrap()
}
fn vault_data(state:&AppState)->String{serde_json::to_string(state.vault.lock().unwrap().data.as_ref().unwrap()).unwrap()}

#[test]fn edited_config_uses_saved_pair_natively_without_mutating_the_vault(){
    let state=state();let before=vault_data(&state);
    let(candidate,original)=prepare_profile_test(&state,input()).unwrap();let original=original.unwrap();
    assert_eq!(candidate.access_key_id,"fixture-saved-ak");assert_eq!(candidate.secret_access_key,"fixture-saved-secret");assert_eq!(candidate.session_token.as_deref(),Some("fixture-saved-session"));
    assert_eq!(candidate.endpoint.as_deref(),Some("https://new-endpoint.example"));assert_eq!(candidate.region.as_deref(),Some("new-region"));assert_eq!(candidate.default_bucket.as_deref(),Some("new-bucket"));
    assert_eq!(candidate.qiniu.as_ref().unwrap().uc_url.as_deref(),Some("https://new-uc.internal"));assert_eq!(candidate.qiniu.as_ref().unwrap().download_domain.as_deref(),Some("https://new-download.example"));
    assert_eq!(candidate.updated_at,original.updated_at);assert_eq!(candidate.created_at,original.created_at);assert_eq!(original.endpoint,saved().endpoint);
    assert_eq!(vault_data(&state),before);
    // The intended UI projection contains credential presence only, never the
    // draft's native secrets. The preparation function has no RPC JSON output.
    let safe=serde_json::to_string(&to_profile_info(&candidate)).unwrap();for secret in ["fixture-saved-ak","fixture-saved-secret","fixture-saved-session"]{assert!(!safe.contains(secret));}
}

#[test]fn partial_key_replacement_is_rejected_and_the_saved_vault_stays_unchanged(){
    let state=state();let before=vault_data(&state);let mut request=input();request.access_key_id="new-ak".into();
    assert!(prepare_profile_test(&state,request).is_err());let mut request=input();request.secret_access_key="new-sk".into();assert!(prepare_profile_test(&state,request).is_err());assert_eq!(vault_data(&state),before);
}

#[test]fn both_new_keys_replace_saved_keys_only_in_the_draft(){
    let state=state();let before=vault_data(&state);let mut request=input();request.access_key_id="new-ak".into();request.secret_access_key="new-sk".into();
    let(candidate,original)=prepare_profile_test(&state,request).unwrap();assert_eq!(candidate.access_key_id,"new-ak");assert_eq!(candidate.secret_access_key,"new-sk");assert_eq!(original.unwrap().access_key_id,"fixture-saved-ak");assert_eq!(vault_data(&state),before);
}

#[test]fn token_blank_preserves_nonempty_replaces_and_explicit_clear_removes(){
    let state=state();let before=vault_data(&state);
    let mut request=input();request.session_token=Some("   ".into());let(candidate,_)=prepare_profile_test(&state,request).unwrap();assert_eq!(candidate.session_token.as_deref(),Some("fixture-saved-session"));
    let mut request=input();request.session_token=Some("replacement-session".into());let(candidate,_)=prepare_profile_test(&state,request).unwrap();assert_eq!(candidate.session_token.as_deref(),Some("replacement-session"));
    let mut request=input();request.clear_session_token=true;let(candidate,_)=prepare_profile_test(&state,request).unwrap();assert!(candidate.session_token.is_none());
    let mut request=input();request.clear_session_token=true;request.session_token=Some("ambiguous".into());assert!(prepare_profile_test(&state,request).is_err());assert_eq!(vault_data(&state),before);
}

#[test]fn provider_changes_require_fresh_pair_and_never_inherit_old_session(){
    let state=state();let before=vault_data(&state);let mut request=input();request.provider=S3Provider::R2;
    assert!(prepare_profile_test(&state,request).is_err());
    let mut request=input();request.provider=S3Provider::R2;request.access_key_id="r2-fixture-ak".into();request.secret_access_key="r2-fixture-sk".into();
    let(candidate,original)=prepare_profile_test(&state,request).unwrap();assert_eq!(candidate.provider,S3Provider::R2);assert!(candidate.qiniu.is_none());assert!(candidate.session_token.is_none());assert_eq!(original.unwrap().provider,S3Provider::Qiniu);
    let mut request=input();request.provider=S3Provider::Aws;request.access_key_id="aws-fixture-ak".into();request.secret_access_key="aws-fixture-sk".into();request.session_token=Some("new-aws-fixture-session".into());
    let(candidate,_)=prepare_profile_test(&state,request).unwrap();assert_eq!(candidate.session_token.as_deref(),Some("new-aws-fixture-session"));assert_eq!(vault_data(&state),before);
}

#[test]fn old_or_absent_revisions_and_locked_vault_refuse_secret_reuse(){
    let state=state();let mut request=input();request.expected_profile_revision=Some("old".into());assert!(prepare_profile_test(&state,request).is_err());
    let mut request=input();request.expected_profile_revision=None;assert!(prepare_profile_test(&state,request).is_err());
    state.vault.lock().unwrap().unlocked=false;assert!(prepare_profile_test(&state,input()).is_err());
}

#[test]fn nonexistent_profile_and_empty_identity_are_rejected(){
    let state=state();let mut request=input();request.profile_id=Some("missing-profile".into());assert!(prepare_profile_test(&state,request).is_err());
    let mut request=input();request.profile_id=Some(" ".into());assert!(prepare_profile_test(&state,request).is_err());
}

#[test]fn new_unsaved_test_requires_both_keys_and_has_no_saved_identity(){
    let state=AppState::default();let mut request=input();request.profile_id=None;request.expected_profile_revision=None;
    assert!(prepare_profile_test(&state,request).is_err());let mut request=input();request.profile_id=None;request.expected_profile_revision=None;request.access_key_id="new-fixture-ak".into();request.secret_access_key="new-fixture-sk".into();
    let(candidate,original)=prepare_profile_test(&state,request).unwrap();assert!(original.is_none());assert_eq!(candidate.id,"test-draft");assert_eq!(candidate.access_key_id,"new-fixture-ak");assert!(state.vault.lock().unwrap().data.is_none());
}

#[test]fn missing_new_qiniu_config_uses_defaults_instead_of_old_environment(){
    let state=state();let mut request=input();request.qiniu=None;
    let(candidate,_)=prepare_profile_test(&state,request).unwrap();assert_eq!(candidate.qiniu,Some(qiniu::QiniuConfig::default()));
}
