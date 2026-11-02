import type { BucketUsage, QiniuUsageAnalytics } from "@shared/s3.types";
import { useState } from "react";
import type { BucketUsageState } from "@/hooks/useBucketUsage";
import { intlLocale, localize, t, useT } from "@/lib/i18n";
import { IconArrowsRotate, IconInfo, IconSpinner } from "@/lib/icons";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";

interface BucketUsageStatusProps extends BucketUsageState {
  bucket: string;
  provider: string;
  online: boolean;
  refresh: () => void;
  cancel: () => void;
}

export function formatStorageBytes(bytes: number | null): string {
  if (bytes === null || !Number.isSafeInteger(bytes) || bytes < 0)
    return t("未知", "Unknown");
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1000)),
    units.length - 1,
  );
  return `${new Intl.NumberFormat(intlLocale(), {
    maximumFractionDigits: index === 0 ? 0 : 2,
  }).format(bytes / 1000 ** index)} ${units[index]}`;
}

function timestamp(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(intlLocale(), { hour12: false });
}

export function usageSourceLabel(
  source: BucketUsage["source"],
  provider: string,
): string {
  if (source === "r2") return t("R2 官方统计", "Official R2 analytics");
  if (source === "qiniu")
    return t("七牛官方分类统计", "Official Qiniu class analytics");
  return provider === "qiniu"
    ? t("七牛对象扫描", "Qiniu object scan")
    : t("S3 扫描统计", "S3 object scan");
}

export function usageBytesLabel(data: BucketUsage): string {
  if (data.bytes === null) return t("总量待确认", "Total unconfirmed");
  const lowerBound = data.source === "scan" && !data.complete;
  return `${lowerBound ? "≥ " : ""}${formatStorageBytes(data.bytes)}`;
}

function countLabel(value: number | null): string {
  return value === null
    ? t("未知", "Unknown")
    : value.toLocaleString(intlLocale());
}

export function qiniuUsageClassLabel(value: string): string {
  switch (value) {
    case "standard":
      return t("标准", "Standard");
    case "line":
      return t("低频", "Infrequent access");
    case "intelligent_tiering":
      return t("智能分层", "Intelligent tiering");
    case "archive_ir":
      return t("归档直读", "Archive instant retrieval");
    case "archive":
      return t("归档", "Archive");
    case "deep_archive":
      return t("深度归档", "Deep archive");
    default:
      return t("未知存储类型", "Unknown storage class");
  }
}

