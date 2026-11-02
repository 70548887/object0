# 七牛用量：官方分类统计与明确来源的扫描回退

2026-11-01，开发分支 `feature/qiniu-kodo`。本功能已接入本地代码，仍需真实公有云验收；不代表整个七牛适配计划已完成，也未包含在既有发布包中。

## 界面保持简单

进入七牛空间后，底栏仍显示当前桶已用空间、对象数；点击信息按钮查看来源、统计时间、获取时间和分类明细，不新增仪表盘。

- 六类官方指标齐全且时间一致时，来源显示“七牛官方统计”。
- 官方结果缺项、权限不足、接口不支持、时间不一致或过旧时，保留分类诊断，尝试有界对象扫描。
- 扫描成功后主值明确标记“七牛对象扫描”，分类表仍是另一份官方证据，不会把两种来源混加。
- 只有未完成扫描的已扫描部分使用 `≥`。官方部分数据不视为用量下限，不相加；无法确认总量时显示“总量待确认／未知”。
- 有效完整零值才显示 0。空响应、缺字段、拒绝访问和查询失败不代表空桶。
- 七牛不显示 R2 免费额度，不推算剩余容量、容量上限或账单。

## 官方接口与数据口径

依据[七牛数据统计接口目录](https://developer.qiniu.com/kodo/3906/statistic-interface)，分别请求标准、低频、智能分层、归档直读、归档、深度归档六类的容量和对象数，共 12 条序列。

请求始终包含**原生空间名**，不使用 S3 别名，也不因缺少参数退化成账号级总量。生产入口仅开放公有云原生永久凭据、非显式 S3 绑定连接，固定七牛官方统计源地址；不把普通下载域名或私有分享 API 当作统计服务。

低频、归档直读、归档和深度归档的容量请求使用 `no_predel=1`，排除提前删除计费用量。对象数接口不附加此参数。智能分层省略 `tier`，使用其全层统计，不再重复累加各访问层。协议细节参考[低频容量](https://developer.qiniu.com/kodo/3910/space-line)、[深度归档容量](https://developer.qiniu.com/kodo/api/11180/space-deep-archive)和[智能分层容量](https://developer.qiniu.com/kodo/12755/space-intelligent-tiering)。这些数值仍属于服务端统计口径，不是应用承诺的实时账单。

请求采用带 `X-Qiniu-Date` 的 V2 签名，不跟随重定向；诊断不回显响应正文、签名或账号密钥。每条请求最多 4 秒，并发 3，响应体最多 512 KiB；总收集过程另有 24 秒保护。取消、锁库或账号编辑会中止仍在进行的统计及回退扫描。

## 时间与完整性

- 查询当天的五分钟粒度序列，独立于操作系统时区，使用固定 `+08:00` 日历窗口。**该查询时区来自官方示例日期与 Unix 时间的对应关系推断，并非文档明确承诺的参数规则**；真实环境验收必须核对这一点。
- 用服务端返回的 Unix 时间作为统计时间，不把获取时间伪装成统计时间。
- 选取所有 12 条序列共有的最新时间点，不取各类各自最新点后相加。
- 共同点距离查询时刻超过 30 分钟时不作为完整官方总量。**30 分钟是应用保守策略，不是七牛 SLA**。
- 数组长度、时间范围、五分钟边界、重复时间、安全整数、负数、浮点数、空值和溢出均验证；空序列不会补零。
- 某类仅有一个指标时，该指标保留自身真实时间，另一项未知；两项均存在但无共同时间时不并排显示成同一时点。
- 区域返回未识别的新存储类型时，整体覆盖视为不完整。重复未知类型只保留一条诊断。
- 零点刚切换日期时可能没有当前日快照，保留未知/扫描回退，不沿用上一日快照冒充当前值。

## 回退、缓存与边界

- 原生扫描没有目录分隔符和目录前缀，覆盖当前空间所有子目录；最多 1000 页，连同官方查询共用 60 秒预算。扫描不是原子快照，并发对象变化会影响结果。
- 扫描失败但已有完整读取的页面时，只展示已扫描下限；首屏即失败且官方不完整时，两项总值为 `null`，不生成零值。
- 现有 S3 扫描也不再将缺少分页状态的响应当成空桶成功。
- 完整主结果沿用 5 分钟缓存；官方部分结果不进入完整结果缓存。账号、服务商、桶或版本变化不会复用旧结果，迟到请求也不会覆盖新页面。
- 官方缺权限与扫描缺权限分别保留诊断；扫描可能产生列表请求费用。
- 私有云、临时/受限 S3 绑定的全桶统计仍未验证，不会扩大其授权范围或猜测公共统计服务。目录分享会话不调用这条全桶用量路径。

## 本地验收与剩余工作

使用模拟 HTTP 服务、合成凭据及前端状态/渲染测试验证签名、参数、分类完整性、公共时间点、空值、错误分类、扫描回退、取消和缓存。首次编译暴露并发请求的借用迭代器 `Send` 类型问题，已改为拥有数据的异步任务队列；原错误日志保留。

本地结果：**352 项 Rust 测试、206 项前端测试（1218 次断言）及 17 组隔离回归通过**；Rust 非测试检查、TypeScript/Vite 构建、5 个变更前端文件的 Biome 检查通过。现存未使用代码和前端大块体积警告仍保留，没有将它们描述为错误清零。

这不替代真实公有云、不同 IAM 权限或私有部署验收。未读取真实密码库、未使用聊天中的密钥、未执行真实云写入、存储类型转换、解冻或付费加速，也没有发布安装包。

证据沿用 `<LOCAL_EVIDENCE>\range-download-20261031` 四角色，保留前次基线并追加本次源代码、补丁、字面输出与独立回滚结果。协议来源研究记录为同目录 `usage-protocol-sources.md`。

## English summary

The existing status bar now supports official Qiniu class metrics and an explicitly labelled object-scan fallback. Twelve series cover bytes and object counts for six storage classes. Only a fresh common timestamp across every required series permits a complete official total. Missing, rejected, malformed, stale or differently timed data are never zero-filled. If scanning also fails before a usable page, the displayed totals remain unknown; only an incomplete scan uses the lower-bound marker.

Queries use the native bucket name, dated V2 signatures, no redirects and bounded requests. Early-deleted billed volume is excluded where the API supports it; intelligent-tiering layers are not counted twice. Fixed `+08:00` query dates are an inference from official examples, and the 30-minute freshness threshold is application policy. The returned server time, rather than fetch time, identifies a measurement.

Class details stay inside the existing info popover. Official and scanned values are not mixed, Qiniu never inherits R2's free-tier display, and neither source represents remaining capacity or a billing forecast. Lock, cancellation and profile changes abort pending work. Private/restricted/share-session whole-bucket analytics remain unavailable until their scope and deployment contracts are verified. Real-cloud acceptance and new packages are still pending.
