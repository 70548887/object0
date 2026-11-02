//! Durable native Qiniu uploads integrated with the ordinary visible queue.
//! Encrypted manifests are written before every remote mutation boundary.
//! Restoring a vault restores rows, never automatically replays cloud writes.
use super::*;
use crate::native_upload_store::{Store,UploadRecord,UploadState,RECORD_VERSION};
use crate::qiniu::multipart::{MultipartControl,MultipartOutcome,MultipartPhase,MultipartOptions};

#[derive(Default)]
pub(crate) struct NativeRuntime {
    records:HashMap<String,UploadRecord>,
    controls:HashMap<String,Arc<MultipartControl>>,
    loaded:bool,
    unreadable:usize,
    epoch:u64,
}
#[derive(Serialize)]
pub(crate) struct RestoreReport{pub restored:usize,pub unreadable:usize}
fn eligible(profile:&Profile)->bool{
    profile.provider==S3Provider::Qiniu && profile.session_token.is_none()
        && profile.qiniu.as_ref().is_some_and(|config|config.mode==qiniu::QiniuMode::Public&&config.bucket_bindings.is_empty())
}
fn status(state:UploadState)->JobStatus{match state{UploadState::Queued=>JobStatus::Queued,UploadState::Running=>JobStatus::Running,UploadState::Paused=>JobStatus::Paused,UploadState::Interrupted=>JobStatus::Interrupted,UploadState::Completed=>JobStatus::Completed,UploadState::Cancelled=>JobStatus::Cancelled}}
fn info(record:&UploadRecord)->JobInfo{
    let total=record.source.size as i64;
    let transferred=if record.state==UploadState::Completed{total}else{record.checkpoint.as_ref().map(|cp|cp.parts.iter().map(|part|part.size as i64).sum()).unwrap_or(0)};
    JobInfo{id:record.job_id.clone(),job_type:JobType::Upload,status:status(record.state),resumable:true,attempt:record.attempt,cancel_requested:record.cancel_requested,
        file_name:Path::new(&record.local_path).file_name().map(|n|n.to_string_lossy().into_owned()).unwrap_or_else(||"upload".into()),
        description:format!("七牛分片上传 / Qiniu multipart: {}/{}",record.bucket,record.key),
        source:None,destination:Some(job_location::for_record(record.location.as_ref(),&record.profile_id,&record.bucket,&record.key)),
        bytes_transferred:transferred,bytes_total:total,percentage:calculate_percentage(transferred,total),speed:0,eta:0,
        error:record.error.clone(),created_at:record.created_at.clone(),started_at:None,
        completed_at:record.state.terminal().then(||record.updated_at.clone())}
}
fn store_from_vault(vault:&VaultRuntime)->Result<Arc<Store>,String>{
    let mut key=existing_transfer_master_key(vault)?.ok_or_else(||"缺少持久传输密钥，请先解锁原密码库 / Durable transfer key is missing; unlock the original vault".to_string())?;
    let result=Store::for_app(&key).map(Arc::new);key.fill(0);result
}
fn store_for_state(state:&AppState)->Result<Arc<Store>,String>{let vault=lock_state(&state.vault)?;store_from_vault(&vault)}
fn confirm_profile(vault:&VaultRuntime,record:&UploadRecord)->Result<Profile,String>{
    ensure_unlocked(vault)?;
    let profile=vault.data.as_ref().and_then(|data|data.profiles.iter().find(|profile|profile.id==record.profile_id)).ok_or_else(||"上传所属账号已移除 / Upload profile was removed".to_string())?;
    storage_backend::ensure_expected_revision(profile,Some(&record.profile_revision))?;
    if !eligible(profile){return Err("此账号不支持原生持久上传 / This account does not support native durable uploads".into())}
    Ok(profile.clone())
}
fn publish(app:&AppHandle,record:&UploadRecord){
    let state=app.state::<AppState>();let Ok(runtime)=state.native_uploads.lock() else{return};
    if !runtime.records.get(&record.job_id).is_some_and(|current|current.attempt==record.attempt&&current.state==record.state){return}
    let snapshot=info(record);emit_job_progress_event(app,&snapshot);
    if record.state.terminal(){let _=app.emit("job:complete",JobCompleteEvent{job_id:record.job_id.clone(),file_name:Some(snapshot.file_name),success:record.state==UploadState::Completed,error:record.error.clone(),status:status(record.state),attempt:record.attempt,profile_id:Some(record.profile_id.clone()),bucket:Some(record.bucket.clone()),source:snapshot.source,destination:snapshot.destination});}
}
fn update_visible(state:&AppState,record:&UploadRecord,queue:bool)->Result<(),String>{
    let mut jobs=lock_state(&state.jobs)?;let id=&record.job_id;
    // A queue item may have been popped but not claimed by a runner yet.
    // Superseding its attempt must release that obsolete scheduling slot.
    if queue&&jobs.jobs.get(id).is_some_and(|job|job.attempt<record.attempt){jobs.running.remove(id);jobs.cancel_flags.remove(id);}
    let mut snapshot=info(record);
    if let Some(previous)=jobs.jobs.get(id).filter(|job|job.attempt==record.attempt){snapshot.started_at=previous.started_at.clone();}
    jobs.jobs.insert(id.clone(),snapshot);
    jobs.order.retain(|existing|existing!=id);jobs.order.insert(0,id.clone());
    if queue{jobs.queue.retain(|task|&task.id!=id);jobs.queue.push_back(JobTask{id:id.clone(),kind:JobTaskKind::NativeUpload{attempt:record.attempt}});}
    else if record.state!=UploadState::Running{jobs.running.remove(id);jobs.queue.retain(|task|&task.id!=id);jobs.cancel_flags.remove(id);}
    Ok(())
}

