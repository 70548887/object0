import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { localize, t, useT } from "@/lib/i18n";
import {
  IconArrowRightArrowLeft,
  IconCircleInfo,
  IconClipboard,
  IconCloudArrowDown,
  IconCopy,
  IconPen,
  IconShareNodes,
  IconTrashCan,
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
import { showDeleteResults } from "./DeleteResultNotice";
import {
  qiniuFolderMutationBlockReason,
  qiniuUnfinishedTransferReason,
} from "./qiniu-transfer-gates";

interface ObjectContextMenuProps {
  /** The object key or folder prefix for this item */
  objectKey: string;
  /** Whether this item is a folder (prefix ending in /) */
  isFolder: boolean;
  /** Callback to open the rename UI for this key */
  onRename: (key: string) => void;
  /** The trigger element. The ContextMenuTrigger renders as a <div> by default.
   *  Pass a `render` element if the trigger must render as a different tag
   *  (e.g. `render={<tr />}` for table rows). */
  children?: ReactNode;
  /** Override the element that ContextMenuTrigger renders as (Base UI `render` prop) */
  triggerRender?: React.ReactElement;
}

export function ObjectContextMenu({
  objectKey,
  isFolder,
  onRename,
  children,
  triggerRender,
}: ObjectContextMenuProps) {
  useT();
  const profileId = useProfileStore((s) => s.activeProfileId);
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const latestProfile = useVaultStore((s) =>
    s.profiles.find((profile) => profile.id === profileId),
  );
  const profile = latestProfile ?? activeProfile;
  const transferBlocked = qiniuUnfinishedTransferReason(profile, "transfer");
  const renameBlocked = qiniuFolderMutationBlockReason(
    profile,
    [objectKey],
    "rename",
  );
  const deleteBlocked = qiniuFolderMutationBlockReason(
    profile,
    [objectKey],
    "delete",
  );
  const folderDownloadBlocked = isFolder
    ? qiniuUnfinishedTransferReason(profile, "folder-download")
    : null;
  const bucket = useBucketStore((s) => s.selectedBucket);
  const openShareDialog = useUIStore((s) => s.openShareDialog);
  const setDetailKey = useUIStore((s) => s.setDetailKey);
  const openTransferDialog = useUIStore((s) => s.openTransferDialog);

  const fileName = objectKey.split("/").filter(Boolean).pop() ?? objectKey;

  const handleCopyKey = async () => {
    try {
      await navigator.clipboard.writeText(objectKey);
      toast.success(t("对象路径已复制", "Object key copied"));
    } catch {
      toast.error(t("复制失败", "Copy failed"));
    }
  };

  const handleDownload = async () => {
    if (!profileId || !bucket) return;
    if (folderDownloadBlocked) return toast.warning(folderDownloadBlocked);
    try {
      if (isFolder) {
        const result = await rpcCall("transfer:download-folder", {
          profileId,
          bucket,
          prefix: objectKey,
        });
        if (result.jobIds.length > 0) {
          useUIStore.getState().setJobPanelOpen(true);
          toast.info(
            t(
              `正在下载文件夹（${result.jobIds.length} 个文件）`,
              `Downloading folder (${result.jobIds.length} files)`,
            ),
          );
        }
      } else {
        await rpcCall("transfer:download", {
          profileId,
          bucket,
          key: objectKey,
          localPath: `~/Downloads/${fileName}`,
        });
        useUIStore.getState().setJobPanelOpen(true);
        toast.info(t(`正在下载 ${fileName}`, `Downloading ${fileName}`));
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
  };

  const handleShare = () => {
    if (isFolder || !profileId || !bucket) return;
    openShareDialog({ key: objectKey, bucket, profileId });
  };

  const handleDetails = () => {
    setDetailKey(objectKey);
  };

  const handleRename = () => {
    if (renameBlocked) return toast.warning(renameBlocked);
    onRename(objectKey);
  };

  const handleTransfer = (defaultMode: "copy" | "move") => {
    if (transferBlocked) return toast.warning(transferBlocked);
    openTransferDialog({ keys: [objectKey], defaultMode });
  };

  const handleDelete = async () => {
    if (!profileId || !bucket) return;
    if (deleteBlocked) return toast.warning(deleteBlocked);
    try {
      const report = await rpcCall("objects:delete", {
        profileId,
        bucket,
        keys: [objectKey],
        expectedProfileRevision: profile?.updatedAt,
      });
      showDeleteResults([objectKey], report, bucket);
      // The request may complete after navigation or a credential edit. Only
      // refresh the view that still belongs to the captured request identity.
      const current = useProfileStore.getState();
      if (
        current.activeProfileId !== profileId ||
        current.activeProfile?.updatedAt !== profile?.updatedAt ||
        useBucketStore.getState().selectedBucket !== bucket
      )
        return;
      const prefix = useObjectStore.getState().currentPrefix;
      useObjectStore.getState().loadObjects(profileId, bucket, prefix);
    } catch (err: unknown) {
      toast.error(
        err instanceof Error
          ? localize(err.message)
          : t("未知错误", "Unknown error"),
      );
    }
  };

  const menuContent = (
    <ContextMenuContent>
      {/* Details (files only) */}
      {!isFolder && (
        <ContextMenuItem onClick={handleDetails}>
          <IconCircleInfo className="size-4 shrink-0" />{" "}
          {t("详细信息", "Details")}
        </ContextMenuItem>
      )}

      {/* Download */}
      <ContextMenuItem
        onClick={() => void handleDownload()}
        disabled={!!folderDownloadBlocked}
        title={folderDownloadBlocked ?? undefined}
      >
        <IconCloudArrowDown className="size-4 shrink-0" />{" "}
        {t("下载", "Download")}
      </ContextMenuItem>

      {/* Share (files only) */}
      {!isFolder && (
        <ContextMenuItem onClick={handleShare}>
          <IconShareNodes className="size-4 shrink-0" /> {t("分享", "Share")}
        </ContextMenuItem>
      )}

      {/* Rename */}
      <ContextMenuItem
        onClick={handleRename}
        disabled={!!renameBlocked}
        title={renameBlocked ?? undefined}
      >
        <IconPen className="size-4 shrink-0" /> {t("重命名", "Rename")}
      </ContextMenuItem>

      {/* Copy to bucket */}
      <ContextMenuItem
        onClick={() => handleTransfer("copy")}
        disabled={!!transferBlocked}
        title={transferBlocked ?? undefined}
      >
        <IconCopy className="size-4 shrink-0" />{" "}
        {t("复制到存储桶", "Copy to bucket")}
      </ContextMenuItem>

      {/* Move to bucket */}
      <ContextMenuItem
        onClick={() => handleTransfer("move")}
        disabled={!!transferBlocked}
        title={transferBlocked ?? undefined}
      >
        <IconArrowRightArrowLeft className="size-4 shrink-0" />{" "}
        {t("移动到存储桶", "Move to bucket")}
      </ContextMenuItem>

      {/* Copy key */}
      <ContextMenuItem onClick={() => void handleCopyKey()}>
        <IconClipboard className="size-4 shrink-0" />{" "}
        {t("复制对象路径", "Copy object key")}
      </ContextMenuItem>

      <ContextMenuSeparator />

      {/* Delete */}
      <ContextMenuItem
        variant="destructive"
        onClick={() => void handleDelete()}
        disabled={!!deleteBlocked}
        title={deleteBlocked ?? undefined}
      >
        <IconTrashCan className="size-4 shrink-0" /> {t("删除", "Delete")}
      </ContextMenuItem>
    </ContextMenuContent>
  );

  return (
    <ContextMenu>
      <ContextMenuPrimitive.Trigger
        data-slot="context-menu-trigger"
        className="select-none"
        render={triggerRender}
      >
        {children}
      </ContextMenuPrimitive.Trigger>
      {menuContent}
    </ContextMenu>
  );
}
