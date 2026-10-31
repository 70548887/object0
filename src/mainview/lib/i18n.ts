import { getLocale, useLocaleStore } from "@/stores/useLocaleStore";

// Keep translations next to the UI that owns them. This bounded, memory-only
// index also lets already-visible feedback switch language without remounting
// forms, discarding drafts or restarting transfer subscriptions.
const pairs = new Map<string, string>();
const reverse = new Map<string, string>();
const MAX_DYNAMIC_PAIRS = 4096;
export function t(zh: string, en: string): string {
  if (zh !== en && zh.length < 4096 && en.length < 4096) {
    if (pairs.size >= MAX_DYNAMIC_PAIRS && !pairs.has(zh)) {
      const oldest = pairs.keys().next().value;
      if (oldest !== undefined) {
        reverse.delete(pairs.get(oldest) ?? "");
        pairs.delete(oldest);
      }
    }
    pairs.set(zh, en);
    reverse.set(en, zh);
  }
  return getLocale() === "en" ? en : zh;
}
export function useT(): typeof t {
  useLocaleStore((state) => state.locale);
  return t;
}
export const intlLocale = (): string =>
  getLocale() === "en" ? "en-US" : "zh-CN";

const nativePairs: ReadonlyArray<readonly [string, string]> = [
  [
    "请求失败，后端未返回具体原因，请重试",
    "Request failed without a detailed reason. Please retry",
  ],
  [
    "统计 API Token 格式无效，请重新填写",
    "Invalid analytics API token format. Enter it again",
  ],
  ["该用量统计请求正在进行中", "This usage request is already running"],
  ["用量统计任务过多，请稍后重试", "Too many usage requests. Retry later"],
  ["用量统计请求标识无效", "Invalid usage request identifier"],
  ["R2 官方统计：", "Official R2 analytics: "],
  ["S3 扫描：", "S3 scan: "],
  [
    "存储服务返回了无效的对象大小，统计已停止",
    "Storage returned an invalid object size. Usage collection stopped",
  ],
  [
    "存储服务返回了无效的对象信息，统计已停止",
    "Storage returned invalid object information. Usage collection stopped",
  ],
  [
    "对象用量超出安全数值范围，无法准确显示",
    "Object usage exceeds the safe numerical range and cannot be displayed accurately",
  ],
  [
    "对象数量超出安全数值范围，无法准确显示",
    "Object count exceeds the safe numerical range and cannot be displayed accurately",
  ],
  ["对象数量超出安全数值范围", "Object count exceeds the safe numerical range"],
  [
    "存储桶用量超出安全数值范围，无法准确显示",
    "Bucket usage exceeds the safe numerical range and cannot be displayed accurately",
  ],
  [
    "未配置有效的 R2 统计接口地址",
    "No valid R2 analytics endpoint is configured",
  ],
  [
    "无法识别 R2 账号，请检查接口地址",
    "Could not identify the R2 account. Check the endpoint",
  ],
  ["R2 统计只支持官方接口地址", "R2 analytics requires an official endpoint"],
  [
    "无法从接口地址识别 R2 账号 ID",
    "Could not extract an R2 account ID from the endpoint",
  ],
  [
    "此 R2 管辖区域暂不支持官方统计",
    "Official analytics is not supported for this R2 jurisdiction",
  ],
  [
    "R2 返回了缺失或无效的用量数据",
    "R2 returned missing or invalid usage metrics",
  ],
  ["未配置 R2 用量统计令牌", "No R2 analytics token is configured"],
  ["无法初始化官方统计连接", "Could not initialize the analytics connection"],
  ["R2 官方统计请求失败", "Official R2 analytics request failed"],
  ["请检查统计令牌权限", "Check the analytics token permissions"],
  [
    "R2 官方统计响应过大，已停止读取",
    "The R2 analytics response is too large; reading stopped",
  ],
  ["读取 R2 官方统计响应失败", "Could not read the R2 analytics response"],
  ["R2 官方统计响应格式无效", "Invalid R2 analytics response format"],
  [
    "R2 官方统计没有返回当前账号",
    "R2 analytics did not return the current account",
  ],
  ["R2 官方统计缺少存储桶数据", "R2 analytics returned no bucket data"],
  ["R2 官方统计缺少用量字段", "R2 analytics is missing usage fields"],
  [
    "R2 官方统计缺少有效的统计时间",
    "R2 analytics is missing a valid measurement time",
  ],
  [
    "R2 官方统计的时间超出查询范围",
    "The R2 snapshot time falls outside the query range",
  ],
  [
    "定制版更新配置不完整，需要同时设置专用更新源和签名公钥。",
    "Custom updates require both a dedicated update feed and signing public key.",
  ],
  ["未找到密码库", "Vault not found"],
  [
    "系统钥匙串中没有保存的密码",
    "No passphrase is saved in the system keychain",
  ],
  [
    "保存的密码已过期，请手动解锁并重新保存。",
    "The saved passphrase is outdated. Unlock manually and save it again.",
  ],
  [
    "此设备的系统钥匙串不可用",
    "The system keychain is unavailable on this device",
  ],
  ["使用系统钥匙串解锁失败", "Could not unlock using the system keychain"],
  ["密码错误", "Incorrect passphrase"],
  ["恢复密钥无效", "Invalid recovery key"],
  ["未知错误", "Unknown error"],
  ["密码库已锁定", "The vault is locked"],
  ["未找到存储账号", "Storage account not found"],
  ["读取默认存储桶", "Read default bucket"],
  ["列出账号存储桶", "List account buckets"],
  ["加载文件列表", "Load files"],
  ["扫描存储桶用量", "Scan bucket usage"],
  [
    "访问被拒绝，请检查凭据是否有当前存储桶的对象列表读取权限",
    "Access denied. Check whether these credentials can list objects in this bucket",
  ],
  [
    "访问密钥 ID 无效，请检查保存的 S3 凭据及其所属账号",
    "Invalid access key ID. Check the saved S3 credentials and account",
  ],
  [
    "请求签名不匹配，请检查访问密钥、接口地址、区域和本机时间",
    "Signature mismatch. Check the secret key, endpoint, region and system clock",
  ],
  [
    "存储桶不存在，请检查桶名称及其所属账号或管辖区域",
    "Bucket not found. Check its name, account and jurisdiction",
  ],
  [
    "会话令牌无效或已过期，请更新凭据",
    "The session token is invalid or expired. Update the credentials",
  ],
  [
    "本机时间与存储服务相差过大，请校准系统时间后重试",
    "The system clock differs from the storage service. Correct the time and retry",
  ],
  [
    "请求超时，请检查网络连接后重试",
    "Request timed out. Check the connection and retry",
  ],
  [
    "接口域名解析失败，请检查接口地址、DNS 和网络连接",
    "DNS lookup failed. Check the endpoint, DNS and connection",
  ],
  [
    "TLS 连接或证书验证失败，请检查系统时间、证书和代理连接",
    "TLS or certificate validation failed. Check the clock, certificates and proxy",
  ],
  [
    "连接存储接口失败，请检查网络、代理和接口地址",
    "Could not connect to storage. Check the connection, proxy and endpoint",
  ],
  [
    "请求参数无效，请检查接口地址、区域和存储桶名称",
    "Invalid request. Check the endpoint, region and bucket name",
  ],
  [
    "存储服务返回了无法解析的响应，请检查接口地址及代理连接",
    "The storage response could not be parsed. Check the endpoint and proxy",
  ],
  [
    "存储服务请求过于频繁，请稍后重试",
    "The storage service is rate-limiting requests. Retry later",
  ],
  [
    "存储服务暂时不可用，请稍后重试",
    "Storage is temporarily unavailable. Retry later",
  ],
  [
    "存储服务拒绝了请求，请核对连接信息后重试",
    "Storage rejected the request. Check the connection settings",
  ],
  [
    "单页请求超时，请检查网络后重试",
    "A page request timed out. Check the connection and retry",
  ],
  ["用量统计已取消", "Usage request cancelled"],
  [
    "统计结果与当前存储桶不一致，请重新刷新",
    "Usage results do not match the current bucket. Refresh again",
  ],
  [
    "读取统计失败，请检查连接或权限",
    "Could not load usage. Check the connection and permissions",
  ],
  ["用量统计请求参数无效", "Invalid usage request parameters"],
  [
    "存储账号已变更，请重新刷新用量",
    "The account changed. Refresh usage again",
  ],
  ["用量统计超时，请稍后重试", "Usage collection timed out. Retry later"],
  [
    "扫描达到时间或分页上限，仅显示已扫描对象的用量下限。",
    "The scan reached its time or page limit. Only a lower bound is shown.",
  ],
  [
    "扫描未完成，当前值仅是已扫描对象的下限。",
    "The scan is incomplete; these values are only a lower bound.",
  ],
  [
    "扫描未完成，请检查网络或存储访问权限后重试；当前值仅是已扫描对象的下限。",
    "The scan is incomplete. Check the connection or access permissions; values are only a lower bound.",
  ],
  [
    "存储服务重复返回分页标识，扫描已停止；当前值仅是用量下限。",
    "Storage repeated a page cursor. The scan stopped; values are only a lower bound.",
  ],
  [
    "存储服务返回异常分页标识，扫描已停止；当前值仅是用量下限。",
    "Storage returned an invalid page cursor. The scan stopped; values are only a lower bound.",
  ],
  [
    "无法创建存储连接，请检查账号配置",
    "Could not create a storage connection. Check the account settings",
  ],
  [
    "R2 官方统计快照超过 24 小时，数据可能延迟。",
    "The official R2 snapshot is over 24 hours old and may be delayed.",
  ],
  [
    "R2 官方暂未生成此存储桶的用量统计",
    "Official R2 usage metrics are not available for this bucket yet",
  ],
  [
    "R2 官方统计不可用，请检查账号及统计令牌权限",
    "Official R2 metrics are unavailable. Check the account and analytics token permissions",
  ],
  ["无法连接 R2 官方统计接口", "Could not connect to the R2 analytics API"],
  [
    "本地定制版已停用自动更新，请手动安装定制版新版本。",
    "Automatic updates are disabled for this customized build. Install a new release manually.",
  ],
  ["自动更新已停用", "Automatic updates disabled"],
  [
    "本地定制版（自动更新已停用）",
    "Customized build (automatic updates disabled)",
  ],
];

