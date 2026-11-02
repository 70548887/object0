# 七牛账号连接后的空间与标签校验

## 2026-11-01 修复范围

截图中的账号已列出一个空间，但文件视图打开了不在该列表中的旧空间。
这不是认证失败的证据：Rust `resolve_named_bucket` 找不到目标空间时在发起
对象列举之前返回 `bucket-not-listed`。本次保留该检查，不通过绕过空间边界掩盖错误。

根因在 `TabBar`：连接流程设置 `activeTabId=null` 后，组件把它转换为 `undefined`。
安装的 Base UI Tabs 将后者视为非受控模式，可能重新选择第一个持久标签。
修复后显式传递 `null`，保持没有活动标签，其他账号的标签仍保留供主动选择。

同时补齐：

- 仅在当前七牛账号的列桶请求成功时校验旧标签；原生桶名优先，S3 别名转为原生名。
- 清除当前账号已不在列表中的标签和文件操作上下文；不会删除云端文件或本地账号。
- 网络错误、权限失败、过期响应不能当作空列表，不能据此清标签。
- 恢复七牛标签和收藏时先等空间列表，拒绝不存在账号或无效空间的对象请求。
- 文件列表读取由标签导航统一处理，换桶时先清旧文件行、选择和详情/传输/分享目标。
- 不再从文件列表渲染 effect 把旧前缀写入新标签。进入目录、后退、面包屑和键盘后退显式更新匹配账号/空间的活动标签。
- 成功通知提示从左侧选择实际空间，不把账号列桶成功称为全部文件操作验证成功。

## 官方参考

实现是独立 Rust 适配，不是直接嵌入官方 Electron 客户端。
参考记录见 `src-tauri/src/qiniu/SOURCES.md`，固定到
[Kodo Browser 2c5d7bad](https://github.com/qiniu/kodo-browser/tree/2c5d7bad6c44e9d57529f8f19bf0faa7c2ee27dd)
及其 `kodo-s3-adapter-sdk@0.7.1`。官方 SDK 的桶列表请求与现实现均使用
`GET /v2/buckets?shared=rd`，保留原生名和 S3 身份，而不是混用名称。

本次修复针对云仓自己的前端导航缺陷，不能由“参考过官方源码”替代测试。
自动化回归均使用假账号和模拟 RPC，不提交用户真实凭据或操作真实空间。
实际对象读写、下载、私有云和完整适配计划仍有各自验收边界。

## English

Successful account discovery was followed by an unrelated restored bucket tab.
`null` was accidentally converted to `undefined`, allowing Base UI Tabs to select
an old tab in uncontrolled mode. The tab bar now stays controlled with no selection.
Only successful, current Qiniu discovery reconciles saved tabs. Failed or stale
requests never act as an empty list. Qiniu navigation waits for discovery; S3
direct-bucket behavior is retained. Object rows and action targets are cleared
before changing scopes. Explicit navigation updates the matching tab prefix,
including breadcrumbs and keyboard back navigation, without render-effect feedback.
All automated checks use fixtures; no real cloud access is claimed by these tests.
