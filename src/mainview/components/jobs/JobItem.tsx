import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import type { JobInfo } from "@shared/job.types";
import { memo, useId, useState } from "react";
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
  IconPause,
  IconPlay,
  IconScissors,
  IconSpinner,
  IconTrashCan,
  IconTriangleExclamation,
  IconXmark,
} from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useJobStore } from "@/stores";
import { resumableJobActions } from "@/stores/useJobStore";
import { toast } from "../common/Toast";
import {
  jobLocationCopyText,
  jobLocationRows,
  jobLocationSummary,
} from "./job-location";

interface JobItemProps {
  job: JobInfo;
}

/** A resumable flag is granted by Rust for the actual task. These labels do
 * not infer resumability from a provider or from the download type itself. */
export function resumableJobCopy(type: JobInfo["type"]) {
  if (type === "download")
    return {
      recovery: t(
        "手动恢复时重新核对远端对象身份、Range 响应和本地临时文件；不会自动覆盖已有目标。",
        "Manual resume revalidates remote object identity, the Range response and the local temporary file. Existing destination files are not automatically overwritten.",
      ),
      cancellationRecovery: t(
        "已记录取消请求；重试只清理本任务临时文件，不会重新下载，也不删除目标或云端文件。",
        "Cancellation is recorded; retry only cleans up this task's temporary file. It never redownloads or deletes destination or cloud files.",
      ),
      cancellationConfirm: t(
        "取消只清理本任务已验证的本地临时文件，不删除已有目标或云端文件；清理后不能续传。若完整文件已经交付，将保留目标并显示真实完成状态。是否取消？",
        "Cancel only removes this task's verified local temporary file, never existing destination or cloud files; it cannot resume after cleanup. If the complete file was already delivered, it is retained and the actual completed status is shown. Cancel?",
      ),
      pauseLabel: t(
        "暂停并保留下载断点",
        "Pause and retain download checkpoint",
      ),
      resumeLabel: t("恢复下载", "Resume download"),
      retryLabel: t("重试安全下载恢复", "Retry safe download resume"),
      heldHint: t(
        "已保留本地下载断点；手动恢复时核对对象身份、Range 与临时文件，不会自动下载。",
        "Local download checkpoint retained. Manual resume revalidates object identity, Range and the temporary file; no automatic download.",
      ),
      cancellationHeldHint: t(
        "已记录取消请求；继续操作只清理本任务临时文件，不会重新下载，也不删除目标或云端文件。",
        "Cancellation is recorded. Continuing only cleans up this task's temporary file; it never redownloads or deletes destination or cloud files.",
      ),
      activeCancellationHint: t(
        "正在确认本地取消清理；不会重新下载，也不会删除已有目标或云端文件。",
        "Local cancellation cleanup is being confirmed; no redownload or deletion of existing destination or cloud files will be started.",
      ),
      completedAfterCancellationHint: t(
        "本地文件已完整交付；取消请求未删除目标或云端文件。",
        "The local file was fully delivered; the cancellation request did not delete destination or cloud files.",
      ),
    };
  return {
    recovery: t(
      "手动恢复并重新校验来源与服务端分片；不会自动重新初始化过期会话。",
      "Resume manually to revalidate the source and server parts. Expired sessions are not reinitialized automatically.",
    ),
    cancellationRecovery: t(
      "已记录取消请求；重试只继续取消清理，不会重新上传。",
      "Cancellation is recorded; retry only continues cancellation cleanup and never reuploads.",
    ),
    cancellationConfirm: t(
      "取消将终止已确认的上传会话并清理分片，不能像暂停一样恢复。是否取消？",
      "Cancel terminates the confirmed upload session and cleans up its parts; unlike pausing, it cannot be resumed. Cancel?",
    ),
    pauseLabel: t("暂停并保留分片", "Pause and retain uploaded parts"),
    resumeLabel: t("恢复上传", "Resume upload"),
    retryLabel: t("重试安全续传", "Retry safe resume"),
    heldHint: t(
      "已保留断点；恢复时重新校验，不会自动上传。",
      "Checkpoint retained. Resume revalidates it; no automatic upload.",
    ),
    cancellationHeldHint: t(
      "已记录取消请求；继续操作只清理上传会话，不会重新上传。",
      "Cancellation is recorded. Continuing only cleans up the upload session; it never reuploads.",
    ),
    activeCancellationHint: t(
      "正在确认取消清理；不会重新上传。",
      "Cancellation cleanup is being confirmed; no reupload will be started.",
    ),
    completedAfterCancellationHint: t(
      "完成提交已确认；取消请求未删除已完成对象。",
      "The commit completed; the cancellation request did not delete the completed object.",
    ),
  };
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
    paused: t("已暂停", "Paused"),
    interrupted: t("已中断，待恢复", "Interrupted; resume required"),
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
    case "paused":
      return <IconPause className={`${cls} text-warning`} />;
    case "interrupted":
      return <IconTriangleExclamation className={`${cls} text-warning`} />;
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
  const pauseJob = useJobStore((s) => s.pauseJob);
  const resumeJob = useJobStore((s) => s.resumeJob);
  const retryJob = useJobStore((s) => s.retryJob);
  const pending = useJobStore((s) => s.pendingJobIds.has(job.id));
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const actions = resumableJobActions(job);
  const resumableCopy = resumableJobCopy(job.type);

  const isActive = job.status === "running" || job.status === "queued";
  const isRunning = job.status === "running";
  const isDone =
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled";

  const isHeld = job.status === "paused" || job.status === "interrupted";
  const hasProgress =
    (isActive || isHeld) && !!job.bytesTotal && job.bytesTotal > 0;
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
  details.push(...jobLocationRows(job));
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
  if (job.resumable)
    details.push([
      t("恢复方式", "Recovery"),
      job.cancelRequested
        ? resumableCopy.cancellationRecovery
        : resumableCopy.recovery,
    ]);
  if (job.attempt !== undefined)
    details.push([t("执行轮次", "Attempt"), String(job.attempt)]);
  const runAction = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error: unknown) {
      toast.error(
        error instanceof Error
          ? localize(error.message)
          : t(
              "任务操作失败，请刷新后重试",
              "Job action failed. Refresh and retry",
            ),
      );
    }
  };
  const requestCancel = () => {
    if (job.resumable && !window.confirm(resumableCopy.cancellationConfirm))
      return;
    void runAction(() => cancelJob(job.id));
  };
  const locationSummary = jobLocationSummary(job);
  const locationCopy = jobLocationCopyText(job);
  const copyLocation = async () => {
    try {
      await navigator.clipboard.writeText(locationCopy);
      toast.success(t("任务位置信息已复制", "Job location copied"));
    } catch {
      toast.error(
        t(
          "复制失败，可选中详情中的位置信息手动复制。",
          "Copy failed. Select the location details and copy them manually.",
        ),
      );
    }
  };

  return (
    <div className="group">
      {/* ── Collapsed header row ── */}
      <div
        className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/80 ${
          isDone ? "opacity-70 hover:opacity-100" : ""
        }`}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={detailId}
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
              {job.fileName ||
                (job.description ? localize(job.description) : "")}
            </span>

            <span
              className="mt-0.5 block truncate text-[10px] text-foreground/55"
              title={locationSummary}
            >
              {locationSummary}
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
            {isHeld && job.resumable && (
              <p className="mt-1 text-[10px] leading-relaxed text-foreground/50">
                {job.cancelRequested
                  ? resumableCopy.cancellationHeldHint
                  : resumableCopy.heldHint}
              </p>
            )}
            {isActive && job.cancelRequested && (
              <p className="mt-1 text-[10px] leading-relaxed text-warning">
                {resumableCopy.activeCancellationHint}
              </p>
            )}
            {job.status === "completed" && job.cancelRequested && (
              <p className="mt-1 text-[10px] leading-relaxed text-warning">
                {resumableCopy.completedAfterCancellationHint}
              </p>
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
        </button>
        <fieldset
          className="m-0 flex min-w-0 shrink-0 flex-wrap items-center gap-0.5 border-0 p-0"
          aria-label={t("任务操作", "Job actions")}
        >
          {actions.pause && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={pending}
              onClick={() => void runAction(() => pauseJob(job.id))}
              title={resumableCopy.pauseLabel}
              aria-label={resumableCopy.pauseLabel}
            >
              <IconPause className="size-3.5" />
            </Button>
          )}
          {actions.resume && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={pending}
              onClick={() => void runAction(() => resumeJob(job.id))}
              title={resumableCopy.resumeLabel}
              aria-label={resumableCopy.resumeLabel}
            >
              <IconPlay className="size-3.5" />
            </Button>
          )}
          {actions.retry && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={pending}
              onClick={() => void runAction(() => retryJob(job.id))}
              title={
                job.cancelRequested
                  ? t("继续取消清理", "Continue cancellation cleanup")
                  : resumableCopy.retryLabel
              }
              aria-label={
                job.cancelRequested
                  ? t("继续取消清理", "Continue cancellation cleanup")
                  : resumableCopy.retryLabel
              }
            >
              <IconArrowsRotate className="size-3.5" />
            </Button>
          )}
          {actions.cancel && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={pending}
              className="shrink-0 text-foreground/40 hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                requestCancel();
              }}
              title={t("取消", "Cancel")}
              aria-label={t("取消", "Cancel")}
            >
              <IconXmark className="size-3.5" />
            </Button>
          )}
        </fieldset>
      </div>

      {/* ── Expanded detail panel ── */}
      {open && (
        <div id={detailId} className="overflow-hidden">
          <div className="border-border/60 border-t bg-card/60 px-8 py-2">
            {locationCopy ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="mb-1 -ml-1"
                onClick={() => void copyLocation()}
              >
                <IconCopy className="size-3" />{" "}
                {t("复制位置信息", "Copy location")}
              </Button>
            ) : (
              <p className="mb-1 text-[11px] text-muted-foreground">
                {locationSummary}
              </p>
            )}
            <table className="w-full text-[11px]">
              <tbody>
                {details.map(([label, value]) => (
                  <tr key={label}>
                    <td className="whitespace-nowrap py-0.5 pr-4 align-top font-semibold text-foreground/40">
                      {label}
                    </td>
                    <td
                      className={`select-text break-all py-0.5 font-mono text-foreground/70 ${
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
