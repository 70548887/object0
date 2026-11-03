import { getCurrentWindow } from "@tauri-apps/api/window";
import { lazy, Suspense } from "react";
import { t, useT } from "@/lib/i18n";
import {
  IconClockRotateLeft,
  IconCloud,
  IconFolderOpen,
  IconGear,
  IconListCheck,
  IconMoon,
  IconSun,
} from "@/lib/icons";
import { cn } from "@/lib/utils";
import {
  useFolderSyncStore,
  useJobStore,
  useShareHistoryStore,
  useThemeStore,
  useUIStore,
} from "@/stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { SidebarTrigger } from "../ui/sidebar";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { WindowControls } from "./WindowControls";

const JobPanel = lazy(() =>
  import("../jobs/JobPanel").then((m) => ({ default: m.JobPanel })),
);

// Full-window chrome belongs above both the sidebar and the object workspace.
export function AppTitleBar() {
  useT();
  const toggleTheme = useThemeStore((s) => s.toggle);
  const theme = useThemeStore((s) => s.theme);
  const jobPanelOpen = useUIStore((s) => s.jobPanelOpen);
  const transfersVisible = useUIStore((s) => s.mainSection === "transfers");
  const setJobPanelOpen = useUIStore((s) => s.setJobPanelOpen);
  const jobs = useJobStore((s) => s.jobs);
  const activeJobCount = jobs.filter(
    (j) => j.status === "running" || j.status === "queued",
  ).length;

  const shareHistoryOpen = useUIStore((s) => s.shareHistoryOpen);
  const sharesVisible = useUIStore((s) => s.mainSection === "shares");
  const setShareHistoryOpen = useUIStore((s) => s.setShareHistoryOpen);
  const shareHistoryCount = useShareHistoryStore((s) => s.entries.length);
  const folderSyncPanelOpen = useUIStore((s) => s.folderSyncPanelOpen);
  const setFolderSyncPanelOpen = useUIStore((s) => s.setFolderSyncPanelOpen);
  const syncingCount = useFolderSyncStore((s) => s.getSyncingCount);
  const activeCount = useFolderSyncStore((s) => s.getActiveCount);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const platform = useUIStore((s) => s.platform);
  const title = t(
    "云仓 (Yuncang) · 多云对象存储管理器",
    "Yuncang · Multi-cloud object storage manager",
  );

  return (
    // Custom title bar. `data-tauri-drag-region` makes the empty surface
    // draggable on all platforms (unlike the `-webkit-app-region` CSS, which
    // does not work on Linux/WebKitGTK). Interactive children are separate
    // pointer targets, so they don't drag.
    // biome-ignore lint/a11y/noStaticElementInteractions: window title-bar drag/maximize chrome, not content
    <header
      data-tauri-drag-region
      className="flex min-h-11 w-full shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-blue-50/80 px-3 py-1.5 dark:bg-card/90"
      onDoubleClick={(e) => {
        // macOS/Windows get native double-click-to-maximize from the drag
        // region; Linux needs an explicit handler. Only fire on the drag
        // surface itself, never on a child control.
        if (platform !== "linux") return;
        if (!(e.target as HTMLElement).hasAttribute("data-tauri-drag-region")) {
          return;
        }
        getCurrentWindow().toggleMaximize();
      }}
    >
      <div
        data-tauri-drag-region
        className={cn(
          "flex min-w-0 basis-full items-center gap-2 sm:basis-[24rem] sm:flex-1",
          // Clear the native macOS traffic lights, which float over the bar.
          platform === "macos" && "pl-[72px]",
        )}
      >
        {/* Outside the mobile Sheet so a closed sidebar can always be opened. */}
        <SidebarTrigger
          className="no-drag shrink-0 md:hidden"
          title={t("显示或隐藏侧栏（Ctrl+B）", "Toggle sidebar (Ctrl+B)")}
          aria-label={t("显示或隐藏侧栏", "Toggle sidebar")}
        />
        <div className="pointer-events-none flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <IconCloud className="size-4" />
          </span>
          <span
            className="min-w-0 truncate text-sm font-semibold tracking-tight"
            title={title}
          >
            {title}
          </span>
        </div>
        {/* Unobstructed blank surface to drag even when the title is short. */}
        <div
          data-tauri-drag-region
          className="h-7 min-w-4 flex-1 self-stretch"
        />
      </div>

      {/* On narrow windows the tools move below the title and may wrap,
          keeping every action and window control reachable without overflow. */}
      <fieldset
        className="no-drag m-0 ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-0.5 border-0 p-0"
        aria-label={t("全局工具", "Global tools")}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="no-drag"
          onClick={toggleTheme}
          title={t("切换主题（Ctrl+\\）", "Toggle Theme (Ctrl+\\)")}
          aria-label={t("切换主题", "Toggle theme")}
        >
          {theme === "dark" ? (
            <IconSun className="size-4" />
          ) : (
            <IconMoon className="size-4" />
          )}
        </Button>

        <div className="no-drag relative">
          <Button
            variant={sharesVisible ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={() =>
              setShareHistoryOpen(!shareHistoryOpen && !sharesVisible)
            }
            title={
              sharesVisible
                ? t(
                    "分享记录已在主区域显示",
                    "Sharing history is already shown in the workspace",
                  )
                : t("分享记录", "Share History")
            }
            aria-label={t("显示或隐藏分享记录", "Toggle share history")}
            aria-pressed={sharesVisible}
          >
            <IconClockRotateLeft className="size-4" />
          </Button>
          {shareHistoryCount > 0 && (
            <Badge
              variant="outline"
              className="absolute -top-1 -right-1 min-w-4 px-1 text-[10px]"
            >
              {shareHistoryCount}
            </Badge>
          )}
        </div>

        <Popover
          open={jobPanelOpen && !transfersVisible}
          onOpenChange={(open) => setJobPanelOpen(open && !transfersVisible)}
        >
          <div className="no-drag relative">
            <PopoverTrigger
              render={
                <Button
                  variant={transfersVisible ? "secondary" : "ghost"}
                  size="icon-sm"
                  title={
                    transfersVisible
                      ? t(
                          "传输列表已在主区域显示",
                          "Transfers are already shown in the workspace",
                        )
                      : t(
                          "显示或隐藏任务面板（Ctrl+J）",
                          "Toggle Jobs Panel (Ctrl+J)",
                        )
                  }
                  aria-label={t("显示或隐藏任务面板", "Toggle jobs panel")}
                  aria-pressed={transfersVisible}
                >
                  <IconListCheck className="size-4" />
                </Button>
              }
            />
            {activeJobCount > 0 && (
              <Badge className="absolute -top-1 -right-1 min-w-4 border-transparent bg-info px-1 text-[10px] text-info-foreground">
                {activeJobCount}
              </Badge>
            )}
          </div>
          <PopoverContent
            align="end"
            sideOffset={8}
            className="flex w-[min(400px,calc(100vw_-_1rem))] flex-col gap-0 overflow-hidden p-0"
          >
            <Suspense fallback={null}>
              <JobPanel />
            </Suspense>
          </PopoverContent>
        </Popover>

        <div className="no-drag relative">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setFolderSyncPanelOpen(!folderSyncPanelOpen)}
            title={t(
              "实时文件夹同步（本地与存储桶持续同步）",
              "Live Folder Sync (continuous local <-> bucket)",
            )}
            aria-label={t(
              "显示或隐藏实时同步面板",
              "Toggle live folder sync panel",
            )}
          >
            <IconFolderOpen
              className={`size-4 ${syncingCount() > 0 ? "text-info" : ""}`}
            />
          </Button>
          {activeCount() > 0 && (
            <Badge className="absolute -top-1 -right-1 min-w-4 px-1 text-[10px] bg-success text-success-foreground border-transparent">
              {activeCount()}
            </Badge>
          )}
        </div>

        <KeyboardShortcutsDialog />

        <Button
          variant="ghost"
          size="icon-sm"
          className="no-drag"
          onClick={() => setSettingsOpen(!settingsOpen)}
          title={t("设置（Ctrl+,）", "Settings (Ctrl+,)")}
          aria-label={t("显示或隐藏设置面板", "Toggle settings panel")}
        >
          <IconGear className="size-4" />
        </Button>

        {/* Custom min/maximize/close controls — Windows & Linux only; macOS
            uses its native traffic lights. */}
        {platform && platform !== "macos" && <WindowControls />}
      </fieldset>
    </header>
  );
}
