//! Short-lived, single-use sync approvals. Never execute a newly discovered
//! diff as though the user had approved the old preview. No credentials stored.
use super::*;
use sha2::{Digest, Sha256};

const PREVIEW_TTL: StdDuration = StdDuration::from_secs(300);
const STALE: &str = "同步范围或文件已变化，请重新预览后确认 / Sync scope or objects changed; preview and confirm again";

struct Approval { scope: String, digest: Vec<u8>, created: Instant }
#[derive(Default)]
pub(crate) struct PreviewRegistry { epoch: u64, approvals: HashMap<String, Approval> }
pub(crate) struct Ticket { scope: String, epoch: u64 }

impl PreviewRegistry {
    fn issue(&mut self, ticket:&Ticket, digest:Vec<u8>, now:Instant)->Result<String,String>{
        if ticket.epoch!=self.epoch{return Err(STALE.into())}
        self.approvals.retain(|_,item| now.saturating_duration_since(item.created)<PREVIEW_TTL);
        if self.approvals.len()>=32{return Err("预览过多，请稍后重新预览 / Too many pending sync previews".into())}
        let id=Uuid::new_v4().to_string();
        self.approvals.insert(id.clone(),Approval{scope:ticket.scope.clone(),digest,created:now});
        Ok(id)
    }
    fn consume(&mut self,ticket:&Ticket,token:&str,now:Instant)->Result<Vec<u8>,String>{
        let approved=self.approvals.remove(token).ok_or_else(||STALE.to_string())?;
        if ticket.epoch!=self.epoch || approved.scope!=ticket.scope || now.saturating_duration_since(approved.created)>=PREVIEW_TTL {return Err(STALE.into())}
        Ok(approved.digest)
    }
    pub(crate) fn clear(&mut self){self.epoch=self.epoch.wrapping_add(1);self.approvals.clear();}
}

