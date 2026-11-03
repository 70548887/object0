import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { localize, t, useT } from "@/lib/i18n";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { toast } from "../common/Toast";
import {
  captureFolderScope,
  type FolderScope,
  folderKey,
  queueFolder,
} from "./folder-creation";

interface CreateFolderDialogProps {
  open: boolean;
  onClose: () => void;
  scope?: FolderScope;
}
// Mount a fresh form on each open. Navigation cannot rebind an existing draft.
export function CreateFolderDialog({
  open,
  onClose,
  scope,
}: CreateFolderDialogProps) {
  return open ? (
    <CreateFolderForm
      onClose={onClose}
      initialScope={scope ?? captureFolderScope()}
    />
  ) : null;
}
function CreateFolderForm({
  onClose,
  initialScope,
}: {
  onClose: () => void;
  initialScope: FolderScope | null;
}) {
  useT();
  const [scope] = useState(initialScope);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const profileId = useProfileStore((s) => s.activeProfileId);
  const profile = useVaultStore((s) =>
    s.profiles.find((p) => p.id === profileId),
  );
  const unlocked = useVaultStore((s) => s.unlocked);
  const bucket = useBucketStore((s) => s.selectedBucket);
  const prefix = useObjectStore((s) => s.currentPrefix);
  const current =
    !!scope &&
    unlocked &&
    profileId === scope.profileId &&
    profile?.updatedAt === scope.expectedProfileRevision &&
    profile.provider === scope.provider &&
    bucket === scope.bucket &&
    prefix === scope.prefix;
  let key = "";
  let error = "";
  if (scope && name.trim()) {
    try {
      key = folderKey(scope, name);
    } catch (err) {
      error =
        err instanceof Error ? err.message : t("名称无效", "Invalid name");
    }
  }
  const close = () => {
    if (!busy.current) onClose();
  };
  const create = async () => {
    if (busy.current || !scope || !current || !key || error) return;
    busy.current = true;
    setCreating(true);
    try {
      await queueFolder(scope, name);
      toast.info(
        t(
          `文件夹“${name.trim()}”已加入创建任务`,
          `Folder “${name.trim()}” queued for creation`,
        ),
      );
      // Completion events refresh only the matching destination; admission is
      // not an acknowledgement that the object already exists.
      if (alive.current) {
        useUIStore.getState().setJobPanelOpen(true);
        onClose();
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? localize(err.message)
          : t("创建失败", "Creation failed"),
      );
    } finally {
      busy.current = false;
      if (alive.current) setCreating(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("新建文件夹", "New folder")}</DialogTitle>
        </DialogHeader>
        <form
          id="create-folder-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label htmlFor="folder-name" className="text-xs">
              {t("文件夹名称", "Folder name")}
            </Label>
            <Input
              id="folder-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-folder"
              disabled={creating}
              aria-invalid={!!error}
            />
            <p className="break-all text-[11px] text-muted-foreground">
              {scope
                ? `${scope.bucket}/${key || scope.prefix}`
                : t("没有可用目标", "No available destination")}
            </p>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            {!current && (
              <p role="alert" className="text-xs text-destructive">
                {t(
                  "账号或目录已改变，请关闭后在目标位置重新新建。",
                  "The account or folder changed. Close this dialog and reopen it at the intended destination.",
                )}
              </p>
            )}
          </div>
        </form>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={close}
            disabled={creating}
          >
            {t("取消", "Cancel")}
          </Button>
          <Button
            size="sm"
            type="submit"
            form="create-folder-form"
            disabled={creating || !current || !key || !!error}
          >
            {creating ? t("正在加入任务…", "Queueing…") : t("创建", "Create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
