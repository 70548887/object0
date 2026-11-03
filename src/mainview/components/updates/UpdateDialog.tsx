import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/lib/formatters";
import { localize, t, useT } from "@/lib/i18n";
import {
  IconArrowsRotate,
  IconCircleInfo,
  IconCloudArrowDown,
} from "@/lib/icons";
import { useFolderSyncStore, useJobStore, useUIStore } from "@/stores";
import { useUpdaterPreferencesStore } from "@/stores/useUpdaterPreferencesStore";
import {
  startUpdateClient,
  updateSession,
  useUpdateState,
} from "./update-client";
import {
  getEditorExitRevision,
  subscribeEditorExitState,
} from "./update-exit-guard";
import { safeUpdatePage } from "./update-session";

export function UpdateHost() {
  const open = useUIStore((state) => state.updateDialogOpen);
  useEffect(() => startUpdateClient(), []);
  return open ? <UpdateDialog /> : null;
}

export function UpdateEntry({ compact = false }: { compact?: boolean }) {
  useT();
  const state = useUpdateState();
  const version = state.info?.currentVersion;
  const available = !!state.result?.release;
  return (
    <button
      type="button"
      onClick={() => {
        useUIStore.getState().setSettingsOpen(false);
        useUIStore.getState().setUpdateDialogOpen(true);
      }}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      title={
        version
          ? `${t("当前版本", "Current version")}: v${version} · ${t("关于与更新", "About and updates")}`
          : t(
              "查看当前版本与软件更新",
              "View the current version and software updates",
            )
      }
      aria-label={t("关于与更新", "About and updates")}
    >
      <IconCircleInfo className="size-3.5 shrink-0" />
      <span
        className={
          compact
            ? "hidden whitespace-nowrap @[720px]/statusbar:inline"
            : "whitespace-nowrap"
        }
      >
        {version ? `v${version}` : t("版本与更新", "Version and updates")}
      </span>
      {available && (
        <span
          role="img"
          className="size-1.5 rounded-full bg-primary"
          aria-label={t("有新版本", "New version available")}
        />
      )}
    </button>
  );
}

