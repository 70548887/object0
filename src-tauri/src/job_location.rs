//! Immutable display snapshots only. These fields never authorize a transfer.
use super::*;

pub(crate) fn from_profile(profile: &Profile, bucket: &str, key: Option<&str>, prefix: Option<&str>) -> JobLocation {
    JobLocation {
        profile_id: profile.id.clone(), profile_name: Some(profile.name.clone()),
        provider: Some(profile.provider), bucket: bucket.into(),
        key: key.map(str::to_string), prefix: prefix.map(str::to_string),
    }
}

fn snapshot(profiles: &[Profile], id: &str, revision: Option<&str>, provider: Option<S3Provider>, bucket: &str, key: Option<&str>, prefix: Option<&str>) -> JobLocation {
    let known = profiles.iter().find(|profile| profile.id == id
        && revision.is_none_or(|revision| !revision.is_empty() && profile.updated_at == revision)
        && provider.is_none_or(|provider| profile.provider == provider));
    match known {
        Some(profile) => from_profile(profile, bucket, key, prefix),
        None => JobLocation { profile_id: id.into(), profile_name: None, provider: None,
            bucket: bucket.into(), key: key.map(str::to_string), prefix: prefix.map(str::to_string) },
    }
}

/// Capture while enqueueing, before the task can outlive an edited/removed account.
pub(crate) fn for_task(kind: &JobTaskKind, profiles: &[Profile]) -> (Option<JobLocation>, Option<JobLocation>) {
    match kind {
        JobTaskKind::Upload {profile_id, profile_revision, provider, bucket, key, ..} =>
            (None, Some(snapshot(profiles, profile_id, Some(profile_revision), Some(*provider), bucket, Some(key), None))),
        JobTaskKind::Download {profile_id, profile_revision, bucket, key, ..} =>
            (Some(snapshot(profiles, profile_id, Some(profile_revision), None, bucket, Some(key), None)), None),
        JobTaskKind::Copy {source_profile_id, source_profile_revision, source_provider, source_bucket, source_key, dest_profile_id, dest_profile_revision, dest_provider, dest_bucket, dest_key}
        | JobTaskKind::Move {source_profile_id, source_profile_revision, source_provider, source_bucket, source_key, dest_profile_id, dest_profile_revision, dest_provider, dest_bucket, dest_key} =>
            (Some(snapshot(profiles, source_profile_id, Some(source_profile_revision), Some(*source_provider), source_bucket, Some(source_key), None)),
             Some(snapshot(profiles, dest_profile_id, Some(dest_profile_revision), Some(*dest_provider), dest_bucket, Some(dest_key), None))),
        JobTaskKind::Delete {profile_id, profile_revision, provider, bucket, keys} =>
            (Some(snapshot(profiles, profile_id, Some(profile_revision), Some(*provider), bucket, (keys.len()==1).then(||keys[0].as_str()), None)), None),
        JobTaskKind::Archive {profile_id, profile_revision, provider, bucket, keys, common_prefix, ..} =>
            (Some(snapshot(profiles, profile_id, Some(profile_revision), Some(*provider), bucket, (keys.len()==1).then(||keys[0].as_str()), Some(common_prefix))), None),
        JobTaskKind::NativeUpload {..} | JobTaskKind::NativeDownload {..} => (None, None),
    }
}

/// Old native manifests know these identities but never recorded a historical
/// account label. Do not fill it from today's account or current selection.
pub(crate) fn for_record(location: Option<&JobLocation>, profile_id: &str, bucket: &str, key: &str) -> JobLocation {
    let mut location = location.cloned().unwrap_or_else(||JobLocation {
        profile_id:profile_id.into(), profile_name:None, provider:None,
        bucket:bucket.into(), key:None, prefix:None,
    });
    location.key = Some(key.into());
    location
}

