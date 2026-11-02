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
  useVaultStore,
} from "@/stores";
import { useQiniuShareStore } from "@/stores/useQiniuShareStore";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { toast } from "../common/Toast";
import { canCreateQiniuDirectoryShare } from "../qiniu/qiniu-share-scope";
import { CreateFolderDialog } from "./CreateFolderDialog";
import {
  qiniuFolderMutationBlockReason,
  qiniuUnfinishedTransferReason,
  qiniuUploadBlockReason,
  qiniuUploadNotice,
} from "./qiniu-transfer-gates";
import { assertCurrentUploadScope } from "./upload-scope";
import { usePendingDelete } from "./usePendingDelete";

export function ObjectToolbar() {
  useT();
  const profileId = useProfileStore((s) => s.activeProfileId);
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const latestProfile = useVaultStore((s) =>
    s.profiles.find((profile) => profile.id === profileId),
  );
  const profile = latestProfile ?? activeProfile;
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
    profileRevision: profile?.updatedAt,
    bucket,
    selectedKeys,
    clearSelection,
    refresh,
  });

  const selected = Array.from(selectedKeys);
  const deleteBlocked = qiniuFolderMutationBlockReason(
    profile,
    selected,
    "delete",
  );
  const singleSelectedKey = selected.length === 1 ? selected[0] : null;
  const hasSelection = selectedKeys.size > 0;
  const uploadBlocked = qiniuUploadBlockReason(profile);
  const uploadNotice = qiniuUploadNotice(profile);
  const syncBlocked = qiniuUnfinishedTransferReason(profile, "sync");
  const archiveBlocked = qiniuUnfinishedTransferReason(profile, "archive");
  const transferBlocked = qiniuUnfinishedTransferReason(profile, "transfer");
  const folderDownloadBlocked = selected.some((key) => key.endsWith("/"))
    ? qiniuUnfinishedTransferReason(profile, "folder-download")
    : null;
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
    if (!profileId || !bucket || !profile?.updatedAt) return;
    if (uploadBlocked) return toast.warning(uploadBlocked);
    if (uploadNotice) toast.warning(uploadNotice);
    const prefix = useObjectStore.getState().currentPrefix;

    try {
      assertCurrentUploadScope({
        profileId,
        expectedProfileRevision: profile.updatedAt,
        provider: profile.provider,
        bucket,
        prefix,
      });
      const result = await rpcCall("transfer:pick-and-upload", {
        profileId,
        expectedProfileRevision: profile.updatedAt,
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
  }, [
    profileId,
    bucket,
    profile?.updatedAt,
    profile?.provider,
    uploadBlocked,
    uploadNotice,
  ]);

  const handleUploadFolder = useCallback(async () => {
    if (!profileId || !bucket || !profile?.updatedAt) return;
    if (uploadBlocked) return toast.warning(uploadBlocked);
    if (uploadNotice) toast.warning(uploadNotice);
    const prefix = useObjectStore.getState().currentPrefix;

    try {
      assertCurrentUploadScope({
        profileId,
        expectedProfileRevision: profile.updatedAt,
        provider: profile.provider,
        bucket,
        prefix,
      });
      const result = await rpcCall("transfer:pick-and-upload-folder", {
        profileId,
        expectedProfileRevision: profile.updatedAt,
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
  }, [
    profileId,
    bucket,
    profile?.updatedAt,
    profile?.provider,
    uploadBlocked,
    uploadNotice,
  ]);

  const handleDownload = useCallback(async () => {
    if (!profileId || !bucket || selectedKeys.size === 0) return;
    if (folderDownloadBlocked) return toast.warning(folderDownloadBlocked);

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
  }, [profileId, bucket, selectedKeys, folderDownloadBlocked]);

  const handleDownloadArchive = useCallback(async () => {
    if (!profileId || !bucket || selectedKeys.size === 0) return;
    if (archiveBlocked) return toast.warning(archiveBlocked);

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
  }, [profileId, bucket, selectedKeys, archiveBlocked]);

  const handleShare = useCallback(() => {
    if (!canShare || !profileId || !bucket || !singleSelectedKey) return;
    openShareDialog({ key: singleSelectedKey, bucket, profileId });
  }, [canShare, profileId, bucket, singleSelectedKey, openShareDialog]);

  const handleTransfer = useCallback(() => {
    if (selectedKeys.size === 0) return;
    if (transferBlocked) return toast.warning(transferBlocked);
    openTransferDialog({
      keys: Array.from(selectedKeys),
      defaultMode: "copy",
    });
  }, [selectedKeys, openTransferDialog, transferBlocked]);

  const handleSync = useCallback(() => {
    if (syncBlocked) return toast.warning(syncBlocked);
    openSyncEntry();
  }, [openSyncEntry, syncBlocked]);

  const handleCreateFolder = useCallback(() => {
    if (uploadBlocked) return toast.warning(uploadBlocked);
    setCreateFolderOpen(true);
  }, [uploadBlocked]);

  const openDeleteConfirm = useCallback(() => {
    if (selectedKeys.size === 0) return;
    if (deleteBlocked) return toast.warning(deleteBlocked);
    setConfirmDelete(true);
  }, [selectedKeys.size, deleteBlocked]);

  useEffect(() => {
    // Keep event-driven toolbar actions centralized for shortcuts and command palette.
    const registrations = [
      [OBJECT_TOOLBAR_EVENTS.OPEN_SEARCH, openSearch],
      [OBJECT_TOOLBAR_EVENTS.UPLOAD_FILES, () => void handleUpload()],
      [OBJECT_TOOLBAR_EVENTS.UPLOAD_FOLDER, () => void handleUploadFolder()],
      [OBJECT_TOOLBAR_EVENTS.NEW_FOLDER, handleCreateFolder],
      [OBJECT_TOOLBAR_EVENTS.DOWNLOAD_SELECTION, () => void handleDownload()],
      [OBJECT_TOOLBAR_EVENTS.DELETE_SELECTION, openDeleteConfirm],
      [OBJECT_TOOLBAR_EVENTS.REFRESH_OBJECTS, refresh],
      [OBJECT_TOOLBAR_EVENTS.OPEN_SYNC, handleSync],
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
    handleSync,
    handleCreateFolder,
    handleTransfer,
    handleShare,
  ]);

  return (
    <div
      className={`no-drag flex items-center gap-2 border-t border-border px-3 py-2${profile?.provider === "qiniu" ? " flex-wrap" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          onClick={() => void handleUpload()}
          disabled={!!uploadBlocked}
          title={uploadNotice ?? t("上传文件", "Upload files")}
        >
          <IconCloudArrowUp /> {t("上传", "Upload")}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleCreateFolder}
          disabled={!!uploadBlocked}
          title={uploadBlocked ?? t("新建文件夹", "New folder")}
        >
          <IconFolder /> {t("新建文件夹", "New folder")}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => void handleDownload()}
          disabled={!hasSelection || !!folderDownloadBlocked}
          title={
            folderDownloadBlocked ?? t("下载选中项", "Download selected items")
          }
        >
          <IconCloudArrowDown /> {t("下载", "Download")}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={handleSync}
          disabled={!!syncBlocked}
          title={syncBlocked ?? syncButtonTitle}
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
          disabled={!hasSelection || !!deleteBlocked}
          title={
            deleteBlocked ??
            (hasSelection
              ? t("删除选中项", "Delete selected items")
              : t("选择要删除的文件", "Select files to delete"))
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
            <DropdownMenuItem
              onClick={() => void handleUploadFolder()}
              disabled={!!uploadBlocked}
              title={uploadNotice ?? undefined}
            >
              <IconFolderPlus /> {t("上传文件夹", "Upload folder")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void handleDownloadArchive()}
              disabled={!hasSelection || !!archiveBlocked}
              title={archiveBlocked ?? undefined}
            >
              <IconFileZipper /> {t("打包下载", "Download archive")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleTransfer}
              disabled={!hasSelection || !!transferBlocked}
              title={transferBlocked ?? undefined}
            >
              <IconArrowRightArrowLeft /> {t("传输", "Transfer")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleShare} disabled={!canShare}>
              <IconShareNodes /> {t("分享", "Share")}
            </DropdownMenuItem>
            {profile?.provider === "qiniu" && (
              <DropdownMenuItem
                disabled={
                  !bucket ||
                  !profileId ||
                  !canCreateQiniuDirectoryShare(profile)
                }
                title={t(
                  "公有云永久凭据可创建；实际权限由服务端确认。分享当前目录，而非选中文件。",
                  "Available for public-cloud permanent credentials; the service confirms permissions. Shares the current folder, not selected files.",
                )}
                onClick={() => {
                  if (
                    !profileId ||
                    !bucket ||
                    !profile ||
                    !canCreateQiniuDirectoryShare(profile)
                  )
                    return;
                  useQiniuShareStore.getState().openCreate({
                    profileId,
                    profileRevision: profile.updatedAt,
                    bucketName: bucket,
                    prefix: useObjectStore.getState().currentPrefix,
                  });
                }}
              >
                <IconShareNodes />{" "}
                {t("分享当前目录（只读）", "Share current folder (read-only)")}
              </DropdownMenuItem>
            )}
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

      {uploadNotice && (
        <p role="note" className="basis-full text-[11px] text-foreground/60">
          {uploadNotice}
          {t(
            "；同步、文件夹/打包下载及跨空间传输暂不可用。",
            "; sync, folder/archive downloads, and cross-bucket transfers are not available yet.",
          )}
        </p>
      )}
      {deleteBlocked && (
        <p role="note" className="basis-full text-[11px] text-foreground/60">
          {deleteBlocked}
        </p>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          if (deleteBlocked) return toast.warning(deleteBlocked);
          void requestDelete();
        }}
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
