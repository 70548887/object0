import type {
  FolderSyncRule,
  FolderSyncRuleStatus,
  FolderSyncState,
} from "@shared/folder-sync.types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/formatters";
import { localize, t, useT } from "@/lib/i18n";
import {
  IconArrowDown,
  IconArrowsLeftRight,
  IconArrowsRotate,
  IconArrowUp,
  IconBroom,
  IconBucket,
  IconCheck,
  IconExclamationCircle,
  IconExclamationTriangle,
  IconEye,
  IconFolder,
  IconPause,
  IconPen,
  IconPlay,
  IconTrash,
  IconTriangleExclamation,
  IconXmark,
} from "@/lib/icons";
import { getLocale } from "@/stores/useLocaleStore";

function StatusIconDisplay({ status }: { status: FolderSyncRuleStatus }) {
  const cls = "text-xs";
  switch (status) {
    case "syncing":
      return <IconArrowsRotate className={`${cls} text-info animate-spin`} />;
    case "watching":
      return <IconEye className={`${cls} text-success`} />;
    case "error":
      return <IconExclamationTriangle className={`${cls} text-destructive`} />;
    case "paused":
      return <IconPause className={`${cls} text-warning`} />;
    default:
      return (
        <span className="inline-block size-3 rounded-full bg-foreground/30" />
      );
  }
}

function getStatusChipClassName(status: FolderSyncRuleStatus): string {
  switch (status) {
    case "syncing":
      return "bg-info/15 text-info";
    case "watching":
      return "bg-success/15 text-success";
    case "error":
      return "bg-destructive/15 text-destructive";
    case "paused":
      return "bg-warning/15 text-warning";
    default:
      return "bg-muted text-foreground/55";
  }
}

function statusLabel(status: FolderSyncRuleStatus): string {
  switch (status) {
    case "syncing":
      return t("同步中", "Syncing");
    case "watching":
      return t("监测中", "Watching");
    case "error":
      return t("错误", "Error");
    case "paused":
      return t("已暂停", "Paused");
    default:
      return t("空闲", "Idle");
  }
}

function DirectionIcon({
  direction,
}: {
  direction: FolderSyncRule["direction"];
}) {
  switch (direction) {
    case "bidirectional":
      return <IconArrowsLeftRight className="size-[8px]" />;
    case "local-to-remote":
      return <IconArrowUp className="size-[8px]" />;
    case "remote-to-local":
      return <IconArrowDown className="size-[8px]" />;
  }
}

function directionLabel(direction: FolderSyncRule["direction"]): string {
  switch (direction) {
    case "bidirectional":
      return t("双向同步", "Bidirectional");
    case "local-to-remote":
      return t("仅上传", "Upload only");
    case "remote-to-local":
      return t("仅下载", "Download only");
  }
}

interface SyncRuleCardProps {
  rule: FolderSyncRule;
  state?: FolderSyncState;
  error?: string;
  unavailableReason?: string;
  conflictCount: number;
  isCompact: boolean;
  onSyncNow: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onClearConflicts: (ruleId: string) => void;
  onEdit: (rule: FolderSyncRule) => void;
  onDelete: (rule: FolderSyncRule) => void;
}

