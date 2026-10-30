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

  const loadDestBuckets = useCallback(async (profileId: string) => {
    setLoadingBuckets(true);
    try {
      const buckets = await rpcCall("buckets:list", { profileId });
      setDestBuckets(buckets.map((b) => b.name));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "未知错误");
    }
    setLoadingBuckets(false);
  }, []);

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
      toast.error(err instanceof Error ? err.message : "未知错误");
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
      toast.success("同步任务已加入队列");
      setOpen(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "未知错误");
    }
    setSyncing(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>对象同步（一次性）</DialogTitle>
          <DialogDescription>
            将一个存储桶或路径复制到其他账号或存储桶，完成后停止。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2 rounded border border-info/30 bg-info/10 p-2.5 text-xs">
            <p className="text-foreground/70">
              需要持续监测本地文件夹的变化并同步吗？
            </p>
            <Button
              variant="outline"
              size="xs"
              className="w-full"
              onClick={handleOpenLiveFolderSync}
            >
              打开实时文件夹同步
            </Button>
          </div>

          {/* Source info */}
          <div className="rounded bg-muted p-2 text-xs">
            <span className="font-semibold">来源存储桶/路径：</span>{" "}
            {currentBucket}
            {currentPrefix ? `/${currentPrefix}` : ""}
          </div>

          {/* Destination profile */}
          <div className="space-y-1.5">
            <Label className="text-xs">目标存储账号</Label>
            <Select
              value={destProfileId}
              onValueChange={(v) => {
                if (v != null) handleDestProfileChange(v);
              }}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue placeholder={"选择存储账号..."}>
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
            <Label className="text-xs">目标存储桶</Label>
            <Select
              value={destBucket}
              onValueChange={(v) => {
                if (v == null) return;
                setDestBucket(v);
                setDiff(null);
              }}
              disabled={!destProfileId || loadingBuckets}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue placeholder={"选择存储桶..."}>
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
            <Label className="text-xs">目标路径前缀（可选）</Label>
            <Input
              className="h-7 text-xs w-full"
              placeholder={"例如 backups/"}
              value={destPrefix}
              onChange={(e) => setDestPrefix(e.target.value)}
            />
          </div>

          {/* Mode */}
          <div className="space-y-1.5">
            <Label className="text-xs">同步方式</Label>
            <Select
              value={mode}
              onValueChange={(v) => {
                if (v == null) return;
                setMode(v as SyncMode);
                setDiff(null);
              }}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue>
                  {(value) => {
                    const labels: Record<string, string> = {
                      additive: "仅新增：只添加缺失的文件",
                      overwrite: "覆盖更新：添加缺失文件并更新变化的文件",
                      mirror: "镜像：保持完全一致（会删除目标中多余的文件）",
                    };
                    return labels[value as string] ?? (value as string);
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="additive">
                  仅新增：只添加缺失的文件
                </SelectItem>
                <SelectItem value="overwrite">
                  覆盖更新：添加缺失文件并更新变化的文件
                </SelectItem>
                <SelectItem value="mirror">
                  镜像：保持完全一致（会删除目标中多余的文件）
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-[10px] text-foreground/50">
              先预览再执行一次；不会在后台持续同步。
            </p>
          </div>

          {mode === "mirror" && (
            <div className="rounded border border-warning/30 bg-warning/10 p-2 text-warning text-xs">
              <IconTriangleExclamation className="mr-1 inline size-3.5" />
              镜像模式会删除目标中存在但来源中不存在的文件。
            </div>
          )}

          {/* Diff preview */}
          {diff && (
            <div className="space-y-1 rounded bg-muted p-3 text-xs">
              <div className="mb-1 font-semibold">预览：</div>
              <div className="text-success">
                + {diff.toAdd.length} 个文件待新增
              </div>
              <div className="text-warning">
                ~ {diff.toUpdate.length} 个文件待更新
              </div>
              <div className="text-destructive">
                - {diff.toDelete.length} 个文件待删除
              </div>
              {diff.toAdd.length === 0 &&
                diff.toUpdate.length === 0 &&
                diff.toDelete.length === 0 && (
                  <div className="text-foreground/50">已同步，无需操作</div>
                )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            取消
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
              "预览变更"
            )}
          </Button>
          <Button size="sm" onClick={handleSync} disabled={syncing || !diff}>
            {syncing ? (
              <IconSpinner className="size-3.5 animate-spin" />
            ) : (
              "执行同步"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
