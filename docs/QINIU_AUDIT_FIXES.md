# 七牛适配审计 A1–A7 修复记录

2026-11-01，分支 `feature/qiniu-kodo`。本轮修复只读审计确认的 7 项问题；不代表整个七牛适配计划已完成。原审计证据保留在 `<LOCAL_EVIDENCE>\audit-20261101-full`，没有改写原失败日志。

## 修复内容

| 编号 | 修复行为 | 正式回归覆盖 |
|---|---|---|
| A1 | 所有 Upload 队列项，包括小文件与目录 marker，保存 `profile_revision` 和 `provider`；账号编辑、换服务商、删除或锁库后，旧任务在入队/执行前拒绝。选择文件/目录对话框打开前捕获身份，整批文件复用同一版本，不在循环中静默改绑。前端入口还发送 `expectedProfileRevision` 并即时核对当前账号、桶、目录。 | `audit_upload_snapshot_refuses_changed_provider_revision_removed_and_locked_account`；前端上传入口与当前范围断言 |
| A2 | 存储类型转换/解冻必须提供 `expectedProfileRevision`；缺失、空或旧版本在创建客户端及云请求前拒绝。前端携带详情面板的版本并从当前 Store 重新确认目标，不能只等待 React 的迟到属性更新。 | `audit_paid_mutation_requires_the_captured_revision_before_client_construction`、移除/锁库测试；前端版本保留/当前范围测试 |
| A3 | 空页带下一页游标时保留“加载更多”，不误报空桶；当前页搜索无匹配也保留继续分页。已消费游标后的空末页显示“本页暂无条目”，提供返回第一页，而不是声称整个桶为空。 | 普通空页、纯目录页、无匹配页、空末页、中英提示 |
| A4 | 原生列表拒绝错误对象、非列表对象及非法 marker 类型/控制字符/超长值；合法 `{}`、空 marker、带游标的空页仍可使用。异常响应不再生成完整零用量或首批总量。 | 解析器及真实模拟 HTTP 的扫描/回退；后续页错误保留已确认下限 |
| A5 | 分享允许字面直接子目录 `shared//`，不折叠路径。越界、点段和多层异常返回检查保留。 | 生产分享运行时登录→列表正常文件与空段目录→进入 `shared//`→模拟下载，并核对请求路径 |
| A6 | native 清理逐项返回成功 ID 和错误，不因后续失败丢失已完成删除；上传阶段成功、下载阶段失败时也会同步移除成功的可见行。失败项保留，可重试；前端只按已确认 ID/attempt 清理，旧响应不影响新任务。 | 上传/下载真实 Store 删除失败注入及重试、跨阶段合并、前端 partial-success/new-attempt/锁库代次保护 |
| A7 | 查看/复制账号信息包含保存的 `shareApiUrl`；分享门户不再显示“预留”。不增加任何新密钥读取。 | `profileInformation` 中英输出和正式审计 UI 用例 |

## 本地验证

- 修复前确认点：**352 项 Rust 测试通过**；历史隔离审计中 6 个 Rust、3 个 UI 正确行为断言失败，归并为 7 项问题。
- 修复后全量：**363 项 Rust 测试通过**。
- 定向同命令 `cargo test --release --lib --offline audit_ -- --nocapture`：**27 项通过、0 失败**，其中包括 11 项新增 Rust 修复回归及原有审计相关对照。
- 前端：**214 项测试、1263 次断言、18 组独立回归通过**。
- TypeScript/Vite 构建、Rust 非测试检查、14 个变更前端文件的 Biome 检查与差异空白检查通过。既有 unused-code 和大块体积警告仍保留。

旧隔离副本故意保持修复前代码和失败现场。新增正式测试使用实际生产 helper、Store 和运行时，不声称旧副本本身已被修好，也没有删除原断言来伪造通过。

## 范围与交付

- A1 本轮覆盖 **Upload** 任务及其输入路径；没有顺带宣称所有历史 COPY/MOVE/同步任务已统一身份适配。
- `jobs:clear` 保留 `removed: [{jobId, attempt}]`，新增 `errors: [{jobId?, error}]`；部分失败不再以整体异常吞掉成功结果。
- 没有读取真实密码库、使用聊天里的凭据、进行真实云上传/删除/解冻或修改既有发布资产。新代码仍未提交或推送，未打包发布。
- 真实公有云/私有部署、实际桌面文件对话框与安装包验收仍待进行；跨云复制移动、私有上传、限速、递归目录与完整编辑等原计划缺口仍在。
- 继续沿用 `<LOCAL_EVIDENCE>\range-download-20261031` 的修改源码 ZIP、累计补丁、`VERIFICATION.txt` 和 `ROLLBACK.sh`；本轮前置快照为 `AUDIT_FIX_BEFORE_SOURCE.zip`。回滚只操作独立标记副本。

## English summary

Audit findings A1–A7 are fixed locally: upload queue identity is revision/provider bound; Qiniu restore/type mutations require the captured revision; continuation/terminal empty pages stay navigable without falsely declaring an empty bucket; malformed native list responses fail closed; literal double-slash share paths are preserved; cleanup retains per-item success across failures; and connection details include the saved share API.

Verification: 363 Rust tests, 214 frontend tests/1263 assertions, 18 isolated frontend regressions, plus 27 focused Rust audit-related tests pass. TypeScript/Vite, non-test Rust checking and targeted Biome pass. This does not establish real-cloud, private-deployment, desktop-dialog or package acceptance. The original failing audit copy is retained as evidence; no real credentials or cloud-side mutations were used.
