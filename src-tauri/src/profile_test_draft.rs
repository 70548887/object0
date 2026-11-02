//! Build a nonpersistent connection-test draft within the native process.
//! Saved secrets never travel back through the RPC: only the ordinary safe
//! connection report may be returned by the caller after executing this draft.
use super::*;

const MISSING_PAIR:&str="请同时填写访问密钥 ID 和访问密钥 / Enter both access key ID and secret access key";
const STALE:&str="账号已变更或缺少版本，请刷新账号后重新测试 / The account changed or its revision is missing; refresh before testing";

pub(crate) fn prepare_profile_test(state:&AppState,input:ProfileTestInput)->Result<(Profile,Option<Profile>),String>{
    let id=input.profile_id.as_deref().filter(|id|!id.trim().is_empty());
    if input.profile_id.is_some()&&id.is_none(){return Err("测试账号标识无效 / Invalid test profile identity".into());}
    let original=match id {
        Some(id)=>{
            let saved=profile_for_id(state,id)?;
            let expected=input.expected_profile_revision.as_deref().filter(|revision|!revision.is_empty()).ok_or_else(||STALE.to_string())?;
            if expected!=saved.updated_at{return Err(STALE.into())}
            Some(saved)
        },
        None=>None,
    };
    let has_ak=!input.access_key_id.trim().is_empty();let has_sk=!input.secret_access_key.trim().is_empty();
    if has_ak!=has_sk{return Err(MISSING_PAIR.into())}
    let provider_changed=original.as_ref().is_some_and(|saved|saved.provider!=input.provider);
    if !has_ak&&(original.is_none()||provider_changed){
        return Err(if provider_changed {"更换存储服务商须重新填写完整凭据 / Changing provider requires a new access-key pair".into()}else{MISSING_PAIR.into()});
    }
    let supplied_token=input.session_token.filter(|token|!token.trim().is_empty());
    if input.clear_session_token&&supplied_token.is_some(){return Err("不能同时清除和替换会话令牌 / A session token cannot be cleared and replaced in the same test".into());}
    let session_token=if input.clear_session_token {None}
        else if supplied_token.is_some(){supplied_token}
        else if !provider_changed {original.as_ref().and_then(|saved|saved.session_token.clone())}
        else {None};
    let (access_key_id,secret_access_key)=if has_ak{(input.access_key_id,input.secret_access_key)}else{
        let saved=original.as_ref().ok_or_else(||MISSING_PAIR.to_string())?;
        (saved.access_key_id.clone(),saved.secret_access_key.clone())
    };
    let timestamp=now_iso();
    let candidate=Profile{
        id:original.as_ref().map(|saved|saved.id.clone()).unwrap_or_else(||"test-draft".into()),
        name:original.as_ref().map(|saved|saved.name.clone()).unwrap_or_else(||"Connection test".into()),
        provider:input.provider,
        access_key_id,secret_access_key,session_token,
        endpoint:input.endpoint,region:Some(input.region),default_bucket:input.default_bucket,
        r2_analytics_token:None,
        // Test exactly the new configuration, not the last saved UC/domain/
        // bindings. A missing Qiniu config means the documented default mode.
        qiniu:if input.provider==S3Provider::Qiniu{Some(input.qiniu.unwrap_or_default())}else{None},
        created_at:original.as_ref().map(|saved|saved.created_at.clone()).unwrap_or_else(||timestamp.clone()),
        updated_at:original.as_ref().map(|saved|saved.updated_at.clone()).unwrap_or(timestamp),
    };
    Ok((candidate,original))
}

#[cfg(test)]
#[path="profile_test_draft_tests.rs"]
mod tests;
