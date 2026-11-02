import { useCallback, useEffect, useRef } from "react";
import { localize, t, useT } from "@/lib/i18n";
import { rpcCall } from "@/lib/rpc-client";
import { toast } from "../common/Toast";
import { showDeleteResults } from "./DeleteResultNotice";

const UNDO_WINDOW_MS = 5000;

// Pending delete that can be undone within the undo window.
interface DeleteSnapshot {
  profileId: string;
  profileRevision?: string;
  bucket: string;
  scope: string;
  keys: string[];
}
interface PendingDelete extends DeleteSnapshot {
  timerId: ReturnType<typeof setTimeout>;
}

interface UsePendingDeleteParams {
  profileId: string | null;
  profileRevision?: string;
  bucket: string | null;
  selectedKeys: Set<string>;
  clearSelection: () => void;
  refresh: () => void;
}

// Deletes the current selection after a brief undo window, surfacing an "Undo"
// toast. Starting a new delete flushes any still-pending one immediately.
export function usePendingDelete({
  profileId,
  profileRevision,
  bucket,
  selectedKeys,
  clearSelection,
  refresh,
}: UsePendingDeleteParams) {
  useT();
  const pendingDeleteRef = useRef<PendingDelete | null>(null);
  const scope = JSON.stringify([profileId, profileRevision, bucket]);
  const currentScopeRef = useRef(scope);
  currentScopeRef.current = scope;
  const currentIdentityRef = useRef({ profileId, profileRevision });
  currentIdentityRef.current = { profileId, profileRevision };
  const currentRefreshRef = useRef(refresh);
  currentRefreshRef.current = refresh;

  // Cancel any in-flight undo timer on unmount.
  useEffect(() => {
    return () => {
      if (pendingDeleteRef.current) {
        clearTimeout(pendingDeleteRef.current.timerId);
        pendingDeleteRef.current = null;
      }
    };
  }, []);

  const commitPendingDelete = useCallback(async (snapshot: DeleteSnapshot) => {
    const { profileId, profileRevision, bucket, keys } = snapshot;
    try {
      if (
        profileRevision !== undefined &&
        currentIdentityRef.current.profileId === profileId &&
        currentIdentityRef.current.profileRevision !== profileRevision
      )
        throw new Error(
          t(
            "账号凭据或连接配置已变化，原删除任务已取消；请刷新后重新选择。",
            "The account credentials or connection changed. The pending deletion was cancelled; refresh and select again.",
          ),
        );
      const payload = {
        profileId,
        bucket,
        keys,
        ...(profileRevision === undefined
          ? {}
          : { expectedProfileRevision: profileRevision }),
      };
      const report = await rpcCall("objects:delete", payload);
      showDeleteResults(keys, report, bucket);
      // Refresh only the still-visible account/bucket. The RPC target is
      // always the immutable snapshot, never the newest render's identity.
      if (currentScopeRef.current === snapshot.scope)
        currentRefreshRef.current();
    } catch (err: unknown) {
      toast.error(
        err instanceof Error
          ? localize(err.message)
          : t("未知错误", "Unknown error"),
      );
    }
  }, []);

  return useCallback(async () => {
    if (!profileId || !bucket || selectedKeys.size === 0) return;

    const keysToDelete = Array.from(selectedKeys);
    const snapshot: DeleteSnapshot = {
      profileId,
      profileRevision,
      bucket,
      scope,
      keys: keysToDelete,
    };
    const count = keysToDelete.length;
    clearSelection();

    // Cancel any previous pending delete
    if (pendingDeleteRef.current) {
      clearTimeout(pendingDeleteRef.current.timerId);
      // Execute the previous pending delete immediately
      const prev = pendingDeleteRef.current;
      pendingDeleteRef.current = null;
      void commitPendingDelete(prev);
    }

    // Show undo toast; actual delete happens after timeout
    const timerId = setTimeout(() => {
      // A callback already queued before clearTimeout must not consume a
      // newer pending delete or submit the old snapshot twice.
      if (pendingDeleteRef.current?.timerId !== timerId) return;
      const pending = pendingDeleteRef.current;
      pendingDeleteRef.current = null;
      void commitPendingDelete(pending);
    }, UNDO_WINDOW_MS);

    pendingDeleteRef.current = { ...snapshot, timerId };

    toast.warning(
      t(`正在删除 ${count} 个文件...`, `Deleting ${count} files...`),
      {
        duration: UNDO_WINDOW_MS,
        action: {
          label: t("撤销", "Undo"),
          onClick: () => {
            if (pendingDeleteRef.current?.timerId === timerId) {
              clearTimeout(timerId);
              pendingDeleteRef.current = null;
              toast.info(t("已取消删除", "Deletion cancelled"));
              if (currentScopeRef.current === snapshot.scope)
                currentRefreshRef.current();
            }
          },
        },
      },
    );
  }, [
    profileId,
    profileRevision,
    bucket,
    scope,
    selectedKeys,
    clearSelection,
    commitPendingDelete,
  ]);
}
