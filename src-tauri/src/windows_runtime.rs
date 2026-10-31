//! Prepare only the adjacent fixed WebView2 runtime on Windows 10.
//!
//! Microsoft requires app-container read/execute access for Fixed Runtime 120+
//! in unpackaged Win32 apps on Windows 10. We check three known paths on every
//! launch instead of trusting a marker that can become stale after re-extraction.
//! No global permissions, policy, sandbox flags, or user credentials are changed.

const APP_CONTAINER_SIDS: [&str; 2] = ["S-1-15-2-2", "S-1-15-2-1"];
const FILE_GENERIC_READ: u32 = 0x0012_0089;
const FILE_GENERIC_EXECUTE: u32 = 0x0012_00a0;

fn requires_acl_initialization(major: u32, build: u32) -> bool {
    major == 10 && build < 22_000
}

fn has_read_execute(mask: u32) -> bool {
    const GENERIC_ALL: u32 = 0x1000_0000;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_EXECUTE: u32 = 0x2000_0000;
    mask & GENERIC_ALL != 0
        || ((mask & GENERIC_READ != 0 || mask & FILE_GENERIC_READ == FILE_GENERIC_READ)
            && (mask & GENERIC_EXECUTE != 0
                || mask & FILE_GENERIC_EXECUTE == FILE_GENERIC_EXECUTE))
}

/// Runs before Tauri creates the first browser environment. Failure is visible
/// even for a Windows release executable without an attached console.
pub(crate) fn initialize() -> bool {
    #[cfg(windows)]
    if let Err(message) = windows::prepare() {
        eprintln!("object0 fixed WebView2 runtime initialization failed");
        #[cfg(not(test))]
        windows::show_error(message);
        #[cfg(test)]
        let _ = message;
        return false;
    }
    true
}

#[cfg(windows)]
mod windows {
    use super::{has_read_execute, requires_acl_initialization, APP_CONTAINER_SIDS};
    use std::{
        ffi::{c_void, OsStr, OsString},
        fs,
        os::windows::{ffi::{OsStrExt, OsStringExt}, fs::MetadataExt, process::CommandExt},
        path::{Component, Path, PathBuf, Prefix},
        process::{Command, Stdio},
    };

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const SE_FILE_OBJECT: u32 = 1;
    const DACL_SECURITY_INFORMATION: u32 = 4;
    const DRIVE_REMOTE: u32 = 4;

