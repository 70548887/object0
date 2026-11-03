import { type ReactNode, useEffect, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { localize, t, useT } from "@/lib/i18n";
import { IconArrowsRotate, IconFileLines, IconFolderPlus } from "@/lib/icons";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { toast } from "../common/Toast";
import { CreateFolderDialog } from "./CreateFolderDialog";
import { qiniuUploadBlockReason } from "./qiniu-transfer-gates";
import {
  type TextEditorScope,
  textEditorBlockReason,
} from "./text-editor-model";
import { captureWorkspaceScope, confirmTextScope } from "./text-editor-scope";

/** Only real blank DOM space, never row triggers, input native menus or a
 * React portal event bubbling back from a dialog/menu outside this wrapper. */
export function isWorkspaceBlankTarget(
  target: EventTarget | null,
  wrapper: HTMLElement,
) {
  const element = target as Element | null;
  if (
    !element ||
    typeof element.closest !== "function" ||
    !wrapper.contains(element)
  )
    return false;
  if (element.closest('[data-slot="context-menu-trigger"]') !== wrapper)
    return false;
  return !element.closest(
    'tr,thead,[data-row-index],button,a,input,textarea,select,[contenteditable="true"],[role="menu"],[role="menuitem"],[role="dialog"],[role="alertdialog"]',
  );
}

export function ObjectWorkspace({ children }: { children: ReactNode }) {
  useT();
  const profile = useProfileStore((state) => state.activeProfile);
  const profiles = useVaultStore((state) => state.profiles);
  const bucket = useBucketStore((state) => state.selectedBucket);
  const prefix = useObjectStore((state) => state.currentPrefix);
  const loading = useObjectStore((state) => state.loading);
  const [open, setOpen] = useState(false);
  const [menuScope, setMenuScope] = useState<TextEditorScope | null>(null);
  const [folderScope, setFolderScope] = useState<TextEditorScope | null>(null);
  const savedProfile = profiles.find((item) => item.id === profile?.id);
  const identity = JSON.stringify([
    profile?.id,
    savedProfile?.updatedAt,
    bucket,
    prefix,
  ]);
  useEffect(() => {
    void identity;
    setOpen(false);
  }, [identity]);
  const createBlocked = menuScope
    ? textEditorBlockReason(menuScope.provider)
    : null;
  const folderBlocked = qiniuUploadBlockReason(savedProfile ?? profile);
  const withScope = (action: (scope: TextEditorScope) => void) => {
    if (!menuScope) return;
    try {
      confirmTextScope(menuScope);
      action(menuScope);
    } catch (error) {
      toast.warning(
        error instanceof Error
          ? localize(error.message)
          : t("目标不可用", "Destination unavailable"),
      );
    }
  };
  const createText = (extension: "txt" | "md") =>
    withScope((scope) => {
      const blocked = textEditorBlockReason(scope.provider);
      if (blocked) return toast.warning(blocked);
      useUIStore.getState().openTextEditor({
        ...scope,
        id: crypto.randomUUID(),
        mode: "create",
        extension,
      });
    });
  return (
    <>
      <ContextMenu open={open} onOpenChange={setOpen}>
        <ContextMenuTrigger
          className="relative flex h-full min-h-0 flex-1 flex-col"
          tabIndex={0}
          aria-label={t("文件列表空白区域菜单", "File list blank-area menu")}
          onContextMenu={(event) => {
            if (
              event.defaultPrevented ||
              !isWorkspaceBlankTarget(event.target, event.currentTarget)
            ) {
              event.preventBaseUIHandler();
              event.stopPropagation();
              return;
            }
            setMenuScope(captureWorkspaceScope());
          }}
          onTouchStart={(event) => {
            if (!isWorkspaceBlankTarget(event.target, event.currentTarget)) {
              event.preventBaseUIHandler();
              event.stopPropagation();
              return;
            }
            setMenuScope(captureWorkspaceScope());
          }}
        >
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-48">
          <ContextMenuItem
            disabled={!menuScope || loading}
            onClick={() =>
              withScope((scope) => {
                void useObjectStore
                  .getState()
                  .loadObjects(scope.profileId, scope.bucket, scope.prefix);
              })
            }
          >
            <IconArrowsRotate className="size-4" />
            {t("刷新", "Refresh")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!menuScope || !!folderBlocked}
            title={folderBlocked ?? undefined}
            onClick={() =>
              withScope((scope) => {
                if (folderBlocked) return toast.warning(folderBlocked);
                setFolderScope(scope);
              })
            }
          >
            <IconFolderPlus className="size-4" />
            {t("新建文件夹", "New folder")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!menuScope || !!createBlocked}
            title={createBlocked ?? undefined}
            onClick={() => createText("txt")}
          >
            <IconFileLines className="size-4" />
            {t("新建文本文件 (.txt)", "New text file (.txt)")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!menuScope || !!createBlocked}
            title={createBlocked ?? undefined}
            onClick={() => createText("md")}
          >
            <IconFileLines className="size-4" />
            {t("新建 Markdown (.md)", "New Markdown (.md)")}
          </ContextMenuItem>
          {createBlocked && (
            <p className="max-w-64 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {createBlocked}
            </p>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <CreateFolderDialog
        open={!!folderScope}
        scope={folderScope ?? undefined}
        onClose={() => setFolderScope(null)}
      />
    </>
  );
}
