//! Background job queue: dispatch of queued upload/download/copy/move/delete/
//! archive/sync work, plus enqueue and cancel.

use super::*;

/// All upload variants, including small form uploads and directory markers,
/// bind the account that was selected when the operation began.
pub(crate) fn confirm_upload_profile(state:&AppState,id:&str,revision:&str,provider:S3Provider)->Result<Profile,String>{
    let profile=profile_for_id(state,id)?;
    if revision.is_empty() || profile.updated_at!=revision || profile.provider!=provider {
        return Err("上传账号已变更，旧任务已拒绝；请重新选择文件 / Upload account changed; stale task refused. Select the files again".into());
    }
    Ok(profile)
}

#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct JobClearError {
    #[serde(skip_serializing_if="Option::is_none")]
    pub(crate) job_id:Option<String>,
    pub(crate) error:String,
}
#[derive(Default,Debug)]
pub(crate) struct NativeClearReport {pub(crate) removed:HashSet<String>,pub(crate) errors:Vec<JobClearError>}
impl NativeClearReport {
    pub(crate) fn merge_phase(&mut self,phase:Result<Self,String>){
        match phase {
            Ok(mut report)=>{self.removed.extend(report.removed);self.errors.append(&mut report.errors);}
            Err(error)=>self.errors.push(JobClearError{job_id:None,error}),
        }
    }
}
/// A later manifest error must not discard IDs whose deletion already won.
/// Kept shared by upload/download and failure-injection tests.
pub(crate) fn clear_native_records<T>(records:&mut HashMap<String,T>,ids:Vec<String>,mut remove:impl FnMut(&str)->Result<(),String>)->NativeClearReport{
    let mut report=NativeClearReport::default();
    for id in ids {
        match remove(&id) {
            Ok(())=>{records.remove(&id);report.removed.insert(id);}
            Err(error)=>report.errors.push(JobClearError{job_id:Some(id),error}),
        }
    }
    report
}

#[derive(Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct ClearedJob {pub(crate) job_id:String,pub(crate) attempt:u64}
pub(crate) fn clear_finished_rows(jobs:&mut JobRuntime,native_removed:&HashSet<String>)->Vec<ClearedJob>{
    let ids:Vec<_>=jobs.jobs.iter().filter_map(|(id,job)|should_remove_finished_job(job,jobs.running.contains(id),native_removed).then(||id.clone())).collect();
    let removed=ids.iter().filter_map(|id|jobs.jobs.get(id).map(|job|ClearedJob{job_id:id.clone(),attempt:job.attempt})).collect();
    for id in ids {jobs.jobs.remove(&id);jobs.cancel_flags.remove(&id);jobs.queue.retain(|task|task.id!=id);}
    let known:HashSet<_>=jobs.jobs.keys().cloned().collect();let running=jobs.running.clone();jobs.order.retain(|id|known.contains(id)||running.contains(id));
    removed
}

pub(crate) fn should_remove_finished_job(job:&JobInfo,running:bool,native_removed:&HashSet<String>)->bool{
    is_terminal_job_status(job.status)&&!running&&(!job.resumable||native_removed.contains(&job.id))
}
fn trim_job_order(jobs:&mut JobRuntime){
    if jobs.order.len()<=JOB_ORDER_MAX{return}
    for removed in jobs.order.split_off(JOB_ORDER_MAX){
        let retained=jobs.running.contains(&removed)||jobs.jobs.get(&removed).is_some_and(|job|!is_terminal_job_status(job.status));
        if retained{jobs.order.push(removed);}else{jobs.jobs.remove(&removed);}
    }
}

