import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import type { JobInfo } from "@shared/job.types";
import { memo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  formatBytes,
  formatDate,
  formatDuration,
  formatETA,
  formatRelativeDate,
  formatSpeed,
} from "@/lib/formatters";
import {
  IconArrowsRotate,
  IconBan,
  IconChevronRight,
  IconCircleCheck,
  IconCircleXmark,
  IconClock,
  IconCloudArrowDown,
  IconCloudArrowUp,
  IconCopy,
  IconDatabase,
  IconFileZipper,
  IconGaugeHigh,
  IconHourglassStart,
  IconScissors,
  IconSpinner,
  IconTrashCan,
  IconTriangleExclamation,
  IconXmark,
} from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useJobStore } from "@/stores";

interface JobItemProps {
  job: JobInfo;
}

const jobTypeLabels: Record<string, string> = {
  upload: "上传",
  download: "下载",
  copy: "复制",
  move: "移动",
  delete: "删除",
  sync: "同步",
  archive: "打包",
};

const jobStatusLabels: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function TypeIcon({ type }: { type: string }) {
  const cls = "size-3.5";
  switch (type) {
    case "upload":
      return <IconCloudArrowUp className={`${cls} text-success`} />;
    case "download":
      return <IconCloudArrowDown className={`${cls} text-info`} />;
    case "copy":
      return <IconCopy className={`${cls} text-primary`} />;
    case "move":
      return <IconScissors className={`${cls} text-warning`} />;
    case "delete":
      return <IconTrashCan className={`${cls} text-destructive`} />;
    case "sync":
      return <IconArrowsRotate className={`${cls} text-primary`} />;
    case "archive":
      return <IconFileZipper className={`${cls} text-secondary`} />;
    default:
      return <IconArrowsRotate className={`${cls} text-primary`} />;
  }
}

function StatusIcon({ status }: { status: string }) {
  const cls = "size-3";
  switch (status) {
    case "queued":
      return <IconClock className={`${cls} text-foreground/40`} />;
    case "running":
      return <IconSpinner className={`${cls} text-info animate-spin`} />;
    case "completed":
      return <IconCircleCheck className={`${cls} text-success`} />;
    case "failed":
      return <IconCircleXmark className={`${cls} text-destructive`} />;
    case "cancelled":
      return <IconBan className={`${cls} text-warning`} />;
    default:
      return null;
  }
}