export function UpdateDialog() {
  useT();
  const state = useUpdateState();
  const autoCheck = useUpdaterPreferencesStore((prefs) => prefs.autoCheck);
  const setAutoCheck = useUpdaterPreferencesStore(
    (prefs) => prefs.setAutoCheck,
  );
  // Recompute exit blockers when transfer/sync/editor state changes. Only
  // metadata is read here; drafts and credentials never enter update payloads.
  useJobStore((store) => store.jobs);
  useFolderSyncStore((store) => store.statuses);
  useUIStore((store) => store.textEditorTarget);
  useSyncExternalStore(
    subscribeEditorExitState,
    getEditorExitRevision,
    getEditorExitRevision,
  );
  const [confirmInstall, setConfirmInstall] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const { info, result, snapshot } = state;
  const release = result?.release;
  const phase = snapshot?.stage;
  const downloading = phase === "downloading" || phase === "verifying";
  const disabled = state.checking || downloading || state.applying;
  const blockers = updateSession.blockers();
  const downloadReason =
    release?.blockedReason ??
    info?.blockedReason ??
    (release && !updateSession.downloadAllowed
      ? t(
          "此发布没有适用于当前平台和安装类型的已签名更新包。",
          "This release has no signed update package for the current platform and package type.",
        )
      : null);
  const progress =
    snapshot?.total && snapshot.total > 0
      ? Math.min(
          100,
          Math.max(0, Math.floor((snapshot.downloaded / snapshot.total) * 100)),
        )
      : null;
  const kind = (value?: string) =>
    value === "installer"
      ? t("安装版", "Installer")
      : value === "portable"
        ? t("便携版", "Portable")
        : t("安装类型未确认", "Package type unconfirmed");
  const showPage = async (url: string | null | undefined) => {
    const safe = safeUpdatePage(url);
    if (!safe) return;
    try {
      await openUrl(safe);
      setLinkError(null);
    } catch {
      setLinkError(
        t(
          "无法打开浏览器，请稍后从 GitHub 仓库查看更新。",
          "Could not open the browser. View the update in the GitHub repository later.",
        ),
      );
    }
  };
  const close = () => {
    if (!state.applying) useUIStore.getState().setUpdateDialogOpen(false);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        data-update-dialog
        className="flex max-h-[90vh] flex-col gap-4 overflow-hidden sm:max-w-xl"
        showCloseButton={!state.applying}
      >
        <DialogHeader>
          <DialogTitle>{t("软件更新", "Software update")}</DialogTitle>
          <DialogDescription>
            {t("更新源：GitHub", "Update source: GitHub")} · 70548887/object0
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 min-w-0 space-y-4 overflow-x-hidden overflow-y-auto pr-1 [overflow-wrap:anywhere]">
          <section className="rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                {t("当前版本", "Current version")}
              </span>
              <span className="min-w-0 break-all font-mono">
                {info
                  ? `v${info.currentVersion}`
                  : state.infoLoading
                    ? t("读取中…", "Loading…")
                    : t("尚未读取", "Not loaded")}
              </span>
            </div>
            {info && (
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {kind(info.packageKind)} · {info.platform}
                </span>
                {info.development && (
                  <span className="rounded bg-warning/10 px-1.5 text-warning">
                    {t("未发布开发构建", "Unreleased development build")}
                  </span>
                )}
                {info.buildHash && (
                  <span className="font-mono" title={info.buildHash}>
                    {info.buildHash.slice(0, 18)}
                  </span>
                )}
              </div>
            )}
            {info?.development && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t(
                  "本地构建可能包含未发布功能；更新会替换程序，但不会删除账号配置。",
                  "This build may contain unpublished features. Updating replaces the program, not account settings.",
                )}
              </p>
            )}
            {result?.checkedAt && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t("上次成功检查：", "Last successful check: ")}
                {new Date(result.checkedAt).toLocaleString()}
              </p>
            )}
          </section>
          {info?.lastUpdateResult && (
            <section
              role={
                info.lastUpdateResult.status === "failed" ? "alert" : "status"
              }
              className={
                info.lastUpdateResult.status === "failed"
                  ? "space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs"
                  : "space-y-1.5 rounded-lg border bg-muted/30 p-3 text-xs"
              }
            >
              <p className="font-medium">
                {info.lastUpdateResult.status === "failed"
                  ? t("上次更新失败", "The previous update failed")
                  : info.lastUpdateResult.status === "completed" &&
                      info.lastUpdateResult.version === info.currentVersion
                    ? t("上次更新已完成", "The previous update completed")
                    : t(
                        "最近更新记录（尚未确认当前版本启动）",
                        "Recent update record (current version startup not confirmed)",
                      )}
                {" · "}
                <span className="min-w-0 break-all font-mono">
                  v{info.lastUpdateResult.version}
                </span>
              </p>
              <p className="max-h-24 min-w-0 max-w-full overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground [overflow-wrap:anywhere]">
                {localize(info.lastUpdateResult.message)}
              </p>
            </section>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">
              {t("更新通道", "Update channel")}
            </span>
            <fieldset
              aria-label={t("更新通道", "Update channel")}
              className="flex rounded-lg border p-0.5"
            >
              {(["stable", "preview"] as const).map((channel) => (
                <Button
                  key={channel}
                  size="sm"
                  variant={state.channel === channel ? "secondary" : "ghost"}
                  aria-pressed={state.channel === channel}
                  disabled={disabled}
                  onClick={() => {
                    setConfirmInstall(false);
                    void updateSession.changeChannel(channel);
                  }}
                >
                  {channel === "stable"
                    ? t("稳定版", "Stable")
                    : t("预览版", "Preview")}
                </Button>
              ))}
            </fieldset>
          </div>
          {state.channel === "preview" && (
            <p className="text-xs text-muted-foreground">
              {t(
                "预览通道包含测试版本；不会自动降级到较旧的稳定版本。",
                "The preview channel includes test releases. Updates never automatically downgrade to an older stable release.",
              )}
            </p>
          )}
          {release ? (
            <section className="space-y-3 rounded-lg border border-primary/25 bg-primary/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  {t("发现新版本", "New version available")}
                </h3>
                <span className="min-w-0 break-all font-mono text-base font-semibold">
                  v{release.version}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {kind(release.packageKind)}
                {release.size !== null ? ` · ${formatBytes(release.size)}` : ""}
                {release.publishedAt
                  ? ` · ${new Date(release.publishedAt).toLocaleDateString()}`
                  : ""}
              </p>
              <p className="max-h-40 min-w-0 max-w-full overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
                {release.notes ||
                  t(
                    "此版本未提供更新摘要。",
                    "No release summary was provided.",
                  )}
              </p>
              <Button
                size="sm"
                variant="link"
                className="h-auto p-0"
                disabled={!safeUpdatePage(release.releaseUrl)}
                onClick={() => void showPage(release.releaseUrl)}
              >
                {t("完整更新说明", "Full release notes")}
              </Button>
            </section>
          ) : (
            !state.checking &&
            result && (
              <p
                role="status"
                className="min-w-0 break-words rounded-lg border p-3 text-sm"
              >
                {localize(result.message)}
              </p>
            )
          )}
          {!result && !state.checking && !state.error && (
            <p className="text-sm text-muted-foreground">
              {t(
                "点击“检查更新”获取此通道的发布信息；检查不会自动下载。",
                "Check this channel for releases. Checking does not download updates.",
              )}
            </p>
          )}
          {(downloadReason || (info?.blockedReason && !release)) && (
            <p
              role="status"
              className="min-w-0 whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"
            >
              {localize(downloadReason ?? info?.blockedReason ?? "")}
            </p>
          )}
          {info && (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              disabled={!safeUpdatePage(info.releaseUrl)}
              onClick={() => void showPage(info.releaseUrl)}
            >
              {t("打开 GitHub 发布页", "Open GitHub releases")}
            </Button>
          )}
          {snapshot && snapshot.stage !== "idle" && (
            <section
              aria-live="polite"
              className="space-y-2 rounded-lg border p-3"
            >
              <p className="text-sm font-medium">
                {phase === "downloading"
                  ? t("正在下载更新", "Downloading update")
                  : phase === "verifying"
                    ? t("正在校验签名…", "Verifying signature…")
                    : phase === "ready"
                      ? t("校验完成，可以安装", "Verified and ready to install")
                      : phase === "cancelled"
                        ? t(
                            "下载已取消，当前程序未改变",
                            "Download cancelled; the current program is unchanged",
                          )
                        : phase === "installing"
                          ? t("正在退出并更新…", "Exiting and updating…")
                          : t("更新操作失败", "Update operation failed")}
              </p>
              {phase === "downloading" && (
                <>
                  <div
                    role="progressbar"
                    aria-label={t("下载进度", "Download progress")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress ?? undefined}
                    className="h-2 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className={
                        progress === null
                          ? "h-full w-1/3 animate-pulse rounded-full bg-primary"
                          : "h-full rounded-full bg-primary transition-[width]"
                      }
                      style={
                        progress === null
                          ? undefined
                          : { width: `${progress}%` }
                      }
                    />
                  </div>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {formatBytes(snapshot.downloaded)}
                    {snapshot.total !== null
                      ? ` / ${formatBytes(snapshot.total)}`
                      : t(" · 总大小未知", " · Total size unknown")}
                    {progress !== null ? ` · ${progress}%` : ""}
                  </p>
                </>
              )}
              {downloading && (
                <p className="text-xs text-muted-foreground">
                  {t(
                    "后台下载，可继续使用；安装前会再次确认。",
                    "You can keep using the app during download. Installation requires confirmation.",
                  )}
                </p>
              )}
            </section>
          )}
          {(state.error || linkError) && (
            <p
              role="alert"
              className="min-w-0 whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive [overflow-wrap:anywhere]"
            >
              {localize(state.error ?? linkError ?? "")}
            </p>
          )}
          <div className="flex items-start justify-between gap-3 text-xs">
            <label htmlFor="updates-auto-check" className="leading-relaxed">
              {t(
                "启动后每天最多自动检查一次（不自动下载）",
                "Automatically check at startup at most once a day (never auto-download)",
              )}
            </label>
            <Switch
              id="updates-auto-check"
              checked={autoCheck}
              onCheckedChange={setAutoCheck}
              disabled={state.applying}
            />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(
              "保留现有账号与配置。安装前请完成任务、停止实时同步并保存/关闭草稿；不会为更新强制结束传输。",
              "Account settings are retained. Finish transfers, stop live sync, and save/close drafts before installing. Updating never forcibly terminates transfers.",
            )}
          </p>
          {confirmInstall && (
            <section className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
              <p className="text-sm font-medium">
                {t("确认退出并更新？", "Exit and install the update?")}
              </p>
              <p className="text-xs">
                {t(
                  "程序将退出，由安装器或升级助手替换程序文件。请确认其他云仓窗口已退出。",
                  "The app will exit and the installer or helper will replace program files. Ensure other Yuncang windows are closed.",
                )}
              </p>
              {blockers.length > 0 && (
                <ul role="alert" className="space-y-1 text-xs text-destructive">
                  {blockers.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmInstall(false)}
                  disabled={state.applying}
                >
                  {t("取消", "Cancel")}
                </Button>
                <Button
                  size="sm"
                  disabled={
                    state.applying ||
                    blockers.length > 0 ||
                    !updateSession.ready
                  }
                  onClick={() => void updateSession.apply()}
                >
                  {t("确认退出并更新", "Confirm exit and update")}
                </Button>
              </div>
            </section>
          )}
        </div>
        <DialogFooter className="shrink-0 flex-wrap gap-2 border-t pt-3">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || state.infoLoading}
            onClick={() => {
              setConfirmInstall(false);
              void updateSession.check();
            }}
          >
            <IconArrowsRotate
              className={state.checking ? "size-3.5 animate-spin" : "size-3.5"}
            />
            {state.checking
              ? t("正在检查…", "Checking…")
              : t("检查更新", "Check for updates")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={close}
            disabled={state.applying}
          >
            {t("稍后", "Later")}
          </Button>
          {downloading ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void updateSession.cancel()}
            >
              {t("取消下载", "Cancel download")}
            </Button>
          ) : updateSession.ready ? (
            <Button
              size="sm"
              disabled={state.applying || !!confirmInstall}
              onClick={() => setConfirmInstall(true)}
            >
              {t("退出并更新", "Exit and update")}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!updateSession.downloadAllowed || disabled}
              onClick={() => void updateSession.download()}
            >
              <IconCloudArrowDown className="size-3.5" />
              {phase === "failed" || phase === "cancelled"
                ? t("重新下载", "Retry download")
                : t("下载更新", "Download update")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
