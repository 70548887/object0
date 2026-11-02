//! Durable public-native Qiniu downloads. Cloud reads and local commits are
//! separate phases; restore never starts either without an explicit action.
use super::*;
use crate::native_download_store::{Store,DownloadRecord,DownloadState,RECORD_VERSION};
use crate::qiniu::range_download::{self,DownloadCheckpoint,DownloadControl,DownloadOutcome,DownloadPhase};

#[derive(Default)]
pub(crate) struct DownloadRuntime{
    records:HashMap<String,DownloadRecord>,controls:HashMap<String,Arc<DownloadControl>>,
    loaded:bool,unreadable:usize,epoch:u64,
}
#[derive(Serialize)]
pub(crate) struct RestoreReport{pub restored:usize,pub unreadable:usize}
fn eligible(profile:&Profile)->bool{profile.provider==S3Provider::Qiniu&&profile.session_token.is_none()&&profile.qiniu.as_ref().is_some_and(|c|c.mode==qiniu::QiniuMode::Public&&c.bucket_bindings.is_empty())}
fn status(value:DownloadState)->JobStatus{match value{DownloadState::Queued=>JobStatus::Queued,DownloadState::Running=>JobStatus::Running,DownloadState::Paused=>JobStatus::Paused,DownloadState::Interrupted=>JobStatus::Interrupted,DownloadState::Completed=>JobStatus::Completed,DownloadState::Cancelled=>JobStatus::Cancelled}}
fn info(record:&DownloadRecord)->JobInfo{
    let cp=&record.checkpoint;let total=cp.remote.size as i64;
    let transferred=if record.state==DownloadState::Completed{total}else{cp.offset as i64};
    JobInfo{id:record.job_id.clone(),job_type:JobType::Download,status:status(record.state),resumable:true,attempt:record.attempt,cancel_requested:record.cancel_requested,
        file_name:Path::new(&cp.target_path).file_name().map(|v|v.to_string_lossy().into_owned()).unwrap_or_else(||"download".into()),
        description:format!("七牛断点下载 / Qiniu ranged download: {}/{}",record.bucket,record.key),bytes_transferred:transferred,bytes_total:total,percentage:calculate_percentage(transferred,total),speed:0,eta:0,
        source:Some(job_location::for_record(record.location.as_ref(),&record.profile_id,&record.bucket,&record.key)),destination:None,
        error:record.error.clone(),created_at:record.created_at.clone(),started_at:None,completed_at:record.state.terminal().then(||record.updated_at.clone())}
}
fn store_from_vault(vault:&VaultRuntime)->Result<Arc<Store>,String>{
    let mut key=existing_transfer_master_key(vault)?.ok_or_else(||"缺少持久传输密钥，请恢复原密码库 / Durable transfer key missing; restore the original vault".to_string())?;
    let result=Store::for_app(&key).map(Arc::new);key.fill(0);result
}
fn confirm_profile(vault:&VaultRuntime,record:&DownloadRecord)->Result<Profile,String>{
    ensure_unlocked(vault)?;
    let profile=vault.data.as_ref().and_then(|data|data.profiles.iter().find(|p|p.id==record.profile_id)).ok_or_else(||"下载所属账号已移除 / Download profile was removed".to_string())?;
    storage_backend::ensure_expected_revision(profile,Some(&record.profile_revision))?;
    if !eligible(profile){return Err("该账号不支持原生持久下载 / This account does not support native durable downloads".into())}
    Ok(profile.clone())
}
fn update_visible(state:&AppState,record:&DownloadRecord,queue:bool)->Result<(),String>{
    let mut jobs=lock_state(&state.jobs)?;let id=&record.job_id;
    if jobs.jobs.get(id).is_some_and(|job|!matches!(job.job_type,JobType::Download)){return Err("下载任务标识冲突，未替换其他任务 / Download task identity conflicts with another task".into())}
    if queue&&jobs.jobs.get(id).is_some_and(|job|job.attempt<record.attempt){jobs.running.remove(id);jobs.cancel_flags.remove(id);}
    let mut snapshot=info(record);if let Some(previous)=jobs.jobs.get(id).filter(|p|p.attempt==record.attempt){snapshot.started_at=previous.started_at.clone();}
    jobs.jobs.insert(id.clone(),snapshot);jobs.order.retain(|old|old!=id);jobs.order.insert(0,id.clone());
    if queue{
        jobs.queue.retain(|task|&task.id!=id);let task=JobTask{id:id.clone(),kind:JobTaskKind::NativeDownload{attempt:record.attempt}};
        if record.cancel_requested{jobs.queue.push_front(task)}else{jobs.queue.push_back(task)}
    }else if record.state!=DownloadState::Running{jobs.running.remove(id);jobs.queue.retain(|task|&task.id!=id);jobs.cancel_flags.remove(id);}
    Ok(())
}
fn publish(app:&AppHandle,record:&DownloadRecord){
    let state=app.state::<AppState>();let Ok(runtime)=state.native_downloads.lock()else{return};
    if !runtime.records.get(&record.job_id).is_some_and(|row|row.attempt==record.attempt&&row.state==record.state){return}
    let snapshot=info(record);emit_job_progress_event(app,&snapshot);
    if record.state.terminal(){let _=app.emit("job:complete",JobCompleteEvent{job_id:record.job_id.clone(),file_name:Some(snapshot.file_name),success:record.state==DownloadState::Completed,error:record.error.clone(),status:status(record.state),attempt:record.attempt,profile_id:Some(record.profile_id.clone()),bucket:Some(record.bucket.clone()),source:snapshot.source,destination:snapshot.destination});}
}
pub(crate) fn contains(state:&AppState,id:&str)->Result<bool,String>{Ok(lock_state(&state.native_downloads)?.records.contains_key(id))}

