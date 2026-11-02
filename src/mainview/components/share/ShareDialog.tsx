import type { QiniuDownloadOptions } from "@shared/qiniu.types";
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
import { localize, t, useT } from "@/lib/i18n";
import { IconFile, IconLink, IconSpinner, IconXmark } from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import { useShareHistoryStore, useUIStore, useVaultStore } from "@/stores";
import { toast } from "../common/Toast";
import { QiniuShareDomains } from "./QiniuShareDomains";
import {
  defaultDownloadDomain,
  isSelectedDomainAvailable,
  ShareRequestGuard,
  safeDownloadFileName,
  sharingProtocol,
  validatedDownloadOptions,
  validatedShareResult,
} from "./qiniu-share-options";
import { ShareExpirationFields } from "./ShareExpirationFields";
import { ShareResult } from "./ShareResult";
import {
  DEFAULT_SHARE_MAX_SECONDS,
  EXPIRATION_PRESETS,
  formatShareExpiration,
  parseCustomExpiration,
} from "./share-expiration";

export function ShareDialog() {
  useT();
  const open = useUIStore((s) => s.shareDialogOpen);
  const target = useUIStore((s) => s.shareTarget);
  const closeDialog = useUIStore((s) => s.closeShareDialog);
  const addHistoryEntry = useShareHistoryStore((s) => s.addEntry);
  const profile = useVaultStore((s) =>
    s.profiles.find((item) => item.id === target?.profileId),
  );
  const targetProfileId = target?.profileId;
  const targetBucket = target?.bucket;
  const protocol = sharingProtocol(profile);
  const native = protocol === "native";
  const [expirationMode, setExpirationMode] = useState<"preset" | "custom">(
    "preset",
  );
  const [selectedPreset, setSelectedPreset] = useState(0);
  const [customValue, setCustomValue] = useState("1");
  const [customUnit, setCustomUnit] = useState<ExpirationUnit>("hours");
  const [generating, setGenerating] = useState(false);
  const [shareResultState, setShareResult] = useState<{
    scope: string;
    result: ShareRes;
  } | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [showQR, setShowQR] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [optionsReload, setOptionsReload] = useState(0);
  const [domainState, setDomainState] = useState<{
    scope: string;
    options: QiniuDownloadOptions | null;
    loading: boolean;
    error: string | null;
  }>({ scope: "", options: null, loading: false, error: null });
  const [domainChoice, setDomainChoice] = useState({ scope: "", domain: "" });
  const request = useRef(new ShareRequestGuard());
  const optionRequest = useRef(new ShareRequestGuard());
  const session =
    open && target
      ? JSON.stringify([
          target.profileId,
          profile?.updatedAt,
          protocol,
          target.bucket,
          target.key,
        ])
      : "";
  optionRequest.current.bind(session);
  const options = domainState.scope === session ? domainState.options : null;
  const selectedDomain =
    domainChoice.scope === session ? domainChoice.domain : "";
  const publicLink =
    native &&
    options?.domains.find((domain) => domain.url === selectedDomain)
      ?.accessMode === "public";
  const optionsLoading =
    native && (domainState.scope !== session || domainState.loading);
  const optionsError = domainState.scope === session ? domainState.error : null;
  const maximumSeconds = native
    ? (options?.maxShareSeconds ?? DEFAULT_SHARE_MAX_SECONDS)
    : DEFAULT_SHARE_MAX_SECONDS;
  const customExpiration = parseCustomExpiration(
    customValue,
    customUnit,
    maximumSeconds,
  );
  const rawExpiresIn =
    expirationMode === "preset"
      ? EXPIRATION_PRESETS[selectedPreset]?.seconds
      : customExpiration.seconds;
  const expiresIn = publicLink
    ? 3600
    : rawExpiresIn !== undefined &&
        rawExpiresIn !== null &&
        rawExpiresIn <= maximumSeconds
      ? rawExpiresIn
      : null;
  const actionScope = JSON.stringify([
    session,
    selectedDomain,
    expirationMode,
    selectedPreset,
    customValue,
    customUnit,
  ]);
  const latestAction = useRef(actionScope);
  latestAction.current = actionScope;
  request.current.bind(actionScope);
  const shareResult =
    shareResultState?.scope === actionScope ? shareResultState.result : null;
  const validNativeDomain = isSelectedDomainAvailable(options, selectedDomain);
  const canOperate =
    protocol !== "unknown" &&
    Boolean(profile) &&
    Boolean(target && !target.key.endsWith("/")) &&
    (!native || (!optionsLoading && Boolean(options) && validNativeDomain));

  useEffect(() => {
    request.current.invalidate();
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
      request.current.invalidate();
    };
  }, [session]);

  useEffect(() => {
    void actionScope;
    request.current.invalidate();
    setGenerating(false);
    setDownloading(false);
    setShareResult(null);
    setRequestError(null);
    setCopyNotice(null);
    setShowQR(false);
  }, [actionScope]);

  useEffect(() => {
    const guard = optionRequest.current;
    void optionsReload;
    if (!native || !session || !targetProfileId || !targetBucket) {
      guard.invalidate();
      setDomainState({
        scope: session,
        options: null,
        loading: false,
        error: null,
      });
      setDomainChoice({ scope: session, domain: "" });
      return;
    }
    const token = guard.begin();
    setDomainState({
      scope: session,
      options: null,
      loading: true,
      error: null,
    });
    setDomainChoice({ scope: session, domain: "" });
    void rpcCall("qiniu:download-options", {
      profileId: targetProfileId,
      bucket: targetBucket,
    })
      .then((value) => {
        const verified = validatedDownloadOptions(value);
        if (!guard.isCurrent(token)) return;
        setDomainState({
          scope: session,
          options: verified,
          loading: false,
          error: null,
        });
        setDomainChoice({
          scope: session,
          domain: defaultDownloadDomain(verified),
        });
      })
      .catch((error: unknown) => {
        if (!guard.isCurrent(token)) return;
        setDomainState({
          scope: session,
          options: null,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : t(
                  "读取下载选项失败，请重试",
                  "Failed to load download options; retry",
                ),
        });
      })
      .finally(() => guard.finish(token));
    return () => guard.invalidate();
  }, [session, native, targetProfileId, targetBucket, optionsReload]);

  const selectDomain = (domain: string) => {
    if (domain && !isSelectedDomainAvailable(options, domain)) return;
    request.current.invalidate();
    setGenerating(false);
    setDownloading(false);
    setShareResult(null);
    setDomainChoice({ scope: session, domain });
  };

  const handleClose = () => {
    // Invalidate immediately: a dismissed request must never copy an old link.
    request.current.invalidate();
    optionRequest.current.invalidate();
    closeDialog();
  };

  const handleGenerate = async () => {
    if (
      !target ||
      !open ||
      !profile ||
      !canOperate ||
      expiresIn === null ||
      request.current.pending
    )
      return;
    const guard = request.current;
    const token = guard.begin();
    const isCurrent = () => guard.isCurrent(token);
    setGenerating(true);
    setRequestError(null);
    setCopyNotice(null);
    try {
      const result = validatedShareResult(
        await rpcCall("share:generate", {
          profileId: target.profileId,
          bucket: target.bucket,
          key: target.key,
          expiresIn,
          expectedProfileRevision: profile.updatedAt,
          ...(native ? { downloadDomain: selectedDomain } : {}),
        }),
        { key: target.key, ...(native ? { domain: selectedDomain } : {}) },
      );
      if (!isCurrent()) return;
      setShareResult({ scope: actionScope, result });
      addHistoryEntry({
        ...target,
        url: result.url,
        expiresAt: result.expiresAt,
        accessMode: result.accessMode,
      });
      // Clipboard failure is separate from successful link generation.
      try {
        await navigator.clipboard.writeText(result.url);
        if (isCurrent())
          toast.success(t("链接已复制到剪贴板！", "Link copied to clipboard!"));
      } catch {
        if (isCurrent())
          setCopyNotice(
            t(
              "链接已生成，自动复制未成功，可点击复制按钮或选中链接手动复制。",
              "The link was generated, but automatic copying failed. Use the copy button or select and copy the link manually.",
            ),
          );
      }
    } catch (error: unknown) {
      if (isCurrent())
        setRequestError(
          error instanceof Error
            ? localize(error.message)
            : t(
                "生成分享链接失败，请重试",
                "Failed to generate a sharing link. Please try again.",
              ),
        );
    } finally {
      if (isCurrent()) {
        guard.finish(token);
        setGenerating(false);
      }
    }
  };

  const handleCopy = async () => {
    if (!shareResult || latestAction.current !== actionScope) return;
    try {
      await navigator.clipboard.writeText(shareResult.url);
      if (latestAction.current !== actionScope) return;
      setCopyNotice(null);
      toast.success(t("链接已复制到剪贴板！", "Link copied to clipboard!"));
    } catch {
      if (latestAction.current === actionScope)
        setCopyNotice(
          t(
            "复制未成功，请选中链接后使用系统复制功能。",
            "Copying failed. Select the link and use the system copy command.",
          ),
        );
    }
  };

  const fileName = target?.key.split("/").pop() || target?.key || "";
  const filePath = target ? `${target.bucket}/${target.key}` : "";
  const downloadFileName = target ? safeDownloadFileName(target.key) : null;
  const handleDownload = async () => {
    if (
      !target ||
      !open ||
      !native ||
      !profile ||
      !canOperate ||
      !downloadFileName ||
      request.current.pending
    )
      return;
    const guard = request.current;
    const token = guard.begin();
    setDownloading(true);
    setRequestError(null);
    try {
      await rpcCall("transfer:download", {
        profileId: target.profileId,
        bucket: target.bucket,
        key: target.key,
        localPath: `~/Downloads/${downloadFileName}`,
        downloadDomain: selectedDomain,
        expectedProfileRevision: profile.updatedAt,
      });
      if (!guard.isCurrent(token)) return;
      useUIStore.getState().setJobPanelOpen(true);
      toast.info(
        t(
          "已按所选域名创建下载任务",
          "Download queued using the selected domain",
        ),
      );
    } catch (error: unknown) {
      if (guard.isCurrent(token))
        setRequestError(
          error instanceof Error
            ? localize(error.message)
            : t(
                "创建下载任务失败，请重试",
                "Failed to queue the download; retry",
              ),
        );
    } finally {
      if (guard.isCurrent(token)) {
        guard.finish(token);
        setDownloading(false);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && handleClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col gap-0 overflow-y-auto rounded-xl p-0 sm:max-w-lg"
      >
        <DialogHeader className="flex-row items-center justify-between gap-3 px-5 pt-5 pb-4">
          <DialogTitle className="text-lg font-semibold">
            {t("分享文件", "Share file")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {native
              ? t(
                  "选择已确认的七牛原生域名和链接有效期。应用安全上限不是服务商承诺，域名访问策略仍然生效。",
                  "Choose a confirmed native Qiniu domain and expiration. The application safety cap is not a provider guarantee; domain access policies still apply.",
                )
              : t(
                  "选择链接有效期并生成文件分享链接，最长支持 7 天。",
                  "Choose an expiration and generate a file sharing link, valid for up to 7 days.",
                )}
          </DialogDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleClose}
            aria-label={t("关闭分享弹窗", "Close sharing dialog")}
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
          {native && (
            <QiniuShareDomains
              options={options}
              loading={optionsLoading}
              error={optionsError}
              selectedDomain={selectedDomain}
              disabled={generating || downloading}
              onSelect={selectDomain}
              onReload={() => {
                optionRequest.current.invalidate();
                request.current.invalidate();
                setShareResult(null);
                setOptionsReload((value) => value + 1);
              }}
            />
          )}
          {protocol === "unknown" && (
            <p role="alert" className="text-xs text-warning">
              {t(
                "账号连接身份尚未确认，请重新加载账号配置后再分享。",
                "The account connection identity is unverified. Reload account settings before sharing.",
              )}
            </p>
          )}
          {(!native || options) &&
            (!shareResult ? (
              publicLink ? (
                <p
                  role="status"
                  className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground"
                >
                  {t(
                    "当前域名对应公开资源，将生成公开外链。客户端不能为公开访问强制设置过期时间；域名、空间或文件策略仍可能使链接失效。",
                    "This domain serves public resources and will generate a public link. The client cannot enforce an expiry for public access; domain, bucket or file policies may still invalidate the link.",
                  )}
                </p>
              ) : (
                <ShareExpirationFields
                  mode={expirationMode}
                  onModeChange={setExpirationMode}
                  selectedPreset={selectedPreset}
                  onPresetChange={setSelectedPreset}
                  customValue={customValue}
                  onCustomValueChange={setCustomValue}
                  customUnit={customUnit}
                  onCustomUnitChange={setCustomUnit}
                  disabled={generating || downloading || optionsLoading}
                  maxSeconds={maximumSeconds}
                  applicationLimit={native}
                  error={
                    expirationMode === "custom" ? customExpiration.error : null
                  }
                />
              )
            ) : (
              <ShareResult
                url={shareResult.url}
                accessMode={shareResult.accessMode}
                expiresLabel={formatShareExpiration(shareResult.expiresAt)}
                showQR={showQR}
                onCopy={handleCopy}
                onToggleQR={() => setShowQR((value) => !value)}
              />
            ))}
          {native && !downloadFileName && (
            <p className="text-xs text-warning">
              {t(
                "此对象名不能直接用作 Windows 文件名。请先选择安全的另存文件名，暂不创建默认路径下载。",
                "This object name cannot be used directly as a Windows filename. Choose a safe Save As name before downloading; no default-path download will be created.",
              )}
            </p>
          )}
          {requestError && (
            <p
              role="alert"
              className="break-words rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive"
            >
              {localize(requestError)}
            </p>
          )}
          {copyNotice && (
            <p
              role="status"
              className="break-words text-xs leading-relaxed text-muted-foreground"
            >
              {localize(copyNotice)}
            </p>
          )}
        </div>
        <DialogFooter className="mx-0 mb-0 flex-row flex-wrap justify-end gap-2 rounded-b-xl bg-transparent px-5 py-4">
          <Button
            type="button"
            variant="outline"
            className="h-10 min-w-20"
            onClick={handleClose}
          >
            {t("关闭", "Close")}
          </Button>
          {native && (
            <Button
              type="button"
              variant="outline"
              className="h-10 min-w-24"
              onClick={handleDownload}
              disabled={
                generating || downloading || !canOperate || !downloadFileName
              }
              aria-busy={downloading}
            >
              {downloading
                ? t("正在创建下载…", "Queuing download…")
                : t("使用所选域名下载", "Download via selected domain")}
            </Button>
          )}
          {!shareResult && (
            <Button
              type="button"
              className="h-10 min-w-28"
              onClick={handleGenerate}
              disabled={
                generating ||
                downloading ||
                !target ||
                !canOperate ||
                expiresIn === null
              }
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
              {generating
                ? t("正在生成…", "Generating…")
                : t("生成链接", "Generate link")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