#[cfg(test)]
mod clear_race_tests{
    use super::*;
    fn job()->JobInfo{serde_json::from_value(json!({"id":"fixture","type":"download","status":"completed","resumable":true,"attempt":1,"fileName":"f","description":"fixture","bytesTransferred":1,"bytesTotal":1,"percentage":100,"speed":0,"eta":0,"createdAt":"fixture"})).unwrap()}
    #[test]fn native_completion_between_manifest_sweep_and_visible_sweep_is_retained(){
        let row=job();assert!(!should_remove_finished_job(&row,false,&HashSet::new()));
        let removed=HashSet::from([row.id.clone()]);assert!(should_remove_finished_job(&row,false,&removed));assert!(!should_remove_finished_job(&row,true,&removed));
    }
    #[test]fn legacy_terminal_clearing_and_held_tasks_keep_existing_semantics(){
        let mut row=job();row.resumable=false;assert!(should_remove_finished_job(&row,false,&HashSet::new()));
        row.status=JobStatus::Interrupted;assert!(!should_remove_finished_job(&row,false,&HashSet::new()));
    }
    #[test]fn history_limit_never_hides_queued_paused_or_interrupted_tasks(){
        let mut jobs=JobRuntime::default();
        for index in 0..JOB_ORDER_MAX{let mut row=job();row.id=format!("recent-{index}");jobs.order.push(row.id.clone());jobs.jobs.insert(row.id.clone(),row);}
        for (id,status) in [("paused",JobStatus::Paused),("queued",JobStatus::Queued),("interrupted",JobStatus::Interrupted),("old-terminal",JobStatus::Completed)]{
            let mut row=job();row.id=id.into();row.status=status;jobs.order.push(row.id.clone());jobs.jobs.insert(row.id.clone(),row);
        }
        trim_job_order(&mut jobs);for id in ["paused","queued","interrupted"]{assert!(jobs.jobs.contains_key(id));assert!(jobs.order.iter().any(|value|value==id));}
        assert!(!jobs.jobs.contains_key("old-terminal"));
    }
    #[test]fn audit_upload_snapshot_refuses_changed_provider_revision_removed_and_locked_account(){
        let state=AppState::default();let original:Profile=serde_json::from_value(json!({"id":"upload-profile","name":"fixture","provider":"qiniu","accessKeyId":"fixture-ak","secretAccessKey":"fixture-sk","qiniu":{},"createdAt":"t","updatedAt":"revision-1"})).unwrap();
        {let mut vault=state.vault.lock().unwrap();vault.unlocked=true;vault.data=Some(VaultData{profiles:vec![original.clone()],..Default::default()});}
        for path in ["small.txt",""] {
            let task=JobTaskKind::Upload{profile_id:original.id.clone(),profile_revision:original.updated_at.clone(),provider:original.provider,bucket:"same-name".into(),key:"file-or-marker".into(),local_path:path.into()};
            let JobTaskKind::Upload{profile_id,profile_revision,provider,..}=task else{unreachable!()};
            assert!(confirm_upload_profile(&state,&profile_id,&profile_revision,provider).is_ok());
            {let mut vault=state.vault.lock().unwrap();let profile=&mut vault.data.as_mut().unwrap().profiles[0];profile.updated_at="revision-2".into();profile.access_key_id="another-account".into();}
            assert!(confirm_upload_profile(&state,&profile_id,&profile_revision,provider).is_err());
            {let mut vault=state.vault.lock().unwrap();let profile=&mut vault.data.as_mut().unwrap().profiles[0];*profile=original.clone();profile.provider=S3Provider::Custom;}
            assert!(confirm_upload_profile(&state,&profile_id,&profile_revision,provider).is_err());
            {state.vault.lock().unwrap().data.as_mut().unwrap().profiles[0]=original.clone();}
        }
        assert!(confirm_upload_profile(&state,&original.id,"",original.provider).is_err());
        {state.vault.lock().unwrap().data.as_mut().unwrap().profiles.clear();}
        assert!(confirm_upload_profile(&state,&original.id,&original.updated_at,original.provider).is_err());
        {let mut vault=state.vault.lock().unwrap();vault.data.as_mut().unwrap().profiles.push(original.clone());vault.unlocked=false;}
        assert!(confirm_upload_profile(&state,&original.id,&original.updated_at,original.provider).is_err());
    }
    #[test]fn audit_clear_keeps_successes_when_the_other_native_phase_fails(){
        let mut jobs=JobRuntime::default();for id in ["uploaded","download-failed","legacy"] {let mut row=job();row.id=id.into();if id=="legacy"{row.resumable=false;}jobs.order.push(row.id.clone());jobs.jobs.insert(row.id.clone(),row);}
        let mut report=NativeClearReport::default();report.merge_phase(Ok(NativeClearReport{removed:HashSet::from(["uploaded".into()]),errors:vec![]}));report.merge_phase(Err("Download manifest directory unavailable".into()));
        let removed=clear_finished_rows(&mut jobs,&report.removed);assert!(removed.iter().any(|r|r.job_id=="uploaded"&&r.attempt==1));assert!(removed.iter().any(|r|r.job_id=="legacy"));assert!(jobs.jobs.contains_key("download-failed"));assert_eq!(report.errors.len(),1);assert!(report.errors[0].job_id.is_none());
        assert!(!jobs.jobs.contains_key("uploaded"));
    }
}

