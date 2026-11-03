# 云仓 GitHub 更新模块 / GitHub updater

适用 `v1.7.0-preview.3`。本次提供版本检测界面和签名失败关闭的实现，**未配置云仓专用更新签名公钥／发布签名，因此自动下载、自动安装不可用，仅支持检测和手动升级**。旧 `v1.7.0-preview.2` 发布资产也不会因此自动获得升级功能。以下下载／安装实现说明及签名配置步骤不是“已可用在线升级”或实机验收声明。

## 本次手动升级 / Manual upgrade for this preview

从 [70548887/object0 的 preview.3 发布页](https://github.com/70548887/object0/releases/tag/v1.7.0-preview.3) 下载匹配的安装包或便携 ZIP 和 `SHA256SUMS.txt`，逐项核对。保存草稿、等待传输结束、停止同步并正常退出所有旧实例后，再安装或完整解压替换，保留整个 `WebView2Runtime`。不要只覆盖 EXE，也不要把账号文件放进包中。此版不会覆盖 stable v1.6.0 或 preview.2 的发布资产；本地安装／配置仍须先备份。

This preview supports update checks and manual upgrades only. No dedicated updater trust key/signature configuration is supplied, so automatic download/installation stays blocked. Download matching assets and checksums from the release page above, verify SHA256, save drafts, finish transfers/sync and exit all old instances before installing or fully extracting the replacement. Keep the complete runtime. A Windows unknown-publisher warning and software-update signature verification are separate matters; neither is bypassed by disabling system protection.

## 使用

- 设置「关于与更新」或底栏版本入口显示实际编译版本、构建号、发布/开发构建、安装类型和最近更新结果。
- 稳定/预览按 SemVer 选择，不自动降级；检查不会自动下载。可选每天最多检查一次，默认关闭。
- 下载固定到一次检测的版本、平台、类型、URL、大小、摘要与签名。取消/重试或切换通道不能让迟到事件恢复旧安装按钮。
- 下载流式写本地缓存，完整下载后真实验签。失败重试会重新下载；当前不宣称支持断点续传。
- 安装前须保存/关闭文本草稿、完成传输、停止同步并退出其他云仓实例。不会强杀旧窗口，也不会假设所有任务均可恢复。
- 安装版使用 Tauri/NSIS；便携版使用当前可信程序的独立助手模式，在程序退出后按发行清单替换，保留旧文件备份，普通文件操作失败时恢复旧文件。
- 本次发布构建没有专用发布公钥：仍可检测 GitHub，但自动下载/安装保持 blocked 并显示原因。不要用任意未签名附件绕过这个限制。

## 正式启用前的发布配置

1. 在受控发布环境生成云仓专用 Tauri/minisign 签名密钥。公钥与私钥不同，私钥及密码不得提交源码、日志、用户账号配置或发布包。
2. 仓库 `70548887/object0` 设置公开变量 `YUNCANG_UPDATER_PUBLIC_KEY`（Tauri 单行公钥编码），Secrets 设置 `YUNCANG_UPDATER_PRIVATE_KEY` 和 `YUNCANG_UPDATER_PRIVATE_KEY_PASSWORD`。不能复用上游的信任配置。
3. 发布的新 tag 必须包含当前更新模块，且四处版本一致。工作流 `signed_updates=true` 会把公钥、实际 tag commit 和 release 构建类型编入程序，构建安装包/便携包，再对两种包及清单签名。
4. 发布前用这次实际编译的 EXE 的 `--yuncang-verify-update-file` 无界面模式逐项验签；仅检查 `.sig` 存在或字段非空不算成功。
5. Release 必须同时有 setup.exe、portable.zip、SHA256SUMS、两份包的 `.sig`、`yuncang-update.json` 和 `yuncang-update.json.sig`。清单版本、通道、架构、平台和包类型必须与发布附件一致。
6. 清单同时含 Tauri `platforms.windows-x86_64` 安装器描述及 `packages.windows-x86_64.installer/portable` 两种固定资产描述。便携 ZIP 包含签名覆盖的 `yuncang-package.json` 身份文件。
7. 首次需要手动安装/完整解压一个带专用公钥的新版本；旧版未启用更新时不能凭新增 GitHub 文件自动启动更新。

`release.yml` 的 `signed_updates` 默认值为 `true`，缺少专用密钥会失败关闭；若日后手动运行该工作流发布仅供手动升级的无签名包，必须显式选择 `signed_updates=false`，不能把缺少密钥当作自动降级。本次使用本机构建和 GitHub Releases 发布，不运行 GitHub CI，也不使用旧 `tauri-publish.yml`；不宣称上述签名工作流已实际执行。

## 安全及验收边界

- 更新源固定本 fork 的 HTTPS GitHub Releases，不读取云存储 AK/SK，也不要求公开仓库用户配置 GitHub Token。
- 便携助手验证同一受写/删除共享锁保护的归档；解压时记录可信 entry 哈希，替换前后复核，拒绝路径越界、链接、重解析点、Windows别名、重复成员和用户配置文件。
- 程序目录之外的当前 C 盘配置不被替换；目录内非发行文件也不删除。备份和失败记录保留，不做未经确认的批量清理。
- 普通 I/O 失败回滚测试不等于断电或进程被杀的崩溃一致性。当前逐成员回滚日志在内存中；断电恢复、多机器安装器、实体 Windows 升级完整链路必须另做实机验收，不能把 mock/单元测试表述为已全部兼容。
- 本地草稿仅保存在内存。应用退出保护覆盖更新按钮的路径；不要依赖强制结束应用后恢复未保存内容。
- 软件更新签名不等于商业 Windows Authenticode 签名；系统仍可能提示未知发布者。

## English summary

This describes the implementation shipped in `v1.7.0-preview.3`, not an available or fully accepted online-upgrade service. Checks are pinned to `70548887/object0`, channel-aware and never downgrade. Signing is fail-closed: this release has no dedicated compiled public key/signing configuration, so automatic download/installation is blocked and upgrades are manual. Do not use storage credentials for updater requests.

Before enabling online upgrades, configure the repository public variable `YUNCANG_UPDATER_PUBLIC_KEY` and protected private-key/password secrets above. The signed release workflow is designed to sign both assets and the manifest and verify them with the exact compiled application's no-UI verification mode; this has not been performed for this preview. Its `signed_updates` input defaults to `true` and fails closed without keys. Any future manual unsigned workflow run must explicitly choose `signed_updates=false`. This release uses a local build and GitHub Releases publishing, not a GitHub CI run or the old `tauri-publish.yml`. Bootstrap the first update-capable edition manually after dedicated signing and real-upgrade acceptance are complete.

Downloads stream to disk and retry from the beginning. Installation requires idle transfers/sync, saved drafts and other instances closed. Installer and portable paths differ; the latter uses a copied trusted executable as helper, bounded extraction, file verification leases, backups and ordinary-I/O rollback. Power-loss recovery and real multi-version Windows upgrade acceptance are not implied by fixture tests. Existing account configuration stays outside the program replacement. No keys are shipped in the artifacts.
