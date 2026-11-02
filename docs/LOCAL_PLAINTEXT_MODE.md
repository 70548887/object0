# 本地明文账号模式与七牛空间读取

日期：2026-11-01，`feature/qiniu-kodo`。用户明确选择 AK/SK 以明文保存，本轮增加可选明文模式，**不把既有加密库静默转换**。

后续更新：正常入口已进一步改为默认明文，并合并七牛连接步骤；本页保留前一阶段实现记录，最新流程见 [默认明文与一键连接](SIMPLE_QINIU_CONNECT.md)。不再要求先去设置打开明文开关。

## 操作入口

- 已有账号：先正常打开当前账号库，再进入 **设置 → 密码库 → 使用本地明文模式**，阅读风险并确认。已经解锁的库不要求恢复密钥。
- 首次使用且没有账号库：设置页提供本地明文模式入口，确认后可直接使用，不必先创建密码。
- 账号文件固定为 `%USERPROFILE%\.config\object0\accounts.local.json`（实际按 `%USERPROFILE%` 解析）。明文模式下启动直接读取，不访问系统钥匙串，不要求云仓密码或恢复密钥。
- 添加七牛：填写凭据后点 **读取空间**，从下拉列表选择原生空间名；无需先保存账号，也不会自动替用户选中。仍可手填。
- 选择空间后重新测试，才验证该空间的对象列表权限；列出空间不等于所有对象/上传/下载权限都已通过。没有列桶权限的受限身份仍需要明确空间绑定，不能绕过权限限制。

## 明文意味着什么

账号凭据、AK/SK、已保存的会话令牌和其他账号配置直接保存在上述 JSON 中，任何能读取该文件的程序或用户都能看到。没有密码、恢复密钥或 Windows 凭据保护；界面会明确标注“明文”。不要上传、共享或放入安装包，也不要把其内容发到聊天中。

为保持已有可恢复传输任务，传输主密钥也原样迁移到明文文件。任务 manifest 仍沿用既有加密格式以兼容，但密钥现在可随账号文件读取，**不能再视作机密保护**。

## 原库和故障保护

- 原 `vault.enc` 不覆盖、不删除，逐字节保留为切换前快照；之后的新增/修改不会同步回旧库。
- 旧程序仍可能读取旧快照，不应交替使用旧程序和明文新版。不要删除明文文件来“切回”旧模式，否则新账号改动会缺失。
- 转换要求当前原库正常解锁且可写，使用当前主数据，不用过时恢复快照。原库身份/数据不一致、原文件异常、目标已存在等情况拒绝，不能把空库覆盖已有账号。
- 写入先使用独占临时文件，flush/sync、回读校验后提交；初次创建不覆盖并发出现的目标。失败不发布候选运行时，原加密库保持不变。
- 明文文件损坏不自动回退旧加密库；运行中发现模式与路径变化也拒绝继续，防止新旧账号混用。
- 明文模式下隐藏锁库、密码和恢复密钥操作；后端同样拒绝恢复/改密码/重置。它不是一个有密码保护的锁定状态。
- 切换时暂停持久传输、清理旧会话/连接缓存。恢复任务仍需用户手动发起，不自动联网续传。

## 空间下拉安全边界

后台连接测试此前已经列举空间，本轮仅增加安全名称/区域/权限字段返回，不附带 AK/SK。前端仅接受认证通过的列表，选项使用原生空间名，不把 S3 别名当默认名称。编辑凭据、服务商、区域或账号版本后清除旧列表并拒绝迟到响应；单纯选择默认空间不会丢弃已读取列表。空列表与读取失败分别提示，不谎称空账号或全部验证成功。

本轮只用合成账号文件和本地测试验证，未读取/导出真实密码库、未代用户执行明文转换、未使用真实七牛凭据。最终桌面程序提供入口，真实转换由用户在软件内完成。

本地验证结果：**384 项 Rust、244 项前端测试（1410 次断言）、20 组隔离回归通过**。模式文件串用/外删后的旧库回退也加入测试；这不等于已在用户真实账号上验证过空间读取或明文转换。

## English summary

Local plaintext mode is an explicit opt-in. Existing users open Settings → Vault → Use local plaintext mode after normally unlocking their current vault. New users can select plaintext onboarding without creating a password. Credentials reside in `%USERPROFILE%\.config\object0\accounts.local.json`, and subsequent startup needs neither a password/recovery key nor Windows keychain access.

Anyone with file access can read AK/SK, saved tokens and the transfer master key. Existing checkpoint envelopes retain their compatible format but no longer have a secret local key boundary. Do not share or package this file. The old encrypted vault remains an unchanged pre-switch snapshot, not a synchronized backup.

Qiniu account forms now expose Read buckets and a native-name dropdown before saving. Listing identities does not prove object access; select a bucket and retest for that permission. Draft changes invalidate stale lists. The implementation was tested using synthetic files only; no real account export or cloud operation was performed by the agent.
