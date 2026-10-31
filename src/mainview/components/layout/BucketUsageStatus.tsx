import { useState } from "react";
import type { BucketUsageState } from "@/hooks/useBucketUsage";
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
  return `${new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: index === 0 ? 0 : 2,
  }).format(bytes / 1000 ** index)} ${units[index]}`;
}

function timestamp(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-CN", { hour12: false });
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const partial = !!data && !data.complete;
  const displayBytes = data
    ? `${partial ? "≥ " : ""}${formatStorageBytes(data.bytes)}`
    : loading
      ? "统计中…"
      : !online
        ? "离线"
        : error
          ? "获取失败"
          : "未统计";
  const sourceLabel = data?.source === "r2" ? "R2 官方统计" : "S3 扫描统计";
  const detailText = data
    ? `${bucket}：${sourceLabel}，${data.bytes.toLocaleString("zh-CN")} 字节，${data.objectCount.toLocaleString("zh-CN")} 个对象。统计时间：${timestamp(data.measuredAt)}${partial ? "；仅部分结果" : ""}${stale ? "；等待刷新" : ""}`
    : (error ??
      (loading ? "正在统计整个存储桶，包含全部子目录" : "尚未统计当前存储桶"));
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
            <span className="hidden @[540px]/statusbar:inline">当前桶已用</span>
            <span className="@[540px]/statusbar:hidden">已用</span>
            {error ? (
              <PopoverTrigger
                className="rounded font-medium text-warning underline decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
                title={error}
                aria-label="用量获取失败，查看具体原因"
              >
                {data ? displayBytes : "获取失败 · 查看原因"}
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
                aria-label="统计待刷新"
              />
            )}
          </span>
          {data && (
            <span className="hidden shrink-0 whitespace-nowrap tabular-nums @[640px]/statusbar:inline">
              · {partial ? "≥ " : ""}
              {data.objectCount.toLocaleString("zh-CN")} 个对象
            </span>
          )}
          {provider === "r2" && (
            <span className="hidden shrink-0 items-center gap-2.5 whitespace-nowrap @[940px]/statusbar:inline-flex">
              <span className="h-3 w-px bg-border" aria-hidden="true" />
              账号免费额度 10 GB·月
            </span>
          )}
        </div>
        <PopoverTrigger
          className="flex size-7 shrink-0 items-center justify-center rounded text-foreground/45 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
          aria-label="查看存储用量说明"
          title="统计来源、时间和免费额度说明"
        >
          <IconInfo className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          className="max-h-[min(70vh,32rem)] w-80 max-w-[calc(100vw-2rem)] gap-3 overflow-y-auto p-3 text-xs"
        >
          <PopoverTitle>当前存储桶用量</PopoverTitle>
          <p className="break-all font-medium">{bucket}</p>
          {data ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <dt className="text-muted-foreground">对象内容大小</dt>
              <dd className="m-0 text-right tabular-nums">
                {partial ? "≥ " : ""}
                {formatStorageBytes(data.bytes)}
              </dd>
              <dt className="text-muted-foreground">对象数量</dt>
              <dd className="m-0 text-right tabular-nums">
                {partial ? "≥ " : ""}
                {data.objectCount.toLocaleString("zh-CN")}
              </dd>
              <dt className="text-muted-foreground">统计来源</dt>
              <dd className="m-0 text-right">{sourceLabel}</dd>
              <dt className="text-muted-foreground">统计时间</dt>
              <dd className="m-0 text-right">{timestamp(data.measuredAt)}</dd>
              {data.metadataBytes !== undefined && (
                <>
                  <dt className="text-muted-foreground">元数据大小</dt>
                  <dd className="m-0 text-right">
                    {formatStorageBytes(data.metadataBytes)}
                  </dd>
                </>
              )}
            </dl>
          ) : (
            <p className="text-muted-foreground">
              {loading
                ? "正在统计，请稍候。"
                : cancelled
                  ? "已取消本次统计，可点击刷新重新获取。"
                  : "暂未取得统计数据。"}
            </p>
          )}
          {(partial || data?.warning || error) && (
            <p className="break-words text-warning" role="status">
              {error ??
                data?.warning ??
                "本次扫描尚未完成，显示的数值只是已扫描部分。"}
            </p>
          )}
          {stale && data && !loading && !error && (
            <p className="text-muted-foreground">
              统计可能已过期或文件已有变化，请刷新统计。
            </p>
          )}
          <p className="text-muted-foreground">
            包含整个存储桶的子目录；显示对象内容大小，不包含元数据和未完成的分段上传。扫描统计需要读取对象列表，可能产生列表请求费用。
          </p>
          {provider === "r2" && (
            <div className="space-y-1 border-t border-border pt-2">
              <p className="font-medium">账号免费额度：10 GB·月</p>
              <p className="text-muted-foreground">
                适用于 R2 标准存储，同一 Cloudflare
                账号下所有桶共享，按存储量和时间计费。它不是容量上限，当前桶大小也不代表本月账号账单用量。
              </p>
              {data?.source !== "r2" && (
                <p className="text-muted-foreground">
                  如需官方统计，可在编辑账号的“用量统计”中配置统计 API Token。
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
              取消本次统计
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
              ? "正在刷新存储用量"
              : error
                ? "重试获取存储用量"
                : "刷新存储用量"
          }
          title={
            !online
              ? "网络离线，连接后再刷新"
              : loading
                ? "正在统计，可在用量说明中取消"
                : "刷新当前存储桶用量"
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