fn scope(vault:&VaultRuntime,input:&SyncInput)->Result<String,String>{
    ensure_unlocked(vault)?;
    let profiles=&vault.data.as_ref().ok_or("Vault is locked")?.profiles;
    let revision=|id:&str|profiles.iter().find(|profile|profile.id==id).map(|p|p.updated_at.as_str()).ok_or_else(||"Profile not found".to_string());
    Ok(json!([input.source_profile_id,revision(&input.source_profile_id)?,input.source_bucket,normalize_prefix(&input.source_prefix),input.dest_profile_id,revision(&input.dest_profile_id)?,input.dest_bucket,normalize_prefix(&input.dest_prefix),format!("{:?}",input.mode)]).to_string())
}
pub(crate) fn begin(state:&AppState,input:&SyncInput)->Result<Ticket,String>{
    let vault=lock_state(&state.vault)?;
    let scope=scope(&vault,input)?;
    let registry=lock_state(&state.sync_previews)?;
    Ok(Ticket{scope,epoch:registry.epoch})
}
fn digest(diff:&SyncDiffRecord)->Result<Vec<u8>,String>{
    let encoded=serde_json::to_vec(diff).map_err(|_|"Could not encode sync preview".to_string())?;
    Ok(Sha256::digest(encoded).to_vec())
}
pub(crate) fn issue(state:&AppState,input:&SyncInput,ticket:&Ticket,diff:&SyncDiffRecord)->Result<String,String>{
    let vault=lock_state(&state.vault)?;
    if scope(&vault,input)?!=ticket.scope{return Err(STALE.into())}
    lock_state(&state.sync_previews)?.issue(ticket,digest(diff)?,Instant::now())
}
pub(crate) fn consume(state:&AppState,input:&SyncInput,ticket:&Ticket)->Result<Vec<u8>,String>{
    let token=input.preview_token.as_deref().filter(|v|!v.is_empty()).ok_or_else(||"请先预览并确认同步 / Preview and confirm sync first".to_string())?;
    if token.len()>128{return Err(STALE.into())}
    lock_state(&state.sync_previews)?.consume(ticket,token,Instant::now())
}
pub(crate) fn verify(state:&AppState,input:&SyncInput,ticket:&Ticket,approved:&[u8],diff:&SyncDiffRecord)->Result<(),String>{
    let current=begin(state,input)?;
    if current.scope!=ticket.scope || current.epoch!=ticket.epoch || digest(diff)?!=approved{return Err(STALE.into())}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ticket(scope:&str)->Ticket{Ticket{scope:scope.into(),epoch:0}}
    #[test]fn approvals_are_single_use_and_scope_bound(){
        let mut registry=PreviewRegistry::default();let now=Instant::now();let t=ticket("account/bucket/prefix/mode/revision");
        let token=registry.issue(&t,vec![1],now).unwrap();assert_eq!(registry.consume(&t,&token,now).unwrap(),vec![1]);assert!(registry.consume(&t,&token,now).is_err());
        let token=registry.issue(&t,vec![1],now).unwrap();assert!(registry.consume(&ticket("another-scope"),&token,now).is_err());
    }
    #[test]fn lock_expires_pending_and_inflight_previews(){
        let mut registry=PreviewRegistry::default();let now=Instant::now();let t=ticket("scope");
        let token=registry.issue(&t,vec![1],now).unwrap();registry.clear();assert!(registry.consume(&t,&token,now).is_err());assert!(registry.issue(&t,vec![1],now).is_err());
    }
    #[test]fn expired_previews_are_rejected(){
        let mut registry=PreviewRegistry::default();let now=Instant::now();let t=ticket("scope");
        let token=registry.issue(&t,vec![1],now).unwrap();assert!(registry.consume(&t,&token,now+PREVIEW_TTL).is_err());
    }
    #[test]fn changed_object_metadata_changes_approval_digest(){
        let mut diff=SyncDiffRecord{to_add:vec![],to_update:vec![],to_delete:vec![],unchanged:0};let before=digest(&diff).unwrap();
        diff.to_add.push(SyncDiffEntryRecord{key:"new".into(),source_size:Some(1),dest_size:None,source_etag:Some("etag".into()),dest_etag:None,source_last_modified:None,dest_last_modified:None,selected:true});
        assert_ne!(before,digest(&diff).unwrap());let listed=digest(&diff).unwrap();diff.to_add[0].source_etag=Some("changed".into());assert_ne!(listed,digest(&diff).unwrap());
    }
    fn fixture()->(AppState,SyncInput){
        let state=AppState::default();
        let profile:Profile=serde_json::from_value(json!({"id":"p","name":"fixture","provider":"r2","accessKeyId":"fixture-ak","secretAccessKey":"fixture-sk","createdAt":"1","updatedAt":"1"})).unwrap();
        {let mut vault=state.vault.lock().unwrap();vault.unlocked=true;vault.data=Some(VaultData{profiles:vec![profile],..Default::default()});}
        let input=serde_json::from_value(json!({"sourceProfileId":"p","sourceBucket":"source","sourcePrefix":"","destProfileId":"p","destBucket":"dest","destPrefix":"","mode":"overwrite"})).unwrap();
        (state,input)
    }
    #[test]fn execution_requires_a_preview_and_rechecks_account_revision_and_diff(){
        let (state,mut input)=fixture();let ticket=begin(&state,&input).unwrap();
        let mut diff=SyncDiffRecord{to_add:vec![],to_update:vec![],to_delete:vec![],unchanged:0};
        assert!(consume(&state,&input,&ticket).is_err());
        input.preview_token=Some(issue(&state,&input,&ticket,&diff).unwrap());
        let approved=consume(&state,&input,&ticket).unwrap();
        assert!(verify(&state,&input,&ticket,&approved,&diff).is_ok());
        diff.unchanged=1;assert!(verify(&state,&input,&ticket,&approved,&diff).is_err());diff.unchanged=0;
        state.vault.lock().unwrap().data.as_mut().unwrap().profiles[0].updated_at="2".into();
        assert!(verify(&state,&input,&ticket,&approved,&diff).is_err());
        assert!(issue(&state,&input,&ticket,&diff).is_err());
    }
    #[test]fn changing_destination_cannot_reuse_a_preview(){
        let (state,mut input)=fixture();let ticket=begin(&state,&input).unwrap();
        let diff=SyncDiffRecord{to_add:vec![],to_update:vec![],to_delete:vec![],unchanged:0};
        input.preview_token=Some(issue(&state,&input,&ticket,&diff).unwrap());
        input.dest_prefix="elsewhere/".into();let changed=begin(&state,&input).unwrap();
        assert!(consume(&state,&input,&changed).is_err());
    }
}