/// Called on demand after unlock. Bad records are surfaced as a count, not
/// silently treated as an empty queue. No network request occurs here.
pub(crate) fn restore(app:&AppHandle)->Result<RestoreReport,String>{
    let state=app.state::<AppState>();let vault=lock_state(&state.vault)?;ensure_unlocked(&vault)?;
    let mut runtime=lock_state(&state.native_uploads)?;
    if runtime.loaded{return Ok(RestoreReport{restored:0,unreadable:runtime.unreadable})}
    let Some(mut key)=existing_transfer_master_key(&vault)? else {
        let path=config_paths::object0_config_dir()?.join("native-upload-jobs");
        runtime.unreadable=Store::record_count(&path)?;
        runtime.loaded=true;return Ok(RestoreReport{restored:0,unreadable:runtime.unreadable})
    };
    let opened=Store::for_app(&key);key.fill(0);let store=opened?;
    install_restored_records(&state,&mut runtime,&vault,&store,store.load_all()?)
}
fn install_restored_records(state:&AppState,runtime:&mut NativeRuntime,vault:&VaultRuntime,store:&Store,report:native_upload_store::LoadReport)->Result<RestoreReport,String>{
    let mut unreadable=report.unreadable_count;let mut restored=0;
    for mut record in report.records{
        let previous_state=record.state;let previous_error=record.error.clone();
        record.state=record.state.after_restart();
        if record.state==UploadState::Interrupted&&(previous_state!=UploadState::Interrupted||record.error.is_none()){record.error=Some("上次运行已中断；恢复会先验证来源和服务端分片 / Previous run was interrupted; resume validates source and server parts first".into());}
        if !record.state.terminal()&&confirm_profile(&vault,&record).is_err(){record.state=UploadState::Interrupted;record.error=Some("账号不存在或版本已变化，任务不会自动恢复 / Account missing or changed; the task will not auto-resume".into());}
        let changed=record.state!=previous_state || record.error!=previous_error;
        if changed{record.updated_at=now_iso();}
        // Persist restart classification, but a read-only disk must not hide a
        // recoverable row or cause any automatic remote replay.
        if changed && store.save(&record).is_err(){unreadable+=1;}
        update_visible(state,&record,false)?;runtime.records.insert(record.job_id.clone(),record);restored+=1;
    }
    runtime.loaded=true;
    runtime.unreadable=unreadable;
    Ok(RestoreReport{restored,unreadable})
}

