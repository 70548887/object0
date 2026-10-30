import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import type { ReactNode } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
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
} from "@/stores";
import { toast } from "../common/Toast";

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
  const profileId = useProfileStore((s) => s.activeProfileId);
  const bucket = useBucketStore((s) => s.selectedBucket);
  const openShareDialog = useUIStore((s) => s.openShareDialog);
  const setDetailKey = useUIStore((s) => s.setDetailKey);
  const openTransferDialog = useUIStore((s) => s.openTransferDialog);

  const fileName = objectKey.split("/").filter(Boolean).pop() ?? objectKey;

  const handleCopyKey = async () => {
    try {
      await navigator.clipboard.writeText(objectKey);
      toast.success("对象路径已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  const handleDownload = async () => {
    if (!profileId || !bucket) return;
    try {
      if (isFolder) {
        const result = await rpcCall("transfer:download-folder", {
          profileId,
          bucket,
          prefix: objectKey,
        });
        if (result.jobIds.length > 0) {
          useUIStore.getState().setJobPanelOpen(true);
          toast.info(`正在下载文件夹（${result.jobIds.length} 个文件）`);
        }
      } else {
        await rpcCall("transfer:download", {
          profileId,
          bucket,
          key: objectKey,
          localPath: `~/Downloads/${fileName}`,
        });
        useUIStore.getState().setJobPanelOpen(true);
        toast.info(`正在下载 ${fileName}`);
      }
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        err.message === "No destination folder selected"
      )
        return;
      toast.error(err instanceof Error ? err.message : "未知错误");
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
    onRename(objectKey);
  };

  const handleDelete = async () => {
    if (!profileId || !bucket) return;
    try {
      await rpcCall("objects:delete", {
        profileId,
        bucket,
        keys: [objectKey],
      });
      toast.success(`已删除“${fileName}”`);
      const prefix = useObjectStore.getState().currentPrefix;
      useObjectStore.getState().loadObjects(profileId, bucket, prefix);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "未知错误");
    }
  };

  const menuContent = (
    <ContextMenuContent>
      {/* Details (files only) */}
      {!isFolder && (
        <ContextMenuItem onClick={handleDetails}>
          <IconCircleInfo className="size-4 shrink-0" /> 详细信息
        </ContextMenuItem>
      )}

      {/* Download */}
      <ContextMenuItem onClick={() => void handleDownload()}>
        <IconCloudArrowDown className="size-4 shrink-0" /> 下载
      </ContextMenuItem>

      {/* Share (files only) */}
      {!isFolder && (
        <ContextMenuItem onClick={handleShare}>
          <IconShareNodes className="size-4 shrink-0" /> 分享
        </ContextMenuItem>
      )}

      {/* Rename */}
      <ContextMenuItem onClick={handleRename}>
        <IconPen className="size-4 shrink-0" /> 重命名
      </ContextMenuItem>

      {/* Copy to bucket */}
      <ContextMenuItem
        onClick={() =>
          openTransferDialog({ keys: [objectKey], defaultMode: "copy" })
        }
      >
        <IconCopy className="size-4 shrink-0" /> 复制到存储桶
      </ContextMenuItem>

      {/* Move to bucket */}
      <ContextMenuItem
        onClick={() =>
          openTransferDialog({ keys: [objectKey], defaultMode: "move" })
        }
      >
        <IconArrowRightArrowLeft className="size-4 shrink-0" /> 移动到存储桶
      </ContextMenuItem>

      {/* Copy key */}
      <ContextMenuItem onClick={() => void handleCopyKey()}>
        <IconClipboard className="size-4 shrink-0" /> 复制对象路径
      </ContextMenuItem>

      <ContextMenuSeparator />

      {/* Delete */}
      <ContextMenuItem
        variant="destructive"
        onClick={() => void handleDelete()}
      >
        <IconTrashCan className="size-4 shrink-0" /> 删除
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
