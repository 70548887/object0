# 七牛文件外链对照修复（2026-11-02）

本轮核对 Kodo Browser `2c5d7bad6c44e9d57529f8f19bf0faa7c2ee27dd`
锁定的 `kodo-s3-adapter-sdk@0.7.1`，不以 master 的不一致版本代替参考。
云仓仍为独立 Rust 实现，不嵌入 Electron 或复制七牛品牌资源。

## 已确认并修复的差异

- 官方 `listDomains` 保留原生源站、CDN、测试域名；旧实现一律禁用 CDN/test，且只接受 HTTPS，导致一些账号完全没有可选域名。
- 官方根据证书绑定/域名信息保留 HTTP 或 HTTPS。现在下载域名单独校验，不把 HTTP 下载支持扩展到公有 UC、管理 API 或分享门户；不会自动降级 HTTPS，也不默认勾选 HTTP。
- 用户明确选择 HTTP 后显示链接与下载令牌明文传输提示。请求重定向仍不自动跟随；未知地址、非标准公有端口、含路径/查询/凭据的 origin 被拒绝。
- CDN 发现地址与固定 SDK 对齐为 `https://api.qiniuapi.com`。授权空间使用官方 Portal 默认域名 schema；S3 地址不混作 Kodo 文件外链。
- 已确认公开且未保护的资源按官方逻辑生成不带下载签名的公开 URL，`accessMode=public, expiresAt=null`。私有、保护状态或权限未知资源继续签名，`accessMode=signed`。
- 未返回 `protected` 不能当作明确未保护。配置域名但未能确认空间关联时也不推断为公开。
- 分享界面、复制结果和历史记录识别公开 URL 无固定到期时间；公开资源不能靠客户端设定强制到期。私有/S3 限期行为保留。
- 拒绝与目标对象/所选域名矛盾、已过期、伪公开却含 `e/token` 的分享返回值，不复制这些错误结果或写入历史。

## 验证边界

自动化使用合成凭据、本地 HTTP fixture、官方签名算法固定向量以及真实组件/store 回调。
覆盖特殊字符对象键、HTTP 全链路解析、CDN/test 可选择、公开/私有/未知访问模式、域名信任隔离、旧 S3 返回兼容、历史记录和迟到请求。
没有使用聊天中的 AK/SK，没有真实云上传、删除、付费转换或真实外链可用性承诺。

生成外链不等于外部可访问性已验证。域名备案、证书、测试域名期限、CDN 自有访问规则、文件限制和空间权限仍可能影响实际访问。
如用户提供错误截图，可继续定位具体失败环节；不要要求其在聊天中发送密钥或完整私密链接。

目录分享与文件外链是独立流程。本次对照未发现公有目录分享主协议的明确差异，因此没有以修文件外链为由改写目录分享协议。
私有门户完整路径/额外参数兼容仍需单独环境验证，不能标为所有私有部署完整兼容。

## References

- [Kodo Browser client factory](https://github.com/qiniu/kodo-browser/blob/2c5d7bad6c44e9d57529f8f19bf0faa7c2ee27dd/src/renderer/modules/qiniu-client/common.ts)
- [Kodo Browser pinned dependencies](https://github.com/qiniu/kodo-browser/blob/2c5d7bad6c44e9d57529f8f19bf0faa7c2ee27dd/package.json)
- [Qiniu download token documentation](https://developer.qiniu.com/kodo/1202/download-token)
- Local verified SDK: `qiniu-kodo-evidence/audit-20261031/reference-sdk-071/package/dist/kodo.js` (`listDomains`, `getObjectURL`) and `dist/region.js`.

## English

The native file-link path now accepts confirmed bucket-associated origin, CDN and test domains, preserving their HTTP/HTTPS scheme. HTTP requires explicit selection and displays a clear warning; download origins never acquire management credential trust. Confirmed public, unprotected resources produce bare public URLs with no fixed expiry. Private/protected/unknown resources remain signed. The sharing UI and history no longer mislabel public links as expiring. Generated responses are bound to the requested key and selected native origin, with expired and contradictory results rejected. Tests use fixtures only; real cloud URL availability and private deployment acceptance are not claimed.