/// Upload-only queue entry. Other jobs retain their existing queue semantics.
pub(crate) async fn enqueue_upload(app:&AppHandle,file_name:String,description:String,total:i64,kind:JobTaskKind)->Result<String,String>{
    let JobTaskKind::Upload{profile_id,profile_revision,provider,bucket,key,local_path}=&kind else{return Err("Invalid upload task".into())};
    let state=app.state::<AppState>();let profile=confirm_upload_profile(&state,profile_id,profile_revision,*provider)?;
    if profile.provider!=S3Provider::Qiniu||local_path.trim().is_empty(){return enqueue_job(app,JobType::Upload,file_name,description,total,kind)}
    let path=expand_user_path(local_path);
    let meta=fs::metadata(&path).map_err(|_|"无法读取上传文件 / Could not inspect upload file".to_string())?;
    if !meta.is_file(){return Err("上传来源不是普通文件 / Upload source is not a file".into())}
    if meta.len()<=qiniu::transfer::FORM_UPLOAD_LIMIT{return enqueue_job(app,JobType::Upload,file_name,description,total,kind)}
    if !eligible(&profile){return Err("大文件持久上传目前仅支持公有云原生永久凭据 / Durable large-file upload currently requires public native Qiniu credentials".into())}
    if meta.len()>qiniu::multipart::MAX_BUFFERED_PART_SIZE*qiniu::multipart::MAX_PARTS as u64{return Err("文件超过当前分片数量上限 / File exceeds the multipart limit".into())}
    let source=storage_backend::guarded(&state,&profile,async {qiniu::multipart::fingerprint_source(&path,&MultipartControl::default()).await.map_err(|e|e.to_string())}).await?;
    // The profile may have been edited while hashing a large local file.
    let store={let mut vault=lock_state(&state.vault)?;
        ensure_unlocked(&vault)?;
        if !vault.data.as_ref().is_some_and(|data|data.profiles.iter().any(|p|p.id==profile.id&&p.updated_at==profile.updated_at)){return Err("账号已变化，请重新选择文件 / Account changed; select the file again".into())}
        let mut secret=ensure_transfer_master_key(&vault_path()?,&mut vault,None)?;
        let result=Store::for_app(&secret).map(Arc::new);secret.fill(0);result?};
    restore(app)?;
    let timestamp=now_iso();let record=UploadRecord{format_version:RECORD_VERSION,job_id:Uuid::new_v4().to_string(),profile_id:profile.id.clone(),profile_revision:profile.updated_at.clone(),bucket:bucket.clone(),key:key.clone(),location:Some(job_location::from_profile(&profile,bucket,Some(key),None)),local_path:source.canonical_path.clone(),source,options:MultipartOptions::default(),checkpoint:None,state:UploadState::Queued,attempt:1,cancel_requested:false,created_at:timestamp.clone(),updated_at:timestamp,error:None};
    {
        let vault=lock_state(&state.vault)?;confirm_profile(&vault,&record)?;
        let mut runtime=lock_state(&state.native_uploads)?;
        store.save(&record)?;update_visible(&state,&record,true)?;runtime.records.insert(record.job_id.clone(),record.clone());
    }
    publish(app,&record);try_start_queued_jobs(app.clone());Ok(record.job_id)
}

/// Shared by production and local contract tests. Only persisted state is
/// returned as a success. Completing is never treated as permission to repeat
/// Complete or delete a possibly committed target.
pub(crate) async fn execute_record(
    record:&mut UploadRecord,client:&qiniu::QiniuClient,context:&qiniu::ResolvedBucketContext,
    control:&MultipartControl,cancel:bool,mut persist:impl FnMut(&UploadRecord)->Result<(),String>,
    on_progress:impl FnMut(u64,u64),
)->Result<(),String>{
    let cancel=cancel||record.cancel_requested;
    let identity=record.clone();
    let mut save=|cp:&qiniu::multipart::MultipartCheckpoint|{
        let mut candidate=record.clone();candidate.checkpoint=Some(cp.clone());candidate.updated_at=now_iso();
        persist(&candidate).map_err(|_|qiniu::QiniuError::new(qiniu::CapabilityState::Unavailable,"checkpoint-save-failed","无法保存上传检查点，写请求已停止 / Could not persist upload checkpoint; writes stopped"))?;
        *record=candidate;Ok(())
    };
    let outcome=if cancel {
        if let Some(cp)=identity.checkpoint.clone(){client.cancel_file_multipart(&identity.profile_id,&identity.profile_revision,context,&identity.key,&identity.options,cp,&mut save).await}
        else{let mut candidate=identity.clone();candidate.state=UploadState::Cancelled;candidate.updated_at=now_iso();persist(&candidate)?;*record=candidate;return Ok(())}
    }else{client.upload_file_multipart_bound(&identity.profile_id,&identity.profile_revision,context,&identity.key,Path::new(&identity.local_path),&identity.options,&identity.source,identity.checkpoint.clone(),control,&mut save,on_progress).await};
    let mut candidate=record.clone();candidate.updated_at=now_iso();
    match outcome {
        Ok(MultipartOutcome::Completed{checkpoint,..})=>{candidate.checkpoint=Some(checkpoint);candidate.state=UploadState::Completed;candidate.error=None;}
        Ok(MultipartOutcome::Paused{checkpoint})=>{candidate.checkpoint=Some(checkpoint);candidate.state=UploadState::Paused;candidate.error=None;}
        Ok(MultipartOutcome::Cancelled{checkpoint})=>{candidate.checkpoint=Some(checkpoint);candidate.state=UploadState::Cancelled;candidate.error=None;}
        Ok(MultipartOutcome::Interrupted{checkpoint,error})=>{candidate.checkpoint=Some(checkpoint);candidate.state=UploadState::Interrupted;candidate.error=Some(error.to_string());}
        Err(error)=>{candidate.state=if error.code=="paused"{UploadState::Paused}else if error.code=="cancelled"&&candidate.checkpoint.is_none(){UploadState::Cancelled}else{UploadState::Interrupted};candidate.error=Some(error.to_string());}
    }
    persist(&candidate)?;*record=candidate;Ok(())
}

