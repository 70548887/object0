# 云仓 v1.7.0-preview.2

**Windows x64 预览版 · 2026-11-02**

本版修复上一预览版审计发现的队列账号绑定、目录旧文件残留和重复列表请求问题。仍为预览版，不覆盖 `v1.7.0-preview.1` 或已有 `v1.6.0` 稳定版资产，也不宣称七牛完整适配或所有真实云环境已经验收。

## 下载与本地启动

- `object0_1.7.0-preview.2_windows_x64_setup.exe`：Windows 安装包；按向导安装后，从开始菜单启动云仓。
- `object0_1.7.0-preview.2_windows_x64_portable.zip`：完整解压到可写目录，双击其中的 `object0.exe`；必须保留相邻的完整 `WebView2Runtime` 文件夹，不要在压缩软件中直接运行。
- `SHA256SUMS.txt`：逐项核对下载文件的 SHA256。

包未使用商业代码签名，Windows 可能显示未知发布者。请核对来源与 SHA256，不要关闭系统保护。实际资产以 [GitHub Release](https://github.com/70548887/object0/releases/tag/v1.7.0-preview.2) 列表为准。

## 修复内容

### 1. 排队任务不再悄悄转向修改后的账号

- 复制／移动任务在创建时绑定源、目标账号的 `revision` 和 `provider`，两端身份从同一密码库状态快照读取。
- 目录展开、同步任务生成和排队期间保留已绑定身份；入队和执行前重新核对，不按同一账号 ID 无条件读取新 Endpoint／凭据。
- 账号版本、服务商、可用性发生变化时拒绝旧任务；在创建客户端或发出源／目标请求之前返回错误，要求重新确认。
- 归档下载和队列删除补上相同的账号版本／服务商保护。
- 任务位置仍是创建时的不可变展示快照，不被当作授权依据，也不会改成当前账号来掩盖目标变化。

### 2. 目录切换不再保留可操作的旧文件

- 进入目录、返回目录时立即清除旧文件行、子目录、选择、分页游标、错误及详情／分享／传输目标。
- 迟到的旧列表响应不会覆盖新目录；已移除行的迟到选择回调不能恢复旧选择。
- 同路径导航保持无操作；此前已确认的延迟删除意图仍按原账号、桶和对象快照处理，不偷偷改目标。

### 3. 统一列表加载责任

- `ObjectBrowser` 负责自动列表加载；目录、面包屑、键盘后退、标签和页大小变更不再由多个入口重复请求。
- 自动加载前核对当前账号、桶、目录和活动标签，拒绝陈旧界面 effect；手动刷新和分页功能保留。
- 同一导航模拟场景从两次 `objects:list` 降为一次。

## 数据与升级提醒

**AK/SK 默认明文保存在** `%USERPROFILE%\.config\object0\accounts.local.json`。任何能读取该文件的程序都能读取密钥。发布包不包含真实账号、密钥、密码库或用户任务。

安装版与便携版共享配置，请只运行一个版本，升级前等待任务结束、正常退出旧程序并备份配置。旧加密库保留，可用原云仓密码选择性导入；没有旧密码不能凭空读取旧密文。旧程序可能拒绝新增字段的原生断点记录，不保证降级恢复这些任务。

## 已完成验证与边界

- Rust：**433 项通过、1 项默认忽略**。
- 前端：**284 项通过、1766 次断言、27 组隔离回归通过**。
- TypeScript／Vite、代码检查和 Tauri Windows 生产构建通过。
- 使用相同模拟输入验证目录基线／修复／独立回滚行为，回滚后 422 个原文件哈希一致。
- 本地 HTTP 模拟验证：修改目标账号后，旧复制任务在任何请求前被拒绝；身份未变化的正常复制仍可写入原目标。

这些是本地测试、模拟契约及组件／状态回归，**不是**真实 R2／S3／七牛的完整链路、私有部署、Windows 安装向导、实体拖放或所有便携环境的实机验收。打包和哈希检查不等同于这些功能验收；没有据此宣称 GitHub CI 已通过。

## 保留的限制

- 七牛私有部署未完成真实环境验收；私有云、限定 S3 绑定及临时凭据上传仍未开放。
- 七牛跨空间／跨云复制移动与同步、私有分享创建、私有／S3 持久恢复、递归目录管理、限速、完整预览和受控文本编辑仍未完成。
- 删除型镜像同步保持关闭，本预览版不用于生产迁移或镜像清理。
- 分享和下载仍受域名、证书、权限、测试域名期限及服务端策略影响；生成链接不代表外部可访问性已验证。
- 旧任务缺失的账号信息不猜测回填；目录上传继续使用“上传文件夹”入口。

详见 [README](../README.md) 和 [Windows 使用说明](PORTABLE_ZH.md)。保留 object0 的 MIT 版权与许可；Microsoft WebView2 按随包独立条款分发。

---

# Yuncang v1.7.0-preview.2

**Windows x64 preview · 2026-11-02**

This preview fixes account binding for queued jobs, actionable stale folder rows and duplicate listings found in the previous release audit. It does not replace `v1.7.0-preview.1` or stable `v1.6.0` assets. It is not a complete Qiniu implementation or proof of acceptance across real cloud deployments.

## Downloads and local startup

- `object0_1.7.0-preview.2_windows_x64_setup.exe`: install using the wizard, then launch Yuncang from the Start menu.
- `object0_1.7.0-preview.2_windows_x64_portable.zip`: extract the entire archive into a writable folder and run `object0.exe`. Keep the complete adjacent `WebView2Runtime` directory; do not run inside an archive viewer.
- `SHA256SUMS.txt`: compare each asset's SHA256.

Packages are not commercially code-signed. Verify the source and checksums without disabling Windows protection. The [GitHub Release asset list](https://github.com/70548887/object0/releases/tag/v1.7.0-preview.2) is authoritative.

## Fixes

1. **Queued account identity:** copy/move capture both account revisions and providers from one vault snapshot and retain them across directory expansion, sync generation and queueing. Admission and execution reject changed, removed or unavailable accounts before clients or requests are created. Archive downloads and queued deletes receive equivalent guards. Immutable display locations remain separate from authorization; current account labels are never substituted to hide retargeting.
2. **Folder transitions:** enter/back navigation immediately clears old objects, prefixes, selection, pagination, errors and detail/share/transfer targets. Late listings cannot overwrite the new folder, and old row callbacks cannot revive removed selections. Same-prefix navigation is a no-op. Previously confirmed delayed deletions retain their original immutable target.
3. **One automatic listing owner:** `ObjectBrowser` handles folder, breadcrumb, keyboard-back, tab and page-size changes, checking the current scope before automatic loading. Manual refresh and pagination remain available. The same navigation fixture now issues one list request instead of two.

## Data and upgrade warning

**AK/SK are saved in plaintext by default** in `%USERPROFILE%\.config\object0\accounts.local.json`. Anyone able to read that file can read its keys. Packages contain no real accounts, credentials, vault or user jobs. Installer and portable editions share settings; finish transfers, exit the old application and back up configuration before changing versions. Run only one edition at a time. Old encrypted vaults remain available for optional import with the original passphrase; missing passwords cannot decrypt them. Older executables may reject newer native checkpoint fields, so downgrade recovery is not guaranteed.

## Verification and limits

Local checks passed **433 Rust tests with one ignored**, **284 frontend tests / 1766 assertions / 27 isolated regression groups**, code checks, TypeScript/Vite and Tauri Windows production builds. Identical navigation fixtures were observed before repair, after repair and after isolated rollback; all 422 original file hashes matched after rollback. Loopback HTTP tests reject an edited destination before any request while allowing an unchanged-identity copy to the original destination.

These are local fixture, mock-contract and component/store results, not end-to-end acceptance of real R2/S3/Qiniu accounts, private deployments, Windows installer wizard flows, physical Explorer drag/drop or every portable environment. Packaging/hash checks are separate. No GitHub CI success is claimed from local results.

Private Qiniu deployments remain unverified in real environments. Private/binding/temporary-credential uploads, Qiniu cross-bucket/cross-cloud transfer/sync, private share creation, private/S3 durable recovery, recursive directory management, rate limiting, complete preview and controlled text editing remain incomplete. Destructive mirror sync stays disabled; do not use this preview for production migration or mirror cleanup. Domains, certificates, permissions and server policies can still prevent a generated link from working. Missing historical account metadata is not guessed; use Upload Folder for directories.

See the [README](../README.en.md) and [Windows guide](PORTABLE_EN.md). Upstream object0 MIT copyright notices remain intact; Microsoft WebView2 is redistributed under the included separate terms.
