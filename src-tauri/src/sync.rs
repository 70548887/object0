//! Bucket-to-bucket sync: object-map building and diff generate/execute.

use super::*;

pub(crate) fn build_sync_object_map(
    objects: Vec<RemoteObject>,
    prefix: &str,
) -> HashMap<String, SyncObjectInfo> {
    let mut map = HashMap::new();
    let normalized_prefix = normalize_prefix(prefix);

    for RemoteObject {
        key,
        size,
        etag,
        last_modified,
    } in objects
    {
        let relative = if normalized_prefix.is_empty() {
            key.clone()
        } else if key.starts_with(&normalized_prefix) {
            key[normalized_prefix.len()..].to_string()
        } else {
            continue;
        };

        if relative.is_empty() {
            continue;
        }
        if relative.ends_with('/') {
            continue;
        }

        map.insert(
            relative,
            SyncObjectInfo {
                size: size.max(0),
                etag,
                last_modified,
            },
        );
    }

    map
}

pub(crate) async fn generate_sync_diff(state: &AppState, input: &SyncInput) -> Result<SyncDiffRecord, String> {
    if input.source_profile_id == input.dest_profile_id && input.source_bucket == input.dest_bucket {
        let source = normalize_prefix(&input.source_prefix);
        let destination = normalize_prefix(&input.dest_prefix);
        if source.starts_with(&destination) || destination.starts_with(&source) {
            return Err("Source and destination sync scopes overlap; no changes were queued".to_string());
        }
    }
    let comparable_identity = input.source_profile_id == input.dest_profile_id;
    if input.mode == SyncMode::Mirror && !comparable_identity {
        return Err("Cross-account mirror deletion requires verified content identities and is not yet enabled. No deletion was queued.".to_string());
    }
    let source_profile = profile_for_id(state, &input.source_profile_id)?;
    let dest_profile = profile_for_id(state, &input.dest_profile_id)?;
    let source_client = to_s3_client(&source_profile)?;
    let dest_client = to_s3_client(&dest_profile)?;

    let source_prefix = normalize_prefix(&input.source_prefix);
    let dest_prefix = normalize_prefix(&input.dest_prefix);

    let source_objects =
        s3_list_all_objects(&source_client, &input.source_bucket, &source_prefix).await?;
    let dest_objects = s3_list_all_objects(&dest_client, &input.dest_bucket, &dest_prefix).await?;

    let source_map = build_sync_object_map(source_objects, &input.source_prefix);
    let dest_map = build_sync_object_map(dest_objects, &input.dest_prefix);

    Ok(compute_sync_diff(&source_map, &dest_map, input.mode, comparable_identity))
}

fn compute_sync_diff(
    source_map: &HashMap<String, SyncObjectInfo>,
    dest_map: &HashMap<String, SyncObjectInfo>,
    mode: SyncMode,
    comparable_identity: bool,
) -> SyncDiffRecord {
    let mut to_add = Vec::new();
    let mut to_update = Vec::new();
    let mut to_delete = Vec::new();
    let mut unchanged = 0i64;

    let mut keys: Vec<String> = source_map.keys().cloned().collect();
    keys.sort();

    for key in keys {
        let Some(src) = source_map.get(&key) else {
            continue;
        };
        if let Some(dest) = dest_map.get(&key) {
            // Additive is strictly create-missing-only. Existing objects are
            // skipped even when their size/content identity differs.
            if mode == SyncMode::Additive {
                unchanged += 1;
                continue;
            }
            if !comparable_identity || src.etag.is_empty() || src.etag != dest.etag || src.size != dest.size {
                to_update.push(SyncDiffEntryRecord {
                    key: key.clone(),
                    source_size: Some(src.size),
                    dest_size: Some(dest.size),
                    source_etag: Some(src.etag.clone()),
                    dest_etag: Some(dest.etag.clone()),
                    source_last_modified: Some(src.last_modified.clone()),
                    dest_last_modified: Some(dest.last_modified.clone()),
                    // ETags are opaque provider identities, not universal hashes.
                    // Cross-account equality cannot authorize an overwrite.
                    selected: comparable_identity,
                });
            } else {
                unchanged += 1;
            }
        } else {
            to_add.push(SyncDiffEntryRecord {
                key: key.clone(),
                source_size: Some(src.size),
                dest_size: None,
                source_etag: Some(src.etag.clone()),
                dest_etag: None,
                source_last_modified: Some(src.last_modified.clone()),
                dest_last_modified: None,
                selected: true,
            });
        }
    }

    if mode == SyncMode::Mirror {
        let mut dest_only: Vec<String> = dest_map
            .keys()
            .filter(|key| !source_map.contains_key(*key))
            .cloned()
            .collect();
        dest_only.sort();

        for key in dest_only {
            let Some(dest) = dest_map.get(&key) else {
                continue;
            };
            to_delete.push(SyncDiffEntryRecord {
                key: key.clone(),
                source_size: None,
                dest_size: Some(dest.size),
                source_etag: None,
                dest_etag: Some(dest.etag.clone()),
                source_last_modified: None,
                dest_last_modified: Some(dest.last_modified.clone()),
                selected: true,
            });
        }
    }

    SyncDiffRecord {
        to_add,
        to_update,
        to_delete,
        unchanged,
    }
}

