# 七牛分享域名默认选择（2026-11-02）

按用户最新要求，文件分享弹窗读取当前空间域名后，自动选中列表中第一个可用域名。
这覆盖了此前要求所有发现域名均手动选择的 UI 行为。

- 依照显示顺序选择，不优先跳到后面的 HTTPS 或账号默认项；已配置域名如果排在首位且可用，自然优先。
- HTTP 同样可以成为默认项，保留明文传输提示，不修改成 HTTPS，也不从失败的 HTTPS 自动降级。
- 禁用、未通过原地址校验或非 Kodo 的域名不被选中；没有可用域名则保持空。
- 手动切换或取消选择不会被普通重渲染覆盖；换空间、换文件或点击重新读取时重新按新列表选首项。
- 选中域名不是请求访问：仍需点击“生成链接”或下载；不自动生成、复制、下载或修改账号配置。
- 后端仍校验实际传入域名与当前账号/空间/版本，不扩大管理接口凭据信任。
- 修复 HTTP 开头的双语提示显示为中文和英文同时堆叠的问题，两种界面语言分别显示对应文字。

## English

The file-sharing dialog now selects the first available domain in the validated list when discovery completes. HTTP is eligible with its warning retained. The scheme and account configuration do not change. Manual changes or clearing the selection survive ordinary rerenders; a new target or explicit reload uses the new list's first available item. No link generation, copying or download happens automatically. Server-side domain and account checks remain unchanged.
