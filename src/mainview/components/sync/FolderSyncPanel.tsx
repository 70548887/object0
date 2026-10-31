import type { FolderSyncRule } from "@shared/folder-sync.types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { localize, useT } from "@/lib/i18n";
import {
  IconBroom,
  IconFolderOpen,
  IconPause,
  IconPlay,
  IconPlus,
  IconSpinner,
  IconTriangleExclamation,
  IconXmark,
} from "@/lib/icons";
import { useFolderSyncStore, useUIStore } from "@/stores";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { toast } from "../common/Toast";
import { FolderSyncRuleEditor } from "./FolderSyncRuleEditor";
import { SyncRuleCard } from "./SyncRuleCard";

const RECENT_CONFLICTS_LIMIT = 20;

export function FolderSyncPanel() {
  const t = useT();
  const folderSyncPanelOpen = useUIStore((s) => s.folderSyncPanelOpen);
  const setFolderSyncPanelOpen = useUIStore((s) => s.setFolderSyncPanelOpen);
  const rules = useFolderSyncStore((s) => s.rules);
  const statuses = useFolderSyncStore((s) => s.statuses);
  const errors = useFolderSyncStore((s) => s.errors);
  const conflicts = useFolderSyncStore((s) => s.conflicts);
  const loading = useFolderSyncStore((s) => s.loading);
  const loadRules = useFolderSyncStore((s) => s.loadRules);
  const removeRule = useFolderSyncStore((s) => s.removeRule);
  const toggleRule = useFolderSyncStore((s) => s.toggleRule);
  const syncNow = useFolderSyncStore((s) => s.syncNow);
  const clearConflicts = useFolderSyncStore((s) => s.clearConflicts);
  const pauseAll = useFolderSyncStore((s) => s.pauseAll);
  const resumeAll = useFolderSyncStore((s) => s.resumeAll);
  const getActiveCount = useFolderSyncStore((s) => s.getActiveCount);
  const setSyncDialogOpen = useUIStore((s) => s.setSyncDialogOpen);
  const folderSyncListDensity = useUIStore((s) => s.folderSyncListDensity);
  const setFolderSyncListDensity = useUIStore(
    (s) => s.setFolderSyncListDensity,
  );

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<FolderSyncRule | null>(null);
  const [deletingRule, setDeletingRule] = useState<FolderSyncRule | null>(null);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  const handleDelete = useCallback(async () => {
    if (!deletingRule) return;
    try {
      await removeRule(deletingRule.id);
      toast.success(t("同步规则已移除", "Sync rule removed"));
    } catch (err: unknown) {
      toast.error(
        err instanceof Error
          ? localize(err.message)
          : t("未知错误", "Unknown error"),
      );
    }
    setDeletingRule(null);
  }, [deletingRule, removeRule, t]);

  const syncRuleNow = useCallback(
    async (id: string) => {
      try {
        await syncNow(id);
        toast.success(t("已开始同步", "Sync started"));
      } catch (err: unknown) {
        toast.error(
          err instanceof Error
            ? localize(err.message)
            : t("未知错误", "Unknown error"),
        );
      }
    },
    [syncNow, t],
  );

  const handleToggle = useCallback(
    async (id: string, enabled: boolean) => {
      try {
        await toggleRule(id, enabled);
        toast.success(
          enabled
            ? t("同步规则已启用", "Sync rule enabled")
            : t("同步规则已暂停", "Sync rule paused"),
        );
      } catch (err: unknown) {
        toast.error(
          err instanceof Error
            ? localize(err.message)
            : t("未知错误", "Unknown error"),
        );
      }
    },
    [toggleRule, t],
  );

  const activeCount = getActiveCount();
  const isCompact = folderSyncListDensity === "compact";
  const recentConflicts = useMemo(
    () => conflicts.slice(0, RECENT_CONFLICTS_LIMIT),
    [conflicts],
  );
  const conflictCountByRule = useMemo(() => {
    const counts = new Map<string, number>();
    for (const conflict of conflicts) {
      counts.set(conflict.ruleId, (counts.get(conflict.ruleId) ?? 0) + 1);
    }
    return counts;
  }, [conflicts]);
  const rulesById = useMemo(
    () => new Map(rules.map((rule) => [rule.id, rule])),
    [rules],
  );

  return (
    <>
      <Sheet
        open={folderSyncPanelOpen}
        onOpenChange={(o) => {
          if (!o) setFolderSyncPanelOpen(false);
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          className="flex w-[420px] max-w-full flex-col gap-0 p-0 sm:max-w-none"
        >
          {/* Header */}
          <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0 border-border border-b px-4 py-3">
            <SheetTitle className="flex min-w-0 items-center gap-2 font-semibold text-sm">
              <IconFolderOpen className="size-4 shrink-0 text-foreground/60" />
              <span className="truncate">
                {t("实时文件夹同步", "Live folder sync")}
              </span>
            </SheetTitle>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-foreground/50 hover:text-foreground"
                onClick={() => setFolderSyncPanelOpen(false)}
                title={t("关闭", "Close")}
              >
                <IconXmark className="size-4" />
              </Button>
            </div>
          </SheetHeader>

          {/* subtitle — moved out of header */}
          <p className="border-border border-b px-4 py-2 text-[11px] text-foreground/50">
            {t(
              "在后台持续同步本地文件夹与存储桶",
              "Continuously sync local folders and buckets in the background",
            )}
          </p>

          {/* secondary toolbar */}
          <div className="flex flex-wrap items-center gap-1.5 border-border border-b px-3 py-1.5">
            {activeCount > 0 && (
              <span className="rounded-full bg-success/20 px-1.5 py-px text-[9px] text-success tabular-nums">
                {activeCount}
                {t(" 进行中", " Active")}
              </span>
            )}
            {conflicts.length > 0 && (
              <span className="rounded-full bg-warning/20 px-1.5 py-px text-[9px] text-warning tabular-nums">
                {conflicts.length}
                {t(" 个冲突", " conflict(s)")}
                {conflicts.length === 1 ? "" : ""}
              </span>
            )}
            <Button
              variant="ghost"
              size="xs"
              className="h-5 min-h-5 gap-1 px-1.5 text-[10px] text-foreground/55 hover:text-primary"
              onClick={() => setAddDialogOpen(true)}
              title={t("添加实时同步规则", "Add live sync rule")}
            >
              <IconPlus className="size-[9px]" />
              {t("添加规则", "Add rule")}
            </Button>
            <div className="ml-auto flex">
              <Button
                variant={!isCompact ? "default" : "ghost"}
                size="xs"
                className="h-5 min-h-5 rounded-r-none px-1.5 text-[10px]"
                onClick={() => setFolderSyncListDensity("comfortable")}
              >
                {t("宽松", "Comfortable")}
              </Button>
              <Button
                variant={isCompact ? "default" : "ghost"}
                size="xs"
                className="h-5 min-h-5 rounded-l-none px-1.5 text-[10px]"
                onClick={() => setFolderSyncListDensity("compact")}
              >
                {t("紧凑", "Compact")}
              </Button>
            </div>
            {rules.length > 0 && (
              <>
                {conflicts.length > 0 && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-5 min-h-5 gap-1 px-1.5 text-[10px] text-warning/70 hover:text-warning"
                    onClick={() => clearConflicts()}
                    title={t("清除冲突通知", "Clear conflict notifications")}
                  >
                    <IconBroom className="size-[9px]" />
                    {t("清除冲突", "Clear conflicts")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-5 min-h-5 text-foreground/40 hover:text-success"
                  onClick={resumeAll}
                  title={t("全部恢复", "Resume all")}
                >
                  <IconPlay className="size-[9px]" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-5 min-h-5 text-foreground/40 hover:text-warning"
                  onClick={pauseAll}
                  title={t("全部暂停", "Pause all")}
                >
                  <IconPause className="size-[9px]" />
                </Button>
              </>
            )}
          </div>

          {/* the "For one-time..." info row stays AS-IS */}
          <div className="flex flex-wrap items-center justify-between gap-1.5 border-border border-b bg-card/50 px-3 py-1.5 text-[10px] text-foreground/55">
            <span className="min-w-0 flex-1">
              {t(
                "如需一次性复制存储桶，请使用对象同步。",
                "Use object sync for a one-time bucket copy.",
              )}
            </span>
            <Button
              variant="ghost"
              size="xs"
              className="h-5 min-h-5 px-1.5 text-[10px] text-info hover:text-info"
              onClick={() => setSyncDialogOpen(true)}
            >
              {t("打开对象同步", "Open object sync")}
            </Button>
          </div>

          {/* Rule list */}
          <div className="flex-1 overflow-y-auto">
            {loading && (
              <div className="flex items-center justify-center p-8">
                <IconSpinner className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}

            {!loading && rules.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 p-8">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                  <IconFolderOpen className="size-6 text-primary" />
                </div>
                <div className="text-center">
                  <p className="font-medium text-sm">
                    {t("暂无实时同步规则", "No live sync rules yet")}
                  </p>
                  <p className="mt-0.5 text-foreground/50 text-xs">
                    {t(
                      "添加实时同步规则，持续同步本地文件夹和 S3 存储桶路径",
                      "Add a live rule to keep a local folder and an S3 bucket prefix in sync",
                    )}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1"
                  onClick={() => setAddDialogOpen(true)}
                >
                  <IconPlus className="size-3.5" />
                  {t(" 添加实时同步规则", " Add live sync rule")}
                </Button>
              </div>
            )}

            {!loading && recentConflicts.length > 0 && (
              <div className="border-border border-b bg-warning/5 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1 text-[10px] text-warning/80">
                    <IconTriangleExclamation className="size-[9px]" />
                    {t("最近的冲突", "Recent conflicts")}
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-5 min-h-5 px-1.5 text-[10px] text-warning/70 hover:text-warning"
                    onClick={() => clearConflicts()}
                  >
                    {t("清除", "Clear")}
                  </Button>
                </div>
                <ul className="mt-1 space-y-1">
                  {recentConflicts.map((conflict) => {
                    const rule = rulesById.get(conflict.ruleId);
                    const key = `${conflict.ruleId}:${conflict.relativePath}`;
                    const ruleName =
                      rule?.localPath.split("/").pop() ?? conflict.ruleId;
                    return (
                      <li
                        key={key}
                        className="truncate text-[10px] text-foreground/65"
                        title={`${ruleName}: ${conflict.relativePath}`}
                      >
                        <IconFolderOpen className="mr-1 inline size-[8px] text-warning/70" />
                        {ruleName}
                        <span className="mx-1 text-foreground/30">·</span>
                        {conflict.relativePath}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {rules.map((rule) => (
              <SyncRuleCard
                key={rule.id}
                rule={rule}
                state={statuses.get(rule.id)}
                error={errors.get(rule.id)}
                conflictCount={conflictCountByRule.get(rule.id) ?? 0}
                isCompact={isCompact}
                onSyncNow={syncRuleNow}
                onToggle={handleToggle}
                onClearConflicts={clearConflicts}
                onEdit={setEditingRule}
                onDelete={setDeletingRule}
              />
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {/* Add Rule Dialog */}
      <Dialog
        open={addDialogOpen}
        onOpenChange={(o) => !o && setAddDialogOpen(false)}
      >
        <DialogContent className="sm:max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t("添加实时文件夹同步规则", "Add live folder sync rule")}
            </DialogTitle>
          </DialogHeader>
          <FolderSyncRuleEditor
            onDone={() => {
              setAddDialogOpen(false);
              loadRules();
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Edit Rule Dialog */}
      <Dialog
        open={!!editingRule}
        onOpenChange={(o) => !o && setEditingRule(null)}
      >
        <DialogContent className="sm:max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {t("编辑实时文件夹同步规则", "Edit live folder sync rule")}
            </DialogTitle>
          </DialogHeader>
          {editingRule && (
            <FolderSyncRuleEditor
              editRule={editingRule}
              onDone={() => {
                setEditingRule(null);
                loadRules();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deletingRule}
        title={t("移除实时同步规则", "Remove live sync rule")}
        message={t(
          `确定移除“${deletingRule?.localPath.split("/").pop()}”的实时同步规则吗？同步将停止，但不会删除文件。`,
          `Remove the live sync rule for “${deletingRule?.localPath.split("/").pop()}”? Syncing will stop, but no files will be deleted.`,
        )}
        confirmLabel={t("移除", "Remove")}
        destructive
        onConfirm={handleDelete}
        onClose={() => setDeletingRule(null)}
      />
    </>
  );
}
