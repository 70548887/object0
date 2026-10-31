import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useS3Objects } from "@/hooks";
import { localize, t, useT } from "@/lib/i18n";
import {
  IconArrowRightArrowLeft,
  IconArrowsRotate,
  IconChevronDown,
  IconCloudArrowDown,
  IconCloudArrowUp,
  IconFileZipper,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconGrip,
  IconMagnifyingGlass,
  IconRotate,
  IconShareNodes,
  IconTableList,
  IconTrashCan,
  IconXmark,
} from "@/lib/icons";
import { OBJECT_TOOLBAR_EVENTS } from "@/lib/object-toolbar-events";
import { rpcCall } from "@/lib/rpc-client";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
} from "@/stores";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { toast } from "../common/Toast";
import { CreateFolderDialog } from "./CreateFolderDialog";
import { usePendingDelete } from "./usePendingDelete";

export function ObjectToolbar() {
  useT();
  const profileId = useProfileStore((s) => s.activeProfileId);
  const bucket = useBucketStore((s) => s.selectedBucket);
  const { selectedKeys, clearSelection, refresh, filters, setFilters } =
    useS3Objects();
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const openSyncEntry = useUIStore((s) => s.openSyncEntry);
  const syncEntryPreference = useUIStore((s) => s.syncEntryPreference);
  const openShareDialog = useUIStore((s) => s.openShareDialog);
  const openTransferDialog = useUIStore((s) => s.openTransferDialog);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);

  const requestDelete = usePendingDelete({
    profileId,
    bucket,
    selectedKeys,
    clearSelection,
    refresh,
  });

  const selected = Array.from(selectedKeys);
  const singleSelectedKey = selected.length === 1 ? selected[0] : null;
  const hasSelection = selectedKeys.size > 0;
  const canShare =
    !!singleSelectedKey &&
    !!profileId &&
    !!bucket &&
    !singleSelectedKey.endsWith("/");
  const syncButtonLabel =
    syncEntryPreference === "object-sync"
      ? t("对象同步", "Object sync")
      : syncEntryPreference === "live-folder-sync"
        ? t("实时同步", "Live sync")
        : t("同步", "Sync");
  const SyncButtonIcon =
    syncEntryPreference === "live-folder-sync" ? IconFolderOpen : IconRotate;
  const syncButtonTitle =
    syncEntryPreference === null
      ? t(
          "选择一次性对象同步或实时文件夹同步",
          "Choose one-time object sync or live folder sync",
        )
      : t(
          "打开默认同步方式（可在命令面板中修改）",
          "Open the default sync mode (change it in the command palette)",
        );

  const openSearch = useCallback(() => {
    useUIStore.getState().setObjectSearchOpen(true);
  }, []);

  const handleUpload = useCallback(async () => {
    if (!profileId || !bucket) return;
    const prefix = useObjectStore.getState().currentPrefix;

    try {
      const result = await rpcCall("transfer:pick-and-upload", {
        profileId,
        bucket,
        prefix,
      });
      if (result.jobIds.length > 0) {
        useUIStore.getState().setJobPanelOpen(true);
        toast.success(
          t(
            `正在上传 ${result.jobIds.length} 个文件`,
            `Uploading ${result.jobIds.length} files`,
          ),
        );
      }
    } catch (err: unknown) {
      // Tauri rejects with the raw error string, not an Error instance.
      const msg = err instanceof Error ? localize(err.message) : String(err);
      toast.error(t(`上传失败：${msg}`, `Upload failed: ${msg}`));
    }
  }, [profileId, bucket]);

  const handleUploadFolder = useCallback(async () => {
    if (!profileId || !bucket) return;
    const prefix = useObjectStore.getState().currentPrefix;

    try {
      const result = await rpcCall("transfer:pick-and-upload-folder", {
        profileId,
        bucket,
        prefix,
      });
      if (result.jobIds.length > 0) {
        useUIStore.getState().setJobPanelOpen(true);
        toast.success(
          t(
            `正在上传文件夹中的 ${result.jobIds.length} 个文件`,
            `Uploading ${result.jobIds.length} files from folder`,
          ),
        );
      }
    } catch (err: unknown) {
      // Tauri rejects with the raw error string, not an Error instance.
      const msg = err instanceof Error ? localize(err.message) : String(err);
      toast.error(t(`上传文件夹失败：${msg}`, `Folder upload failed: ${msg}`));
    }
  }, [profileId, bucket]);

  const handleDownload = useCallback(async () => {
    if (!profileId || !bucket || selectedKeys.size === 0) return;

    let started = false;
    for (const key of selectedKeys) {
      try {
        const isFolder = key.endsWith("/");

        if (isFolder) {
          const result = await rpcCall("transfer:download-folder", {
            profileId,
            bucket,
            prefix: key,
          });
          if (result.jobIds.length > 0) {
            if (!started) {
              useUIStore.getState().setJobPanelOpen(true);
              started = true;
            }
            const folderName = key.slice(0, -1).split("/").pop() || key;
            toast.info(
              t(
                `正在下载文件夹 ${folderName}（${result.jobIds.length} 个文件）`,
                `Downloading folder ${folderName} (${result.jobIds.length} files)`,
              ),
            );
          }
        } else {
          await rpcCall("transfer:download", {
            profileId,
            bucket,
            key,
            localPath: `~/Downloads/${key.split("/").pop()}`,
          });
          if (!started) {
            useUIStore.getState().setJobPanelOpen(true);
            started = true;
          }
          toast.info(
            t(
              `正在下载 ${key.split("/").pop()}`,
              `Downloading ${key.split("/").pop()}`,
            ),
          );
        }
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.message === "No destination folder selected"
        )
          return;
        toast.error(
          err instanceof Error
            ? localize(err.message)
            : t("未知错误", "Unknown error"),
        );
      }
    }
  }, [profileId, bucket, selectedKeys]);

  const handleDownloadArchive = useCallback(async () => {
    if (!profileId || !bucket || selectedKeys.size === 0) return;

    try {
      const keys = Array.from(selectedKeys);
      const prefix = useObjectStore.getState().currentPrefix;

      await rpcCall("transfer:download-archive", {
        profileId,
        bucket,
        keys,
        prefix: prefix || undefined,
      });

      useUIStore.getState().setJobPanelOpen(true);
      toast.info(
        t(
          `正在将 ${keys.length} 个文件打包为 .tar.gz`,
          `Creating a .tar.gz archive of ${keys.length} files`,
        ),
      );
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.message === "No destination folder selected"
      )
        return;
      toast.error(
        t(
          `打包失败：${err instanceof Error ? localize(err.message) : t("未知错误", "Unknown error")}`,
          `Archive failed: ${err instanceof Error ? localize(err.message) : t("未知错误", "Unknown error")}`,
        ),
      );
    }
  }, [profileId, bucket, selectedKeys]);

  const handleShare = useCallback(() => {
    if (!canShare || !profileId || !bucket || !singleSelectedKey) return;
    openShareDialog({ key: singleSelectedKey, bucket, profileId });
  }, [canShare, profileId, bucket, singleSelectedKey, openShareDialog]);

  const handleTransfer = useCallback(() => {
    if (selectedKeys.size === 0) return;
    openTransferDialog({
      keys: Array.from(selectedKeys),
      defaultMode: "copy",
    });
  }, [selectedKeys, openTransferDialog]);

  const openDeleteConfirm = useCallback(() => {
    if (selectedKeys.size === 0) return;
    setConfirmDelete(true);
  }, [selectedKeys.size]);

  useEffect(() => {
    // Keep event-driven toolbar actions centralized for shortcuts and command palette.
    const registrations = [
      [OBJECT_TOOLBAR_EVENTS.OPEN_SEARCH, openSearch],
      [OBJECT_TOOLBAR_EVENTS.UPLOAD_FILES, () => void handleUpload()],
      [OBJECT_TOOLBAR_EVENTS.UPLOAD_FOLDER, () => void handleUploadFolder()],
      [OBJECT_TOOLBAR_EVENTS.NEW_FOLDER, () => setCreateFolderOpen(true)],
      [OBJECT_TOOLBAR_EVENTS.DOWNLOAD_SELECTION, () => void handleDownload()],
      [OBJECT_TOOLBAR_EVENTS.DELETE_SELECTION, openDeleteConfirm],
      [OBJECT_TOOLBAR_EVENTS.REFRESH_OBJECTS, refresh],
      [OBJECT_TOOLBAR_EVENTS.OPEN_SYNC, openSyncEntry],
      [OBJECT_TOOLBAR_EVENTS.OPEN_TRANSFER, handleTransfer],
      [OBJECT_TOOLBAR_EVENTS.SHARE_SELECTION, handleShare],
    ] as const;

    const listeners = registrations.map(([name, action]) => {
      const listener = () => {
        action();
      };
      window.addEventListener(name, listener);
      return [name, listener] as const;
    });

    return () => {
      for (const [name, listener] of listeners) {
        window.removeEventListener(name, listener);
      }
    };
  }, [
    openSearch,
    handleUpload,
    handleUploadFolder,
    handleDownload,
    openDeleteConfirm,
    refresh,
    openSyncEntry,
    handleTransfer,
    handleShare,
  ]);

  return (
    <div className="no-drag flex items-center gap-2 border-t border-border px-3 py-2">
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          onClick={() => void handleUpload()}
          title={t("上传文件", "Upload files")}
        >
          <IconCloudArrowUp /> {t("上传", "Upload")}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCreateFolderOpen(true)}
          title={t("新建文件夹", "New folder")}
        >
          <IconFolder /> {t("新建文件夹", "New folder")}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleDownload()}
          disabled={!hasSelection}
          title={t("下载选中项", "Download selected items")}
        >
          <IconCloudArrowDown /> {t("下载", "Download")}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={openSyncEntry}
          title={syncButtonTitle}
        >
          <SyncButtonIcon /> {syncButtonLabel}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className={
            hasSelection
              ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
              : "text-foreground/35 opacity-60"
          }
          onClick={openDeleteConfirm}
          disabled={!hasSelection}
          title={
            hasSelection
              ? t("删除选中项", "Delete selected items")
              : t("选择要删除的文件", "Select files to delete")
          }
        >
          <IconTrashCan /> {t("删除", "Delete")}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm">
                {t("更多", "More")}
                <IconChevronDown className="size-3" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem onClick={() => void handleUploadFolder()}>
              <IconFolderPlus /> {t("上传文件夹", "Upload folder")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void handleDownloadArchive()}
              disabled={!hasSelection}
            >
              <IconFileZipper /> {t("打包下载", "Download archive")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleTransfer} disabled={!hasSelection}>
              <IconArrowRightArrowLeft /> {t("传输", "Transfer")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleShare} disabled={!canShare}>
              <IconShareNodes /> {t("分享", "Share")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {filters.search && (
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-md bg-muted px-2 text-foreground/80 text-xs hover:bg-muted/70"
            onClick={() => setFilters({ search: "" })}
            title={t("清除筛选", "Clear filters")}
            aria-label={t("清除筛选", "Clear filters")}
          >
            <span className="max-w-32 truncate font-mono">
              {filters.search}
            </span>
            <IconXmark className="size-3 shrink-0" />
          </button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={openSearch}
          title={t("搜索文件（Ctrl+F）", "Search files (Ctrl+F)")}
          aria-label={t("搜索文件", "Search files")}
        >
          <IconMagnifyingGlass />
        </Button>

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          title={t("刷新", "Refresh")}
          aria-label={t("刷新文件列表", "Refresh file list")}
        >
          <IconArrowsRotate />
        </Button>

        <div className="flex rounded-lg border border-border overflow-hidden">
          <Button
            variant={viewMode === "table" ? "secondary" : "ghost"}
            size="icon-sm"
            className="rounded-none border-0"
            onClick={() => setViewMode("table")}
            title={t("列表视图", "List view")}
            aria-label={t("切换到列表视图", "Switch to list view")}
          >
            <IconTableList />
          </Button>
          <Button
            variant={viewMode === "grid" ? "secondary" : "ghost"}
            size="icon-sm"
            className="rounded-none border-0 border-l border-border"
            onClick={() => setViewMode("grid")}
            title={t("网格视图", "Grid view")}
            aria-label={t("切换到网格视图", "Switch to grid view")}
          >
            <IconGrip />
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void requestDelete()}
        title={t("删除文件", "Delete files")}
        message={t(
          `确定删除 ${selectedKeys.size} 个文件吗？此操作无法撤销。`,
          `Delete ${selectedKeys.size} files? This action cannot be undone.`,
        )}
        confirmLabel={t("删除", "Delete")}
      />

      <CreateFolderDialog
        open={createFolderOpen}
        onClose={() => setCreateFolderOpen(false)}
      />
    </div>
  );
}
