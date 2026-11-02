# 桶页面桌面拖拽上传（2026-11-02）

## 使用

从资源管理器选择一个或多个文件，拖到已打开的桶文件列表或下方空白区域。
悬停时显示虚线提示及目标桶/目录；松开后直接加入上传任务，无需再次打开文件选择器。
上传进度及失败原因在任务面板查看，完成后的刷新沿用现有任务事件。

- 上传到当前打开的目录，不自动切换到鼠标下的子目录行。
- 拖到侧栏、工具栏或弹窗上不会向背后的桶上传；未选桶时不接收。
- 切换账号、凭据版本、桶或目录后，旧手势及未提交的批次条目不会改传到新目标。
- 同一批重复路径去重；不同路径但同一文件名拒绝整批，避免批内静默覆盖。
- 文件夹暂不通过此手势递归展开，请使用已有“上传文件夹”入口（受服务商既有能力限制）。
- 无效路径、目录、缺失文件在后端入队前报错，不再以零字节文件假成功入队；真正零字节文件正常支持。
- 同名远端对象沿用现有上传行为，本轮不引入自动删除或镜像同步。

## 实现与回归边界

Windows Tauri 默认启用原生拖放，旧代码只监听 HTML5 事件并读取浏览器通常没有的 `File.path`。
新版通过 `getCurrentWebview().onDragDropEvent` 接收系统文件路径，原生模式不再执行 DOM 上传，避免双重入队。
物理像素坐标按 DPR 转为 CSS 坐标，结合区域边界、顶层命中元素、modal/inert 判断落点。
桶内容容器使用完整高度，包含列表下方空白，而不是只覆盖表格自身。

监听与异步注册都有卸载清理。账号版本/桶/前缀在手势进入区域时捕获，并在每个上传 RPC 前再次核对。
已接受的任务不会因后续目标切换被偷偷取消；余下条目停止并报告部分提交，迟到结果不打开新目标的成功面板。
所有原生文件大小由 Rust 检查，不给七牛路径伪造 `size=0`。

自动化使用模拟原生事件、DOM 矩形、DPI、账号和 RPC，未读取用户文件或上传真实云空间。
实际 Windows 系统拖放和真实上传仍需用户在新版桌面中验证。打开内嵌调试器时 Tauri 可能报告不准的拖放坐标，测试应关闭或分离调试器。

## English

Drag one or more computer files into the active bucket's file list or blank content area. A bounded overlay shows the bucket/folder; dropping queues uploads directly. Native Tauri paths replace the unreliable browser File.path path, with no duplicate DOM/native queueing. Only the active content area accepts drops; modals, other panels and changed account/folder scopes are rejected. DPI conversion and delayed listener cleanup are covered by fixture tests. Directories should use Upload Folder; invalid local sources are rejected before queueing. No real user file or cloud upload was performed by the agent.
