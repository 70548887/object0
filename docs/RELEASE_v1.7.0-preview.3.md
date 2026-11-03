# 云仓 / Yuncang v1.7.0-preview.3

## 简体中文

本预览发布到 [70548887/object0](https://github.com/70548887/object0/releases/tag/v1.7.0-preview.3)，是相对 preview.2 的累积更新，不覆盖 stable v1.6.0 或 preview.2 的旧发布资产。云仓基于 [sayedhfatimi/object0](https://github.com/sayedhfatimi/object0)，保留 MIT 许可证和上游版权声明。

### Windows x64 下载与手动升级

- [安装包](https://github.com/70548887/object0/releases/download/v1.7.0-preview.3/object0_1.7.0-preview.3_windows_x64_setup.exe)
- [便携 ZIP](https://github.com/70548887/object0/releases/download/v1.7.0-preview.3/object0_1.7.0-preview.3_windows_x64_portable.zip)
- [SHA256SUMS.txt](https://github.com/70548887/object0/releases/download/v1.7.0-preview.3/SHA256SUMS.txt)

适用于 Windows 10／11 x64。先备份配置，保存草稿、等待传输结束、停止同步并退出所有旧实例，再安装或完整解压替换。便携包保留与 `object0.exe` 相邻的完整 `WebView2Runtime`，不能只取出或覆盖一个 EXE。账号不随 ZIP 携带，安装版与便携版共享本机配置。

**本次没有专用软件更新签名配置，自动下载／安装不可用，只提供检测及手动升级。** 更新界面的稳定／预览选择和实际版本展示不等于可用的在线升级。软件验签失败保持关闭，不能用未签名附件绕过。Windows 安装包没有商业 Authenticode 签名，可能显示“未知发布者”；请核对仓库来源和 SHA256，不要关闭系统保护。软件更新签名与 Windows 发布者签名是两回事。

### 相对 preview.2 的变化

- 空白区右键菜单提供刷新、新建目录、`.txt`／`.md` 文本。目录操作沿用服务商／身份权限限制，不能推断所有七牛身份均可用。
- 文本限 1 MiB UTF-8，允许 `txt`／`md`／`markdown`。七牛文本创建／编辑暂不开放；S3 兼容连接新建必须获得服务端条件创建支持，同名不覆盖。已有文本编辑仅 R2 开放，条件保存发现版本冲突时保留草稿，不退回无条件覆盖。未保存草稿仅在内存中，退出前请保存。
- 全宽标题与紧凑侧栏，地址在操作栏上方，保留响应式布局修复。收藏、最近、传输和分享记录可在主列表展示；任务保留创建时的账号、服务商、桶和完整对象路径，旧任务缺失字段仍显示未记录。
- 分享历史保存默认关闭，用户主动开启后才保存；打开历史不会自动清理过期记录，可手动清理，顶部分享 Sheet 继续保留。
- 更新检测界面显示实际编译版本及稳定／预览通道，手动检查不自动下载；可选每日检查默认关闭。取消后迟到的 ready 事件不能恢复旧安装按钮。
- 保留移动任务账号 revision／路径检查、账号变化后拒绝旧任务、目录切换清旧目标及避免重复自动列表请求等保护。

### 能力与验证边界

本次发布候选的本地代码回归：前端 **286 项测试、1779 次断言通过，另有 36 组隔离回归通过**；Rust **467 项通过、2 项忽略**。命令、输出、构建及包哈希另保留在发布验证记录中。这些结果不等于所有云／Windows 实机验收，也不代表 GitHub CI；本次未运行 GitHub CI。

专用更新签名、原生签名实际升级完整链路、多机器安装和目标私有云部署仍待验收。普通文件 I/O 失败回滚测试不证明断电／强杀后的崩溃一致性。七牛的私有分享创建、私有／S3 持久恢复、跨空间／跨云复制移动同步、递归目录管理、限速、完整预览与受控文本编辑仍不完整；绑定模式、私有云和临时凭据上传尚未开放，删除型镜像同步保持关闭。七牛链接仍受域名、证书、测试域名期限和服务端策略限制，公开直链不能由客户端强制过期，生成链接不代表外部访问已验收。

**AK/SK 默认明文保存在 `%USERPROFILE%\.config\object0\accounts.local.json`**。可读该文件的程序即可读取凭据；不要共享、提交或随发布包分发。保留旧 `vault.enc` 作为可选导入来源，不删除账号／任务文件强行降级。请先在独立测试空间验证，不对生产数据执行镜像清理。

详见 [中文 README](../README.md)、[Windows 使用说明](PORTABLE_ZH.md) 与 [更新边界](UPDATER.md)。WebView2 使用独立许可，随包提供；上游 MIT 来源声明保持不变。

## English

This cumulative preview since preview.2 is published to [70548887/object0](https://github.com/70548887/object0/releases/tag/v1.7.0-preview.3). It does not replace existing stable v1.6.0 or preview.2 release assets. Yuncang is based on [sayedhfatimi/object0](https://github.com/sayedhfatimi/object0), preserving its MIT license and copyright notices.

### Windows x64 downloads and manual upgrades

- [Installer](https://github.com/70548887/object0/releases/download/v1.7.0-preview.3/object0_1.7.0-preview.3_windows_x64_setup.exe)
- [Portable ZIP](https://github.com/70548887/object0/releases/download/v1.7.0-preview.3/object0_1.7.0-preview.3_windows_x64_portable.zip)
- [SHA256SUMS.txt](https://github.com/70548887/object0/releases/download/v1.7.0-preview.3/SHA256SUMS.txt)

Windows 10/11 x64. Back up settings, save drafts, finish transfers, stop sync and exit every old instance before installation or full extraction/replacement. Keep the complete adjacent `WebView2Runtime` with `object0.exe`; do not extract or replace only the EXE. Accounts do not travel with the ZIP, and installer/portable editions share local configuration.

**There is no dedicated software-update signing configuration in this release. Automatic download/installation is unavailable; check versions and upgrade manually.** Stable/preview controls and actual-version display are not a usable online-upgrade service. Signature failures remain fail-closed; unsigned attachments cannot bypass this. Windows packages are not commercially Authenticode-signed and may show an unknown publisher. Verify the source and SHA256 without disabling system protection. Updater signatures and Windows publisher signatures are separate.

### Changes since preview.2

- The blank-space context menu offers refresh, folder creation and `.txt` / `.md` creation. Folder operations retain provider/identity restrictions; not every Qiniu identity is guaranteed to support them.
- Text is limited to 1 MiB UTF-8 and `txt` / `md` / `markdown` extensions. Qiniu text creation/editing is unavailable. S3-compatible creation requires server-side conditional create and never overwrites an existing name. Editing existing text is R2-only: conditional saves retain drafts on version conflicts and never fall back to unconditional overwrite. Unsaved drafts live only in memory; save before exiting.
- A full-width title, compact sidebar and address above the action bar, retaining responsive fixes. Favorites, recent items, transfers and share history can appear in the main list. Jobs retain captured account, provider, bucket and full object path; absent old fields remain explicitly unrecorded.
- Share-history persistence is off by default and requires opt-in. Opening history never automatically removes expired records; cleanup is manual. The top sharing Sheet remains available.
- Update checks show the actual compiled version and stable/preview channels; checks do not automatically download. Optional daily checking is off by default. Late ready events after cancellation cannot restore the old install button.
- Retains move account-revision/path checks, stale-job rejection after account changes, clearing old targets on navigation and avoiding duplicate automatic listings.

### Scope and verification limits

This release candidate passed **286 frontend tests with 1779 assertions**, **36 additional isolated regression groups**, and **467 Rust tests with two ignored** locally. Commands, output, builds and package hashes are retained in the release verification records. These results are not universal cloud/Windows acceptance and do not imply GitHub CI; no GitHub CI run is claimed for this release.

Dedicated updater signing, native signed real-upgrade flows, multi-machine installation and target private-cloud deployments still require acceptance. Ordinary-I/O rollback tests do not establish power-loss/forced-termination crash consistency. Qiniu private share creation, private/S3 durable recovery, cross-bucket/cross-cloud copy/move/sync, recursive directory management, rate limiting, full preview and controlled text editing remain incomplete. Binding-mode/private-cloud/temporary-credential uploads remain unavailable; destructive mirror sync stays disabled. Links still depend on domains, certificates, test-domain expiry and server policies. Public URLs cannot be made to expire by the client, and URL creation is not verified external accessibility.

**AK/SK are saved in plaintext by default in `%USERPROFILE%\.config\object0\accounts.local.json`.** Any program able to read that file can read credentials. Never share, commit or bundle account files. Old `vault.enc` stays available for optional import; do not delete account/job files to force a downgrade. Validate in a dedicated test bucket and never use this preview for production mirror cleanup.

See the [English README](../README.en.md), [Windows guide](PORTABLE_EN.md) and [updater boundaries](UPDATER.md). WebView2 has separate terms included with packages; upstream MIT attribution is unchanged.