const JobItemInner = function JobItemInner({ job }: JobItemProps) {
  const cancelJob = useJobStore((s) => s.cancelJob);
  const [open, setOpen] = useState(false);

  const isActive = job.status === "running" || job.status === "queued";
  const isRunning = job.status === "running";
  const isDone =
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled";

  const hasProgress = isActive && !!job.bytesTotal && job.bytesTotal > 0;
  const pct = job.percentage ?? 0;

  /* ── inline metadata (under filename, next to status) ── */
  const inlineChips: { label: string; showDb?: boolean }[] = [];

  if (isDone && job.bytesTotal && job.bytesTotal > 0) {
    inlineChips.push({
      label: formatBytes(job.bytesTotal),
      showDb: true,
    });
  }

  /* ── right-side stacked metadata ── */
  const rightChips: { label: string; showClock?: boolean }[] = [];

  if (isDone && job.startedAt && job.completedAt) {
    rightChips.push({
      label: formatDuration(job.startedAt, job.completedAt),
      showClock: true,
    });
  } else if (isActive && job.startedAt) {
    rightChips.push({
      label: formatDuration(job.startedAt),
      showClock: true,
    });
  }

  if (isDone && job.completedAt) {
    rightChips.push({ label: formatRelativeDate(job.completedAt) });
  } else if (job.createdAt) {
    rightChips.push({ label: formatRelativeDate(job.createdAt) });
  }

  /* ── detail rows ── */
  const details: [string, string][] = [];
  details.push(["任务 ID", job.id]);
  details.push(["类型", jobTypeLabels[job.type] ?? job.type]);
  details.push(["状态", jobStatusLabels[job.status] ?? job.status]);
  if (job.description) details.push(["描述", job.description]);
  if (job.createdAt) details.push(["入队时间", formatDate(job.createdAt)]);
  if (job.startedAt) details.push(["开始时间", formatDate(job.startedAt)]);
  if (job.completedAt) details.push(["完成时间", formatDate(job.completedAt)]);
  if (job.startedAt) {
    details.push([
      isDone ? "耗时" : "已用时间",
      formatDuration(job.startedAt, job.completedAt),
    ]);
  }
  if (job.bytesTotal && job.bytesTotal > 0) {
    details.push(["总大小", formatBytes(job.bytesTotal)]);
    details.push(["已传输", formatBytes(job.bytesTransferred ?? 0)]);
  }
  if (job.speed && job.speed > 0) {
    details.push(["速度", formatSpeed(job.speed)]);
  }
  if (isDone && job.startedAt && job.completedAt && job.bytesTotal) {
    const elapsed =
      (new Date(job.completedAt).getTime() -
        new Date(job.startedAt).getTime()) /
      1000;
    if (elapsed > 0) {
      details.push(["平均速度", formatSpeed(job.bytesTotal / elapsed)]);
    }
  }
  if (job.error) details.push(["错误", job.error]);

  return (
    <div className="group">
      {/* ── Collapsed header row ── */}
      <button
        type="button"
        className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/80 ${
          isDone ? "opacity-70 hover:opacity-100" : ""
        }`}
        onClick={() => setOpen((v) => !v)}
      >
        {/* Chevron + type icon stacked */}
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <IconChevronRight
            className="text-[9px] text-foreground/30"
            style={{
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 150ms ease",
            }}
          />
          <span className="text-sm">
            <TypeIcon type={job.type} />
          </span>
        </div>

        {/* Centre: name + progress block */}
        <div className="min-w-0 flex-1">
          {/* Row 1: filename */}
          <span className="block truncate font-medium text-xs leading-tight">
            {job.fileName || job.description}
          </span>

          {/* Row 2: status + inline metadata */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-foreground/40">
            <span className="flex items-center gap-1">
              <StatusIcon status={job.status} />
              {jobStatusLabels[job.status] ?? job.status}
            </span>
            {inlineChips.map((chip) => (
              <span
                key={chip.label}
                className="whitespace-nowrap font-mono tabular-nums"
              >
                {chip.showDb && (
                  <IconDatabase className="mr-0.5 inline size-[8px]" />
                )}
                {chip.label}
              </span>
            ))}
          </div>

          {/* Progress bar */}
          {hasProgress && (
            <div className="mt-1.5">
              <ProgressPrimitive.Root value={pct} className="flex flex-wrap">
                <ProgressPrimitive.Track className="relative flex h-2 w-full items-center overflow-x-hidden rounded-full bg-muted/80">
                  <ProgressPrimitive.Indicator
                    className={cn(
                      "h-full transition-all",
                      job.status === "running"
                        ? "bg-linear-to-r from-primary to-info"
                        : "bg-primary/60",
                    )}
                  />
                </ProgressPrimitive.Track>
              </ProgressPrimitive.Root>
            </div>
          )}

          {/* Transfer stats — separate line below progress bar */}
          {isRunning && job.bytesTotal && job.bytesTotal > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-foreground/50 tabular-nums">
              <span>
                {formatBytes(job.bytesTransferred ?? 0)}
                <span className="text-foreground/30"> / </span>
                {formatBytes(job.bytesTotal)}
              </span>
              <span className="font-semibold text-foreground/60">{pct}%</span>
              {job.speed ? (
                <span>
                  <IconGaugeHigh className="mr-0.5 inline size-[8px] text-info/60" />
                  {formatSpeed(job.speed)}
                </span>
              ) : null}
              {job.eta ? (
                <span>
                  <IconClock className="mr-0.5 inline size-[8px] text-foreground/30" />
                  {formatETA(job.eta)} 剩余
                </span>
              ) : null}
            </div>
          )}

          {/* Queued indicator */}
          {job.status === "queued" && (
            <div className="mt-1 text-[10px] text-foreground/40">
              <IconHourglassStart className="mr-1 inline size-[8px]" />
              正在排队等待...
            </div>
          )}

          {/* Inline error for collapsed view */}
          {!open && job.error && (
            <div className="mt-1 truncate text-[10px] text-destructive/80">
              <IconTriangleExclamation className="mr-1 inline size-[8px]" />
              {job.error}
            </div>
          )}
        </div>

        {/* Right-side stacked: duration + time ago */}
        {rightChips.length > 0 && (
          <div className="hidden shrink-0 flex-col items-end gap-0.5 pt-0.5 sm:flex">
            {rightChips.map((chip) => (
              <span
                key={chip.label}
                className="whitespace-nowrap font-mono text-[10px] text-foreground/40 tabular-nums"
              >
                {chip.showClock && (
                  <IconClock className="mr-1 inline size-[8px]" />
                )}
                {chip.label}
              </span>
            ))}
          </div>
        )}

        {/* Cancel button */}
        {isActive && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-foreground/40 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              cancelJob(job.id);
            }}
            title={"取消"}
          >
            <IconXmark className="size-3.5" />
          </Button>
        )}
      </button>

      {/* ── Expanded detail panel ── */}
      {open && (
        <div className="overflow-hidden">
          <div className="border-border/60 border-t bg-card/60 px-8 py-2">
            <table className="w-full text-[11px]">
              <tbody>
                {details.map(([label, value]) => (
                  <tr key={label}>
                    <td className="whitespace-nowrap py-0.5 pr-4 align-top font-semibold text-foreground/40">
                      {label}
                    </td>
                    <td
                      className={`break-all py-0.5 font-mono text-foreground/70 ${
                        label === "Error" ? "text-destructive/80" : ""
                      }`}
                    >
                      {value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export const JobItem = memo(JobItemInner);
