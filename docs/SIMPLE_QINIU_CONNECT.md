# 默认明文与七牛一键连接

2026-11-01，开发分支 `feature/qiniu-kodo`。本轮按“去掉默认加密流程、普通七牛只填 AK/SK”的方案改造，而不是继续增加开关或迁移提示。

## 正常使用流程

1. 打开软件：新环境直接创建并读取 `accounts.local.json`，不出现创建密码、解锁、恢复密钥或七牛升级确认。
2. 添加账号：先选择服务商，不预选七牛。Amazon S3、Cloudflare R2、七牛云 Kodo、DigitalOcean Spaces、MinIO、Google Cloud Storage、Backblaze B2 和自定义 S3 均直接可选。选择七牛后显示公有云的 **AccessKey、SecretKey** 两项输入，点击 **连接**；其他服务商进入对应表单。
3. 后端签名读取账号空间列表；成功后仅保存一次账号，自动命名，进入该账号的空间列表。
4. 点击空间浏览文件。区域按所选空间解析；下载地址只在相应功能需要时配置，不阻挡账号连接。

没有默认空间也能连接。合法的空空间列表显示“连接成功，暂无可列出的空间”，不等于认证失败。这里的成功只指账号连接及空间列表读取，不冒充对象读取、写入或下载权限全部已验证。

原“测试连接／读取空间／保存”三个步骤在普通七牛公有云入口合并为一个“连接”。账号名称可以连接后编辑。S3 绑定、私有云、Session Token、下载/分享域名通过“七牛高级设置”进入，并保持七牛配置，不误切换成 Amazon S3。其他供应商不再藏在高级设置中。点击“更换服务商”可返回选择；切换或关闭将清空未保存的输入，避免凭据串用。编辑已有账号仍直接打开该账号表单。

## 本地账号与旧库

正常账号文件在 `%USERPROFILE%\.config\object0\accounts.local.json`。AK/SK 以明文保存，能读取文件的程序也能读取凭据，不提供密码或恢复密钥保护。设置页仅显示本地存储说明及可选旧账号导入。

- 已有有效明文文件：直接读取，不依赖旧库或系统钥匙串；异常旧导入来源不会阻挡有效明文库。
- 旧加密库在当前进程已经正常解锁：迁移当前主数据，不需要恢复密钥，原 `vault.enc` 原样保留。
- 仅有未解锁旧库：一次性显示“导入旧账号（可选）”，可输入原云仓密码导入，或点“暂不导入，直接使用”。跳过不会伪称旧账号已迁移。
- 新建环境：不再走原 SetupScreen 或要求用户手动选择明文模式。
- 以后导入旧账号：在设置中操作，增量合并、不覆盖已存在的冲突账号；账号 ID 内容冲突或两个不同传输主密钥时明确拒绝，保留两边文件。
- 旧文件只是历史快照，不再同步新改动。不要删除当前明文文件来切换回旧程序；新旧版本不要同时运行。

旧库密码仅用于一次性解密导入，不能无密码恢复密文。没有恢复密钥输入、没有生成恢复密钥的必要，也不会为了迁移而重置原库。损坏的活动明文文件仍然报错，不静默回退或创建空替代文件。

## 请求、保存和错误边界

新增 `profile:connect-qiniu`，输入为请求 ID、AK/SK 和可选名称；公有云原生配置固定，不接受任意 Endpoint。返回的是安全账号信息和空间身份，不返回密钥。

- 空间列表请求完成且合法后，才在本地持久保存账号。认证、权限、网络或磁盘失败不会被当作连接成功。
- 请求 ID 加有界内存记录防止重复保存；相同已保存公有身份再次连接会复用账号。
- 验证前后核对明文账号内存/磁盘快照；旧响应不能覆盖更新后的账号数据。
- 关闭窗口、改输入及已登记请求失效会发取消。提交之前取消不保存；提交已经完成后的关闭不能撤销已保存账号，会提示先核对账号列表。
- 已知取消 ID 的短期记录跨运行时清理保留，避免迟到的同 ID 请求重新入队；这些记录不持久化，不宣称跨进程网络重放保护。
- 连接后直接采用已返回的空间列表，不重复列桶；仍核对当前保存账号版本。旧活动标签取消选中，但其他标签保留，避免界面串账号。
- 401、403、网络/证书、超时、本地保存失败分别提供固定提示，不回显原始敏感错误。受限账号缺列桶权限时可使用高级配置，并不能绕过其实际权限。

## 实施和验收

测试使用合成账号文件、模拟 HTTP 和状态/渲染测试，包括默认启动、旧库导入/跳过、保留旧字节、账号/传输密钥冲突、错误密码、坏文件、空空间、重复请求、取消、权限失败、保存失败和迟到结果。

本地回归结果：**405 项 Rust、252 项前端测试（1469 次断言）、21 组隔离回归通过**。这是代码与模拟契约验收，不替代真实账号、私有部署或 Windows 安装向导验收。

第一次 Rust 编译暴露测试直接构造私有传输密钥字段，已改为合法的测试反序列化构造，没有放宽密钥类型可见性。原失败日志保留。

没有使用用户真实七牛凭据、没有代用户执行旧库导入，也没有上传、删除或解冻云文件。桌面构建必须使用 Tauri CLI 的生产协议；旧安装包不会因开发源码改动而自动更新。

## English summary

Normal startup now uses local plaintext accounts by default. New installations go directly to the main UI; an old encrypted vault is an optional one-time import source, not a password/recovery gate for new accounts. The old file is preserved. Skip import starts a separate local account file; later imports merge without overwriting conflicts or losing transfer-key identity.

Adding an account first shows all eight storage providers without preselecting Qiniu. Selecting Qiniu opens its ordinary public-cloud dialog with AccessKey, SecretKey and one Connect button; other providers open their corresponding forms. Qiniu advanced settings keep Qiniu selected. Change provider returns to the chooser, clearing unsaved inputs; closing and reopening also resets the choice. Existing accounts still open directly for editing.

A signed bucket-list request succeeds before one local save, then the returned bucket list is adopted without a second request. Default bucket, download domains, S3 bindings and private endpoints are not ordinary prerequisites. Advanced Qiniu settings remain separately reachable.

Account connection, bucket object access and download capability are distinct states. Empty authorized lists are valid. Requests are bounded, cancelable and idempotent within the process; stale snapshots and failed persistence do not overwrite local accounts. Credentials are plaintext by user choice and must not be shared or packaged. Tests use fixtures only; real-cloud and deployment acceptance remain separate.