    #[repr(C)]
    struct OsVersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }

    #[repr(C)]
    struct Trustee {
        multiple: *mut c_void,
        operation: u32,
        form: u32,
        kind: u32,
        name: *mut u16,
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfo) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, length: u32) -> u32;
        fn GetDriveTypeW(root: *const u16) -> u32;
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn ConvertStringSidToSidW(text: *const u16, sid: *mut *mut c_void) -> i32;
        fn GetNamedSecurityInfoW(
            name: *const u16, object_type: u32, information: u32,
            owner: *mut *mut c_void, group: *mut *mut c_void,
            dacl: *mut *mut c_void, sacl: *mut *mut c_void,
            descriptor: *mut *mut c_void,
        ) -> u32;
        fn GetEffectiveRightsFromAclW(acl: *mut c_void, trustee: *mut Trustee, rights: *mut u32) -> u32;
    }

    #[cfg(not(test))]
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(window: *mut c_void, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }

    struct LocalMemory(*mut c_void);
    impl Drop for LocalMemory {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // The Win32 APIs above allocate these buffers with LocalAlloc.
                unsafe { LocalFree(self.0); }
            }
        }
    }

    fn wide(text: impl AsRef<OsStr>) -> Vec<u16> {
        text.as_ref().encode_wide().chain(Some(0)).collect()
    }

    pub(super) fn show_error(message: &str) {
        #[cfg(not(test))]
        unsafe {
            MessageBoxW(std::ptr::null_mut(), wide(message).as_ptr(), wide("object0 运行环境未就绪").as_ptr(), 0x10);
        }
        #[cfg(test)]
        let _ = message;
    }

    fn windows_version() -> Result<(u32, u32), &'static str> {
        let mut info = OsVersionInfo {
            size: std::mem::size_of::<OsVersionInfo>() as u32,
            major: 0, minor: 0, build: 0, platform: 0, service_pack: [0; 128],
        };
        // RtlGetVersion is not affected by compatibility-manifest version lies.
        if unsafe { RtlGetVersion(&mut info) } != 0 {
            return Err("无法确认 Windows 运行环境，请重新启动程序；问题持续时请联系发布者。");
        }
        Ok((info.major, info.build))
    }

    fn is_unc(path: &Path) -> bool {
        matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..)))
    }

    fn is_remote_drive(path: &Path) -> bool {
        let Some(Component::Prefix(prefix)) = path.components().next() else { return false };
        let drive = match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            _ => return false,
        };
        let root = wide(format!("{}:\\", drive as char));
        unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_REMOTE }
    }

    fn has_container_access(path: &Path, sid_text: &str) -> bool {
        let name = wide(path);
        let mut descriptor = std::ptr::null_mut();
        let mut dacl = std::ptr::null_mut();
        let status = unsafe {
            GetNamedSecurityInfoW(name.as_ptr(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(), std::ptr::null_mut(), &mut dacl,
                std::ptr::null_mut(), &mut descriptor)
        };
        let _descriptor = LocalMemory(descriptor);
        if status != 0 { return false; }
        // A null DACL grants full access. We do not create or weaken a DACL.
        if dacl.is_null() { return true; }
        let mut sid = std::ptr::null_mut();
        if unsafe { ConvertStringSidToSidW(wide(sid_text).as_ptr(), &mut sid) } == 0 { return false; }
        let _sid = LocalMemory(sid);
        let mut trustee = Trustee {
            multiple: std::ptr::null_mut(), operation: 0, form: 0,
            kind: 5, name: sid.cast(), // TRUSTEE_IS_SID / WELL_KNOWN_GROUP
        };
        let mut rights = 0;
        (unsafe { GetEffectiveRightsFromAclW(dacl, &mut trustee, &mut rights) == 0 })
            && has_read_execute(rights)
    }

    fn runtime_accessible(paths: &[PathBuf]) -> bool {
        paths.iter().all(|path| APP_CONTAINER_SIDS.iter().all(|sid| has_container_access(path, sid)))
    }

    fn system_icacls() -> Result<PathBuf, &'static str> {
        let mut buffer = vec![0u16; 260];
        let mut size = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if size as usize >= buffer.len() {
            buffer.resize(size as usize + 1, 0);
            size = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        }
        if size == 0 || size as usize >= buffer.len() {
            return Err("无法找到 Windows 自带的权限初始化工具，请检查系统完整性。");
        }
        Ok(PathBuf::from(OsString::from_wide(&buffer[..size as usize])).join("icacls.exe"))
    }

    pub(super) fn prepare() -> Result<(), &'static str> {
        let executable = std::env::current_exe()
            .map_err(|_| "无法识别程序目录，请将完整便携包解压到本地目录后再运行。")?;
        let parent = executable.parent().ok_or("无法识别程序目录，请重新完整解压便携包。")?;
        let runtime = parent.join("WebView2Runtime");
        let metadata = match fs::symlink_metadata(&runtime) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err("无法读取运行环境目录，请将完整便携包解压到你拥有权限的本地目录。"),
        };
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("运行环境目录不是普通本地文件夹，请重新完整解压官方便携包。");
        }
        if is_unc(&runtime) || is_remote_drive(&runtime) {
            return Err("固定 WebView2 运行环境不支持网络或共享目录，请将完整便携包解压到本地磁盘后再运行。");
        }
        let runtime = runtime.canonicalize()
            .map_err(|_| "无法读取运行环境目录，请重新完整解压便携包。")?;
        let exe_parent = parent.canonicalize()
            .map_err(|_| "无法确认程序所在目录，请重新完整解压便携包。")?;
        if runtime.parent() != Some(exe_parent.as_path()) {
            return Err("运行环境目录不在程序旁，请重新完整解压官方便携包。");
        }
        let paths = vec![runtime.clone(), runtime.join("msedgewebview2.exe"), runtime.join("msedge.dll")];
        if !paths[1..].iter().all(|path| path.is_file()) {
            return Err("运行环境文件缺失，请将官方便携压缩包中的全部文件解压后再运行。");
        }
        let (major, build) = windows_version()?;
        if !requires_acl_initialization(major, build) || runtime_accessible(&paths) { return Ok(()); }

        // The only writes are Microsoft's documented inheritable RX grants on
        // the adjacent runtime folder. No shell, recursion option, elevation,
        // global ACL, security policy, or sandbox-disabling argument is used.
        let icacls = system_icacls()?;
        for sid in APP_CONTAINER_SIDS {
            let success = Command::new(&icacls)
                .arg(&runtime).arg("/grant").arg(format!("*{sid}:(OI)(CI)(RX)"))
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW).status().map(|status| status.success()).unwrap_or(false);
            if !success {
                return Err("当前目录不允许初始化运行环境。请将完整便携包解压到你拥有且可写的本地目录，然后重新运行；无需修改系统安全设置。");
            }
        }
        if !runtime_accessible(&paths) {
            return Err("运行环境的读取或执行权限未就绪。请重新完整解压到你拥有且可写的本地目录，然后重新运行。");
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn unc_detection_does_not_reject_verbatim_local_drives() {
            assert!(is_unc(Path::new(r"\\server\share\app\WebView2Runtime")));
            assert!(is_unc(Path::new(r"\\?\UNC\server\share\app\WebView2Runtime")));
            assert!(!is_unc(Path::new(r"C:\app\WebView2Runtime")));
            assert!(!is_unc(Path::new(r"\\?\C:\app\WebView2Runtime")));
        }
        #[test]
        fn acl_checks_fail_closed_for_missing_files() {
            assert!(!has_container_access(Path::new(r"C:\nonexistent-object0-runtime-test\missing.dll"), APP_CONTAINER_SIDS[0]));
        }
        #[test]
        fn system_tool_path_is_absolute_and_not_path_searched() {
            let path = system_icacls().expect("Windows system directory");
            assert!(path.is_absolute());
            assert_eq!(path.file_name().unwrap(), "icacls.exe");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_11_and_other_versions_do_not_need_acl_writes() {
        assert!(requires_acl_initialization(10, 19_045));
        assert!(!requires_acl_initialization(10, 22_000));
        assert!(!requires_acl_initialization(10, 26_100));
        assert!(!requires_acl_initialization(6, 9_600));
    }
    #[test]
    fn only_two_microsoft_documented_container_sids_are_granted() {
        assert_eq!(APP_CONTAINER_SIDS, ["S-1-15-2-2", "S-1-15-2-1"]);
    }
    #[test]
    fn access_test_requires_both_read_and_execute() {
        assert!(has_read_execute(FILE_GENERIC_READ | FILE_GENERIC_EXECUTE));
        assert!(has_read_execute(0xa000_0000));
        assert!(has_read_execute(0x1000_0000));
        assert!(!has_read_execute(FILE_GENERIC_READ));
        assert!(!has_read_execute(FILE_GENERIC_EXECUTE));
        assert!(!has_read_execute(0));
    }
}
