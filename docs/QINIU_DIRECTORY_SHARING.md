# 七牛目录分享：只读会话接线

日期：2026-11-01，分支 `feature/qiniu-kodo`。这是本地开发功能，不是新发布版本，也不代表真实七牛或私有部署已完成验收。

## 界面入口

- 公有云原生永久凭据、非 S3 绑定的七牛账号：进入空间及目录，在文件工具栏更多菜单中选择“分享当前目录（只读）”。
- 默认有效期 1 小时，可选 15～120 分钟；后端产生随机六位提取码。创建前绑定账号版本、空间原生名称和目录，不在账号切换后复用旧操作。
- 侧栏“连接共享目录”：输入分享链接及提取码，经后端验证后，打开独立的只读文件浏览窗口。
- 共享窗口提供限定根路径内的面包屑、文件与目录、分页和单文件下载；没有上传、删除、移动、同步或全桶用量入口。
- 分享账号不加入普通账号列表。界面只取得临时会话标识、显示空间名、目录范围、有效期与只读标记，不取得 AK/SK、Session Token、S3 地址或签名下载链接。
- 到期和关闭窗口会结束本地会话；关闭不是撤销远端分享。已经创建的远端链接仍按服务端有效期到期。

## 后端边界

- `qiniu:share-create/login/list/download/close` 独立于账号型文件操作。每次列举、读取及交付都重新检查会话、有效期和授权范围。
- 链接本身不能指定或扩大长期凭据的发送目的地。公有云仅用验证过的七牛官方服务；分享登录不使用任何长期账号凭据。
- 私有协议与界面支持明确门户、`shareApiUrl`、手工区域/S3 地址和可信 CA 的路径。门户发现结果不能自动扩大 API 信任；UC 地址不会因此获得分享 API 信任。私有登录入口已接通，目标部署仍标记“待实机验收”；私有分享创建没有开放。
- 目录前缀必须为空或以 `/` 结尾；拒绝点路径段、反斜杠、控制字符和前导 `/`，不会将不可表达的对象名称悄悄改写成另一个对象。
- 不透明分页游标保留在 Rust 内，绑定会话和目录；拒绝跨目录、失效、重复和异常分页。目录空页但有下一页时仍允许继续加载。
- 分享凭据仅在内存中，锁库、恢复密码库、重置、退出和账号配置失效时清除；同时使未完成登录失效，迟到响应不能重新建立会话。
- 仅复制临时凭据给原生请求客户端；关闭会话会取消在途操作，但不承诺第三方 HTTP/SDK 内部所有临时内存副本都已立即逐字节清零。

## 分享下载与普通持久任务不同

- 分享下载由原生保存对话框选择目标；不接受前端提供任意本地目标路径。
- 分享会话默认不持久化，因此本轮分享下载不提供暂停、断点续传、任务历史或重启恢复。公有原生普通账号下载的持久 Range 队列不受影响。
- 下载使用同目录 `.yuncang-share-<UUID>.part` 明文临时文件，不预先截断目标。已存在目标明确拒绝，即使保存对话框确认覆盖，也不会自动覆盖。
- 请求绑定远端 ETag/版本和大小，完成后重新核对对象身份和临时文件内容。原子 create-if-absent 交付与会话关闭在同一锁内排序，锁库完成后不会再交付旧会话文件。
- 文件系统不支持原子硬链接时明确失败，不退化为删除旧文件。失败/取消只清理经过归属校验的本任务临时文件，不删除云端对象或用户目标。
- 异常进程终止可能留下 `.part`；没有持久会话记录供重启恢复，本轮没有自动扫描或清理任意历史临时文件。

## 验证与剩余范围

验证使用本地模拟服务、合成身份、临时目录及前端状态/渲染测试。包括长期凭据不进入登录、分享 S3 标识映射、范围拒绝、分页、锁库及迟到响应、对象变化和目标保护。真实服务有效性、真实桌面保存对话框与关闭/重开、私有部署均需另行验收，不能用模拟成功替代。

公有分享接线阶段的回归结果：Rust **323 项通过**；前端 **167 项、973 次断言通过**，另 **15 组隔离回归通过**；TypeScript/Vite 构建、Rust 非测试检查、13 个变更前端文件的 Biome 检查通过。首轮 Rust 测试因 SDK 桶路径尾斜杠断言不当出现 1 项失败，修正断言后全量通过，失败日志保留。私有分享后续结果另记于同目录验证记录。构建仍有现存未使用代码和前端大块体积警告。

证据沿用并扩展 `<LOCAL_EVIDENCE>\range-download-20261031` 的四角色；此前上传/Range 下载基线和日志保留。没有读取真实密码库、使用聊天中的密钥、访问真实账号或覆盖既有发布资产。

