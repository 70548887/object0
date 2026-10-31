import type { SyncDiff, SyncMode } from "@shared/s3.types";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { localize, useT } from "@/lib/i18n";
import { IconSpinner, IconTriangleExclamation } from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { toast } from "../common/Toast";

export function SyncDialog() {
  const t = useT();
  const open = useUIStore((s) => s.syncDialogOpen);
  const setOpen = useUIStore((s) => s.setSyncDialogOpen);
  const setFolderSyncPanelOpen = useUIStore((s) => s.setFolderSyncPanelOpen);
  const profiles = useVaultStore((s) => s.profiles);
  const currentProfileId = useProfileStore((s) => s.activeProfileId);
  const currentBucket = useBucketStore((s) => s.selectedBucket);
  const currentPrefix = useObjectStore((s) => s.currentPrefix);

  const [destProfileId, setDestProfileId] = useState("");
  const [destBucket, setDestBucket] = useState("");
  const [destPrefix, setDestPrefix] = useState("");
  const [mode, setMode] = useState<SyncMode>("additive");
  const [destBuckets, setDestBuckets] = useState<string[]>([]);
  const [loadingBuckets, setLoadingBuckets] = useState(false);
  const [diff, setDiff] = useState<SyncDiff | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const handleOpenLiveFolderSync = () => {
    setOpen(false);
    setFolderSyncPanelOpen(true);
  };

  const loadDestBuckets = useCallback(
    async (profileId: string) => {
      setLoadingBuckets(true);
      try {
        const buckets = await rpcCall("buckets:list", { profileId });
        setDestBuckets(buckets.map((b) => b.name));
      } catch (err: unknown) {
        toast.error(
          err instanceof Error
            ? localize(err.message)
            : t("未知错误", "Unknown error"),
        );
      }
      setLoadingBuckets(false);
    },
    [t],
  );

  const handleDestProfileChange = (id: string) => {
    setDestProfileId(id);
    setDestBucket("");
    setDiff(null);
    if (id) {
      loadDestBuckets(id);
    }
  };

  const previewSyncDiff = async () => {
    if (!currentProfileId || !currentBucket || !destProfileId || !destBucket)
      return;

    setPreviewing(true);
    setDiff(null);
    try {
      const result = await rpcCall("sync:preview", {
        sourceProfileId: currentProfileId,
        sourceBucket: currentBucket,
        sourcePrefix: currentPrefix,
        destProfileId,
        destBucket,
        destPrefix,
        mode,
      });
      setDiff(result);
    } catch (err: unknown) {
      toast.error(
        err instanceof Error
          ? localize(err.message)
          : t("未知错误", "Unknown error"),
      );
    }
    setPreviewing(false);
  };

  const handleSync = async () => {
    if (!currentProfileId || !currentBucket || !destProfileId || !destBucket)
      return;

    setSyncing(true);
    try {
      await rpcCall("sync:execute", {
        sourceProfileId: currentProfileId,
        sourceBucket: currentBucket,
        sourcePrefix: currentPrefix,
        destProfileId,
        destBucket,
        destPrefix,
        mode,
      });
      toast.success(t("同步任务已加入队列", "Sync jobs queued"));
      setOpen(false);
    } catch (err: unknown) {
      toast.error(
        err instanceof Error
          ? localize(err.message)
          : t("未知错误", "Unknown error"),
      );
    }
    setSyncing(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("对象同步（一次性）", "Object sync (one-time)")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "将一个存储桶或路径复制到其他账号或存储桶，完成后停止。",
              "Copy a bucket or prefix to another account or bucket, then stop.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2 rounded border border-info/30 bg-info/10 p-2.5 text-xs">
            <p className="text-foreground/70">
              {t(
                "需要持续监测本地文件夹的变化并同步吗？",
                "Need to watch local folder changes and keep syncing?",
              )}
            </p>
            <Button
              variant="outline"
              size="xs"
              className="w-full"
              onClick={handleOpenLiveFolderSync}
            >
              {t("打开实时文件夹同步", "Open live folder sync")}
            </Button>
          </div>

          {/* Source info */}
          <div className="rounded bg-muted p-2 text-xs">
            <span className="font-semibold">
              {t("来源存储桶/路径：", "Source bucket/prefix:")}
            </span>{" "}
            {currentBucket}
            {currentPrefix ? `/${currentPrefix}` : ""}
          </div>

          {/* Destination profile */}
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t("目标存储账号", "Destination account")}
            </Label>
            <Select
              value={destProfileId}
              onValueChange={(v) => {
                if (v != null) handleDestProfileChange(v);
              }}
            >
              <SelectTrigger
                aria-label={t("目标存储账号", "Destination account")}
                size="sm"
                className="w-full"
              >
                <SelectValue
                  placeholder={t(
                    "选择存储账号...",
                    "Select a storage account...",
                  )}
                >
                  {(value) =>
                    profiles.find((p) => p.id === value)?.name ??
                    (value as string)
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Destination bucket */}
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t("目标存储桶", "Destination bucket")}
            </Label>
            <Select
              value={destBucket}
              onValueChange={(v) => {
                if (v == null) return;
                setDestBucket(v);
                setDiff(null);
              }}
              disabled={!destProfileId || loadingBuckets}
            >
              <SelectTrigger
                aria-label={t("目标存储桶", "Destination bucket")}
                size="sm"
                className="w-full"
              >
                <SelectValue
                  placeholder={t("选择存储桶...", "Select a bucket...")}
                >
                  {(value) => value as string}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {destBuckets.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Destination prefix */}
          <div className="space-y-1.5">
            <Label className="text-xs">
              {t("目标路径前缀（可选）", "Destination prefix (optional)")}
            </Label>
            <Input
              aria-label={t(
                "目标路径前缀（可选）",
                "Destination prefix (optional)",
              )}
              className="h-7 text-xs w-full"
              placeholder={t("例如 backups/", "For example, backups/")}
              value={destPrefix}
              onChange={(e) => setDestPrefix(e.target.value)}
            />
          </div>

          {/* Mode */}
          <div className="space-y-1.5">
            <Label className="text-xs">{t("同步方式", "Sync mode")}</Label>
            <Select
              value={mode}
              onValueChange={(v) => {
                if (v == null) return;
                setMode(v as SyncMode);
                setDiff(null);
              }}
            >
              <SelectTrigger
                aria-label={t("同步方式", "Sync mode")}
                size="sm"
                className="w-full"
              >
                <SelectValue>
                  {(value) => {
                    const labels: Record<string, string> = {
                      additive: t(
                        "仅新增：只添加缺失的文件",
                        "Additive: add missing files only",
                      ),
                      overwrite: t(
                        "覆盖更新：添加缺失文件并更新变化的文件",
                        "Overwrite: add missing and update changed files",
                      ),
                      mirror: t(
                        "镜像：保持完全一致（会删除目标中多余的文件）",
                        "Mirror: exact match (deletes extra destination files)",
                      ),
                    };
                    return labels[value as string] ?? (value as string);
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="additive">
                  {t(
                    "仅新增：只添加缺失的文件",
                    "Additive: add missing files only",
                  )}
                </SelectItem>
                <SelectItem value="overwrite">
                  {t(
                    "覆盖更新：添加缺失文件并更新变化的文件",
                    "Overwrite: add missing and update changed files",
                  )}
                </SelectItem>
                <SelectItem value="mirror">
                  {t(
                    "镜像：保持完全一致（会删除目标中多余的文件）",
                    "Mirror: exact match (deletes extra destination files)",
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-[10px] text-foreground/50">
              {t(
                "先预览再执行一次；不会在后台持续同步。",
                "Preview, then run once. This does not sync continuously in the background.",
              )}
            </p>
          </div>

          {mode === "mirror" && (
            <div className="rounded border border-warning/30 bg-warning/10 p-2 text-warning text-xs">
              <IconTriangleExclamation className="mr-1 inline size-3.5" />
              {t(
                "镜像模式会删除目标中存在但来源中不存在的文件。",
                "Mirror mode deletes destination files that do not exist in the source.",
              )}
            </div>
          )}

          {/* Diff preview */}
          {diff && (
            <div className="space-y-1 rounded bg-muted p-3 text-xs">
              <div className="mb-1 font-semibold">
                {t("预览：", "Preview:")}
              </div>
              <div className="text-success">
                + {diff.toAdd.length}
                {t(" 个文件待新增", " file(s) to add")}
              </div>
              <div className="text-warning">
                ~ {diff.toUpdate.length}
                {t(" 个文件待更新", " file(s) to update")}
              </div>
              <div className="text-destructive">
                - {diff.toDelete.length}
                {t(" 个文件待删除", " file(s) to delete")}
              </div>
              {diff.toAdd.length === 0 &&
                diff.toUpdate.length === 0 &&
                diff.toDelete.length === 0 && (
                  <div className="text-foreground/50">
                    {t(
                      "已同步，无需操作",
                      "Already in sync; no changes needed",
                    )}
                  </div>
                )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            {t("取消", "Cancel")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={previewSyncDiff}
            disabled={previewing || !destProfileId || !destBucket}
          >
            {previewing ? (
              <IconSpinner className="size-3.5 animate-spin" />
            ) : (
              t("预览变更", "Preview changes")
            )}
          </Button>
          <Button size="sm" onClick={handleSync} disabled={syncing || !diff}>
            {syncing ? (
              <IconSpinner className="size-3.5 animate-spin" />
            ) : (
              t("执行同步", "Run sync")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
