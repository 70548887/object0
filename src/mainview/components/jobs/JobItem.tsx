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
import { localize, t, useT } from "@/lib/i18n";
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

function jobTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    upload: t("上传", "Upload"),
    download: t("下载", "Download"),
    copy: t("复制", "Copy"),
    move: t("移动", "Move"),
    delete: t("删除", "Delete"),
    sync: t("同步", "Sync"),
    archive: t("打包", "Archive"),
  };
  return labels[type] ?? type;
}

function jobStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: t("排队中", "Queued"),
    running: t("进行中", "Active"),
    completed: t("已完成", "Completed"),
    failed: t("失败", "Failed"),
    cancelled: t("已取消", "Cancelled"),
  };
  return labels[status] ?? status;
}

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
  const t = useT();
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
  details.push([t("任务 ID", "Job ID"), job.id]);
  details.push([t("类型", "Type"), jobTypeLabel(job.type)]);
  details.push([t("状态", "Status"), jobStatusLabel(job.status)]);
  if (job.description)
    details.push([t("描述", "Description"), localize(job.description)]);
  if (job.createdAt)
    details.push([t("入队时间", "Queued at"), formatDate(job.createdAt)]);
  if (job.startedAt)
    details.push([t("开始时间", "Started at"), formatDate(job.startedAt)]);
  if (job.completedAt)
    details.push([t("完成时间", "Completed at"), formatDate(job.completedAt)]);
  if (job.startedAt) {
    details.push([
      isDone ? t("耗时", "Duration") : t("已用时间", "Elapsed"),
      formatDuration(job.startedAt, job.completedAt),
    ]);
  }
  if (job.bytesTotal && job.bytesTotal > 0) {
    details.push([t("总大小", "Total size"), formatBytes(job.bytesTotal)]);
    details.push([
      t("已传输", "Transferred"),
      formatBytes(job.bytesTransferred ?? 0),
    ]);
  }
  if (job.speed && job.speed > 0) {
    details.push([t("速度", "Speed"), formatSpeed(job.speed)]);
  }
  if (isDone && job.startedAt && job.completedAt && job.bytesTotal) {
    const elapsed =
      (new Date(job.completedAt).getTime() -
        new Date(job.startedAt).getTime()) /
      1000;
    if (elapsed > 0) {
      details.push([
        t("平均速度", "Average speed"),
        formatSpeed(job.bytesTotal / elapsed),
      ]);
    }
  }
  if (job.error) details.push([t("错误", "Error"), localize(job.error)]);

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
            {job.fileName || (job.description ? localize(job.description) : "")}
          </span>

          {/* Row 2: status + inline metadata */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-foreground/40">
            <span className="flex items-center gap-1">
              <StatusIcon status={job.status} />
              {jobStatusLabel(job.status)}
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
                  {formatETA(job.eta)}
                  {t(" 剩余", " remaining")}
                </span>
              ) : null}
            </div>
          )}

          {/* Queued indicator */}
          {job.status === "queued" && (
            <div className="mt-1 text-[10px] text-foreground/40">
              <IconHourglassStart className="mr-1 inline size-[8px]" />
              {t("正在排队等待...", "Waiting in the queue...")}
            </div>
          )}

          {/* Inline error for collapsed view */}
          {!open && job.error && (
            <div className="mt-1 truncate text-[10px] text-destructive/80">
              <IconTriangleExclamation className="mr-1 inline size-[8px]" />
              {localize(job.error)}
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
            title={t("取消", "Cancel")}
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
                        label === t("错误", "Error")
                          ? "text-destructive/80"
                          : ""
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
