import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { CONCURRENCY_OPTIONS, PAGE_SIZES } from "@/lib/constants";
import { useT } from "@/lib/i18n";
import { IconGear, IconXmark } from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import {
  useShareHistoryStore,
  useThemeStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { useLocaleStore } from "@/stores/useLocaleStore";
import { LegacyImportDialog } from "../vault/LegacyImport";

export function SettingsPanel() {
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const pageSize = useUIStore((s) => s.pageSize);
  const setPageSize = useUIStore((s) => s.setPageSize);
  const desktopNotifications = useUIStore((s) => s.desktopNotifications);
  const setDesktopNotifications = useUIStore((s) => s.setDesktopNotifications);
  const persistShareHistory = useUIStore((s) => s.persistShareHistory);
  const setPersistShareHistory = useUIStore((s) => s.setPersistShareHistory);
  const jobConcurrency = useUIStore((s) => s.jobConcurrency);
  const setJobConcurrency = useUIStore((s) => s.setJobConcurrency);
  const clearShareHistory = useShareHistoryStore((s) => s.clearAll);
  const unlocked = useVaultStore((state) => state.unlocked);
  const configPath = useVaultStore((state) => state.configPath);
  const legacyAvailable = useVaultStore((state) => state.legacyAvailable);
  const importingLegacy = useVaultStore((state) => state.importingLegacy);
  const [legacyImportOpen, setLegacyImportOpen] = useState(false);

  return (
    <>
      <Sheet
        open={settingsOpen}
        onOpenChange={(o) => {
          if (!o && !importingLegacy) setSettingsOpen(false);
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          className="flex w-[360px] max-w-full flex-col gap-0 p-0 sm:max-w-none"
        >
          <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0 border-border border-b px-4 py-3">
            <SheetTitle className="flex min-w-0 items-center gap-2 font-semibold text-sm">
              <IconGear className="size-4 shrink-0 text-foreground/60" />
              <span className="truncate">{t("设置", "Settings")}</span>
            </SheetTitle>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-foreground/50 hover:text-foreground"
                onClick={() => setSettingsOpen(false)}
                title={t("关闭", "Close")}
                aria-label={t("关闭设置", "Close settings")}
              >
                <IconXmark className="size-4" />
              </Button>
            </div>
          </SheetHeader>

          {/* Settings body */}
          <div className="flex-1 overflow-y-auto p-4">
            <div className="flex flex-col gap-6">
              {/* Appearance */}
              <section>
                <h4 className="mb-3 font-semibold text-foreground/50 text-xs uppercase tracking-wider">
                  {t("外观", "Appearance")}
                </h4>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor="settings-language" className="text-sm">
                      {t("语言", "Language")}
                    </label>
                    <Select
                      value={locale}
                      onValueChange={(value) => {
                        if (value === "zh-CN" || value === "en")
                          setLocale(value);
                      }}
                    >
                      <SelectTrigger
                        id="settings-language"
                        aria-label={t("界面语言", "Interface language")}
                        size="sm"
                        className="w-32 shrink-0"
                      >
                        <SelectValue>
                          {(value) => (value === "en" ? "English" : "简体中文")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="zh-CN">简体中文</SelectItem>
                        <SelectItem value="en">English</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">{t("主题", "Theme")}</span>
                    <Select
                      value={theme}
                      onValueChange={(v) => {
                        if (v != null) setTheme(v as "dark" | "light");
                      }}
                    >
                      <SelectTrigger
                        aria-label={t("主题", "Theme")}
                        size="sm"
                        className="w-32"
                      >
                        <SelectValue>
                          {(value) => {
                            const labels: Record<string, string> = {
                              dark: t("深色", "Dark"),
                              light: t("浅色", "Light"),
                            };
                            return labels[value as string] ?? (value as string);
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="dark">
                          {t("深色", "Dark")}
                        </SelectItem>
                        <SelectItem value="light">
                          {t("浅色", "Light")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">
                      {t("默认视图", "Default view")}
                    </span>
                    <Select
                      value={viewMode}
                      onValueChange={(v) => {
                        if (v != null) setViewMode(v as "table" | "grid");
                      }}
                    >
                      <SelectTrigger
                        aria-label={t("默认视图", "Default view")}
                        size="sm"
                        className="w-32"
                      >
                        <SelectValue>
                          {(value) => {
                            const labels: Record<string, string> = {
                              table: t("列表", "Table"),
                              grid: t("网格", "Grid"),
                            };
                            return labels[value as string] ?? (value as string);
                          }}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="table">
                          {t("列表", "Table")}
                        </SelectItem>
                        <SelectItem value="grid">
                          {t("网格", "Grid")}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </section>

              {/* Browsing */}
              <section>
                <h4 className="mb-3 font-semibold text-foreground/50 text-xs uppercase tracking-wider">
                  {t("浏览", "Browse")}
                </h4>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm">
                        {t("每页数量", "Page size")}
                      </span>
                      <p className="text-[10px] text-foreground/40">
                        {t(
                          "每页加载的文件数量",
                          "Number of objects loaded per page",
                        )}
                      </p>
                    </div>
                    <Select
                      value={String(pageSize)}
                      onValueChange={(v) => {
                        if (v != null) setPageSize(Number(v));
                      }}
                    >
                      <SelectTrigger
                        aria-label={t("每页数量", "Page size")}
                        size="sm"
                        className="w-32"
                      >
                        <SelectValue>{(value) => value as string}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {PAGE_SIZES.map((s) => (
                          <SelectItem key={s} value={String(s)}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </section>

              {/* Notifications */}
              <section>
                <h4 className="mb-3 font-semibold text-foreground/50 text-xs uppercase tracking-wider">
                  {t("通知", "Notifications")}
                </h4>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm">
                        {t("桌面通知", "Desktop notifications")}
                      </span>
                      <p className="text-[10px] text-foreground/40">
                        {t("任务完成时通知", "Notify when a job finishes")}
                      </p>
                    </div>
                    <Switch
                      aria-label={t("桌面通知", "Desktop notifications")}
                      checked={desktopNotifications}
                      onCheckedChange={setDesktopNotifications}
                    />
                  </div>
                </div>
              </section>

              {/* Privacy */}
              <section>
                <h4 className="mb-3 font-semibold text-foreground/50 text-xs uppercase tracking-wider">
                  {t("隐私", "Privacy")}
                </h4>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm">
                        {t("保存分享记录", "Save share history")}
                      </span>
                      <p className="text-[10px] text-foreground/40">
                        {t(
                          "在本机保存分享链接，重启后仍可查看",
                          "Keep share links on this device across restarts",
                        )}
                      </p>
                    </div>
                    <Switch
                      aria-label={t("保存分享记录", "Save share history")}
                      checked={persistShareHistory}
                      onCheckedChange={(enabled) => {
                        setPersistShareHistory(enabled);
                        if (!enabled) clearShareHistory();
                      }}
                    />
                  </div>
                </div>
              </section>

              {/* Transfers */}
              <section>
                <h4 className="mb-3 font-semibold text-foreground/50 text-xs uppercase tracking-wider">
                  {t("传输", "Transfers")}
                </h4>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-sm">
                        {t("并发任务数", "Concurrent jobs")}
                      </span>
                      <p className="text-[10px] text-foreground/40">
                        {t(
                          "最多同时进行的传输任务（默认 3 个）",
                          "Maximum simultaneous transfers (default: 3)",
                        )}
                      </p>
                    </div>
                    <Select
                      value={String(jobConcurrency)}
                      onValueChange={(v) => {
                        if (v == null) return;
                        const n = Number(v);
                        setJobConcurrency(n);
                        rpcCall("jobs:set-concurrency", { concurrency: n });
                      }}
                    >
                      <SelectTrigger
                        aria-label={t("并发任务数", "Concurrent jobs")}
                        size="sm"
                        className="w-32"
                      >
                        <SelectValue>{(value) => value as string}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {CONCURRENCY_OPTIONS.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </section>

              {/* Local accounts */}
              <section className="space-y-3">
                <h4 className="font-semibold text-foreground/50 text-xs uppercase tracking-wider">
                  {t("本地账号", "Local accounts")}
                </h4>
                <p className="text-sm">
                  {t("明文保存在本机", "Saved locally as plaintext")}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t(
                    "无需云仓密码或恢复密钥。能读取账号文件的程序可以读取 AK/SK；请勿分享该文件。",
                    "No Yuncang password or recovery key is required. Programs with access to the account file can read AK/SK; do not share it.",
                  )}
                </p>
                {configPath && (
                  <p className="break-all text-xs text-muted-foreground">
                    {configPath}
                  </p>
                )}
                {legacyAvailable && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!unlocked}
                    onClick={() => setLegacyImportOpen(true)}
                  >
                    {t("导入旧加密库账号", "Import old encrypted accounts")}
                  </Button>
                )}
              </section>
            </div>
          </div>
        </SheetContent>
      </Sheet>
      <LegacyImportDialog
        open={legacyImportOpen}
        onClose={() => setLegacyImportOpen(false)}
      />
    </>
  );
}
