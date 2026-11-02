# 七牛“连接尚未完整验证”与保存条件

2026-11-01，`feature/qiniu-kodo` 本地修正。

后续更新：本页记录旧测试/保存分离流程的修正。正常入口现已改为默认明文和 AK/SK 一键连接，不再要求本页历史描述中的恢复密钥或升级确认，详见 [最新流程](SIMPLE_QINIU_CONNECT.md)。

## 如何理解测试结果

- 认证、区域发现通过，空间访问显示“尚未验证”：表示账号认证已通过，但没有指定默认空间验证对象列表权限。**不是密钥或网络连接失败，也不是已经验证全部功能。**
- 可以填写默认存储桶的真实原生名称后重新测试；不填也可以在满足保存条件后保存账号，再选择空间。
- 自定义下载域名为可选配置，不阻止保存或列出空间；实际下载访问需要选定空间和可用域名后单独验证。
- 修正版将这种部分验证显示为黄色提示，仍保留后端原始 `success=false`，不会把未知权限改成成功。真正认证、权限或网络错误仍用红色提示。
- 新增已知诊断文字的中英显示；未知服务商错误不按斜杠盲目拆分，以免改写路径或其他上下文。

## 保存按钮为什么是灰色

保存条件与连接测试结果是两回事。首次保存七牛账号可能需要：

1. 填写账号名称和所需凭据。
2. 阅读并勾选密码库升级与回退说明。
3. 如果原密码库配置过恢复密钥，在本地填写**创建云仓密码库时保存的恢复密钥**，用于验证旧恢复快照。

这个恢复密钥不是七牛 SecretKey，也不应发到聊天中。修正版在按钮旁列出尚未满足的条件，没有移除后端恢复密钥验证、加密备份或迁移保护。

如果恢复密钥遗失，请保留原密码库及备份，**不要为了解除按钮禁用而重置或删除密码库**。最新测试构建已补上“设置 → 密码库 → 重新生成恢复密钥”入口：必须仍知道当前云仓解锁密码，并由你在本机明确确认后执行。它先创建加密备份，保持账号、主密码和传输密钥不变；旧恢复密钥只对当前库失效，对旧备份仍可能有效。实际更换不会由代理、安装程序或启动过程自动执行。

## 本地运行注意

应使用 `bun run tauri build --no-bundle --ci -- --offline` 生成桌面测试程序；该命令启用 `tauri/custom-protocol` 并嵌入前端。直接 `cargo build --release` 不会自动开启生产协议，仍可能访问未启动的 `localhost:1420`。

配置目录保持 `%USERPROFILE%\.config\object0`。修正版可先构建暂存；当前窗口有未保存的账号表单时，不自动关闭或重启，以免丢失输入。本轮没有读取真实密码库、获取用户恢复密钥、代为提交账号设置或执行真实存储操作。

## English summary

Passed authentication/region discovery with an unselected bucket is **partial verification**, not a credential/network failure or full access verification. The UI now uses an amber result while keeping the native success flag unchanged; real errors stay red. Optional download-domain configuration does not block saving or bucket listing.

Save prerequisites are shown separately. A first Qiniu vault migration may require acknowledgement and the existing **Yuncang vault recovery key**, not the Qiniu SecretKey. Encryption, verified backups and recovery checks are unchanged. If the key is lost, preserve the vault and backups instead of resetting or deleting them. The latest test build adds Settings → Vault → Generate a new recovery key, requiring the current unlock passphrase and explicit local confirmation. It preserves the primary vault and creates a verified encrypted backup; old keys can still unlock older backups. Installation and startup never rotate keys automatically.
