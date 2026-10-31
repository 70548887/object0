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

function formatStorageBytes(bytes: number): string {
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

function timestamp(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(intlLocale(), { hour12: false });
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
  const displayBytes = data
    ? `${partial ? "≥ " : ""}${formatStorageBytes(data.bytes)}`
    : loading
      ? t("统计中…", "Calculating…")
      : !online
        ? t("离线", "Offline")
        : error
          ? t("获取失败", "Failed to load")
          : t("未统计", "Not calculated");
  const sourceLabel =
    data?.source === "r2"
      ? t("R2 官方统计", "Official R2 analytics")
      : t("S3 扫描统计", "S3 object scan");
  const detailText = data
    ? t(
        `${bucket}：${sourceLabel}，${data.bytes.toLocaleString(intlLocale())} 字节，${data.objectCount.toLocaleString(intlLocale())} 个对象。统计时间：${timestamp(data.measuredAt)}${partial ? "；仅部分结果" : ""}${stale ? "；等待刷新" : ""}`,
        `${bucket}: ${sourceLabel}, ${data.bytes.toLocaleString(intlLocale())} bytes, ${data.objectCount.toLocaleString(intlLocale())} objects. Measured at: ${timestamp(data.measuredAt)}${partial ? t("；仅部分结果", "; partial result only") : ""}${stale ? t("；等待刷新", "; refresh required") : ""}`,
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
              · {partial ? "≥ " : ""}
              {data.objectCount.toLocaleString(intlLocale())}{" "}
              {t("个对象", "objects")}
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
                {partial ? "≥ " : ""}
                {formatStorageBytes(data.bytes)}
              </dd>
              <dt className="text-muted-foreground">
                {t("对象数量", "Object count")}
              </dt>
              <dd className="m-0 text-right tabular-nums">
                {partial ? "≥ " : ""}
                {data.objectCount.toLocaleString(intlLocale())}
              </dd>
              <dt className="text-muted-foreground">
                {t("统计来源", "Source")}
              </dt>
              <dd className="m-0 text-right">{sourceLabel}</dd>
              <dt className="text-muted-foreground">
                {t("统计时间", "Measured at")}
              </dt>
              <dd className="m-0 text-right">{timestamp(data.measuredAt)}</dd>
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
                  : t(
                      "本次扫描尚未完成，显示的数值只是已扫描部分。",
                      "The scan is incomplete. These values cover only the scanned objects.",
                    )}
            </p>
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
            {t(
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