pub(crate) fn restore(app:&AppHandle)->Result<RestoreReport,String>{
    let state=app.state::<AppState>();let vault=lock_state(&state.vault)?;ensure_unlocked(&vault)?;let mut runtime=lock_state(&state.native_downloads)?;
    if runtime.loaded{return Ok(RestoreReport{restored:0,unreadable:runtime.unreadable})}
    let Some(mut key)=existing_transfer_master_key(&vault)?else{
        runtime.unreadable=Store::record_count(&config_paths::object0_config_dir()?.join("native-download-jobs"))?;
        runtime.loaded=true;return Ok(RestoreReport{restored:0,unreadable:runtime.unreadable})
    };
    let opened=Store::for_app(&key);key.fill(0);let store=opened?;
    install_restored_records(&state,&mut runtime,&vault,&store,store.load_all()?)
}
fn install_restored_records(state:&AppState,runtime:&mut DownloadRuntime,vault:&VaultRuntime,store:&Store,report:native_download_store::LoadReport)->Result<RestoreReport,String>{
    let mut unreadable=report.unreadable_count;let mut restored=0;
    for mut record in report.records{
        let old_state=record.state;let old_error=record.error.clone();record.state=record.state.after_restart();
        if record.state==DownloadState::Interrupted&&(old_state!=DownloadState::Interrupted||record.error.is_none()){record.error=Some("上次下载已中断；手动恢复会校验远端对象和本地断点 / Previous download interrupted; manual resume verifies the remote object and local prefix".into());}
        if !record.state.terminal()&&confirm_profile(vault,&record).is_err(){record.state=DownloadState::Interrupted;record.error=Some("账号已移除或版本变化；未自动恢复下载 / Account missing or changed; no download resumed automatically".into());}
        if record.state!=old_state||record.error!=old_error{record.updated_at=now_iso();if store.save(&record).is_err(){unreadable+=1;}}
        update_visible(state,&record,false)?;runtime.records.insert(record.job_id.clone(),record);restored+=1;
    }
    runtime.loaded=true;runtime.unreadable=unreadable;Ok(RestoreReport{restored,unreadable})
}
pub(crate) async fn enqueue_download(app:&AppHandle,file_name:String,description:String,kind:JobTaskKind)->Result<String,String>{
    let JobTaskKind::Download{profile_id,profile_revision,bucket,key,local_path,download_domain}=&kind else{return Err("Invalid download task".into())};
    let state=app.state::<AppState>();let profile=profile_for_id(&state,profile_id)?;storage_backend::ensure_expected_revision(&profile,Some(profile_revision))?;
    if !eligible(&profile){return enqueue_job(app,JobType::Download,file_name,description,0,kind)}
    if key.is_empty()||key.ends_with('/'){return Err("断点下载目前仅支持文件对象 / Ranged download currently supports files only".into())}
    let job_id=Uuid::new_v4().to_string();let target=expand_user_path(local_path);
    let checkpoint=storage_backend::guarded(&state,&profile,async {
        let client=storage_backend::qiniu_client(&profile)?;
        let context=client.resolve_named_bucket(bucket).await.map_err(|e|e.to_string())?;
        let domain=qiniu_download::resolve_domain(&client,&context,download_domain.as_deref()).await?;
        let client=client.for_validated_download_domain(&domain).map_err(|e|e.to_string())?;
        client.prepare_download_checkpoint(&job_id,&profile.id,&profile.updated_at,&context,key,&target,&DownloadControl::default()).await.map_err(|e|e.to_string())
    }).await?;
    let store={let mut vault=lock_state(&state.vault)?;ensure_unlocked(&vault)?;
        if !vault.data.as_ref().is_some_and(|data|data.profiles.iter().any(|p|p.id==profile.id&&p.updated_at==profile.updated_at)){return Err("账号已变化，请重新下载 / Account changed; request the download again".into())}
        let mut key=ensure_transfer_master_key(&vault_path()?,&mut vault,None)?;let result=Store::for_app(&key).map(Arc::new);key.fill(0);result?};
    restore(app)?;
    let timestamp=now_iso();let record=DownloadRecord{format_version:RECORD_VERSION,job_id,profile_id:profile.id.clone(),profile_revision:profile.updated_at.clone(),bucket:checkpoint.bucket.clone(),key:key.clone(),location:Some(job_location::from_profile(&profile,&checkpoint.bucket,Some(key),None)),checkpoint,state:DownloadState::Queued,attempt:1,cancel_requested:false,created_at:timestamp.clone(),updated_at:timestamp,error:None};
    {let vault=lock_state(&state.vault)?;confirm_profile(&vault,&record)?;let mut runtime=lock_state(&state.native_downloads)?;store.save(&record)?;update_visible(&state,&record,true)?;runtime.records.insert(record.job_id.clone(),record.clone());}
    publish(app,&record);try_start_queued_jobs(app.clone());Ok(record.job_id)
}

