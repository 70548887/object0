use std::path::PathBuf;

pub fn object0_config_dir() -> Result<PathBuf, String> {
    let home = if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| "Unable to resolve USERPROFILE/HOME".to_string())?
    } else {
        std::env::var("HOME").map_err(|_| "Unable to resolve HOME".to_string())?
    };

    let mut path = PathBuf::from(home);
    if cfg!(target_os = "macos") {
        path.push("Library");
        path.push("Application Support");
        path.push("object0");
    } else {
        path.push(".config");
        path.push("object0");
    }
    Ok(path)
}

pub fn vault_path() -> Result<PathBuf, String> {
    active_vault_path_at(&object0_config_dir()?)
}
pub(crate) fn active_vault_path_at(directory:&std::path::Path)->Result<PathBuf,String>{
    let plain=directory.join("accounts.local.json");
    // Even an invalid or dangling entry selects plaintext mode and fails
    // closed when loaded; never silently fall back to an older encrypted DB.
    match std::fs::symlink_metadata(&plain) {
        Ok(_)=>Ok(plain),
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Ok(directory.join("vault.enc")),
        Err(_)=>Err("无法检查本地账号文件 / Could not inspect the local account file".into()),
    }
}

pub fn plaintext_accounts_path() -> Result<PathBuf,String>{Ok(object0_config_dir()?.join("accounts.local.json"))}

pub fn favorites_path() -> Result<PathBuf, String> {
    Ok(object0_config_dir()?.join("favorites.json"))
}

pub fn folder_sync_rules_path() -> Result<PathBuf, String> {
    Ok(object0_config_dir()?.join("folder-sync-rules.json"))
}

pub fn folder_sync_records_path(rule_id: &str) -> Result<PathBuf, String> {
    Ok(object0_config_dir()?
        .join("folder-sync")
        .join(format!("{rule_id}.json")))
}

pub fn job_history_path() -> Result<PathBuf, String> {
    Ok(object0_config_dir()?.join("job-history.json"))
}
