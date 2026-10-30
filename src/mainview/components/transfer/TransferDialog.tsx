import type { TransferMode } from "@shared/s3.types";
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
import {
  IconArrowRightArrowLeft,
  IconCopy,
  IconFile,
  IconFolder,
  IconSpinner,
  IconTriangleExclamation,
} from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { toast } from "../common/Toast";

export function TransferDialog() {
  const open = useUIStore((s) => s.transferDialogOpen);
  const target = useUIStore((s) => s.transferTarget);
  const closeDialog = useUIStore((s) => s.closeTransferDialog);
  const profiles = useVaultStore((s) => s.profiles);
  const currentProfileId = useProfileStore((s) => s.activeProfileId);
  const currentBucket = useBucketStore((s) => s.selectedBucket);
  const currentPrefix = useObjectStore((s) => s.currentPrefix);

  const [destProfileId, setDestProfileId] = useState("");
  const [destBucket, setDestBucket] = useState("");
  const [destPrefix, setDestPrefix] = useState("");
  const [mode, setMode] = useState<TransferMode>(target?.defaultMode ?? "copy");
  const [destBuckets, setDestBuckets] = useState<string[]>([]);
  const [loadingBuckets, setLoadingBuckets] = useState(false);
  const [transferring, setTransferring] = useState(false);

  // Reset mode when target changes
  const effectiveMode = target?.defaultMode ?? mode;

  const keys = target?.keys ?? [];
  const fileCount = keys.filter((k) => !k.endsWith("/")).length;
  const folderCount = keys.filter((k) => k.endsWith("/")).length;

  const loadDestBuckets = useCallback(async (profileId: string) => {
    setLoadingBuckets(true);
    try {
      const buckets = await rpcCall("buckets:list", { profileId });
      setDestBuckets(buckets.map((b) => b.name));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "加载存储桶失败");
    }
    setLoadingBuckets(false);
  }, []);

  const handleDestProfileChange = (id: string) => {
    setDestProfileId(id);
    setDestBucket("");
    if (id) {
      loadDestBuckets(id);
    }
  };

  const runCrossBucketTransfer = async () => {
    if (!currentProfileId || !currentBucket || !destProfileId || !destBucket)
      return;
    if (keys.length === 0) return;

    setTransferring(true);
    try {
      const result = await rpcCall("transfer:cross-bucket", {
        sourceProfileId: currentProfileId,
        sourceBucket: currentBucket,
        keys,
        sourcePrefix: currentPrefix,
        destProfileId,
        destBucket,
        destPrefix,
        mode: effectiveMode,
      });

      if (result.jobIds.length > 0) {
        useUIStore.getState().setJobPanelOpen(true);
        toast.success(
          `正在${effectiveMode === "move" ? "移动" : "复制"} ${result.jobIds.length} 个文件`,
        );
      }

      closeDialog();

      // If moving, refresh the source listing
      if (effectiveMode === "move") {
        useObjectStore
          .getState()
          .loadObjects(currentProfileId, currentBucket, currentPrefix);
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "传输失败");
    }
    setTransferring(false);
  };

  const handleClose = () => {
    closeDialog();
    setDestProfileId("");
    setDestBucket("");
    setDestPrefix("");
    setDestBuckets([]);
  };

  const summaryParts: string[] = [];
  if (fileCount > 0) summaryParts.push(`${fileCount} 个文件`);
  if (folderCount > 0) summaryParts.push(`${folderCount} 个文件夹`);
  const summary = summaryParts.join("和") || "0 个项目";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{`${effectiveMode === "move" ? "移动" : "复制"}到存储桶`}</DialogTitle>
          <DialogDescription>
            {effectiveMode === "move"
              ? "将选中项目移动到其他存储桶，传输成功后会删除原文件。"
              : "将选中项目复制到其他存储桶，保留原文件。"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Source summary */}
          <div className="rounded bg-muted p-2 text-xs">
            <span className="font-semibold">来源：</span> {currentBucket}
            {currentPrefix ? `/${currentPrefix}` : ""} — {summary}
            {keys.length <= 5 && (
              <ul className="mt-1 ml-2 list-inside list-disc text-foreground/60">
                {keys.map((k) => (
                  <li key={k} className="truncate">
                    {k.endsWith("/") ? (
                      <IconFolder className="mr-1 inline size-[10px]" />
                    ) : (
                      <IconFile className="mr-1 inline size-[10px]" />
                    )}
                    {k}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Transfer mode */}
          <div className="space-y-1.5">
            <Label className="text-xs">方式</Label>
            <Select
              value={effectiveMode}
              onValueChange={(v) => {
                if (v != null) setMode(v as TransferMode);
              }}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue>
                  {(value) => {
                    const labels: Record<string, string> = {
                      copy: "复制：保留原文件",
                      move: "移动：传输完成后删除原文件",
                    };
                    return labels[value as string] ?? (value as string);
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="copy">复制：保留原文件</SelectItem>
                <SelectItem value="move">移动：传输完成后删除原文件</SelectItem>
              </SelectContent>
            </Select>
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
                if (v != null) setDestBucket(v);
              }}
              disabled={!destProfileId || loadingBuckets}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue
                  placeholder={loadingBuckets ? "正在加载..." : "选择存储桶..."}
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
            <Label className="text-xs">目标路径（可选）</Label>
            <Input
              className="h-7 text-xs"
              placeholder={"例如 backups/2026/"}
              value={destPrefix}
              onChange={(e) => setDestPrefix(e.target.value)}
            />
            <p className="mt-1 text-[10px] text-foreground/50">
              文件将放在目标存储桶的此路径下。
            </p>
          </div>

          {/* Move warning */}
          {effectiveMode === "move" && (
            <div className="rounded border border-warning/30 bg-warning/10 p-2 text-warning text-xs">
              <IconTriangleExclamation className="mr-1 inline size-3.5" />
              移动成功后将删除原文件，来源：{" "}
              <span className="font-semibold">{currentBucket}</span> 。
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={handleClose}>
            取消
          </Button>
          <Button
            size="sm"
            onClick={runCrossBucketTransfer}
            disabled={
              transferring || !destProfileId || !destBucket || keys.length === 0
            }
          >
            {transferring ? (
              <IconSpinner className="size-3.5 animate-spin" />
            ) : effectiveMode === "move" ? (
              <>
                <IconArrowRightArrowLeft className="size-3.5" /> 移动
              </>
            ) : (
              <>
                <IconCopy className="size-3.5" /> 复制
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