fn can_start(record:&UploadRecord,expected_attempt:u64,already_active:bool)->bool{
    record.state==UploadState::Queued&&record.attempt==expected_attempt&&!already_active
}
fn merge_durable_intent(previous:&UploadRecord,candidate:&UploadRecord)->Result<UploadRecord,String>{
    let mut candidate=candidate.clone();
    if previous.cancel_requested {
        candidate.cancel_requested=true;
        let committed=previous.checkpoint.as_ref().is_some_and(|cp|matches!(cp.phase,MultipartPhase::Completing|MultipartPhase::Completed));
        if !committed&&candidate.checkpoint.as_ref().is_some_and(|cp|cp.phase==MultipartPhase::Completing){
            return Err("取消先于完成提交，写入已停止；请继续取消清理 / Cancellation preceded completion; writes stopped. Continue cancellation cleanup".into());
        }
    }
    Ok(candidate)
}
pub(crate) async fn run(app:&AppHandle,id:&str,expected_attempt:u64){
    let state=app.state::<AppState>();
    let prepared=(||->Result<_,String>{
        let vault=lock_state(&state.vault)?;let store=store_from_vault(&vault)?;
        let mut runtime=lock_state(&state.native_uploads)?;
        let Some(mut record)=runtime.records.get(id).cloned() else{return Ok(None)};
        // A popped queue item may race with pause/cancel/resume. It must not
        // revive a terminal row or steal a newer attempt's queue slot.
        if !can_start(&record,expected_attempt,runtime.controls.contains_key(id)){return Ok(None)}
        let profile=confirm_profile(&vault,&record)?;
        record.state=UploadState::Running;record.error=None;record.updated_at=now_iso();store.save(&record)?;
        let control=Arc::new(MultipartControl::default());let cancel=record.cancel_requested;
        runtime.controls.insert(id.into(),control.clone());runtime.records.insert(id.into(),record.clone());
        Ok(Some((record,profile,store,control,runtime.epoch,cancel)))
    })();
    let (mut record,profile,store,control,epoch,cancel)=match prepared{Ok(Some(value))=>value,Ok(None)=>return,Err(error)=>{interrupt_visible(app,id,expected_attempt,error);return}};
    let attempt=record.attempt;
    let result=storage_backend::guarded(&state,&profile,async {
        let client=storage_backend::qiniu_client(&profile)?;
        let context=client.resolve_named_bucket(&record.bucket).await.map_err(|e|e.to_string())?;
        if context.backend_mode!="kodo"{return Err("Cannot resume native upload through S3".into())}
        if !cancel{qiniu_privacy_gate::ensure_verified(&client,&context).await?;}
        execute_record(&mut record,&client,&context,&control,cancel,|candidate|{
            let mut runtime=lock_state(&state.native_uploads)?;
            if runtime.epoch!=epoch || !runtime.records.get(id).is_some_and(|r|r.attempt==attempt){return Err("Upload session changed; writes stopped".into())}
            let previous=runtime.records.get(id).ok_or("Upload record missing")?;
            let candidate=merge_durable_intent(previous,candidate)?;
            store.save(&candidate)?;runtime.records.insert(id.into(),candidate);Ok(())
        },|done,total|{
            // Keep callback ordering native-runtime -> visible-jobs, matching
            // lock/restore. Old attempts cannot overwrite a newer row.
            if let Ok(runtime)=state.native_uploads.lock(){if runtime.epoch==epoch&&runtime.records.get(id).is_some_and(|r|r.attempt==attempt){update_job_progress(app,id,done as i64,total as i64,0,0);}}
        }).await
    }).await;
    let visible={let Ok(mut runtime)=state.native_uploads.lock() else{return};
        if runtime.epoch!=epoch{return}
        runtime.controls.remove(id);
        let Some(mut final_record)=runtime.records.get(id).cloned() else{return};
        if let Err(error)=result{
            final_record.state=UploadState::Interrupted;final_record.error=Some(error);final_record.updated_at=now_iso();
            if store.save(&final_record).is_err(){final_record.error=Some("任务中断且状态写入失败；请检查磁盘后恢复，已有检查点保留 / Upload interrupted and status persistence failed; check disk before resuming".into());}
            runtime.records.insert(id.into(),final_record.clone());
        }
        let _=update_visible(&state,&final_record,false);final_record
    };
    publish(app,&visible);usage::emit_changed(app,&visible.profile_id,&visible.bucket);
}
fn interrupt_visible(app:&AppHandle,id:&str,attempt:u64,error:String){
    let state=app.state::<AppState>();let store=store_for_state(&state).ok();
    let snapshot={let Ok(mut runtime)=state.native_uploads.lock() else{return};let Some(record)=runtime.records.get_mut(id) else{return};if record.state.terminal()||record.attempt!=attempt{return}
        record.state=UploadState::Interrupted;record.error=Some(error);record.updated_at=now_iso();if let Some(store)=store{let _=store.save(record);}
        let value=record.clone();let _=update_visible(&state,&value,false);value};publish(app,&snapshot);
}

