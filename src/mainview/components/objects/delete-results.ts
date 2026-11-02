import { localize, t } from "@/lib/i18n";

export interface DeleteItemResult {
  key: string;
  success: boolean;
  error?: string;
}

export interface DeleteSummary {
  results: DeleteItemResult[];
  succeeded: number;
  failed: DeleteItemResult[];
}

// Exact diagnostics emitted by the native deletion adapter. Never split or
// translate arbitrary object keys/provider text based on a slash delimiter.
const NATIVE_DELETE_REASONS = [
  [
    "删除结果未确认，请刷新列表后核对，勿假定文件已删除",
    "Deletion is unconfirmed; refresh and verify before retrying",
  ],
  [
    "删除结果未确认，请刷新列表后核对",
    "Deletion is unconfirmed; refresh and verify",
  ],
  [
    "访问被拒绝，请检查对象删除权限",
    "Access denied; check object-delete permission",
  ],
  ["对象删除参数无效", "Invalid object-delete argument"],
  [
    "对象不存在，未取得删除确认",
    "Object does not exist; deletion was not confirmed",
  ],
  [
    "存储服务限流，请稍后重试",
    "Storage service rate-limited the operation; retry later",
  ],
  [
    "存储服务暂时失败，删除结果未确认",
    "Storage service failed; deletion is unconfirmed",
  ],
] as const;

function localizeNativeReason(error: string): string {
  const pair = NATIVE_DELETE_REASONS.find(
    ([zh, en]) => error === `${zh} / ${en}`,
  );
  return pair ? t(pair[0], pair[1]) : localize(error);
}

function missingResult() {
  return t(
    "服务未确认此对象的删除结果；请刷新核对，不要当作已删除",
    "The service did not confirm this object's deletion. Refresh and verify; do not assume success",
  );
}

function invalidResult() {
  return t(
    "服务返回了不匹配或无效的删除结果；请刷新核对",
    "The service returned mismatched or invalid deletion results. Refresh and verify",
  );
}

function safeError(error: unknown): string {
  if (typeof error !== "string" || !error.trim())
    return t("删除失败，服务未提供原因", "Deletion failed without a reason");
  // The native API returns bounded diagnostics. Do not expose a future raw
  // request, signed URL or credential-bearing SDK error through this UI path.
  if (
    error.length > 512 ||
    /https?:\/\/|authorization\s*:|bearer\s+|x-amz-|secret[\s_-]*(?:access[\s_-]*)?key|access[\s_-]*key|session[\s_-]*token|upload[\s_-]*token|[?&](?:token|signature)=/i.test(
      error,
    )
  )
    return t(
      "删除失败；可能包含敏感信息的服务详情已隐藏，请检查账号权限与连接",
      "Deletion failed. Potentially sensitive service details were hidden; check permissions and connection settings",
    );
  return localizeNativeReason(
    error.trim().split("\r").join(" ").split("\n").join(" "),
  );
}

/** RPC completion is not per-object success. Results are bound to the exact
 * original key set, and malformed/absent confirmation fails closed. */
export function summarizeDeleteResults(
  requestedKeys: readonly string[],
  report: unknown,
): DeleteSummary {
  const keys = [...new Set(requestedKeys)];
  const requested = new Set(keys);
  const allFailed = (error: string): DeleteSummary => ({
    results: keys.map((key) => ({ key, success: false, error })),
    succeeded: 0,
    failed: keys.map((key) => ({ key, success: false, error })),
  });
  if (!report || typeof report !== "object" || !("results" in report))
    return allFailed(missingResult());
  const values = report.results;
  if (!Array.isArray(values)) return allFailed(invalidResult());
  if (values.length > keys.length) return allFailed(invalidResult());
  const received = new Map<string, DeleteItemResult>();
  for (const value of values) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.key !== "string" ||
      !requested.has(value.key) ||
      typeof value.success !== "boolean" ||
      received.has(value.key) ||
      (value.success && value.error !== undefined && value.error !== null)
    )
      return allFailed(invalidResult());
    received.set(value.key, {
      key: value.key,
      success: value.success,
      ...(value.success ? {} : { error: safeError(value.error) }),
    });
  }
  const results = keys.map(
    (key) =>
      received.get(key) ?? { key, success: false, error: missingResult() },
  );
  const failed = results.filter((result) => !result.success);
  return { results, succeeded: results.length - failed.length, failed };
}

export function deleteFailureDetails(
  bucket: string,
  failures: readonly DeleteItemResult[],
): string {
  return [
    `${t("存储桶", "Bucket")}: ${JSON.stringify(bucket)}`,
    ...failures.map(
      (result) =>
        `${JSON.stringify(result.key)}: ${localize(result.error ?? missingResult())}`,
    ),
  ].join("\n");
}
