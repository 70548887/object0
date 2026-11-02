# R2 连接超时排查与修复（2026-11-02）

## 实际证据

- 用户截图显示对象列表请求超时；现有安全日志记录 `Timeout, http=None`，不是服务端明确的密钥拒绝。
- 保存的 R2 Endpoint 格式与 `region=auto` 正常；仅检查密钥存在性，不输出、记录或使用真实 AK/SK。
- 对已配置 R2 账号源地址和桶子域分别作一次不带鉴权的 HEAD，均收到 HTTP 400，TLS 分别约 4.557 秒、4.510 秒；HTTP 400 只说明传输路径可达。
- 已安装 SDK 的 `BehaviorVersion::latest` 默认连接截止为 3100 ms。R2 客户端此前没有覆盖这一值。
- 真实 SDK 合成凭据单次诊断：原版 HTTP 401、2957 ms；修改版 HTTP 401、676 ms。两次均已建立网络，但故意无效的凭据被拒绝。这不是用户密钥错误证据，也不能将耗时差归功于补丁或声称已复现并解决真实账号故障。

## 最小改动

仅 `s3::to_s3_client` 的 `S3Provider::R2` 分支设置 `connect_timeout=15s`，提高慢 DNS/TCP/TLS 建连的容忍度。不修改 Endpoint、Region、凭据、签名、地址风格或其它服务商。不设置总操作、单次操作或读取的短时限，避免长文件传输被 15 秒截断。

服务不可达时重试可能比以前等待更久。没有关闭 TLS 证书校验，没有修改系统代理/防火墙/DNS。网络波动、代理路径或真实账号权限仍需在桌面中复测，不承诺增加连接等待就解决所有故障。

## 回归与诊断边界

本地配置测试覆盖 R2 的 15 秒和其它服务商原值，确认传输总时限未被短设、端点和区域未变。
本地 TCP fixture 接收 TLS ClientHello 后等 4.5 秒关闭：旧 3.1 秒先超时，新配置等待关闭后返回非超时握手错误。该 fixture 只验证连接截止行为，不代表完整 TLS 成功。
`r2_transport_probe` 为默认忽略的测试，只有明确指定有效 R2 地址/桶才运行；它只发一次合成凭据的只读请求，不输出服务端原始错误、账号地址或密钥。测试命令退出成功表示诊断执行完成，不等于账号连接成功。

之前七牛域名首选及分享改动保留。发现的前端重复只读列表请求不是本轮已证实超时根因，不混入本次连接时限修复。

## English

Only R2 connection establishment now uses a 15-second timeout instead of the installed SDK's 3.1-second default. Transfer/read/operation deadlines, credentials, region, endpoint, TLS validation and other providers are unchanged. Unsigned HEAD and synthetic-key requests establish transport observations only; real credentials were not submitted. The baseline synthetic request already reached HTTP 401, so this change improves slow-handshake tolerance rather than proving the user's reported outage was reproduced and fixed. Real account browsing still requires retesting.