pub(crate) fn pause(app:&AppHandle,id:&str)->Result<(),String>{
    let state=app.state::<AppState>();let vault=lock_state(&state.vault)?;let store=store_from_vault(&vault)?;
    let mut runtime=lock_state(&state.native_uploads)?;
    let record=runtime.records.get(id).ok_or("Task does not support pause")?;confirm_profile(&vault,record)?;
    if record.cancel_requested{return Err("任务已请求取消；恢复只会继续取消清理，不可改成暂停上传 / Cancellation was requested; resume only continues cleanup, not uploading".into())}
    if let Some(control)=runtime.controls.get(id){control.pause();return Ok(())}
    if record.state!=UploadState::Queued{return Err("Only a queued or running upload can be paused".into())}
    let mut candidate=record.clone();candidate.state=if candidate.checkpoint.as_ref().is_some_and(|cp|matches!(cp.phase,MultipartPhase::Completing|MultipartPhase::Completed)){UploadState::Interrupted}else{UploadState::Paused};candidate.updated_at=now_iso();store.save(&candidate)?;
    update_visible(&state,&candidate,false)?;runtime.records.insert(id.into(),candidate.clone());drop(runtime);drop(vault);publish(app,&candidate);Ok(())
}
pub(crate) fn resume(app:&AppHandle,id:&str)->Result<(),String>{
    let state=app.state::<AppState>();let vault=lock_state(&state.vault)?;let store=store_from_vault(&vault)?;
    let mut runtime=lock_state(&state.native_uploads)?;let record=runtime.records.get(id).ok_or("恢复记录未加载，请先刷新任务 / Resume record is not loaded; refresh jobs first")?;
    confirm_profile(&vault,record)?;
    if runtime.controls.contains_key(id)||!matches!(record.state,UploadState::Paused|UploadState::Interrupted){return Err("Only paused or interrupted uploads can resume".into())}
    let mut candidate=record.clone();candidate.state=UploadState::Queued;candidate.error=None;candidate.attempt=candidate.attempt.checked_add(1).ok_or("Upload attempt overflow")?;candidate.updated_at=now_iso();
    store.save(&candidate)?;update_visible(&state,&candidate,true)?;runtime.records.insert(id.into(),candidate.clone());drop(runtime);drop(vault);publish(app,&candidate);try_start_queued_jobs(app.clone());Ok(())
}
/// true means this task belongs to the durable queue (legacy cancel must not run).
pub(crate) fn cancel(app:&AppHandle,id:&str)->Result<bool,String>{
    let state=app.state::<AppState>();
    {let runtime=lock_state(&state.native_uploads)?;if !runtime.records.contains_key(id){return Ok(false)}}
    let vault=lock_state(&state.vault)?;let store=store_from_vault(&vault)?;let mut runtime=lock_state(&state.native_uploads)?;
    let record=runtime.records.get(id).ok_or("Upload no longer loaded")?;confirm_profile(&vault,record)?;
    if record.state.terminal(){return Err("Completed or cancelled uploads cannot be cancelled again".into())}
    let mut candidate=record.clone();candidate.updated_at=now_iso();candidate.cancel_requested=true;
    if let Some(control)=runtime.controls.get(id).cloned(){
        // Commit the intent before signaling the runner. A lock/restart must
        // never turn a user-confirmed cancellation into an upload retry.
        store.save(&candidate)?;update_visible(&state,&candidate,false)?;runtime.records.insert(id.into(),candidate.clone());control.cancel();drop(runtime);drop(vault);publish(app,&candidate);return Ok(true)
    }
    if candidate.checkpoint.is_none(){candidate.state=UploadState::Cancelled;store.save(&candidate)?;update_visible(&state,&candidate,false)?;}
    else{candidate.state=UploadState::Queued;candidate.attempt=candidate.attempt.checked_add(1).ok_or("Upload attempt overflow")?;store.save(&candidate)?;update_visible(&state,&candidate,true)?;}
    runtime.records.insert(id.into(),candidate.clone());drop(runtime);drop(vault);publish(app,&candidate);try_start_queued_jobs(app.clone());Ok(true)
}