/// Shared production/test boundary. Only after durable checkpoint callbacks
/// succeed can the job be reported completed. Local commit and cancel recovery
/// intentionally accept no cloud client or bucket context.
pub(crate) async fn execute_record(record:&mut DownloadRecord,client:Option<&qiniu::QiniuClient>,context:Option<&qiniu::ResolvedBucketContext>,control:&DownloadControl,mut persist:impl FnMut(&DownloadRecord)->Result<(),String>,on_progress:impl FnMut(u64,u64))->Result<(),String>{
    let identity=record.clone();let mut save=|cp:&DownloadCheckpoint|{
        let mut candidate=record.clone();candidate.checkpoint=cp.clone();candidate.updated_at=now_iso();
        persist(&candidate).map_err(|_|qiniu::QiniuError::new(qiniu::CapabilityState::Unavailable,"checkpoint-save-failed","下载记录保存失败，后续写入停止 / Download manifest could not be saved; writes stopped"))?;
        *record=candidate;Ok(())
    };
    let outcome=if identity.cancel_requested||control.is_cancelled(){
        range_download::cancel_download_checkpoint(identity.checkpoint.clone(),&mut save).await
    }else if matches!(identity.checkpoint.phase,DownloadPhase::Committing|DownloadPhase::Completed){
        range_download::reconcile_download_checkpoint(identity.checkpoint.clone(),&mut save).await
    }else if control.is_paused(){Ok(DownloadOutcome::Paused{checkpoint:identity.checkpoint.clone()})}
    else{
        let client=client.ok_or_else(||"下载连接尚未准备好 / Download connection is not ready".to_string())?;
        let context=context.ok_or_else(||"下载空间尚未验证 / Download bucket is unverified".to_string())?;
        client.run_download_checkpoint(context,identity.checkpoint.clone(),control,&mut save,on_progress).await
    };
    let mut candidate=record.clone();candidate.updated_at=now_iso();
    match outcome{
        Ok(DownloadOutcome::Completed{checkpoint,..})=>{candidate.checkpoint=checkpoint;candidate.state=DownloadState::Completed;candidate.error=None;}
        Ok(DownloadOutcome::Paused{checkpoint})=>{candidate.checkpoint=checkpoint;candidate.state=DownloadState::Paused;candidate.error=None;}
        Ok(DownloadOutcome::Cancelled{checkpoint})=>{candidate.checkpoint=checkpoint;candidate.state=DownloadState::Cancelled;candidate.error=None;}
        Ok(DownloadOutcome::Interrupted{checkpoint,error})=>{candidate.checkpoint=checkpoint;candidate.state=DownloadState::Interrupted;candidate.error=Some(error.to_string());}
        Err(error)=>{candidate.state=if error.code=="paused"&&candidate.checkpoint.phase==DownloadPhase::Downloading{DownloadState::Paused}else{DownloadState::Interrupted};candidate.error=Some(error.to_string());}
    }
    persist(&candidate)?;*record=candidate;Ok(())
}
fn can_start(record:&DownloadRecord,attempt:u64,active:bool)->bool{record.state==DownloadState::Queued&&record.attempt==attempt&&!active}
fn merge_durable_intent(previous:&DownloadRecord,candidate:&DownloadRecord)->Result<DownloadRecord,String>{
    let mut candidate=candidate.clone();
    if previous.cancel_requested{
        candidate.cancel_requested=true;
        if previous.checkpoint.phase==DownloadPhase::Downloading&&candidate.checkpoint.phase==DownloadPhase::Committing{return Err("取消先于本地交付，已停止写入；请继续清理 / Cancellation preceded local commit; writes stopped. Continue cleanup".into())}
    }
    Ok(candidate)
}
async fn metadata_or_stop<T>(operation:impl std::future::Future<Output=Result<T,String>>,control:&DownloadControl)->Result<Option<T>,String>{
    use futures_util::future::{select,Either};let mut pending=Box::pin(operation);
    loop{if control.is_paused()||control.is_cancelled(){return Ok(None)}
        match select(pending,Box::pin(tokio::time::sleep(StdDuration::from_millis(100)))).await{
            Either::Left((result,_))=>return result.map(Some),Either::Right((_,future))=>pending=future,
        }
    }
}
pub(crate) async fn run(app:&AppHandle,id:&str,attempt:u64){
    let state=app.state::<AppState>();
    let prepared=(||->Result<_,String>{
        let vault=lock_state(&state.vault)?;let store=store_from_vault(&vault)?;let mut runtime=lock_state(&state.native_downloads)?;
        let Some(mut record)=runtime.records.get(id).cloned()else{return Ok(None)};
        if !can_start(&record,attempt,runtime.controls.contains_key(id)){return Ok(None)}
        let profile=confirm_profile(&vault,&record)?;record.state=DownloadState::Running;record.error=None;record.updated_at=now_iso();store.save(&record)?;
        let control=Arc::new(DownloadControl::default());runtime.controls.insert(id.into(),control.clone());runtime.records.insert(id.into(),record.clone());
        Ok(Some((record,profile,store,control,runtime.epoch)))
    })();
    let (mut record,profile,store,control,epoch)=match prepared{Ok(Some(value))=>value,Ok(None)=>return,Err(error)=>{interrupt_visible(app,id,attempt,error);return}};
    let result=storage_backend::guarded(&state,&profile,async {
        let connection=if record.cancel_requested||matches!(record.checkpoint.phase,DownloadPhase::Committing|DownloadPhase::Completed){None}else{
            metadata_or_stop(async{
                let client=storage_backend::qiniu_client(&profile)?;
                let context=client.resolve_named_bucket(&record.bucket).await.map_err(|e|e.to_string())?;
                if context.backend_mode!="kodo"{return Err("不能把原生下载断点切换到 S3 / Native download checkpoints cannot switch to S3".into())}
                let domain=qiniu_download::resolve_domain(&client,&context,Some(&record.checkpoint.domain)).await?;
                let client=client.for_validated_download_domain(&domain).map_err(|e|e.to_string())?;Ok((client,context))
            },&control).await?
        };
        execute_record(&mut record,connection.as_ref().map(|v|&v.0),connection.as_ref().map(|v|&v.1),&control,|candidate|{
            let mut runtime=lock_state(&state.native_downloads)?;
            if runtime.epoch!=epoch||!runtime.records.get(id).is_some_and(|row|row.attempt==attempt){return Err("下载状态已变化，写入停止 / Download runtime changed; writes stopped".into())}
            let previous=runtime.records.get(id).ok_or("Download manifest is missing")?;let candidate=merge_durable_intent(previous,candidate)?;
            store.save(&candidate)?;runtime.records.insert(id.into(),candidate);Ok(())
        },|done,total|{
            if let Ok(runtime)=state.native_downloads.lock(){if runtime.epoch==epoch&&runtime.records.get(id).is_some_and(|r|r.attempt==attempt){update_job_progress(app,id,done as i64,total as i64,0,0);}}
        }).await
    }).await;
    let visible={let Ok(mut runtime)=state.native_downloads.lock()else{return};if runtime.epoch!=epoch{return}
        runtime.controls.remove(id);let Some(mut final_record)=runtime.records.get(id).cloned()else{return};
        if let Err(error)=result{final_record.state=DownloadState::Interrupted;final_record.error=Some(error);final_record.updated_at=now_iso();if store.save(&final_record).is_err(){final_record.error=Some("下载中断且状态写入失败，已有断点保留，请检查磁盘 / Download interrupted and state write failed; prior checkpoint retained; check disk".into());}runtime.records.insert(id.into(),final_record.clone());}
        let _=update_visible(&state,&final_record,false);final_record
    };publish(app,&visible);
}
fn interrupt_visible(app:&AppHandle,id:&str,attempt:u64,error:String){
    let state=app.state::<AppState>();let store={let Ok(vault)=state.vault.lock()else{return};store_from_vault(&vault).ok()};
    let snapshot={let Ok(mut runtime)=state.native_downloads.lock()else{return};let Some(record)=runtime.records.get_mut(id)else{return};if record.state.terminal()||record.attempt!=attempt{return}
        record.state=DownloadState::Interrupted;record.error=Some(error);record.updated_at=now_iso();if let Some(store)=store{let _=store.save(record);}let value=record.clone();let _=update_visible(&state,&value,false);value};publish(app,&snapshot);
}
pub(crate) fn pause(app:&AppHandle,id:&str)->Result<(),String>{
    let state=app.state::<AppState>();let vault=lock_state(&state.vault)?;let store=store_from_vault(&vault)?;let mut runtime=lock_state(&state.native_downloads)?;
    let record=runtime.records.get(id).ok_or("Task does not support download pause")?;confirm_profile(&vault,record)?;
    if record.cancel_requested{return Err("已记录取消请求，只能继续清理 / Cancellation is recorded; only cleanup can continue".into())}
    if let Some(control)=runtime.controls.get(id){control.pause();return Ok(())}
    if record.state!=DownloadState::Queued{return Err("只有排队或进行中的下载可暂停 / Only queued or running downloads can pause".into())}
    let mut candidate=record.clone();candidate.state=if candidate.checkpoint.phase==DownloadPhase::Downloading{DownloadState::Paused}else{DownloadState::Interrupted};candidate.updated_at=now_iso();store.save(&candidate)?;update_visible(&state,&candidate,false)?;runtime.records.insert(id.into(),candidate.clone());drop(runtime);drop(vault);publish(app,&candidate);Ok(())
}
pub(crate) fn resume(app:&AppHandle,id:&str)->Result<(),String>{
    let state=app.state::<AppState>();let vault=lock_state(&state.vault)?;let store=store_from_vault(&vault)?;let mut runtime=lock_state(&state.native_downloads)?;
    let record=runtime.records.get(id).ok_or("下载断点未加载，请刷新任务 / Download checkpoint not loaded; refresh tasks")?;confirm_profile(&vault,record)?;
    if runtime.controls.contains_key(id)||!matches!(record.state,DownloadState::Paused|DownloadState::Interrupted){return Err("只有暂停或中断的下载可恢复 / Only paused or interrupted downloads can resume".into())}
    let mut candidate=record.clone();candidate.state=DownloadState::Queued;candidate.error=None;candidate.attempt=candidate.attempt.checked_add(1).ok_or("Download attempt overflow")?;candidate.updated_at=now_iso();store.save(&candidate)?;update_visible(&state,&candidate,true)?;runtime.records.insert(id.into(),candidate.clone());drop(runtime);drop(vault);publish(app,&candidate);try_start_queued_jobs(app.clone());Ok(())
}
pub(crate) fn cancel(app:&AppHandle,id:&str)->Result<bool,String>{
    let state=app.state::<AppState>();if !contains(&state,id)?{return Ok(false)}
    let vault=lock_state(&state.vault)?;let store=store_from_vault(&vault)?;let mut runtime=lock_state(&state.native_downloads)?;
    let record=runtime.records.get(id).ok_or("Download no longer loaded")?;confirm_profile(&vault,record)?;if record.state.terminal(){return Err("已结束的下载不能再次取消 / Finished downloads cannot be cancelled again".into())}
    let mut candidate=record.clone();candidate.cancel_requested=true;candidate.updated_at=now_iso();
    if let Some(control)=runtime.controls.get(id).cloned(){store.save(&candidate)?;update_visible(&state,&candidate,false)?;runtime.records.insert(id.into(),candidate.clone());control.cancel();drop(runtime);drop(vault);publish(app,&candidate);return Ok(true)}
    candidate.state=DownloadState::Queued;candidate.attempt=candidate.attempt.checked_add(1).ok_or("Download attempt overflow")?;store.save(&candidate)?;update_visible(&state,&candidate,true)?;runtime.records.insert(id.into(),candidate.clone());drop(runtime);drop(vault);publish(app,&candidate);try_start_queued_jobs(app.clone());Ok(true)
}
pub(crate) fn suspend_for_lock(state:&AppState,vault:&VaultRuntime){let store=store_from_vault(vault).ok();let Ok(mut runtime)=state.native_downloads.lock()else{return};suspend_runtime(state,&mut runtime,store.as_deref());}
fn suspend_runtime(state:&AppState,runtime:&mut DownloadRuntime,store:Option<&Store>){
    for control in runtime.controls.values(){control.pause();}
    for record in runtime.records.values_mut(){if !record.state.terminal(){record.state=DownloadState::Interrupted;record.error=Some("密码库已锁定或应用退出，下载断点保留 / Vault locked or app exited; download checkpoint retained".into());record.updated_at=now_iso();if let Some(store)=store{if store.save(record).is_err(){eprintln!("Download suspension write failed; prior checkpoint retained");}}}}
    if let Ok(mut jobs)=state.jobs.lock(){let ids:HashSet<_>=runtime.records.keys().cloned().collect();jobs.queue.retain(|task|!ids.contains(&task.id));jobs.order.retain(|id|!ids.contains(id));for id in ids{jobs.jobs.remove(&id);jobs.running.remove(&id);jobs.cancel_flags.remove(&id);}}
    runtime.records.clear();runtime.controls.clear();runtime.loaded=false;runtime.unreadable=0;runtime.epoch=runtime.epoch.wrapping_add(1);
}
fn clearable_ids(runtime:&DownloadRuntime)->Vec<String>{runtime.records.values().filter(|r|r.state.terminal()&&!runtime.controls.contains_key(&r.job_id)).map(|r|r.job_id.clone()).collect()}
pub(crate) fn clear_terminal(app:&AppHandle)->Result<NativeClearReport,String>{
    let state=app.state::<AppState>();let vault=lock_state(&state.vault)?;ensure_unlocked(&vault)?;let mut runtime=lock_state(&state.native_downloads)?;let ids=clearable_ids(&runtime);if ids.is_empty(){return Ok(NativeClearReport::default())}let store=store_from_vault(&vault)?;
    Ok(clear_terminal_records(&mut runtime,&store,ids))
}
fn clear_terminal_records(runtime:&mut DownloadRuntime,store:&Store,ids:Vec<String>)->NativeClearReport{clear_native_records(&mut runtime.records,ids,|id|store.remove(id))}

#[cfg(test)]
#[path="native_download_jobs_tests.rs"]
mod tests;
