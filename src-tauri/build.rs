fn main() {
    for name in ["YUNCANG_UPDATER_PUBLIC_KEY", "YUNCANG_BUILD_HASH", "YUNCANG_BUILD_KIND", "YUNCANG_PACKAGE_KIND"] {
        println!("cargo:rerun-if-env-changed={name}");
        let value = std::env::var(name).unwrap_or_default();
        // Compile-time public metadata only. Never read a signing private key.
        if !value.contains(['\r', '\n']) { println!("cargo:rustc-env={name}={value}"); }
    }
    tauri_build::build()
}