pub(crate) fn try_start_queued_jobs(app: AppHandle) {
    let state = app.state::<AppState>();

    let mut start_now: Vec<(JobTask, Arc<AtomicBool>)> = Vec::new();
    let mut running_snapshots: Vec<JobInfo> = Vec::new();

    if let Ok(mut jobs) = lock_state(&state.jobs) {
        while jobs.running.len() < jobs.concurrency as usize {
            let Some(task) = jobs.queue.pop_front() else {
                break;
            };

            let cancel_flag = jobs
                .cancel_flags
                .entry(task.id.clone())
                .or_insert_with(|| Arc::new(AtomicBool::new(false)))
                .clone();
            jobs.running.insert(task.id.clone());

            if let Some(job) = jobs.jobs.get_mut(&task.id) {
                job.status = JobStatus::Running;
                job.started_at = Some(now_iso());
                job.speed = 0;
                job.eta = 0;
                running_snapshots.push(job.clone());
            }

            start_now.push((task, cancel_flag));
        }
    }

    for snapshot in running_snapshots {
        emit_job_progress_event(&app, &snapshot);
    }

    for (task, cancel_flag) in start_now {
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let JobTaskKind::NativeUpload{attempt}=&task.kind {
                native_jobs::run(&app_handle,&task.id,*attempt).await;
                try_start_queued_jobs(app_handle);
                return;
            }
            if let JobTaskKind::NativeDownload{attempt}=&task.kind {
                native_download_jobs::run(&app_handle,&task.id,*attempt).await;
                try_start_queued_jobs(app_handle);
                return;
            }
            let mut usage_changes: HashSet<(String, String)> = HashSet::new();
            let result: Result<i64, String> = async {
                let state = app_handle.state::<AppState>();
                let mut speed_calc = (Instant::now(), 0i64);

                let update = |transferred: i64, total: i64, speed_calc: &mut (Instant, i64)| {
                    let now = Instant::now();
                    let dt = now.duration_since(speed_calc.0).as_secs_f64();
                    let bytes_delta = transferred - speed_calc.1;
                    let speed = if dt > 0.4 {
                        (bytes_delta as f64 / dt) as i64
                    } else {
                        0
                    };
                    let eta = if speed > 0 && total > transferred {
                        (total - transferred) / speed.max(1)
                    } else {
                        0
                    };
                    if dt > 0.4 {
                        *speed_calc = (now, transferred);
                    }
                    update_job_progress(&app_handle, &task.id, transferred, total, speed, eta);
                };

                match &task.kind {
                    JobTaskKind::NativeUpload{..} => Err("Native upload dispatch mismatch".into()),
                    JobTaskKind::NativeDownload{..} => Err("Native download dispatch mismatch".into()),
                    JobTaskKind::Upload {
                        profile_id,
                        profile_revision,
                        provider,
                        bucket,
                        key,
                        local_path,
                    } => {
                        let profile = confirm_upload_profile(&state, profile_id,profile_revision,*provider)?;
                        if profile.provider == S3Provider::Qiniu {
                            let client = match storage_backend::get(&state, &profile)? {
                                storage_backend::StorageBackend::Qiniu(client) => client,
                                _ => return Err("Invalid Qiniu backend".to_string()),
                            };
                            return storage_backend::guarded(&state, &profile, async {
                            let context = client.resolve_named_bucket(bucket).await.map_err(|error| error.to_string())?;
                            if context.backend_mode != "kodo" { return Err("七牛私有云或临时凭据上传尚未验证 / Qiniu private-cloud or temporary-credential upload is not yet verified".to_string()); }
                            qiniu_privacy_gate::ensure_verified(&client, &context).await?;
                            if local_path.trim().is_empty() {
                                usage_changes.insert((profile_id.clone(), bucket.clone()));
                                client.upload_empty_marker(&context,key,&cancel_flag).await.map_err(|error| if error.code == "cancelled" { JOB_CANCELLED.to_string() } else { error.to_string() })?;
                                update(0,0,&mut speed_calc);
                                return Ok(0);
                            }
                            let local = expand_user_path(local_path);
                            usage_changes.insert((profile_id.clone(), bucket.clone()));
                            client.upload_file(&context, key, &local, false, None, &cancel_flag, |t, total| {
                                update(t as i64, total as i64, &mut speed_calc);
                            }).await.map(|size| size as i64).map_err(|error| if error.code == "cancelled" { JOB_CANCELLED.to_string() } else { error.to_string() })
                            }).await;
                        }
                        let client = to_s3_client(&profile)?;
                        if local_path.trim().is_empty() {
                            update(0, 0, &mut speed_calc);
                            usage_changes.insert((profile_id.clone(), bucket.clone()));
                            client
                                .put_object()
                                .bucket(bucket.to_string())
                                .key(key.to_string())
                                .body(ByteStream::from(Vec::<u8>::new()))
                                .send()
                                .await
                                .map_err(|err| err.to_string())?;
                            update(0, 0, &mut speed_calc);
                            Ok(0)
                        } else {
                            let local = expand_user_path(local_path);
                            let total = fs::metadata(&local)
                                .map(|m| m.len() as i64)
                                .unwrap_or(0)
                                .max(0);
                            update(0, total, &mut speed_calc);
                            usage_changes.insert((profile_id.clone(), bucket.clone()));
                            s3_upload_file(&client, bucket, key, &local, &cancel_flag, |t, tot| {
                                update(t, tot, &mut speed_calc);
                            })
                            .await
                        }
                    }
                    JobTaskKind::Download {
                        profile_id,
                        profile_revision,
                        bucket,
                        key,
                        local_path,
                        download_domain,
                    } => {
                        let profile = profile_for_id(&state, profile_id)?;
                        storage_backend::ensure_expected_revision(&profile,Some(profile_revision))?;
                        if profile.provider == S3Provider::Qiniu {
                            let client = match storage_backend::get(&state, &profile)? {
                                storage_backend::StorageBackend::Qiniu(client) => client,
                                _ => return Err("Invalid Qiniu backend".to_string()),
                            };
                            return storage_backend::guarded(&state, &profile, async {
                            let context = client.resolve_named_bucket(bucket).await.map_err(|error| error.to_string())?;
                            let local = expand_user_path(local_path);
                            update(0, 0, &mut speed_calc);
                            if context.backend_mode == "s3" {
                                if download_domain.is_some(){return Err("S3 下载不接受原生域名选择 / S3 downloads do not accept native domain overrides".into());}
                                // The server-resolved S3 identity, not the native
                                // bucket name, is required by private-cloud S3.
                                let bridge=storage_backend::qiniu_s3_bridge(&profile,&context)?;
                                return qiniu_s3_download(&bridge,key,&local,&cancel_flag,|t,total| {
                                    update(t,total,&mut speed_calc);
                                }).await;
                            }
                            if context.backend_mode != "kodo" { return Err("未知七牛连接模式 / Unknown Qiniu backend mode".to_string()); }
                            let domain=qiniu_download::resolve_domain(&client,&context,download_domain.as_deref()).await?;
                            let client=client.for_validated_download_domain(&domain).map_err(|error|error.to_string())?;
                            client.download_file(&context, key, &local, false, &cancel_flag, |t, total| {
                                update(t as i64, total as i64, &mut speed_calc);
                            }).await.map(|size| size as i64).map_err(|error| if error.code == "cancelled" { JOB_CANCELLED.to_string() } else { error.to_string() })
                            }).await;
                        }
                        let client = to_s3_client(&profile)?;
                        let local = expand_user_path(local_path);
                        update(0, 0, &mut speed_calc);
                        s3_download_file(&client, bucket, key, &local, &cancel_flag, |t, tot| {
                            update(t, tot, &mut speed_calc);
                        })
                        .await
                    }
                    JobTaskKind::Copy {
                        source_profile_id,
                        source_bucket,
                        source_key,
                        dest_profile_id,
                        dest_bucket,
                        dest_key,
                    } => {
                        let src_profile = profile_for_id(&state, source_profile_id)?;
                        let dst_profile = profile_for_id(&state, dest_profile_id)?;
                        if source_profile_id == dest_profile_id && source_bucket == dest_bucket && source_key == dest_key {
                            return Err("Source and destination are the same object; nothing was changed".to_string());
                        }
                        let src_client = to_s3_client(&src_profile)?;
                        let dst_client = to_s3_client(&dst_profile)?;
                        // Until the provider adapter resolves both bucket regions,
                        // only one bucket is a confirmed server-copy namespace.
                        let same_profile = server_copy_scope_confirmed(source_profile_id, source_bucket, dest_profile_id, dest_bucket);
                        update(0, 0, &mut speed_calc);
                        usage_changes.insert((dest_profile_id.clone(), dest_bucket.clone()));
                        if same_profile {
                            match s3_copy_object(
                                &src_client,
                                source_bucket,
                                source_key,
                                &dst_client,
                                dest_bucket,
                                dest_key,
                                &cancel_flag,
                                |t, tot| update(t, tot, &mut speed_calc),
                            )
                            .await
                            {
                                Ok(transferred) => Ok(transferred),
                                Err(err) if err == JOB_CANCELLED => Err(err),
                                Err(err) => s3_copy_object_via_temp_file(
                                    &src_client,
                                    source_bucket,
                                    source_key,
                                    &dst_client,
                                    dest_bucket,
                                    dest_key,
                                    &cancel_flag,
                                    |t, tot| update(t, tot, &mut speed_calc),
                                )
                                .await
                                .map_err(|fallback_err| {
                                    format!("{err}; fallback copy failed: {fallback_err}")
                                }),
                            }
                        } else {
                            s3_copy_object_via_temp_file(
                                &src_client,
                                source_bucket,
                                source_key,
                                &dst_client,
                                dest_bucket,
                                dest_key,
                                &cancel_flag,
                                |t, tot| update(t, tot, &mut speed_calc),
                            )
                            .await
                        }
                    }
                    JobTaskKind::Move {
                        source_profile_id,
                        source_bucket,
                        source_key,
                        dest_profile_id,
                        dest_bucket,
                        dest_key,
                    } => {
                        if source_profile_id != dest_profile_id {
                            return Err("Cross-account moves require verified destination content and are not yet enabled. Copy first; the source was preserved.".to_string());
                        }
                        if source_bucket == dest_bucket && source_key == dest_key {
                            return Err("Source and destination are the same object; nothing was changed".to_string());
                        }
                        let src_profile = profile_for_id(&state, source_profile_id)?;
                        let dst_profile = profile_for_id(&state, dest_profile_id)?;
                        let src_client = to_s3_client(&src_profile)?;
                        let dst_client = to_s3_client(&dst_profile)?;
                        let same_profile = server_copy_scope_confirmed(source_profile_id, source_bucket, dest_profile_id, dest_bucket);
                        update(0, 0, &mut speed_calc);
                        usage_changes.insert((dest_profile_id.clone(), dest_bucket.clone()));
                        let transferred = if same_profile {
                            match s3_copy_object(
                                &src_client,
                                source_bucket,
                                source_key,
                                &dst_client,
                                dest_bucket,
                                dest_key,
                                &cancel_flag,
                                |t, tot| update(t, tot, &mut speed_calc),
                            )
                            .await
                            {
                                Ok(transferred) => transferred,
                                Err(err) if err == JOB_CANCELLED => return Err(err),
                                Err(err) => s3_copy_object_via_temp_file(
                                    &src_client,
                                    source_bucket,
                                    source_key,
                                    &dst_client,
                                    dest_bucket,
                                    dest_key,
                                    &cancel_flag,
                                    |t, tot| update(t, tot, &mut speed_calc),
                                )
                                .await
                                .map_err(|fallback_err| {
                                    format!("{err}; fallback copy failed: {fallback_err}")
                                })?,
                            }
                        } else {
                            s3_copy_object_via_temp_file(
                                &src_client,
                                source_bucket,
                                source_key,
                                &dst_client,
                                dest_bucket,
                                dest_key,
                                &cancel_flag,
                                |t, tot| update(t, tot, &mut speed_calc),
                            )
                            .await?
                        };

                        if cancel_flag.load(Ordering::SeqCst) {
                            return Err(JOB_CANCELLED.to_string());
                        }

                        usage_changes.insert((source_profile_id.clone(), source_bucket.clone()));
                        s3_verify_and_delete_source(
                            &src_client, source_bucket, source_key,
                            &dst_client, dest_bucket, dest_key, &cancel_flag,
                        ).await?;
                        Ok(transferred)
                    }
                    JobTaskKind::Delete {
                        profile_id,
                        bucket,
                        keys,
                    } => {
                        let profile = profile_for_id(&state, profile_id)?;
                        let client = to_s3_client(&profile)?;
                        update(0, keys.len() as i64, &mut speed_calc);
                        if !keys.is_empty() {
                            usage_changes.insert((profile_id.clone(), bucket.clone()));
                        }
                        s3_delete_keys(&client, bucket, keys).await?;
                        update(keys.len() as i64, keys.len() as i64, &mut speed_calc);
                        Ok(keys.len() as i64)
                    }
                    JobTaskKind::Archive {
                        profile_id,
                        bucket,
                        keys,
                        common_prefix,
                        destination_path,
                    } => {
                        let profile = profile_for_id(&state, profile_id)?;
                        let client = to_s3_client(&profile)?;
                        let destination = expand_user_path(destination_path);
                        update(0, 0, &mut speed_calc);
                        s3_download_archive_tar_gz(
                            &client,
                            bucket,
                            keys,
                            common_prefix,
                            &destination,
                            &cancel_flag,
                            |t, tot| update(t, tot, &mut speed_calc),
                        )
                        .await
                    }
                }
            }
            .await;

            match result {
                Ok(bytes) => finish_job(
                    &app_handle,
                    &task.id,
                    JobStatus::Completed,
                    None,
                    Some(bytes),
                ),
                Err(err) if err == JOB_CANCELLED => {
                    finish_job(&app_handle, &task.id, JobStatus::Cancelled, Some(err), None)
                }
                Err(err) => finish_job(&app_handle, &task.id, JobStatus::Failed, Some(err), None),
            }

            for (profile_id, bucket) in usage_changes {
                usage::emit_changed(&app_handle, &profile_id, &bucket);
            }

            try_start_queued_jobs(app_handle);
        });
    }
}

