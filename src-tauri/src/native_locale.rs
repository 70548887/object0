//! UI language only. Account IDs, credential services and data paths remain stable.
use std::sync::atomic::{AtomicBool, Ordering};
static ENGLISH: AtomicBool = AtomicBool::new(false);

pub(crate) fn english() -> bool { ENGLISH.load(Ordering::Relaxed) }
pub(crate) fn text<'a>(zh: &'a str, en: &'a str) -> &'a str { if english() { en } else { zh } }
pub(crate) fn app_name() -> &'static str { text("云仓", "Yuncang") }
fn parse(value: &str) -> Result<bool, String> {
    match value { "zh-CN" => Ok(false), "en" => Ok(true), _ => Err("Unsupported language".to_string()) }
}
pub(crate) fn initialize() {
    let saved = super::config_paths::object0_config_dir().ok().map(|dir| dir.join("ui-language.json"));
    if let Some(path) = saved {
        if std::fs::metadata(&path).is_ok_and(|meta| meta.len() <= 1024) {
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    if let Some(locale) = value.get("locale").and_then(serde_json::Value::as_str) {
                        ENGLISH.store(parse(locale).unwrap_or(false), Ordering::Relaxed);
                    }
                }
            }
        }
    }
}
pub(crate) fn set(locale: &str) -> Result<(), String> {
    let english = parse(locale)?;
    let dir = super::config_paths::object0_config_dir()?;
    std::fs::create_dir_all(&dir).map_err(|_| "Could not save language preference".to_string())?;
    let payload = serde_json::to_vec(&serde_json::json!({"locale":locale})).map_err(|_| "Invalid language preference".to_string())?;
    super::util::write_atomic(&dir.join("ui-language.json"), &payload)?;
    ENGLISH.store(english, Ordering::Relaxed);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::parse;
    #[test] fn only_supported_language_identifiers_are_accepted() {
        assert_eq!(parse("zh-CN").unwrap(), false);
        assert_eq!(parse("en").unwrap(), true);
        assert!(parse("../../vault.enc").is_err());
        assert!(parse("en-US").is_err());
    }
    #[test] fn native_display_names_follow_the_selected_language() {
        use super::{ENGLISH, Ordering, app_name};
        let previous = ENGLISH.swap(false, Ordering::Relaxed);
        assert_eq!(app_name(), "云仓");
        ENGLISH.store(true, Ordering::Relaxed);
        assert_eq!(app_name(), "Yuncang");
        ENGLISH.store(previous, Ordering::Relaxed);
    }
}
