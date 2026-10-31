import type { ShareRes } from "@shared/s3.types";
import type { ExpirationUnit } from "@shared/share.types";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconFile, IconLink, IconSpinner, IconXmark } from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import { useShareHistoryStore, useUIStore } from "@/stores";
import { toast } from "../common/Toast";
import { ShareExpirationFields } from "./ShareExpirationFields";
import { ShareResult } from "./ShareResult";
import {
  EXPIRATION_PRESETS,
  formatShareExpiration,
  parseCustomExpiration,
} from "./share-expiration";

export function ShareDialog() {
  const open = useUIStore((s) => s.shareDialogOpen);
  const target = useUIStore((s) => s.shareTarget);
  const closeDialog = useUIStore((s) => s.closeShareDialog);
  const addHistoryEntry = useShareHistoryStore((s) => s.addEntry);
  const [expirationMode, setExpirationMode] = useState<"preset" | "custom">(
    "preset",
  );
  const [selectedPreset, setSelectedPreset] = useState(0);
  const [customValue, setCustomValue] = useState("1");
  const [customUnit, setCustomUnit] = useState<ExpirationUnit>("hours");
  const [generating, setGenerating] = useState(false);
  const [shareResult, setShareResult] = useState<ShareRes | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [showQR, setShowQR] = useState(false);
  const request = useRef<symbol | null>(null);
  const session =
    open && target
      ? JSON.stringify([target.profileId, target.bucket, target.key])
      : "";
  const latestSession = useRef(session);
  latestSession.current = session;

  useEffect(() => {
    request.current = null;
    setGenerating(false);
    setShareResult(null);
    setRequestError(null);
    setCopyNotice(null);
    if (!session) return;
    setExpirationMode("preset");
    setSelectedPreset(0);
    setCustomValue("1");
    setCustomUnit("hours");
    setShowQR(false);
    return () => {
      request.current = null;
    };
  }, [session]);

  const customExpiration = parseCustomExpiration(customValue, customUnit);
  const expiresIn =
    expirationMode === "preset"
      ? EXPIRATION_PRESETS[selectedPreset].seconds
      : customExpiration.seconds;

  const handleClose = () => {
    // Invalidate immediately: a dismissed request must never copy an old link.
    request.current = null;
    closeDialog();
  };

  const handleGenerate = async () => {
    if (!target || !open || expiresIn === null || request.current) return;
    const token = Symbol("share-request");
    request.current = token;
    const isCurrent = () =>
      request.current === token && latestSession.current === session;
    setGenerating(true);
    setRequestError(null);
    setCopyNotice(null);
    try {
      const result = await rpcCall("share:generate", {
        profileId: target.profileId,
        bucket: target.bucket,
        key: target.key,
        expiresIn,
      });
      if (!isCurrent()) return;
      setShareResult(result);
      addHistoryEntry({
        ...target,
        url: result.url,
        expiresAt: result.expiresAt,
      });
      // Clipboard failure is separate from successful link generation.
      try {
        await navigator.clipboard.writeText(result.url);
        if (isCurrent()) toast.success("链接已复制到剪贴板！");
      } catch {
        if (isCurrent())
          setCopyNotice(
            "链接已生成，自动复制未成功，可点击复制按钮或选中链接手动复制。",
          );
      }
    } catch (error: unknown) {
      if (isCurrent())
        setRequestError(
          error instanceof Error ? error.message : "生成分享链接失败，请重试",
        );
    } finally {
      if (isCurrent()) {
        request.current = null;
        setGenerating(false);
      }
    }
  };

  const handleCopy = async () => {
    if (!shareResult) return;
    try {
      await navigator.clipboard.writeText(shareResult.url);
      if (latestSession.current !== session) return;
      setCopyNotice(null);
      toast.success("链接已复制到剪贴板！");
    } catch {
      if (latestSession.current === session)
        setCopyNotice("复制未成功，请选中链接后使用系统复制功能。");
    }
  };

  const fileName = target?.key.split("/").pop() || target?.key || "";
  const filePath = target ? `${target.bucket}/${target.key}` : "";

  return (
    <Dialog open={open} onOpenChange={(value) => !value && handleClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col gap-0 overflow-y-auto rounded-xl p-0 sm:max-w-lg"
      >
        <DialogHeader className="flex-row items-center justify-between gap-3 px-5 pt-5 pb-4">
          <DialogTitle className="text-lg font-semibold">分享文件</DialogTitle>
          <DialogDescription className="sr-only">
            选择链接有效期并生成文件分享链接，最长支持 7 天。
          </DialogDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleClose}
            aria-label="关闭分享弹窗"
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <IconXmark className="size-4" aria-hidden="true" />
          </Button>
        </DialogHeader>
        <div className="min-w-0 space-y-5 px-5 pb-5">
          <div className="flex min-w-0 items-center gap-3 rounded-lg bg-muted/65 p-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <IconFile className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-medium" title={fileName}>
                {fileName}
              </p>
              <p
                className="truncate text-xs text-muted-foreground"
                title={filePath}
              >
                {filePath}
              </p>
            </div>
          </div>
          {!shareResult ? (
            <ShareExpirationFields
              mode={expirationMode}
              onModeChange={setExpirationMode}
              selectedPreset={selectedPreset}
              onPresetChange={setSelectedPreset}
              customValue={customValue}
              onCustomValueChange={setCustomValue}
              customUnit={customUnit}
              onCustomUnitChange={setCustomUnit}
              disabled={generating}
              error={
                expirationMode === "custom" ? customExpiration.error : null
              }
            />
          ) : (
            <ShareResult
              url={shareResult.url}
              expiresLabel={formatShareExpiration(shareResult.expiresAt)}
              showQR={showQR}
              onCopy={handleCopy}
              onToggleQR={() => setShowQR((value) => !value)}
            />
          )}
          {requestError && (
            <p
              role="alert"
              className="break-words rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive"
            >
              {requestError}
            </p>
          )}
          {copyNotice && (
            <p
              role="status"
              className="break-words text-xs leading-relaxed text-muted-foreground"
            >
              {copyNotice}
            </p>
          )}
        </div>
        <DialogFooter className="mx-0 mb-0 flex-row justify-end gap-2 rounded-b-xl bg-transparent px-5 py-4">
          <Button
            type="button"
            variant="outline"
            className="h-10 min-w-20"
            onClick={handleClose}
          >
            关闭
          </Button>
          {!shareResult && (
            <Button
              type="button"
              className="h-10 min-w-28"
              onClick={handleGenerate}
              disabled={generating || !target || expiresIn === null}
              aria-busy={generating}
            >
              {generating ? (
                <IconSpinner
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <IconLink className="size-4" aria-hidden="true" />
              )}
              {generating ? "正在生成…" : "生成链接"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
