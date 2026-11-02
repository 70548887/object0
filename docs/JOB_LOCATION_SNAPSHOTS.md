# 拖拽修复与任务目标信息（2026-11-02）

## 先修复审计问题

1. 上一批文件正在创建上传任务时，第二次拖入会明确提示“本次未接收，请稍候重拖”，不再静默丢失。提示不把未接收文件说成已上传；原生与 DOM 重复回调仍不重复入队。
2. 原生 enter/over/drop/leave 监听逐项注册，只有全部成功才启用。任一步失败会清理已注册监听，停止迟到回调，并清除拖拽浮层；卸载期间迟到的注册结果立即清理。

修复阶段先独立执行回归，之后才添加下面的任务位置功能。

## 新任务显示目标

任务折叠行显示“账号名称 · 存储桶”。展开详情分别显示：

- 来源／目标账号名称，以及账号 ID；
- 存储服务商（R2、七牛等）；
- 来源／目标存储桶或空间；
- 完整对象路径；
- “复制位置信息”按钮，复制以上显示字段，不包含 AK/SK、Session Token、Endpoint 或本地文件路径。

上传记录目标，下载记录来源，复制／移动分别记录两端。路径没有记录时明确显示“未记录”，不猜为桶根目录。

这些字段在任务创建时捕获，随进度、完成事件和历史记录保存。切换页面不会把历史任务标成当前账号；后来重命名或删除账号也不覆盖原记录名称。
任务字段只用于展示，不参与授权判断，不改变原有账号版本、存储权限或传输校验。

## 旧记录与兼容性

- 以前的普通任务没有保存账号 ID 或名称，无法可靠补回；显示“历史任务未记录账号/位置”，仍保留旧描述。不会仅凭桶名推断账号。
- 旧七牛断点记录能保留其已知账号 ID、桶、对象键；没记录过的历史名称/服务商仍标为未记录，不套用当前账号。
- 新版可读取缺少新增可选字段的旧普通历史与旧原生断点记录。
- 新原生断点记录仍采用既有加密/完整性格式，只新增可选显示快照。旧程序的严格 JSON 解析可能拒绝带新增字段的记录，**不保证降级读取新产生的原生任务**；不要删除任务文件来降级，继续使用新版处理这些任务。
- “历史记录可显示目标”不等于把所有 S3 任务改成跨重启断点续传；已有持久传输范围不变。

## 验证与边界

模拟回归覆盖忙状态多次手势、注册第1～4步失败和晚到清理，以及账号/桶显示、复制白名单、进度/完成/刷新合并、旧事件与旧执行轮次保护。
Rust 测试覆盖普通历史序列化、原生加密记录往返、缺字段旧记录、来源目标方向、历史名称不随当前配置改变、元数据不含凭据。
未访问用户真实凭据或替用户上传文件；实机外观与真实云传输仍应在新版窗口中验证。

## English

The two audited drag/drop defects were fixed before adding job-location metadata: busy gestures now get explicit rejection feedback, and native listener registration is atomic with rollback and stale-callback protection. Jobs now carry immutable safe source/destination snapshots containing account ID/name, provider, bucket and object path. Progress, completion and persisted history retain them. The UI shows a compact location summary, detailed fields and an allowlisted Copy location action. Old records remain readable but unknown metadata is not guessed from the active account. Older versions may reject new native manifests with added display fields; downgrade compatibility is not promised. Transfer authorization and resumability boundaries are unchanged.