export function SyncRuleCard({
  rule,
  state,
  error,
  unavailableReason,
  conflictCount,
  isCompact,
  onSyncNow,
  onToggle,
  onClearConflicts,
  onEdit,
  onDelete,
}: SyncRuleCardProps) {
  const t = useT();
  const status = state?.status ?? "idle";
  const progress = state?.progress;
  const ruleName = rule.localPath.split("/").pop() || rule.localPath;

  return (
    <div
      className={`border-border border-b ${
        isCompact ? "px-2 py-1.5" : "px-2.5 py-2"
      }`}
    >
      <div
        className={`border border-border/70 bg-card/35 ${
          isCompact
            ? "space-y-1.5 rounded-md px-2 py-1.5"
            : "space-y-2 rounded-lg px-2.5 py-2"
        }`}
      >
        {/* Header */}
        <div className="flex items-start gap-2">
          <div className="mt-0.5 shrink-0">
            <StatusIconDisplay status={status} />
          </div>
          <div className="min-w-0 flex-1">
            <div
              className={`truncate font-medium leading-tight ${
                isCompact ? "text-[11px]" : "text-[12px]"
              }`}
            >
              {ruleName}
            </div>
            <span
              className={`inline-flex rounded-full px-1.5 py-px text-[9px] ${
                isCompact ? "mt-0.5" : "mt-1"
              } ${getStatusChipClassName(status)}`}
            >
              {statusLabel(status)}
            </span>
            {conflictCount > 0 && (
              <span
                className={`ml-1 inline-flex rounded-full bg-warning/20 px-1.5 py-px text-[9px] text-warning ${
                  isCompact ? "mt-0.5" : "mt-1"
                }`}
              >
                {conflictCount}
                {t(" 个冲突", " conflict(s)")}
                {conflictCount === 1 ? "" : ""}
              </span>
            )}
          </div>
        </div>

        {/* Metadata chips */}
        <div
          className={`flex flex-wrap items-center gap-1 text-foreground/55 ${
            isCompact ? "text-[9px]" : "text-[10px]"
          }`}
        >
          <span className="inline-flex items-center gap-1 rounded bg-muted/70 px-1.5 py-px">
            <DirectionIcon direction={rule.direction} />
            {directionLabel(rule.direction)}
          </span>
          <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded bg-muted/70 px-1.5 py-px">
            <IconBucket className="size-[8px]" />
            <span className="truncate">
              {rule.bucket}
              {rule.bucketPrefix ? `/${rule.bucketPrefix}` : ""}
            </span>
          </span>
        </div>

        <div
          className={`truncate rounded bg-muted/45 px-1.5 text-foreground/45 ${
            isCompact ? "py-0.5 text-[9px]" : "py-1 text-[10px]"
          }`}
        >
          <IconFolder className="mr-1 inline size-[8px]" />
          {rule.localPath}
        </div>

        {/* Progress bar when syncing */}
        {status === "syncing" && progress && progress.total > 0 && (
          <div className="space-y-0.5">
            <div
              className={`flex items-center justify-between text-foreground/50 ${
                isCompact ? "text-[9px]" : "text-[10px]"
              }`}
            >
              <span>
                {progress.completed}/{progress.total}
                {t(" 个文件", " file(s)")}
              </span>
              <span>
                {formatBytes(progress.bytesTransferred)} /{" "}
                {formatBytes(progress.bytesTotal)}
              </span>
            </div>
            <Progress
              value={
                progress.total > 0
                  ? (progress.completed / progress.total) * 100
                  : 0
              }
              className="h-1"
            />
            {state?.currentFile && (
              <div
                className={`truncate text-foreground/30 ${
                  isCompact ? "text-[8px]" : "text-[9px]"
                }`}
              >
                {state.currentFile}
              </div>
            )}
          </div>
        )}

        {/* Error message */}
        {error && (
          <div
            className={`rounded bg-destructive/10 px-2 text-destructive ${
              isCompact ? "py-0.5 text-[9px]" : "py-1 text-[10px]"
            }`}
          >
            <IconExclamationCircle className="mr-1 inline size-[9px]" />
            {localize(error)}
          </div>
        )}

        {/* Last sync info */}
        {rule.lastSyncAt && (
          <div
            className={`truncate text-foreground/35 ${
              isCompact ? "text-[8px]" : "text-[9px]"
            }`}
          >
            {t("上次同步", "Last synced")}{" "}
            {new Date(rule.lastSyncAt).toLocaleString(
              getLocale() === "en" ? "en-US" : "zh-CN",
            )}
            {rule.lastSyncStatus === "success" && (
              <IconCheck className="ml-1 inline size-[9px] text-success/80" />
            )}
            {rule.lastSyncStatus === "error" && (
              <IconXmark className="ml-1 inline size-[9px] text-destructive/80" />
            )}
            {rule.lastSyncStatus === "partial" && (
              <IconTriangleExclamation className="ml-1 inline size-[9px] text-warning/80" />
            )}
          </div>
        )}

        {unavailableReason && (
          <p role="note" className="text-[10px] text-warning">
            {unavailableReason}
          </p>
        )}

        {/* Actions */}
        <div
          className={`flex flex-wrap items-center gap-1 border-border/70 border-t ${
            isCompact ? "pt-1" : "pt-1.5"
          }`}
        >
          <Button
            variant="ghost"
            size="xs"
            className={`gap-1 px-2 ${
              isCompact ? "h-5 min-h-5 text-[9px]" : "h-6 min-h-6 text-[10px]"
            }`}
            onClick={() => {
              if (!unavailableReason) onSyncNow(rule.id);
            }}
            title={unavailableReason ?? t("立即同步", "Sync now")}
            disabled={!!unavailableReason || status === "syncing"}
          >
            <IconArrowsRotate className="size-[9px]" />
            {t("同步", "Sync")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className={`gap-1 px-2 ${
              isCompact ? "h-5 min-h-5 text-[9px]" : "h-6 min-h-6 text-[10px]"
            }`}
            onClick={() => {
              if (!unavailableReason || rule.enabled)
                onToggle(rule.id, !rule.enabled);
            }}
            disabled={!!unavailableReason && !rule.enabled}
            title={
              !rule.enabled && unavailableReason
                ? unavailableReason
                : rule.enabled
                  ? t("暂停规则", "Pause rule")
                  : t("启用规则", "Enable rule")
            }
          >
            {rule.enabled ? (
              <IconPause className="size-[9px] text-warning" />
            ) : (
              <IconPlay className="size-[9px] text-success" />
            )}
            {rule.enabled ? t("暂停", "Pause") : t("启用", "Enable")}
          </Button>
          {conflictCount > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className={`gap-1 px-2 text-warning/80 hover:text-warning ${
                isCompact ? "h-5 min-h-5 text-[9px]" : "h-6 min-h-6 text-[10px]"
              }`}
              onClick={() => onClearConflicts(rule.id)}
              title={t("清除此规则的冲突", "Clear conflicts for this rule")}
            >
              <IconBroom className="size-[9px]" />
              {t("清除冲突", "Clear conflicts")}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              className={isCompact ? "size-5 min-h-5" : "size-6 min-h-6"}
              onClick={() => onEdit(rule)}
              title={t("编辑", "Edit")}
            >
              <IconPen className="size-[10px]" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className={`text-destructive/55 hover:text-destructive ${isCompact ? "size-5 min-h-5" : "size-6 min-h-6"}`}
              onClick={() => onDelete(rule)}
              title={t("移除", "Remove")}
            >
              <IconTrash className="size-[10px]" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