// Kept separate from dispatch so the resolved S3 bucket identity and the
// existing atomic-download guarantees can be verified with a loopback server.
async fn qiniu_s3_download(
    bridge:&qiniu::s3_bridge::QiniuS3Bridge,
    key:&str,
    local_path:&Path,
    cancel_flag:&AtomicBool,
    on_progress:impl FnMut(i64,i64),
)->Result<i64,String>{
    s3_download_file_create_new(&bridge.client,&bridge.bucket_name,key,local_path,cancel_flag,on_progress).await
}

#[cfg(test)]
#[path = "qiniu_s3_download_tests.rs"]
mod qiniu_s3_download_tests;

pub(crate) fn enqueue_job(
    app: &AppHandle,
    job_type: JobType,
    file_name: String,
    description: String,
    bytes_total: i64,
    kind: JobTaskKind,
) -> Result<String, String> {
    let job_id = Uuid::new_v4().to_string();
    let state = app.state::<AppState>();
    // Display snapshots do not alter admission or authorization. If account
    // metadata is unavailable, retain known task IDs without inventing labels.
    let (source, destination) = match state.vault.lock() {
        Ok(vault) if vault.unlocked => job_location::for_task(&kind, vault.data.as_ref().map(|data|data.profiles.as_slice()).unwrap_or(&[])),
        _ => job_location::for_task(&kind, &[]),
    };
    let info = JobInfo {
        id: job_id.clone(),
        job_type,
        status: JobStatus::Queued,
        resumable: false,
        attempt: 0,
        cancel_requested: false,
        file_name,
        description,
        source,
        destination,
        bytes_transferred: 0,
        bytes_total: bytes_total.max(0),
        percentage: 0,
        speed: 0,
        eta: 0,
        error: None,
        created_at: now_iso(),
        started_at: None,
        completed_at: None,
    };

    let task = JobTask {
        id: job_id.clone(),
        kind,
    };

    {
        let mut jobs = lock_state(&state.jobs)?;
        jobs.jobs.insert(job_id.clone(), info.clone());
        jobs.order.retain(|id| id != &job_id);
        jobs.order.insert(0, job_id.clone());
        trim_job_order(&mut jobs);
        jobs.queue.push_back(task);
        jobs.cancel_flags
            .insert(job_id.clone(), Arc::new(AtomicBool::new(false)));
    }

    emit_job_progress_event(app, &info);
    try_start_queued_jobs(app.clone());
    Ok(job_id)
}

