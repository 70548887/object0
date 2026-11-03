import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { t, useT } from "@/lib/i18n";
import {
  IconArrowRightArrowLeft,
  IconArrowsRotate,
  IconBarsProgress,
  IconClockRotateLeft,
  IconCloudArrowDown,
  IconCloudArrowUp,
  IconCodeCompare,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconGear,
  IconGrip,
  IconLock,
  IconMagnifyingGlass,
  IconMoon,
  IconRotate,
  IconShareNodes,
  IconSidebar,
  IconSun,
  IconTableList,
  IconTrashCan,
} from "@/lib/icons";
import {
  dispatchObjectToolbarEvent,
  OBJECT_TOOLBAR_EVENTS,
} from "@/lib/object-toolbar-events";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useThemeStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { qiniuUnfinishedTransferReason } from "../objects/qiniu-transfer-gates";
import { toast } from "./Toast";

interface PaletteCommand {
  id: string;
  label: string;
  Icon: LucideIcon;
  section: string;
  shortcut?: string;
  action: () => void;
}

export function CommandPalette() {
  useT();
  const [open, setOpen] = useState(false);

  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const setJobPanelOpen = useUIStore((s) => s.setJobPanelOpen);
  const jobPanelOpen = useUIStore((s) => s.jobPanelOpen);
  const setShareHistoryOpen = useUIStore((s) => s.setShareHistoryOpen);
  const shareHistoryOpen = useUIStore((s) => s.shareHistoryOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const openSyncChooser = useUIStore((s) => s.openSyncChooser);
  const setFolderSyncPanelOpen = useUIStore((s) => s.setFolderSyncPanelOpen);
  const folderSyncPanelOpen = useUIStore((s) => s.folderSyncPanelOpen);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const theme = useThemeStore((s) => s.theme);
  const lock = useVaultStore((s) => s.lock);
  const plaintext = useVaultStore((s) => s.storageMode === "plaintext");
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const mainSection = useUIStore((s) => s.mainSection);
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const latestProfile = useVaultStore((s) =>
    s.profiles.find((profile) => profile.id === activeProfileId),
  );
  const syncBlocked = qiniuUnfinishedTransferReason(
    latestProfile ?? activeProfile,
    "sync",
  );
  const bucket = useBucketStore((s) => s.selectedBucket);
  const selectedKeys = useObjectStore((s) => s.selectedKeys);
  const selectedCount = selectedKeys.size;
  const shareableSelection =
    selectedCount === 1 && !Array.from(selectedKeys)[0]?.endsWith("/");

  const commands: PaletteCommand[] = (() => {
    const baseCommands: PaletteCommand[] = [
      {
        id: "toggle-sidebar",
        label: t("显示或隐藏侧栏", "Toggle Sidebar"),
        Icon: IconSidebar,
        section: t("视图", "View"),
        shortcut: "Ctrl+B",
        action: toggleSidebar,
      },
      {
        id: "toggle-theme",
        label: t(
          `切换到${theme === "dark" ? "浅色" : "深色"}主题`,
          `Switch to ${theme === "dark" ? t("浅色", "Light") : t("深色", "Dark")} theme`,
        ),
        Icon: theme === "dark" ? IconSun : IconMoon,
        section: t("视图", "View"),
        shortcut: "Ctrl+\\",
        action: toggleTheme,
      },
      {
        id: "toggle-jobs",
        label: jobPanelOpen
          ? t("隐藏任务面板", "Hide Job Panel")
          : t("显示任务面板", "Show Job Panel"),
        Icon: IconBarsProgress,
        section: t("视图", "View"),
        shortcut: "Ctrl+J",
        action: () => setJobPanelOpen(!jobPanelOpen),
      },
      {
        id: "toggle-share-history",
        label: shareHistoryOpen
          ? t("隐藏分享记录", "Hide Share History")
          : t("显示分享记录", "Show Share History"),
        Icon: IconClockRotateLeft,
        section: t("视图", "View"),
        action: () => setShareHistoryOpen(!shareHistoryOpen),
      },
      {
        id: "view-table",
        label: t("切换为列表视图", "Switch to Table View"),
        Icon: IconTableList,
        section: t("视图", "View"),
        action: () => setViewMode("table"),
      },
      {
        id: "view-grid",
        label: t("切换为网格视图", "Switch to Grid View"),
        Icon: IconGrip,
        section: t("视图", "View"),
        action: () => setViewMode("grid"),
      },
      {
        id: "open-settings",
        label: settingsOpen
          ? t("关闭设置", "Close Settings")
          : t("打开设置", "Open Settings"),
        Icon: IconGear,
        section: t("应用", "App"),
        action: () => setSettingsOpen(!settingsOpen),
      },
      ...(!plaintext
        ? [
            {
              id: "lock-vault",
              label: t("锁定密码库", "Lock Vault"),
              Icon: IconLock,
              section: t("应用", "App"),
              action: lock,
            },
          ]
        : []),
      {
        id: "toggle-live-folder-sync",
        label: folderSyncPanelOpen
          ? t("隐藏实时文件夹同步", "Hide Live Folder Sync")
          : t("显示实时文件夹同步", "Show Live Folder Sync"),
        Icon: IconFolderOpen,
        section: t("同步", "Sync"),
        action: () => setFolderSyncPanelOpen(!folderSyncPanelOpen),
      },
      {
        id: "choose-sync-type",
        label: t("选择同步方式", "Choose Sync Type"),
        Icon: IconCodeCompare,
        section: t("同步", "Sync"),
        action: () => {
          if (useUIStore.getState().mainSection !== "storage") return;
          if (syncBlocked) return toast.warning(syncBlocked);
          openSyncChooser();
        },
      },
    ];

    if (mainSection !== "storage") {
      return baseCommands.filter(
        (command) => command.id !== "choose-sync-type",
      );
    }
    if (!activeProfileId || !bucket) {
      return baseCommands;
    }

    const objectCommands: PaletteCommand[] = [
      {
        id: "obj-search",
        label: t("搜索文件", "Search Objects"),
        Icon: IconMagnifyingGlass,
        section: t("文件", "Objects"),
        shortcut: "Ctrl+F",
        action: () =>
          dispatchObjectToolbarEvent(OBJECT_TOOLBAR_EVENTS.OPEN_SEARCH),
      },
      {
        id: "obj-refresh",
        label: t("刷新文件列表", "Refresh Objects"),
        Icon: IconArrowsRotate,
        section: t("文件", "Objects"),
        action: () =>
          dispatchObjectToolbarEvent(OBJECT_TOOLBAR_EVENTS.REFRESH_OBJECTS),
      },
      {
        id: "obj-upload-files",
        label: t("上传文件", "Upload Files"),
        Icon: IconCloudArrowUp,
        section: t("文件", "Objects"),
        action: () =>
          dispatchObjectToolbarEvent(OBJECT_TOOLBAR_EVENTS.UPLOAD_FILES),
      },
      {
        id: "obj-upload-folder",
        label: t("上传文件夹", "Upload Folder"),
        Icon: IconFolderPlus,
        section: t("文件", "Objects"),
        action: () =>
          dispatchObjectToolbarEvent(OBJECT_TOOLBAR_EVENTS.UPLOAD_FOLDER),
      },
      {
        id: "obj-new-folder",
        label: t("新建文件夹", "Create Folder"),
        Icon: IconFolder,
        section: t("文件", "Objects"),
        action: () =>
          dispatchObjectToolbarEvent(OBJECT_TOOLBAR_EVENTS.NEW_FOLDER),
      },
      {
        id: "obj-sync",
        label: t("打开同步（默认）", "Open Sync (Default)"),
        Icon: IconRotate,
        section: t("文件", "Objects"),
        action: () =>
          dispatchObjectToolbarEvent(OBJECT_TOOLBAR_EVENTS.OPEN_SYNC),
      },
    ];

    if (selectedCount > 0) {
      objectCommands.push(
        {
          id: "obj-download-selection",
          label: t(
            `下载选中项（${selectedCount}）`,
            `Download selected (${selectedCount})`,
          ),
          Icon: IconCloudArrowDown,
          section: t("文件", "Objects"),
          action: () =>
            dispatchObjectToolbarEvent(
              OBJECT_TOOLBAR_EVENTS.DOWNLOAD_SELECTION,
            ),
        },
        {
          id: "obj-transfer-selection",
          label: t(
            `传输选中项（${selectedCount}）`,
            `Transfer selected (${selectedCount})`,
          ),
          Icon: IconArrowRightArrowLeft,
          section: t("文件", "Objects"),
          action: () =>
            dispatchObjectToolbarEvent(OBJECT_TOOLBAR_EVENTS.OPEN_TRANSFER),
        },
        {
          id: "obj-delete-selection",
          label: t(
            `删除选中项（${selectedCount}）`,
            `Delete selected (${selectedCount})`,
          ),
          Icon: IconTrashCan,
          section: t("文件", "Objects"),
          action: () =>
            dispatchObjectToolbarEvent(OBJECT_TOOLBAR_EVENTS.DELETE_SELECTION),
        },
      );
    }

    if (shareableSelection) {
      objectCommands.push({
        id: "obj-share-selection",
        label: t("分享选中文件", "Share Selected File"),
        Icon: IconShareNodes,
        section: t("文件", "Objects"),
        action: () =>
          dispatchObjectToolbarEvent(OBJECT_TOOLBAR_EVENTS.SHARE_SELECTION),
      });
    }

    return [...baseCommands, ...objectCommands];
  })();

  const execute = useCallback((cmd: PaletteCommand) => {
    setOpen(false);
    cmd.action();
  }, []);

  // Global shortcut to open
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Group commands by section for rendering
  // cmdk owns filtering + hides empty groups; we pass all sections unfiltered.
  const sections = useMemo(() => {
    const map = new Map<string, PaletteCommand[]>();
    for (const cmd of commands) {
      const list = map.get(cmd.section) ?? [];
      list.push(cmd);
      map.set(cmd.section, list);
    }
    return map;
  }, [commands]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <Command>
        <CommandInput placeholder={t("输入命令…", "Type a command…")} />
        <CommandList>
          <CommandEmpty>
            {t("没有匹配的命令", "No matching commands")}
          </CommandEmpty>
          {Array.from(sections.entries()).map(([section, cmds]) => (
            <CommandGroup key={section} heading={section}>
              {cmds.map((cmd) => (
                <CommandItem
                  key={cmd.id}
                  value={`${cmd.section} ${cmd.label}`}
                  onSelect={() => execute(cmd)}
                >
                  <cmd.Icon className="size-4" />
                  <span className="flex-1">{cmd.label}</span>
                  {cmd.shortcut && (
                    <CommandShortcut>{cmd.shortcut}</CommandShortcut>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        {mainSection === "storage" && activeProfile && bucket && (
          <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
            {`${activeProfile.name} / ${bucket}`}
          </div>
        )}
      </Command>
    </CommandDialog>
  );
}
