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
import { IconGear, IconSpinner, IconTrashCan, IconXmark } from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import { useShareHistoryStore, useThemeStore, useUIStore } from "@/stores";
import { useKeychainStatus } from "./useKeychainStatus";

export function SettingsPanel() {
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
  const {
    hasStoredPassphrase,
    keychainAvailable,
    keychainBusy,
    keychainMessage,
    keychainError,
    keychainStatusText,
    keychainBadge,
    keychainBadgeClass,
    forgetStoredPassphrase,
  } = useKeychainStatus();

  return (
    <Sheet
      open={settingsOpen}
      onOpenChange={(o) => {
        if (!o) setSettingsOpen(false);
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-[360px] flex-col gap-0 p-0 sm:max-w-none"
      >
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0 border-border border-b px-4 py-3">
          <SheetTitle className="flex min-w-0 items-center gap-2 font-semibold text-sm">
            <IconGear className="size-4 shrink-0 text-foreground/60" />
            <span className="truncate">设置</span>
          </SheetTitle>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-foreground/50 hover:text-foreground"
              onClick={() => setSettingsOpen(false)}
              title={"关闭"}
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
                外观
              </h4>
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">主题</span>
                  <Select
                    value={theme}
                    onValueChange={(v) => {
                      if (v != null) setTheme(v as "dark" | "light");
                    }}
                  >
                    <SelectTrigger size="sm" className="w-32">
                      <SelectValue>
                        {(value) => {
                          const labels: Record<string, string> = {
                            dark: "Dark",
                            light: "Light",
                          };
                          return labels[value as string] ?? (value as string);
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="dark">深色</SelectItem>
                      <SelectItem value="light">浅色</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">默认视图</span>
                  <Select
                    value={viewMode}
                    onValueChange={(v) => {
                      if (v != null) setViewMode(v as "table" | "grid");
                    }}
                  >
                    <SelectTrigger size="sm" className="w-32">
                      <SelectValue>
                        {(value) => {
                          const labels: Record<string, string> = {
                            table: "Table",
                            grid: "Grid",
                          };
                          return labels[value as string] ?? (value as string);
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="table">列表</SelectItem>
                      <SelectItem value="grid">网格</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>

            {/* Browsing */}
            <section>
              <h4 className="mb-3 font-semibold text-foreground/50 text-xs uppercase tracking-wider">
                浏览
              </h4>
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm">每页数量</span>
                    <p className="text-[10px] text-foreground/40">
                      每页加载的文件数量
                    </p>
                  </div>
                  <Select
                    value={String(pageSize)}
                    onValueChange={(v) => {
                      if (v != null) setPageSize(Number(v));
                    }}
                  >
                    <SelectTrigger size="sm" className="w-32">
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
                通知
              </h4>
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm">桌面通知</span>
                    <p className="text-[10px] text-foreground/40">
                      任务完成时通知
                    </p>
                  </div>
                  <Switch
                    checked={desktopNotifications}
                    onCheckedChange={setDesktopNotifications}
                  />
                </div>
              </div>
            </section>

            {/* Privacy */}
            <section>
              <h4 className="mb-3 font-semibold text-foreground/50 text-xs uppercase tracking-wider">
                隐私
              </h4>
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm">保存分享记录</span>
                    <p className="text-[10px] text-foreground/40">
                      在本机保存分享链接，重启后仍可查看
                    </p>
                  </div>
                  <Switch
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
                传输
              </h4>
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm">并发任务数</span>
                    <p className="text-[10px] text-foreground/40">
                      最多同时进行的传输任务（默认 3 个）
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
                    <SelectTrigger size="sm" className="w-32">
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

            {/* Vault */}
            <section>
              <h4 className="mb-3 font-semibold text-foreground/50 text-xs uppercase tracking-wider">
                密码库
              </h4>
              <div className="flex flex-col gap-3">
                <div className="space-y-2 rounded-md border border-border/70 bg-card/35 p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-sm">已保存的密码</span>
                      <p className="text-[10px] text-foreground/40">
                        {keychainStatusText}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-1.5 py-px text-[9px] ${keychainBadgeClass}`}
                    >
                      {keychainBadge.label}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="xs"
                      className="w-full"
                      disabled={
                        keychainBusy ||
                        keychainAvailable === false ||
                        hasStoredPassphrase === null ||
                        !hasStoredPassphrase
                      }
                      onClick={forgetStoredPassphrase}
                    >
                      {keychainBusy ? (
                        <IconSpinner className="size-3.5 animate-spin" />
                      ) : (
                        <>
                          <IconTrashCan className="size-3.5" />
                          移除保存的密码
                        </>
                      )}
                    </Button>
                  </div>
                  <p className="text-[10px] text-foreground/35">
                    从系统钥匙串中移除已保存的密码。
                  </p>

                  {keychainMessage && (
                    <p className="text-[10px] text-success">
                      {keychainMessage}
                    </p>
                  )}
                  {keychainError && (
                    <p className="text-[10px] text-destructive">
                      {keychainError}
                    </p>
                  )}
                </div>
              </div>
            </section>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