/// Caller holds the vault lock, before clearing its key/cache. The latest
/// checkpoint is already durable; a crash or write error here still restores
/// Running as Interrupted. No Abort or object delete is issued on locking.
pub(crate) fn suspend_for_lock(state:&AppState,vault:&VaultRuntime){
    let store=store_from_vault(vault).ok();
    let Ok(mut runtime)=state.native_uploads.lock() else{return};
    suspend_runtime(state,&mut runtime,store.as_deref());
}
fn suspend_runtime(state:&AppState,runtime:&mut NativeRuntime,store:Option<&Store>){
    for control in runtime.controls.values(){control.pause();}
    for record in runtime.records.values_mut(){if !record.state.terminal(){
        record.state=UploadState::Interrupted;record.error=Some("密码库已锁定或应用已退出；检查点已保留 / Vault locked or application exited; checkpoint retained".into());record.updated_at=now_iso();
        if let Some(store)=store{if store.save(record).is_err(){eprintln!("Could not persist upload suspension; existing checkpoint retained");}}
    }}
    if let Ok(mut jobs)=state.jobs.lock(){let ids:HashSet<_>=runtime.records.keys().cloned().collect();jobs.queue.retain(|task|!ids.contains(&task.id));jobs.order.retain(|id|!ids.contains(id));for id in ids{jobs.jobs.remove(&id);jobs.running.remove(&id);jobs.cancel_flags.remove(&id);}}
    runtime.records.clear();runtime.controls.clear();runtime.loaded=false;runtime.unreadable=0;runtime.epoch=runtime.epoch.wrapping_add(1);
}
pub(crate) fn pause_for_exit(app:&AppHandle){let state=app.state::<AppState>();if let Ok(vault)=state.vault.lock(){suspend_for_lock(&state,&vault);native_download_jobs::suspend_for_lock(&state,&vault);storage_backend::clear(&state);};}
pub(crate) fn clear_terminal(app:&AppHandle)->Result<NativeClearReport,String>{
    let state=app.state::<AppState>();let vault=lock_state(&state.vault)?;ensure_unlocked(&vault)?;
    let mut runtime=lock_state(&state.native_uploads)?;
    let ids=clearable_ids(&runtime);
    if ids.is_empty(){return Ok(NativeClearReport::default())}let store=store_from_vault(&vault)?;
    Ok(clear_terminal_records(&mut runtime,&store,ids))
}
fn clear_terminal_records(runtime:&mut NativeRuntime,store:&Store,ids:Vec<String>)->NativeClearReport{clear_native_records(&mut runtime.records,ids,|id|store.remove(id))}
fn clearable_ids(runtime:&NativeRuntime)->Vec<String>{runtime.records.values().filter(|r|r.state.terminal()&&!runtime.controls.contains_key(&r.job_id)).map(|r|r.job_id.clone()).collect()}

#[cfg(test)]
#[path="native_jobs_tests.rs"]
mod tests;
