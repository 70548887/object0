# 恢复密钥管理与本地测试包

2026-11-01，`feature/qiniu-kodo`。此功能用于：密码库已正常解锁、仍知道当前云仓密码，但遗失旧恢复密钥。**不知道当前密码时不能使用此功能；不要重置或删除原库。**

历史范围说明：此页描述之前恢复密钥管理测试包；最新开发版正常入口已移除密码库/恢复密钥流程，改为默认明文和可选旧账号导入，见 [最新连接流程](SIMPLE_QINIU_CONNECT.md)。旧加密兼容代码保留，不代表当前普通界面仍要求恢复密钥。

## 操作

1. 关闭账号编辑表单，打开“设置 → 密码库 → 重新生成恢复密钥”。
2. 手动输入当前云仓密码，勾选旧恢复密钥失效的确认。这里不是七牛 SecretKey，也不是旧恢复密钥。
3. 后端验证当前密码及磁盘/内存一致性，创建并核验加密备份后才更新恢复密钥。
4. 新密钥在本机显示；复制或下载后确认已保存。对话框同时显示加密备份路径。
5. 再添加七牛账号，确认升级说明，在需要时填入刚保存的新恢复密钥。

不要把密码或恢复密钥发送到聊天。安装、启动和连接测试都不会自动更换恢复密钥；本次开发仅用合成密码库验证，没有执行真实用户密码库更换。

## 保持不变的内容

- 主密码及对应主加密 key/salt、主密文、账号列表、版本和持久传输密钥保持不变，仅替换恢复密钥封装。
- 新库先要求用户以正常密码解锁；恢复密钥解锁但尚未重设主密码的只读状态不能调用更换。
- V3 从当前主密码解密的数据生成最新恢复快照，不用可能过时的旧恢复快照替代账号数据。迁移 V4 时，新恢复密钥继续可用。
- 先建立同目录 `vault.enc.pre-recovery-rotation-<UUID>.bak`，flush/sync 并逐字节核对。备份或候选写入失败，不发布新内存状态；最终同目录原子替换。
- 旧恢复密钥对当前库失效，**但仍可解锁匹配的历史加密备份**，需要妥善保管备份。
- 操作前和提交前重复检查磁盘状态；不声称能在多个独立程序同时写同一密码库时提供跨进程事务。安装版/便携版仍应一次只运行一个。

## 锁库与中断

锁库始终允许，并立即清除待显示的新密钥；迟到响应不会在下一解锁会话复活。若本地连接中断或锁库与更换并发，提示“更换可能已完成”，不自动重试、不宣称旧密钥必然有效。主密码仍有效，用户可重新解锁后明确再次生成。生成请求中普通关闭按钮禁用，但不限制安全锁库。

恢复密钥仅保留在当前内存展示，确认后清除，不写明文配置或日志。原生错误采用固定安全文本；传输层任意错误不回显输入密码。

## 验证及发布边界

合成测试覆盖 V3/V4、错误密码/缺确认/锁库/恢复-only 拒绝、主密文与账号保持、稳定传输密钥保持、备份与写入失败、外部文件变化、旧恢复快照修正，以及 V3 更换→七牛迁移 V4→重新解锁/保存/恢复链路。前端覆盖明确确认、迟到锁库、重新解锁、保留账号、新密钥保存确认和中英提示。

最终本地回归：**372 项 Rust、233 项前端测试（1348 次断言）、19 组独立前端回归通过**。这不是云端、私有部署或安装向导端到端验收。

Windows 产物通过 Tauri CLI 正式构建（包含 `tauri/custom-protocol`），不再使用缺少生产协议的裸 `cargo build --release` 启动桌面端。本地包沿用内部版本 **1.6.0** 和原标识，仅放入新的日期测试目录，不覆盖原 `releases/v1.6.0`，不发布 GitHub。便携包包含中英文说明和固定 WebView2；不包含账号、密码库、缓存或日志。

## English summary

The new manual Settings → Vault → Generate a new recovery key flow is for a normally unlocked vault when the current passphrase is still known. It verifies that passphrase, checks disk/runtime consistency, creates a byte-verified encrypted backup and replaces only the recovery envelope. Primary ciphertext, accounts, passphrase and transfer identity remain unchanged. The old key no longer unlocks the current vault but may still unlock old backups.

Lock remains available and clears pending secrets. Late or interrupted results do not automatically retry or reveal a key in a later session. If the outcome is uncertain, unlock with the unchanged current passphrase and explicitly generate another key. The agent did not rotate the real vault or enter user secrets.

Local test packages retain internal version 1.6.0 and the existing app identifier/configuration directory; they are separate dated artifacts, not a stable release. Only one edition should run at a time. Real-cloud/private-deployment/installer acceptance remains pending.
