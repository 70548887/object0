# 云仓 v1.7.0-preview.1

**Windows x64 预览版 · 2026-11-02**

本版集中提供七牛 Kodo 适配预览、多账号／多空间桌面管理、文件分享改进和拖拽上传。它不覆盖已有 v1.6.0 稳定版资产，也不将七牛未完成能力描述为完整适配。

## 下载内容

- `object0_1.7.0-preview.1_windows_x64_setup.exe`：Windows 安装包。
- `object0_1.7.0-preview.1_windows_x64_portable.zip`：完整解压即可运行，包含固定 WebView2 运行时。
- `SHA256SUMS.txt`：下载完整性校验。

包未使用商业代码签名，Windows 可能显示未知发布者。请核对来源与 SHA256，不要关闭系统保护。发行资产以 [GitHub Release](https://github.com/70548887/object0/releases/tag/v1.7.0-preview.1) 实际列出的文件为准。

## 主要更新

- 统一选择 8 种连接类型：七牛 Kodo、Cloudflare R2、Amazon S3、DigitalOcean Spaces、MinIO、Google Cloud Storage 的 S3 互操作接口、Backblaze B2、自定义 S3 兼容服务。
- 多账号及每账号多个空间／桶切换、目录浏览、文件详情和现有 S3 文件管理。
- 七牛普通公有云 AK/SK 一键连接；按空间解析区域，保留原生名与 S3 标识映射。
- 七牛公有原生大文件持久分片上传、暂停／手动恢复；原生 Range 下载、目录只读分享、分类用量统计接入应用链路。
- 文件外链支持对应空间的源站／CDN／测试域名，默认选首个可用项；区分公开直链与私有限时签名，不给公开资源虚构强制到期时间。
- 电脑多文件拖入桶内容区和下方空白处，直接上传到当前目录；目标变化保护、重复事件去重及后端普通文件检查。
- 修复忙时第二次拖入被静默忽略，以及原生监听部分注册失败后残留回调／拖拽浮层卡住的问题。
- 任务保存创建时的账号、服务商、桶和完整对象路径，支持查看与复制。切换或重命名账号不改写历史快照；旧缺失信息不猜测补填。
- R2 连接建立等待提高到 15 秒，不给大文件读取或整体传输设置 15 秒短限制；不承诺它能解决所有网络故障。
- 默认简体中文，可切换 English；README 与 Windows 指南同步提供中英版本。

## 凭据与升级提醒

**本版默认明文保存 AK/SK**：`%USERPROFILE%\.config\object0\accounts.local.json`。能读取文件的程序可读取密钥。安装包和 ZIP 不包含任何真实账号、密钥或用户任务。

旧加密库原文件保留，可用原云仓密码一次性导入或跳过；没有旧密码时不能读取旧密文，不强制恢复密钥，不通过删库解除导入问题。
安装与便携版共享配置，请只运行一个版本，升级前完成任务并备份配置。新版可读旧任务；旧程序可能拒绝新增字段的原生断点记录，不保证降级恢复这些新任务。

## 验证范围

最近功能阶段已在本地执行并通过：

- Rust：**428 项通过，1 项默认忽略**。
- 前端：**284 项、1766 次断言、26 组隔离回归通过**。
- TypeScript／Vite 与 Tauri Windows 生产构建；独立源码回滚和关键行为前后对照。

上述测试主要使用合成凭据、本地 HTTP fixture、模拟原生拖放和组件／状态回归。它们**不是**所有真实公有云／私有云的完整链路、所有 Windows 安装环境或实体资源管理器拖放的验收证明。发行过程的打包／哈希检查与软件功能实机验收是不同边界；以发布记录中实际完成的检查为准，不预先宣称所有 CI 已通过。

## 已知限制

- 七牛私有部署未完成真实环境验收，受限身份与 Session Token 能力取决于明确配置和实际权限；私有云、限定 S3 绑定和临时凭据上传尚未开放。
- 七牛跨桶／跨云复制移动与同步、私有分享创建、私有／S3 持久传输恢复、递归目录管理、限速、完整预览和受控文本编辑仍未完成。
- 删除型镜像同步保持关闭。本预览版不用于生产数据迁移或镜像清理。
- 真实域名绑定、证书、访问规则、测试域名期限及文件限制可能影响外链；链接生成成功不等于外部可访问性已验证。
- 旧任务未记录的账号信息无法可靠回填；不根据相同桶名或当前选中账号推断。
- 本版保留现有远端同名对象上传策略；目录请使用已有“上传文件夹”入口，而不是拖入后默认递归。

详见 [README](../README.md)、[Windows 使用说明](PORTABLE_ZH.md) 和各功能文档。基于 object0，保留 MIT 许可证及原版权声明；WebView2 按随包独立条款分发。

---

# Yuncang v1.7.0-preview.1

**Windows x64 preview · 2026-11-02**

This preview adds Qiniu Kodo workflows, multi-account/bucket desktop management, file-link improvements and native file drag/drop. Existing stable v1.6.0 assets are not replaced. It is not a complete Qiniu console or universal deployment-compatibility claim.

## Assets

- `object0_1.7.0-preview.1_windows_x64_setup.exe`: Windows installer.
- `object0_1.7.0-preview.1_windows_x64_portable.zip`: extract the complete archive and run; fixed WebView2 is included.
- `SHA256SUMS.txt`: download integrity checksums.

Packages are not commercially code-signed. Verify source and SHA256 without disabling Windows protection. The actual [GitHub Release asset list](https://github.com/70548887/object0/releases/tag/v1.7.0-preview.1) is authoritative for downloads.

## Highlights

- Eight provider choices, independent accounts and bucket tabs, with Google Cloud Storage using S3 interoperability/HMAC rather than OAuth.
- Public native Qiniu AK/SK connection, per-bucket regions and native/S3 identity mapping; durable multipart uploads, manual resume, Range downloads, public read-only directory sharing and classified usage workflows.
- Bucket-associated origin/CDN/test-domain file links, first-available default selection, explicit HTTP warnings and correct public versus expiring signed-link behavior.
- Multiple computer files dropped onto the current bucket/folder content area; stale-target checks, native/DOM deduplication and backend regular-file validation.
- Busy second-drop feedback and atomic native-listener setup/cleanup fixes.
- Immutable job source/destination metadata: account, provider, bucket and full object path, with Copy location. Missing old metadata is not guessed.
- R2 connection-establishment timeout extended to 15 seconds, without a 15-second whole-transfer/read cap. This is not a guarantee that every network problem is solved.
- Chinese by default, switchable English, with matching documentation.

## Data and verification

**AK/SK are stored in plaintext by default** in `%USERPROFILE%\.config\object0\accounts.local.json`. Anyone who can read that file can read its keys. Packages include no real accounts, credentials or user jobs. Old encrypted vaults are retained for optional one-time import with the original passphrase or may be skipped; recovery keys are not mandatory. Back up settings and run only one edition at a time. Older executables may reject new native checkpoint fields; downgrade recovery is not guaranteed.

Latest feature-stage local verification passed **428 Rust tests with one ignored**, plus **284 frontend tests, 1766 assertions and 26 isolated regression groups**, TypeScript/Vite and Tauri Windows production builds, and isolated source rollback checks. These use fixture credentials, loopback HTTP, simulated native events and component/store tests. They do not prove real-cloud end-to-end acceptance, every Windows installation path or physical Explorer drag/drop. Packaging/hash verification is separate; no claim is made in advance that every CI run has passed.

## Limitations

Private Qiniu deployments have not completed real-environment acceptance. Private/binding/temporary-credential uploads remain unavailable. Qiniu cross-bucket/cross-cloud transfer/sync, private share creation, private/S3 durable transfer recovery, recursive directory management, rate limiting, complete preview and controlled text editing are unfinished. Destructive mirror synchronization remains disabled; do not use this preview for production migrations or mirror cleanup. Domain/certificate/access policies can still invalidate a generated link. Old account metadata cannot be reconstructed reliably, and remote same-name upload behavior is unchanged.

See the [README](../README.en.md) and [Windows guide](PORTABLE_EN.md). Upstream object0 MIT copyright notices are preserved; Microsoft WebView2 is redistributed under its included separate terms.
