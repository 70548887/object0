//! Require an explicit update feed and signing key for this customized build.

pub(super) const LOCAL_UPDATES_DISABLED: &str =
    "本地定制版已停用自动更新，请手动安装定制版新版本。";

pub(super) fn require_custom_update_source(
    has_endpoints: bool,
    has_signing_key: bool,
) -> Result<(), &'static str> {
    match (has_endpoints, has_signing_key) {
        (true, true) => Ok(()),
        (false, false) => Err(LOCAL_UPDATES_DISABLED),
        _ => Err("定制版更新配置不完整，需要同时设置专用更新源和签名公钥。"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_build_without_override_stays_disabled() {
        assert_eq!(require_custom_update_source(false, false), Err(LOCAL_UPDATES_DISABLED));
    }

    #[test]
    fn endpoint_alone_never_reuses_bundled_upstream_key() {
        assert!(require_custom_update_source(true, false).is_err());
    }

    #[test]
    fn key_alone_never_reuses_bundled_upstream_feed() {
        assert!(require_custom_update_source(false, true).is_err());
    }

    #[test]
    fn explicit_feed_and_key_enable_custom_updates() {
        assert_eq!(require_custom_update_source(true, true), Ok(()));
    }
}
