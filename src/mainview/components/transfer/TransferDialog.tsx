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
import { localize, t, useT } from "@/lib/i18n";
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
import {
  qiniuTransferPairReason,
  qiniuUnfinishedTransferReason,
} from "../objects/qiniu-transfer-gates";

export function TransferDialog() {
  useT();
  const open = useUIStore((s) => s.transferDialogOpen);
  const target = useUIStore((s) => s.transferTarget);
  const closeDialog = useUIStore((s) => s.closeTransferDialog);
  const profiles = useVaultStore((s) => s.profiles);
  const currentProfileId = useProfileStore((s) => s.activeProfileId);
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const currentBucket = useBucketStore((s) => s.selectedBucket);
  const currentPrefix = useObjectStore((s) => s.currentPrefix);

  const [destProfileId, setDestProfileId] = useState("");
  const [destBucket, setDestBucket] = useState("");
  const [destPrefix, setDestPrefix] = useState("");
  const [mode, setMode] = useState<TransferMode>(target?.defaultMode ?? "copy");
  const [destBuckets, setDestBuckets] = useState<string[]>([]);
  const [loadingBuckets, setLoadingBuckets] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const transferBlocked = qiniuTransferPairReason(
    profiles.find((p) => p.id === currentProfileId) ?? activeProfile,
    profiles.find((p) => p.id === destProfileId),
    "transfer",
  );

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
      toast.error(
        err instanceof Error
          ? localize(err.message)
          : t("加载存储桶失败", "Failed to load buckets"),
      );
    }
    setLoadingBuckets(false);
  }, []);

  const handleDestProfileChange = (id: string) => {
    const reason = qiniuUnfinishedTransferReason(
      profiles.find((p) => p.id === id),
      "transfer",
    );
    if (reason) return toast.warning(reason);
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
    if (transferBlocked) return toast.warning(transferBlocked);

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
          t(
            `正在${effectiveMode === "move" ? t("移动", "Move") : t("复制", "Copy")} ${result.jobIds.length} 个文件`,
            `${effectiveMode === "move" ? "Moving" : "Copying"} ${result.jobIds.length} files`,
          ),
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
      toast.error(
        err instanceof Error
          ? localize(err.message)
          : t("传输失败", "Transfer failed"),
      );
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
  if (fileCount > 0)
    summaryParts.push(t(`${fileCount} 个文件`, `${fileCount} files`));
  if (folderCount > 0)
    summaryParts.push(t(`${folderCount} 个文件夹`, `${folderCount} folders`));
  const summary =
    summaryParts.join(t("和", " and ")) || t("0 个项目", "0 items");

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t(
              `${effectiveMode === "move" ? t("移动", "Move") : t("复制", "Copy")}到存储桶`,
              `${effectiveMode === "move" ? t("移动", "Move") : t("复制", "Copy")} to bucket`,
            )}
          </DialogTitle>
          <DialogDescription>
            {effectiveMode === "move"
              ? t(
                  "将选中项目移动到其他存储桶，传输成功后会删除原文件。",
                  "Move the selected items to another bucket. Originals are deleted only after a successful transfer.",
                )
              : t(
                  "将选中项目复制到其他存储桶，保留原文件。",
                  "Copy the selected items to another bucket and keep the originals.",
                )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {transferBlocked && (
            <p role="note" className="text-warning text-xs">
              {transferBlocked}
            </p>
          )}
          {/* Source summary */}
          <div className="rounded bg-muted p-2 text-xs">
            <span className="font-semibold">{t("来源：", "Source:")}</span>{" "}
            {currentBucket}
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
            <Label className="text-xs">{t("方式", "Mode")}</Label>
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
                      copy: t("复制：保留原文件", "Copy: keep originals"),
                      move: t(
                        "移动：传输完成后删除原文件",
                        "Move: delete originals after transfer",
                      ),
                    };
                    return labels[value as string] ?? (value as string);
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="copy">
                  {t("复制：保留原文件", "Copy: keep originals")}
                </SelectItem>
                <SelectItem value="move">
                  {t(
                    "移动：传输完成后删除原文件",
                    "Move: delete originals after transfer",
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
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
              <SelectTrigger size="sm" className="w-full">
                <SelectValue
                  placeholder={t("选择存储账号...", "Select an account...")}
                >
                  {(value) =>
                    profiles.find((p) => p.id === value)?.name ??
                    (value as string)
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem
                    key={p.id}
                    value={p.id}
                    disabled={p.provider === "qiniu"}
                    title={
                      qiniuUnfinishedTransferReason(p, "transfer") ?? undefined
                    }
                  >
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
                if (v != null) setDestBucket(v);
              }}
              disabled={!destProfileId || loadingBuckets}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue
                  placeholder={
                    loadingBuckets
                      ? t("正在加载...", "Loading...")
                      : t("选择存储桶...", "Select a bucket...")
                  }
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
              {t("目标路径（可选）", "Destination prefix (optional)")}
            </Label>
            <Input
              className="h-7 text-xs"
              placeholder={t("例如 backups/2026/", "e.g. backups/2026/")}
              value={destPrefix}
              onChange={(e) => setDestPrefix(e.target.value)}
            />
            <p className="mt-1 text-[10px] text-foreground/50">
              {t(
                "文件将放在目标存储桶的此路径下。",
                "Files will be placed under this prefix in the destination bucket.",
              )}
            </p>
          </div>

          {/* Move warning */}
          {effectiveMode === "move" && (
            <div className="rounded border border-warning/30 bg-warning/10 p-2 text-warning text-xs">
              <IconTriangleExclamation className="mr-1 inline size-3.5" />
              {t(
                "移动成功后将删除原文件，来源：",
                "After a successful move, originals will be deleted from:",
              )}{" "}
              <span className="font-semibold">{currentBucket}</span>
              {t("。", ".")}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={handleClose}>
            {t("取消", "Cancel")}
          </Button>
          <Button
            size="sm"
            onClick={runCrossBucketTransfer}
            disabled={
              !!transferBlocked ||
              transferring ||
              !destProfileId ||
              !destBucket ||
              keys.length === 0
            }
            title={transferBlocked ?? undefined}
          >
            {transferring ? (
              <IconSpinner className="size-3.5 animate-spin" />
            ) : effectiveMode === "move" ? (
              <>
                <IconArrowRightArrowLeft className="size-3.5" />{" "}
                {t("移动", "Move")}
              </>
            ) : (
              <>
                <IconCopy className="size-3.5" /> {t("复制", "Copy")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