export function clearMessageTranslations(): void {
  pairs.clear();
  reverse.clear();
}

const nativeByChineseLength = [...nativePairs].sort(
  (a, b) => b[0].length - a[0].length,
);
const nativeByEnglishLength = [...nativePairs].sort(
  (a, b) => b[1].length - a[1].length,
);

export function localize(message: string): string {
  if (!message) return message;
  const english = getLocale() === "en";
  const direct = english ? pairs.get(message) : reverse.get(message);
  if (direct !== undefined) return direct;
  const operationPrefixes: ReadonlyArray<readonly [string, string]> = [
    ["上传到 ", "Upload to "],
    ["下载 ", "Download "],
    ["复制 ", "Copy "],
    ["移动 ", "Move "],
  ];
  for (const [zh, en] of operationPrefixes) {
    const source = english ? zh : en;
    if (message.startsWith(source))
      return (english ? en : zh) + message.slice(source.length);
  }
  const nativeExact = nativePairs.find(
    ([zh, en]) => (english ? zh : en) === message,
  );
  if (nativeExact) return english ? nativeExact[1] : nativeExact[0];
  // Unknown provider text and user data must not be rewritten just because a
  // file name contains a word that happens to be a translated UI label.
  if (!nativePairs.some(([zh, en]) => message.startsWith(english ? zh : en)))
    return message;
  let result = message;
  for (const [zh, en] of english
    ? nativeByChineseLength
    : nativeByEnglishLength) {
    const source = english ? zh : en;
    if (result.includes(source))
      result = result.split(source).join(english ? en : zh);
  }
  // Only backend-generated operation prefixes are rewritten; object keys and
  // user account names stay byte-for-byte intact.
  if (english) {
    result = result
      .replace(/^上传到 /, "Upload to ")
      .replace(/^下载 /, "Download ")
      .replace(/^复制 /, "Copy ")
      .replace(/^移动 /, "Move ");
    result = result
      .replace(/失败：/g, " failed: ")
      .replace(/（HTTP (\d+)）/g, " (HTTP $1)");
  } else {
    result = result
      .replace(/^Upload to /, "上传到 ")
      .replace(/^Download /, "下载 ")
      .replace(/^Copy /, "复制 ")
      .replace(/^Move /, "移动 ");
  }
  return result;
}