fn ensure_sync_execution_safe(mode: SyncMode, comparable_identity: bool, diff: &SyncDiffRecord) -> Result<(), String> {
    if mode == SyncMode::Mirror || diff.to_delete.iter().any(|entry| entry.selected) {
        return Err("镜像删除暂未启用：尚缺少复制完成依赖及条件删除校验；未加入任务 / Mirror deletion is disabled until copy dependencies and conditional deletion are verified; no jobs were queued".to_string());
    }
    if !comparable_identity && diff.to_update.iter().any(|entry| entry.selected) {
        return Err("跨账号内容身份尚未可靠比较，禁止覆盖；未加入任务 / Cross-account content identities are not verified; overwrite was refused and no jobs were queued".to_string());
    }
    if !diff.to_add.iter().chain(&diff.to_update).any(|entry| entry.selected) {
        return Err("没有已选择且可安全执行的同步操作；未创建任务 / No selected and safe sync operations; no jobs were created".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod audit_tests {
    use super::*;

    fn object(tag: &str) -> SyncObjectInfo {
        SyncObjectInfo { size: 5, etag: tag.into(), last_modified: "fixture-time".into() }
    }

    fn maps() -> (HashMap<String, SyncObjectInfo>, HashMap<String, SyncObjectInfo>) {
        (HashMap::from([("missing".into(), object("new")), ("changed".into(), object("new"))]),
         HashMap::from([("changed".into(), object("old")), ("dest-only".into(), object("old"))]))
    }

    #[test]
    fn additive_sync_only_adds_missing_objects() {
        let (source, destination) = maps();
        let diff = compute_sync_diff(&source, &destination, SyncMode::Additive, true);
        assert_eq!(diff.to_add.len(), 1);
        assert!(diff.to_update.is_empty(), "Additive mode must never overwrite existing objects");
        assert!(diff.to_delete.is_empty());
    }

    #[test]
    fn overwrite_sync_adds_missing_and_updates_changed_objects() {
        let (source, destination) = maps();
        let diff = compute_sync_diff(&source, &destination, SyncMode::Overwrite, true);
        assert_eq!(diff.to_add.len(), 1, "Overwrite mode includes missing objects");
        assert_eq!(diff.to_update.len(), 1);
        assert!(diff.to_delete.is_empty());
    }

    #[test]
    fn unselected_cross_account_differences_do_not_block_missing_files() {
        let (source, destination) = maps();
        let diff = compute_sync_diff(&source, &destination, SyncMode::Overwrite, false);
        assert_eq!(diff.to_add.len(), 1);
        assert_eq!(diff.to_update.len(), 1);
        assert!(!diff.to_update[0].selected);
        assert!(ensure_sync_execution_safe(SyncMode::Overwrite, false, &diff).is_ok());
    }

    #[test]
    fn cross_account_etag_equality_is_not_a_comparable_hash() {
        let same = HashMap::from([("same".into(), object("identical-opaque-etag"))]);
        let mut diff = compute_sync_diff(&same, &same, SyncMode::Overwrite, false);
        assert_eq!(diff.unchanged, 0);
        assert_eq!(diff.to_update.len(), 1);
        assert!(!diff.to_update[0].selected);
        diff.to_update[0].selected = true;
        assert!(ensure_sync_execution_safe(SyncMode::Overwrite, false, &diff).is_err());
    }

    #[test]
    fn mirror_preview_cannot_execute_deletes_before_dependency_support() {
        let (source, destination) = maps();
        let diff = compute_sync_diff(&source, &destination, SyncMode::Mirror, true);
        assert_eq!(diff.to_delete.len(), 1);
        assert!(ensure_sync_execution_safe(SyncMode::Mirror, true, &diff).is_err());
        assert!(ensure_sync_execution_safe(SyncMode::Overwrite, true, &diff).is_err());
    }

    #[test]
    fn no_selected_actions_never_claim_a_nonexistent_sync_job() {
        let same = HashMap::from([("same".into(), object("opaque-etag"))]);
        let unchanged = compute_sync_diff(&same, &same, SyncMode::Overwrite, true);
        assert!(ensure_sync_execution_safe(SyncMode::Overwrite, true, &unchanged).unwrap_err().contains("no jobs were created"));
        let unverified = compute_sync_diff(&same, &same, SyncMode::Overwrite, false);
        assert!(ensure_sync_execution_safe(SyncMode::Overwrite, false, &unverified).is_err());
    }
}

pub(crate) fn execute_sync_diff(
    app: &AppHandle,
    input: &SyncInput,
    diff: &SyncDiffRecord,
    source_profile: &Profile,
    dest_profile: &Profile,
) -> Result<String, String> {
    ensure_sync_execution_safe(input.mode, input.source_profile_id == input.dest_profile_id, diff)?;
    if source_profile.id!=input.source_profile_id || dest_profile.id!=input.dest_profile_id {
        return Err("同步账号不匹配 / Sync accounts do not match".into());
    }
    confirm_transfer_profiles(&app.state::<AppState>(),&source_profile.id,&source_profile.updated_at,source_profile.provider,&dest_profile.id,&dest_profile.updated_at,dest_profile.provider)?;
    let mut job_ids = Vec::new();

    let mut enqueue_copy = |entry: &SyncDiffEntryRecord| -> Result<(), String> {
        let source_key = join_prefix_key(&input.source_prefix, &entry.key);
        let dest_key = join_prefix_key(&input.dest_prefix, &entry.key);
        let file_name = entry
            .key
            .split('/')
            .filter(|part| !part.is_empty())
            .last()
            .unwrap_or(entry.key.as_str())
            .to_string();

        let job_id = enqueue_job(
            app,
            JobType::Sync,
            file_name,
            format!(
                "同步 {}:{} → {}:{}",
                input.source_bucket, source_key, input.dest_bucket, dest_key
            ),
            entry.source_size.unwrap_or(0),
            JobTaskKind::Copy {
                source_profile_id: input.source_profile_id.clone(),
                source_profile_revision: source_profile.updated_at.clone(),
                source_provider: source_profile.provider,
                source_bucket: input.source_bucket.clone(),
                source_key,
                dest_profile_id: input.dest_profile_id.clone(),
                dest_profile_revision: dest_profile.updated_at.clone(),
                dest_provider: dest_profile.provider,
                dest_bucket: input.dest_bucket.clone(),
                dest_key,
            },
        )?;
        job_ids.push(job_id);
        Ok(())
    };

    for entry in diff.to_add.iter().filter(|entry| entry.selected) {
        enqueue_copy(entry)?;
    }
    for entry in diff.to_update.iter().filter(|entry| entry.selected) {
        enqueue_copy(entry)?;
    }

    let delete_keys: Vec<String> = diff
        .to_delete
        .iter()
        .filter(|entry| entry.selected)
        .map(|entry| join_prefix_key(&input.dest_prefix, &entry.key))
        .collect();
    if !delete_keys.is_empty() {
        let delete_job_id = enqueue_job(
            app,
            JobType::Delete,
            format!("{} object(s)", delete_keys.len()),
            format!("Mirror delete on {}", input.dest_bucket),
            delete_keys.len() as i64,
            JobTaskKind::Delete {
                profile_id: input.dest_profile_id.clone(),
                profile_revision: dest_profile.updated_at.clone(),
                provider: dest_profile.provider,
                bucket: input.dest_bucket.clone(),
                keys: delete_keys,
            },
        )?;
        job_ids.push(delete_job_id);
    }

    job_ids
        .first()
        .cloned()
        .ok_or_else(|| "没有已创建的同步任务 / No sync jobs were created".to_string())
}