pub(crate) fn cancel_job(app: &AppHandle, job_id: &str) {
    let mut queued_cancel_snapshot: Option<JobInfo> = None;
    {
        let state = app.state::<AppState>();
        if let Ok(mut jobs) = lock_state(&state.jobs) {
            if let Some(index) = jobs.queue.iter().position(|task| task.id == job_id) {
                jobs.queue.remove(index);
                if let Some(job) = jobs.jobs.get_mut(job_id) {
                    job.status = JobStatus::Cancelled;
                    job.error = Some(JOB_CANCELLED.to_string());
                    job.completed_at = Some(now_iso());
                    queued_cancel_snapshot = Some(job.clone());
                }
                jobs.cancel_flags.remove(job_id);
            } else if let Some(cancel_flag) = jobs.cancel_flags.get(job_id) {
                cancel_flag.store(true, Ordering::SeqCst);
            }
        };
    }

    if let Some(job) = queued_cancel_snapshot {
        emit_job_progress_event(app, &job);
        emit_job_complete_event(app, &job);
        persist_job_history_snapshot(app);
    }
}

pub(crate) fn calculate_percentage(transferred: i64, total: i64) -> i64 {
    if total <= 0 {
        0
    } else {
        (((transferred as f64) / (total as f64)) * 100.0).round() as i64
    }
}