本计划剩余：私有/S3 持久传输、私有分享创建与目标部署实机验收、七牛跨云复制/移动、安全镜像、限速、递归目录管理、完整预览/编辑和新安装包/便携包。删除型镜像仍关闭。后续已接入公有原生的[官方分类用量](QINIU_USAGE.md)，但分享会话仍不会获取全桶统计。

## 私有分享配置与登录（后续完善）

1. 编辑七牛账号并选择私有云。填写本部署的 UC 地址；分享使用的每个区域必须明确配置区域 ID 和 S3 源地址，不能用显示空间名猜 S3 标识。
2. 在“下载与分享配置”中分别填写**分享门户源地址**和**分享 API 源地址**。只接受 HTTP(S) 源地址，不接受凭据、路径、查询或片段；不会从 UC、门户或粘贴的分享链接自动补齐 API 地址。
3. 可选可信 CA PEM 路径；留空使用系统/运行时默认 TLS 信任，不关闭证书验证。HTTP 配置显示明文传输警告。请不要将真实 AK/SK、提取码或分享令牌粘贴到配置源地址中。
4. 保存后，在侧栏“连接共享目录”的环境列表选择该私有账号。不完整环境显示原因并禁用；配置齐全只代表可尝试验证，不代表服务或权限已经验收。
5. 输入属于该环境已保存门户的链接和六位提取码。后端仅发送分享令牌/提取码，随后使用服务端返回的临时凭据访问明确允许的 S3 区域/地址，绝不使用该账号长期 AK/SK 来登录分享。

私有登录请求同时携带 `privateEnvironmentId` 和 `expectedPrivateEnvironmentRevision`。保存档案版本不匹配、环境被删除/切换、公有请求附带私有版本、未配置分享服务或可信 CA 无效，均在分享请求前拒绝。前端还比较配置指纹，在验证返回与打开浏览窗口前再次核对；配置列表变化时清理等待中、已验证但未打开及已打开的本地会话，数组单纯重排不会误失效。

分享 API 配置可空缺，旧的“仅门户”档案仍能保存普通存储功能；但不能作为完整私有分享环境登录。启用分享 API 时要求门户和至少一个合法手工区域。区域 ID 限 1～128 位 ASCII 字母、数字、短横线或下划线，前后端保持一致。编辑分享 API 会清除旧的连接测试结果；切回公有云不会携带私有分享 API。

模拟验收覆盖真实 RPC 的私有登录和列表、生产下载执行器及 Windows 临时文件，检查临时/长期凭据隔离、重定向不跟随、错误区域/地址、权限与不支持/网络错误区别，以及档案编辑或锁库时的迟到响应。没有运行真实桌面保存对话框，没有真实私有部署或公有测试空间的验收结果。

私有入口完善后的本地结果：**334 项 Rust 测试、193 项前端测试（1097 次断言）、16 组隔离回归通过**；Rust 非测试检查、TypeScript/Vite 构建及 12 个变更前端文件的 Biome 检查通过。手工区域 ID 保存/登录校验已统一；环境选择在链接和提取码之前，减少切换环境清空输入造成的困惑。最终差异、字面输出和独立副本回滚以现有四角色验证记录为准。

## English summary

Public native accounts with permanent credentials and no explicit S3 bindings can create read-only shares from the current-folder menu. Shares default to one hour, accept 15–120 minutes, and receive a random six-character extraction code. The sidebar's **Connect shared directory** opens a separate, scoped browser after code verification.

Only the session ID, display bucket name, prefix, expiry and read-only flag reach the frontend. Temporary AK/SK/tokens stay in Rust. Every request is scope/expiry checked; opaque pagination is session-and-directory bound. Lock, reset, recovery, account-environment changes, expiry and closing invalidate local sessions and late responses. Closing a session does not revoke its remote share link.

Downloads use the native save picker and an owned plaintext temporary file beside the chosen target. Existing files are never replaced. Remote identity, length and local content are checked before atomic create-only delivery; a completed close/lock prevents later delivery. Share downloads are not durable jobs and do not support pause/restart recovery. A process crash can leave a partial file; this implementation does not scan arbitrary directories to remove it.

Private configuration and login are now connected: save an explicit portal, `shareApiUrl`, at least one manual S3 region/origin, and an optional CA in the account form, then select that saved environment in the share login dialog. Incomplete environments are disabled with a reason; all private environments remain marked **Pending real-deployment acceptance**. Private share creation is still disabled. An empty CA path uses default TLS trust, not insecure certificate bypass. HTTP origins have an unencrypted-transport warning.

Private login carries both the saved environment ID and revision. The Rust preflight validates configuration and CA before requesting the share service; the frontend also rejects changed/removed environments before sending, after verification and before adopting a session. Discovered addresses never automatically receive credentials. The permanent credentials of the selected account are not used for share login. Legacy portal-only profiles remain saveable but are not eligible for private share login. Local mocks, state tests and production builds are not substitutes for public-cloud, private-cloud or real desktop-dialog acceptance. No real vault/account or existing release asset was modified by these tests.
