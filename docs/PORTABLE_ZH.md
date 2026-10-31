# object0 Windows 中文版

## 便携压缩包

将整个 ZIP 解压到一个可写目录，双击其中的 `object0.exe` 即可启动。
保留 `WebView2Runtime` 文件夹与程序相邻；本包已包含固定版 Microsoft Edge WebView2 运行时，打开界面不要求另外安装运行时。
不要直接在压缩软件中运行 EXE，也不要只复制一个 EXE。

- 支持 Windows 10 / 11 的 x64 系统。
- 程序界面可离线打开；连接 S3 / R2、上传、下载和分享仍需网络及有效账号凭据。
- “便携”表示无需安装程序，不表示账号随 U 盘移动。账号与加密密码库继续保存在当前用户 C 盘的 `%USERPROFILE%\.config\object0`，不会存入本压缩包。
- 安装版与便携版使用同一份账号配置，请一次只运行一个版本。

## 安装包

`object0_<版本>_windows_x64_setup.exe` 是中文 NSIS 安装包，按向导安装即可。
安装或切换新版前，先正常退出旧版本并等待传输任务结束。发布包不包含任何预置账号、密钥或示例密码库。

## 完整性校验

下载同一版本的 `SHA256SUMS.txt`。在 PowerShell 中运行：

```powershell
Get-FileHash -Algorithm SHA256 .\object0_<版本>_windows_x64_portable.zip
Get-FileHash -Algorithm SHA256 .\object0_<版本>_windows_x64_setup.exe
```

将得到的哈希与校验文件对应项比较。本项目未声称具有 Windows 代码签名；发布页中的 SHA256 用于核对下载文件是否一致。

## 许可证与更新

object0 使用 MIT 许可证，原作者版权声明保留在随包 `LICENSE` 中。
Microsoft Edge WebView2 运行时版权归 Microsoft 所有，按其运行时分发条款提供。
完整 Microsoft 固定运行时许可随包放在 `WEBVIEW2-LICENSE.html`。固定运行时不自动升级，请使用后续整包更新获得运行时安全修复。
本地中文定制版默认停用上游自动更新，请从本 fork 的 GitHub Releases 手动下载新版本：
<https://github.com/70548887/object0/releases>

统计页面的 10 GB·月是 R2 标准存储的账号免费计费额度，不是单桶容量上限。真实连接失败时应查看界面给出的具体原因，不会将读取失败显示为 0。