pub(crate) fn job_to_progress_event(job: &JobInfo) -> JobProgressEvent {
    JobProgressEvent {
        job_id: job.id.clone(),
        job_type: job.job_type,
        status: job.status,
        resumable: job.resumable,
        attempt: job.attempt,
        cancel_requested: job.cancel_requested,
        file_name: job.file_name.clone(),
        source: job.source.clone(),
        destination: job.destination.clone(),
        bytes_transferred: job.bytes_transferred,
        bytes_total: job.bytes_total,
        percentage: job.percentage,
        speed: job.speed,
        eta: job.eta,
        error: job.error.clone(),
    }
}

pub(crate) fn emit_job_progress_event(app: &AppHandle, job: &JobInfo) {
    let _ = app.emit("job:progress", job_to_progress_event(job));
}

pub(crate) fn emit_job_complete_event(app: &AppHandle, job: &JobInfo) {
    let complete = JobCompleteEvent {
        job_id: job.id.clone(),
        file_name: Some(job.file_name.clone()),
        success: job.status == JobStatus::Completed,
        error: job.error.clone(),
        status: job.status,
        attempt: job.attempt,
        profile_id: None,
        bucket: None,
        source: job.source.clone(),
        destination: job.destination.clone(),
    };
    let _ = app.emit("job:complete", complete);
}