/** Kept in the existing usage popover; incomplete rows are never summed here. */
export function QiniuUsageBreakdown({
  analytics,
}: {
  analytics: QiniuUsageAnalytics;
}) {
  useT();
  const statusLabel = (state: string) => {
    switch (state) {
      case "available":
        return t("已取得", "Available");
      case "partial":
        return t("缺项／未对齐", "Partial / unaligned");
      case "forbidden":
        return t("权限不足", "Permission denied");
      case "unsupported":
        return t("未支持", "Unsupported");
      default:
        return t("不可用", "Unavailable");
    }
  };
  return (
    <section
      className="min-w-0 space-y-2 border-t border-border pt-2"
      aria-label={t(
        "七牛官方分类用量",
        "Official Qiniu usage by storage class",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <h3 className="font-medium">
          {t("七牛官方分类用量", "Official Qiniu class usage")}
        </h3>
        <span
          className={
            analytics.complete ? "text-muted-foreground" : "text-warning"
          }
        >
          {analytics.complete
            ? t("类别齐全 · 时间已对齐", "Complete · Time aligned")
            : t("部分统计 · 不合计", "Partial · Not summed")}
        </span>
      </div>
      <div className="max-h-64 overflow-auto rounded-md border border-border/70">
        <table className="w-full table-fixed text-left text-[11px]">
          <thead className="sticky top-0 bg-muted text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">
                {t("存储类型", "Storage class")}
              </th>
              <th className="w-20 px-1 py-1.5 text-right font-medium">
                {t("用量", "Size")}
              </th>
              <th className="w-16 px-2 py-1.5 text-right font-medium">
                {t("对象数", "Objects")}
              </th>
            </tr>
          </thead>
          <tbody>
            {analytics.classes.map((item) => (
              <tr
                key={item.storageClass}
                className="border-t border-border/60 align-top"
              >
                <td className="break-words px-2 py-2">
                  <div className="font-medium">
                    {qiniuUsageClassLabel(item.storageClass)}
                  </div>
                  <div
                    className={
                      item.state === "available"
                        ? "text-muted-foreground"
                        : "text-warning"
                    }
                  >
                    {statusLabel(item.state)}
                  </div>
                  {item.reason && (
                    <div className="mt-0.5 break-words text-muted-foreground">
                      {localize(item.reason)}
                    </div>
                  )}
                  {!analytics.complete && (
                    <div className="mt-0.5 text-muted-foreground">
                      {t("时间：", "At: ")}
                      {timestamp(item.measuredAt)}
                    </div>
                  )}
                </td>
                <td className="break-words px-1 py-2 text-right tabular-nums">
                  {formatStorageBytes(item.bytes)}
                </td>
                <td className="break-words px-2 py-2 text-right tabular-nums">
                  {countLabel(item.objectCount)}
                </td>
              </tr>
            ))}
            {analytics.classes.length === 0 && (
              <tr>
                <td colSpan={3} className="px-2 py-3 text-muted-foreground">
                  {t(
                    "未取得分类统计；这不表示空间为空。",
                    "No class metrics were returned; this does not mean the bucket is empty.",
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {analytics.complete && (
        <p className="text-muted-foreground">
          {t("统一统计时间：", "Aligned measurement: ")}
          {timestamp(analytics.measuredAt)}
        </p>
      )}
      {analytics.warning && (
        <p role="status" className="break-words text-warning">
          {localize(analytics.warning)}
        </p>
      )}
      <p className="text-muted-foreground">
        {t(
          "官方统计可能延迟。缺失或不同时间的数据不会按零补齐，也不会相加为全桶总量；此处不代表容量上限或账单金额。",
          "Official metrics can be delayed. Missing or differently timed data are not filled with zeros or summed into a bucket total. These values are not a capacity limit or a bill.",
        )}
      </p>
    </section>
  );
}

export function BucketUsageStatus({
  bucket,
  provider,
  online,
  data,
  loading,
  error,
  stale,
  cancelled,
  refresh,
  cancel,
}: BucketUsageStatusProps) {
  useT();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const partial = !!data && !data.complete;
  const lowerBound = partial && data?.source === "scan";
  const displayBytes = data
    ? usageBytesLabel(data)
    : loading
      ? t("统计中…", "Calculating…")
      : !online
        ? t("离线", "Offline")
        : error
          ? t("获取失败", "Failed to load")
          : t("未统计", "Not calculated");
  const sourceLabel = data ? usageSourceLabel(data.source, provider) : "";
  const detailText = data
    ? t(
        `${bucket}：${sourceLabel}，${data.bytes === null ? "总量待确认" : `${data.bytes.toLocaleString(intlLocale())} 字节`}，${countLabel(data.objectCount)} 个对象。统计时间：${timestamp(data.measuredAt)}${partial ? "；仅部分结果" : ""}${stale ? "；等待刷新" : ""}`,
        `${bucket}: ${sourceLabel}, ${data.bytes === null ? "total unconfirmed" : `${data.bytes.toLocaleString(intlLocale())} bytes`}, ${countLabel(data.objectCount)} objects. Measured at: ${timestamp(data.measuredAt)}${partial ? t("；仅部分结果", "; partial result only") : ""}${stale ? t("；等待刷新", "; refresh required") : ""}`,
      )
    : error
      ? localize(error)
      : loading
        ? t(
            "正在统计整个存储桶，包含全部子目录",
            "Calculating the entire bucket, including all subfolders",
          )
        : t(
            "尚未统计当前存储桶",
            "The current bucket has not been measured yet",
          );
  const tone = error || partial ? "text-warning" : "text-primary";

  return (
    <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden @[760px]/statusbar:gap-2.5">
          <span className="h-3 w-px shrink-0 bg-border" aria-hidden="true" />
          <span
            className="inline-flex min-w-0 shrink-0 items-center gap-1 whitespace-nowrap"
            title={detailText}
            aria-live="polite"
            aria-atomic="true"
            aria-busy={loading}
          >
            <span className="hidden @[540px]/statusbar:inline">
              {t("当前桶已用", "Bucket used")}
            </span>
            <span className="@[540px]/statusbar:hidden">
              {t("已用", "Used")}
            </span>
            {error ? (
              <PopoverTrigger
                className="rounded font-medium text-warning underline decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
                title={localize(error)}
                aria-label={t(
                  "用量获取失败，查看具体原因",
                  "Usage unavailable. View the reason",
                )}
              >
                {data
                  ? displayBytes
                  : t("获取失败 · 查看原因", "Failed · Details")}
              </PopoverTrigger>
            ) : (
              <span className={`font-medium tabular-nums ${tone}`}>
                {displayBytes}
              </span>
            )}
            {data && !loading && (stale || !!error) && (
              <span
                className="size-1.5 rounded-full bg-warning"
                role="img"
                aria-label={t("统计待刷新", "Usage needs refreshing")}
              />
            )}
          </span>
          {data && (
            <span className="hidden shrink-0 whitespace-nowrap tabular-nums @[640px]/statusbar:inline">
              · {lowerBound ? "≥ " : ""}
              {countLabel(data.objectCount)} {t("个对象", "objects")}
            </span>
          )}
          {provider === "r2" && (
            <span className="hidden shrink-0 items-center gap-2.5 whitespace-nowrap @[940px]/statusbar:inline-flex">
              <span className="h-3 w-px bg-border" aria-hidden="true" />
              {t("账号免费额度 10 GB·月", "Account free tier: 10 GB-month")}
            </span>
          )}
        </div>
        <PopoverTrigger
          className="flex size-7 shrink-0 items-center justify-center rounded text-foreground/45 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
          aria-label={t("查看存储用量说明", "View storage usage details")}
          title={t(
            "统计来源、时间和免费额度说明",
            "Source, timestamp and free-tier details",
          )}
        >
          <IconInfo className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          className="max-h-[min(70vh,32rem)] w-80 max-w-[calc(100vw-2rem)] gap-3 overflow-y-auto p-3 text-xs"
        >
          <PopoverTitle>
            {t("当前存储桶用量", "Current bucket usage")}
          </PopoverTitle>
          <p className="break-all font-medium">{bucket}</p>
          {data ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <dt className="text-muted-foreground">
                {t("对象内容大小", "Object content size")}
              </dt>
              <dd className="m-0 text-right tabular-nums">
                {lowerBound ? "≥ " : ""}
                {formatStorageBytes(data.bytes)}
              </dd>
              <dt className="text-muted-foreground">
                {t("对象数量", "Object count")}
              </dt>
              <dd className="m-0 text-right tabular-nums">
                {lowerBound ? "≥ " : ""}
                {countLabel(data.objectCount)}
              </dd>
              <dt className="text-muted-foreground">
                {t("统计来源", "Source")}
              </dt>
              <dd className="m-0 text-right">{sourceLabel}</dd>
              <dt className="text-muted-foreground">
                {t("统计时间", "Measured at")}
              </dt>
              <dd className="m-0 text-right">{timestamp(data.measuredAt)}</dd>
              <dt className="text-muted-foreground">
                {t("本次获取时间", "Fetched at")}
              </dt>
              <dd className="m-0 text-right">{timestamp(data.fetchedAt)}</dd>
              {data.metadataBytes !== undefined && (
                <>
                  <dt className="text-muted-foreground">
                    {t("元数据大小", "Metadata size")}
                  </dt>
                  <dd className="m-0 text-right">
                    {formatStorageBytes(data.metadataBytes)}
                  </dd>
                </>
              )}
            </dl>
          ) : (
            <p className="text-muted-foreground">
              {loading
                ? t("正在统计，请稍候。", "Calculating usage. Please wait.")
                : cancelled
                  ? t(
                      "已取消本次统计，可点击刷新重新获取。",
                      "Calculation cancelled. Refresh to try again.",
                    )
                  : t("暂未取得统计数据。", "No usage data is available yet.")}
            </p>
          )}
          {(partial || data?.warning || error) && (
            <p className="break-words text-warning" role="status">
              {error
                ? localize(error)
                : data?.warning
                  ? localize(data.warning)
                  : data?.source === "qiniu"
                    ? t(
                        "官方分类统计不完整或时间未对齐，全桶总量待确认。",
                        "Official class metrics are incomplete or unaligned. The bucket total is unconfirmed.",
                      )
                    : t(
                        "本次扫描尚未完成，显示的数值只是已扫描部分。",
                        "The scan is incomplete. These values cover only the scanned objects.",
                      )}
            </p>
          )}
          {data?.qiniuAnalytics && (
            <QiniuUsageBreakdown analytics={data.qiniuAnalytics} />
          )}
          {stale && data && !loading && !error && (
            <p className="text-muted-foreground">
              {t(
                "统计可能已过期或文件已有变化，请刷新统计。",
                "Usage may be outdated or objects may have changed. Refresh the calculation.",
              )}
            </p>
          )}
          <p className="text-muted-foreground">
            {data?.source === "qiniu"
              ? t(
                  "统计范围为当前整个存储桶，不受当前目录影响。官方数据按存储类型和统计时间提供，并非实时文件列表；请注意延迟及类型完整性。",
                  "The scope is the entire current bucket, independent of the open folder. Official metrics are grouped by storage class and timestamp rather than a live object listing; check delay and coverage.",
                )
              : t(
                  "包含整个存储桶的子目录；显示对象内容大小，不包含元数据和未完成的分段上传。扫描统计需要读取对象列表，可能产生列表请求费用。",
                  "Includes every subfolder in the bucket. Content size excludes metadata and unfinished multipart uploads. Scanning reads object lists and may incur list-operation charges.",
                )}
          </p>
          {provider === "r2" && (
            <div className="space-y-1 border-t border-border pt-2">
              <p className="font-medium">
                {t("账号免费额度：10 GB·月", "Account free tier: 10 GB-month")}
              </p>
              <p className="text-muted-foreground">
                {t(
                  "适用于 R2 标准存储，同一 Cloudflare 账号下所有桶共享，按存储量和时间计费。它不是容量上限，当前桶大小也不代表本月账号账单用量。",
                  "For R2 Standard storage, shared by all buckets in the same Cloudflare account and billed by storage size and time. This is not a capacity limit, and the current bucket size is not the account’s monthly billable usage.",
                )}
              </p>
              {data?.source !== "r2" && (
                <p className="text-muted-foreground">
                  {t(
                    "如需官方统计，可在编辑账号的“用量统计”中配置统计 API Token。",
                    "For official analytics, configure an analytics API token under Usage analytics when editing the account.",
                  )}
                </p>
              )}
            </div>
          )}
          {loading && (
            <button
              type="button"
              className="self-start text-primary underline underline-offset-2"
              onClick={cancel}
            >
              {t("取消本次统计", "Cancel calculation")}
            </button>
          )}
        </PopoverContent>
        <button
          type="button"
          className="flex size-7 shrink-0 items-center justify-center rounded text-foreground/55 transition-colors hover:bg-accent hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
          disabled={loading || !online}
          onClick={refresh}
          aria-label={
            loading
              ? t("正在刷新存储用量", "Refreshing storage usage")
              : error
                ? t("重试获取存储用量", "Retry storage usage")
                : t("刷新存储用量", "Refresh storage usage")
          }
          title={
            !online
              ? t(
                  "网络离线，连接后再刷新",
                  "Offline. Reconnect before refreshing",
                )
              : loading
                ? t(
                    "正在统计，可在用量说明中取消",
                    "Calculating. Cancel from the usage details",
                  )
                : t("刷新当前存储桶用量", "Refresh the current bucket usage")
          }
        >
          {loading ? (
            <IconSpinner className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <IconArrowsRotate className="size-3.5" />
          )}
        </button>
      </div>
    </Popover>
  );
}