/// Optional labels/provider metadata cannot block recovery. Only contradictory
/// stored resource identity is rejected; a missing optional key is recoverable.
pub(crate) fn matches_record(location: Option<&JobLocation>, profile_id: &str, bucket: &str, key: &str) -> bool {
    location.is_none_or(|location| location.profile_id == profile_id && location.bucket == bucket
        && location.key.as_deref().is_none_or(|saved| saved == key))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile(id:&str,name:&str,provider:S3Provider)->Profile {
        serde_json::from_value(json!({"id":id,"name":name,"provider":provider,"accessKeyId":"credential-ak-must-not-leak","secretAccessKey":"credential-sk-must-not-leak","sessionToken":"credential-session-must-not-leak","createdAt":"t","updatedAt":"revision-1"})).unwrap()
    }
    fn upload(id:&str,revision:&str)->JobTaskKind {JobTaskKind::Upload{profile_id:id.into(),profile_revision:revision.into(),provider:S3Provider::R2,bucket:"same-bucket".into(),key:"目录/文件+%.txt".into(),local_path:"C:/fixture/not-opened.txt".into()}}
    fn old_job()->JobInfo {serde_json::from_value(json!({"id":"old","type":"upload","status":"completed","fileName":"f","description":"legacy","bytesTransferred":1,"bytesTotal":1,"percentage":100,"speed":0,"eta":0,"createdAt":"t"})).unwrap()}
    #[test]fn queued_snapshot_keeps_original_label_and_only_safe_fields_after_profile_rename_or_removal() {
        let mut profiles=vec![profile("first","Original R2",S3Provider::R2),profile("second","Other account",S3Provider::Qiniu)];
        let (_,location)=for_task(&upload("first","revision-1"),&profiles);let location=location.unwrap();
        profiles[0].name="Renamed".into();profiles.clear();
        assert_eq!(location.profile_name.as_deref(),Some("Original R2"));assert_eq!(location.profile_id,"first");assert_eq!(location.key.as_deref(),Some("目录/文件+%.txt"));
        let encoded=serde_json::to_string(&location).unwrap();
        for secret in ["credential-ak","credential-sk","credential-session","localPath","endpoint"]{assert!(!encoded.contains(secret));}
        assert_eq!(serde_json::from_str::<JobLocation>(&encoded).unwrap(),location);
    }
    #[test]fn stale_or_missing_account_never_borrows_current_label_or_provider() {
        let profiles=vec![profile("first","New identity",S3Provider::R2),profile("other","Active Qiniu",S3Provider::Qiniu)];
        for task in [upload("first","old-revision"),upload("removed","revision-1")] {
            let (_,location)=for_task(&task,&profiles);let location=location.unwrap();
            assert!(location.profile_name.is_none());assert!(location.provider.is_none());assert_eq!(location.bucket,"same-bucket");
        }
        let changed=vec![profile("first","Replaced provider",S3Provider::Custom)];
        assert!(for_task(&upload("first","revision-1"),&changed).1.unwrap().profile_name.is_none());
    }
    #[test]fn ordinary_history_and_progress_roundtrip_keep_destinations_while_legacy_stays_unknown() {
        let mut job=old_job();assert!(job.source.is_none()&&job.destination.is_none());
        job.destination=for_task(&upload("first","revision-1"),&[profile("first","Account",S3Provider::R2)]).1;
        let serialized=serde_json::to_string(&vec![job.clone()]).unwrap();let restored:Vec<JobInfo>=serde_json::from_str(&serialized).unwrap();
        assert_eq!(restored[0].destination,job.destination);
        let event=job_to_progress_event(&job);let event=serde_json::to_value(event).unwrap();
        assert_eq!(event["destination"]["profileName"],"Account");assert_eq!(event["destination"]["bucket"],"same-bucket");
        let mut old=serde_json::to_value(job).unwrap();old.as_object_mut().unwrap().remove("destination");
        assert!(serde_json::from_value::<JobInfo>(old).unwrap().destination.is_none());
    }
    #[test]fn operation_directions_and_cross_account_copy_are_not_swapped() {
        let profiles=vec![profile("first","R2",S3Provider::R2),profile("second","Qiniu",S3Provider::Qiniu)];
        let task=JobTaskKind::Copy{source_profile_id:"first".into(),source_profile_revision:"revision-1".into(),source_provider:S3Provider::R2,source_bucket:"source".into(),source_key:"a".into(),dest_profile_id:"second".into(),dest_profile_revision:"revision-1".into(),dest_provider:S3Provider::Qiniu,dest_bucket:"target".into(),dest_key:"b".into()};
        let (source,destination)=for_task(&task,&profiles);assert_eq!(source.unwrap().profile_name.as_deref(),Some("R2"));assert_eq!(destination.unwrap().profile_name.as_deref(),Some("Qiniu"));
        let task=JobTaskKind::Download{profile_id:"second".into(),profile_revision:"revision-1".into(),bucket:"source".into(),key:"k".into(),local_path:"unused".into(),download_domain:None};
        let (source,destination)=for_task(&task,&profiles);assert_eq!(source.unwrap().bucket,"source");assert!(destination.is_none());
        let task=JobTaskKind::Delete{profile_id:"first".into(),profile_revision:"revision-1".into(),provider:S3Provider::R2,bucket:"source".into(),keys:vec!["a".into(),"b".into()]};
        assert!(for_task(&task,&profiles).0.unwrap().key.is_none());
    }
    #[test]fn old_native_location_keeps_known_identity_without_inventing_labels() {
        let location=for_record(None,"old-profile","old-bucket","old-key");
        assert_eq!(location.profile_id,"old-profile");assert_eq!(location.bucket,"old-bucket");assert_eq!(location.key.as_deref(),Some("old-key"));assert!(location.profile_name.is_none()&&location.provider.is_none());
        assert!(matches_record(Some(&location),"old-profile","old-bucket","old-key"));
        assert!(!matches_record(Some(&location),"other","old-bucket","old-key"));
        assert!(!matches_record(Some(&location),"old-profile","other","old-key"));
        assert!(!matches_record(Some(&location),"old-profile","old-bucket","other"));
        let mut optional=location;optional.profile_name=Some("Renamed\nlabel".into());optional.key=None;
        assert!(matches_record(Some(&optional),"old-profile","old-bucket","old-key"));
    }
}