pub(crate) fn emit_update_available_event(
    app: &AppHandle,
    version: &str,
    update_available: bool,
    update_ready: bool,
) {
    let payload = UpdateAvailableEventPayload {
        version: version.to_string(),
        update_available,
        update_ready,
    };
    let _ = app.emit("update:available", payload);
}

pub(crate) fn update_job_progress(
    app: &AppHandle,
    job_id: &str,
    transferred: i64,
    total: i64,
    speed: i64,
    eta: i64,
) {
    let mut snapshot: Option<JobInfo> = None;
    let state = app.state::<AppState>();
    if let Ok(mut jobs) = lock_state(&state.jobs) {
        if let Some(job) = jobs.jobs.get_mut(job_id) {
            job.bytes_transferred = transferred.max(0);
            if total >= 0 {
                job.bytes_total = total;
            }
            job.percentage = calculate_percentage(job.bytes_transferred, job.bytes_total);
            job.speed = speed.max(0);
            job.eta = eta.max(0);
            snapshot = Some(job.clone());
        }
    }
    if let Some(job) = snapshot {
        emit_job_progress_event(app, &job);
    }
}

pub(crate) fn finish_job(
    app: &AppHandle,
    job_id: &str,
    status: JobStatus,
    error: Option<String>,
    bytes_transferred: Option<i64>,
) {
    let mut snapshot: Option<JobInfo> = None;
    let state = app.state::<AppState>();
    if let Ok(mut jobs) = lock_state(&state.jobs) {
        jobs.running.remove(job_id);
        jobs.cancel_flags.remove(job_id);
        if let Some(job) = jobs.jobs.get_mut(job_id) {
            job.status = status;
            if let Some(transferred) = bytes_transferred {
                job.bytes_transferred = transferred.max(0);
                if job.bytes_total <= 0 {
                    job.bytes_total = transferred.max(0);
                }
                job.percentage = calculate_percentage(job.bytes_transferred, job.bytes_total);
            }
            if matches!(status, JobStatus::Completed) {
                if job.bytes_total > 0 {
                    job.bytes_transferred = job.bytes_total;
                    job.percentage = 100;
                }
            }
            job.error = error;
            job.completed_at = Some(now_iso());
            snapshot = Some(job.clone());
        }
    }
    if let Some(job) = snapshot {
        emit_job_progress_event(app, &job);
        emit_job_complete_event(app, &job);
    }
    persist_job_history_snapshot(app);
}

