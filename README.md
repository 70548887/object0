# 云仓

**简体中文** | [English](README.en.md)

**一个桌面管理端，统一管理多个云存储账号。**

云仓（Yuncang）支持 Cloudflare R2、AWS S3 以及其他 S3 兼容存储，集中完成文件浏览、上传、下载、同步和分享。本项目基于 [sayedhfatimi/object0](https://github.com/sayedhfatimi/object0) 开发，保留上游 MIT 许可证和版权声明。

[![最新发布](https://img.shields.io/github/v/release/70548887/object0)](https://github.com/70548887/object0/releases) [![许可证](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## 下载与安装

前往 [GitHub 发布页](https://github.com/70548887/object0/releases) 下载 Windows x64 版本：

- **安装包**：按 Windows 安装向导操作，提供卸载入口。
- **便携 ZIP**：完整解压到本地可写目录，双击其中的 `object0.exe`。保留旁边的 `WebView2Runtime` 文件夹，不需要另行安装 WebView2。
- **完整性校验**：使用同一发布页中的 `SHA256SUMS.txt` 核对下载文件。

已发布的 v1.6.0 安装包仍显示历史名称 **object0**，界面仅中文。本次更名和中英切换已在最新源码中开发；已有发布文件不会被静默覆盖。仓库地址、内部程序文件名和数据标识暂时沿用原名以保持兼容。

## 中文与英文

软件默认使用 **简体中文**。在 **设置 → 语言 → English** 中切换，界面立即生效并保存选择，下次启动自动恢复。尚未解锁密码库时，也可以通过界面右上角切换语言。

切换语言不会翻译账号名、桶名、文件名、对象路径、URL 或访问凭据，也不会重置正在编辑的表单或传输任务。

本 README 默认中文，点击顶部 **English** 即可查看英文文档。

## 主要功能

- **多账号管理**：连接 Cloudflare R2、AWS S3、MinIO 等 S3 兼容服务。
- **文件管理**：浏览、上传、下载、复制、移动和文件夹操作。
- **本地密码库**：加密保存访问凭据，支持账号详情与连接测试。
- **传输与同步**：任务队列、文件夹同步及冲突处理。
- **分享文件**：生成有效期不超过 7 天的分享链接和二维码。
- **用量统计**：显示当前存储桶内容大小和对象数，支持有界 S3 扫描及可选 R2 官方统计。
- **桌面体验**：深浅主题、中英切换、键盘操作和窄窗口适配。

## 快速开始

1. 启动程序，创建或解锁本地密码库。
2. 添加存储账号，填写服务商、接口地址与访问凭据。
3. 对于 R2，接口地址通常为 `https://<账号ID>.r2.cloudflarestorage.com`，区域为 `auto`；桶级凭据需要填写默认存储桶。
4. 测试连接并保存，选择存储桶后管理文件。

实际可用操作取决于凭据权限。读取失败会显示错误，而不是将用量显示为零。

## 数据保存与升级兼容

- 现有账号及加密密码库继续保存在 Windows 的 `%USERPROFILE%\.config\object0`。
- 程序标识、系统钥匙串服务和浏览器偏好存储键保持原值，避免更名后丢失已有数据。
- “便携”表示应用无需安装，不表示账号跟随 U 盘移动；发布包不包含账号或密钥。
- 安装版与便携版共享本地数据，请一次只运行一个版本，更新前等待传输完成并正常退出。
- 上游自动更新默认停用，请从本仓库手动下载定制版本。
- 当前安装包未使用商业代码签名证书，Windows 可能显示未知发布者；请核对来源和 SHA256，不要关闭系统安全保护。

R2 的 **10 GB·月** 是标准存储的账号级免费计费额度，不是每个桶的容量上限。扫描对象可能产生列表请求费用，官方统计也可能有延迟。

## 开发

技术栈：**Tauri 2、Rust、React、TypeScript、Tailwind CSS**。项目使用 **Bun**，不使用 npm、pnpm 或 yarn。

```sh
bun install --frozen-lockfile
bun run build
bun run tauri dev
bun test tests/share-expiration.test.ts tests/share-expiration-i18n.test.ts tests/i18n.test.ts
```

Windows 打包需要按 `packaging/windows-runtime.json` 准备固定 WebView2 运行时。参见 [Windows 分发说明](docs/PORTABLE_ZH.md) 和 [开发约定](CLAUDE.md)。

## 验证范围

中英界面使用本地示例数据测试。真实 S3/R2 操作需要你自己的有效凭据；仓库和发布压缩包不含用户密钥。每个发布版本的具体测试范围、系统覆盖和已知限制以对应发行说明为准。

## 许可证与致谢

本项目采用 [MIT 许可证](LICENSE)，基于 **object0** 及其原作者、贡献者的工作。Microsoft WebView2 按其独立条款分发，许可文件随 Windows 包提供。本分支不将上游代码声明为原创。