pub(crate) fn persist_job_history_snapshot(app: &AppHandle) {
    let history = {
        let state = app.state::<AppState>();
        let Ok(jobs) = lock_state(&state.jobs) else {
            return;
        };

        let mut collected = Vec::new();
        for id in &jobs.order {
            let Some(job) = jobs.jobs.get(id) else {
                continue;
            };
            if job.resumable || !is_terminal_job_status(job.status) || jobs.running.contains(id) {
                continue;
            }
            collected.push(job.clone());
            if collected.len() >= JOB_HISTORY_MAX {
                break;
            }
        }
        collected
    };

    let _ = save_job_history_to_disk(&history);
}

pub(crate) fn hydrate_job_history_runtime(app: &AppHandle) {
    let history = load_job_history_from_disk();
    if history.is_empty() {
        return;
    }

    let state = app.state::<AppState>();
    let Ok(mut jobs) = lock_state(&state.jobs) else {
        return;
    };

    for job in history {
        if !is_terminal_job_status(job.status) {
            continue;
        }
        let id = job.id.clone();
        if jobs.jobs.contains_key(&id) {
            continue;
        }
        jobs.order.push(id.clone());
        jobs.jobs.insert(id, job);
    }

    if jobs.order.len() > JOB_HISTORY_MAX {
        jobs.order.truncate(JOB_HISTORY_MAX);
    }
}
