import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { localize, t, useT } from "@/lib/i18n";
import { rpcCall } from "@/lib/rpc-client";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { reportEditorExitState } from "../updates/update-exit-guard";
import {
  TextEditorSession,
  type TextEditorTarget,
  validateTextContent,
  validateTextName,
} from "./text-editor-model";
import { confirmTextScope, isTextScopeCurrent } from "./text-editor-scope";

/** Mounted outside ContentArea so navigation cannot silently discard a draft. */
export function TextEditorHost() {
  const target = useUIStore((state) => state.textEditorTarget);
  return target ? (
    <TextEditorDialog
      key={target.id}
      target={target}
      onClose={() => useUIStore.getState().closeTextEditor()}
    />
  ) : null;
}

export function TextEditorDialog({
  target,
  onClose,
}: {
  target: TextEditorTarget;
  onClose: () => void;
}) {
  useT();
  // Subscribe to current identity only to update the disabled/warning UI. The
  // actual read/write destination always comes from the immutable target.
  useVaultStore((state) => state.profiles);
  useVaultStore((state) => state.unlocked);
  useProfileStore((state) => state.activeProfileId);
  useBucketStore((state) => state.selectedBucket);
  useObjectStore((state) => state.currentPrefix);
  const session = useMemo(
    () =>
      new TextEditorSession(target, {
        confirmScope: () => confirmTextScope(target),
        isScopeCurrent: () => isTextScopeCurrent(target),
        read: (input) => rpcCall("objects:read-text", input),
        write: (input) => rpcCall("objects:write-text", input),
        refresh: () => {
          void useObjectStore
            .getState()
            .loadObjects(target.profileId, target.bucket, target.prefix);
        },
      }),
    [target],
  );
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const [confirm, setConfirm] = useState<"close" | "reload" | null>(null);
  const editorDirty =
    state.content !== state.initialContent || state.name !== state.initialName;
  useEffect(() => {
    reportEditorExitState(target.id, {
      dirty: editorDirty,
      busy: state.loading || state.saving,
    });
    return () => reportEditorExitState(target.id, null);
  }, [target.id, editorDirty, state.loading, state.saving]);
  useEffect(() => {
    session.activate();
    if (target.mode === "edit") void session.read();
    return () => session.dispose();
  }, [session, target.mode]);
  const current = isTextScopeCurrent(target);
  const busy = state.loading || state.saving;
  const validation =
    (session.createOnly ? validateTextName(state.name) : null) ??
    validateTextContent(state.content);
  const canSave =
    current &&
    !busy &&
    state.loaded &&
    !validation &&
    !session.blockedReason &&
    !session.needsReload;
  const requestClose = () => {
    if (session.getSnapshot().saving) return;
    if (session.dirty) setConfirm("close");
    else onClose();
  };
  const reload = () => {
    if (busy || !current) return;
    if (session.dirty) setConfirm("reload");
    else void session.read();
  };
  const byteLength = new TextEncoder().encode(state.content).length;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[90vh] flex-col gap-3 sm:max-w-3xl"
        onKeyDown={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "s"
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229 &&
              canSave &&
              !confirm
            )
              void session.save();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {target.mode === "create" && !state.createdKey
              ? t("新建文本文件", "New text file")
              : t("编辑文本文件", "Edit text file")}
            {session.dirty ? " *" : ""}
          </DialogTitle>
          <DialogDescription className="break-all text-xs">
            {target.profileName ?? target.profileId} · {target.bucket} ·{" "}
            <span className="font-mono">{session.key}</span>
          </DialogDescription>
        </DialogHeader>
        {session.createOnly && (
          <div className="space-y-1.5">
            <Label htmlFor="text-editor-name">{t("文件名", "Filename")}</Label>
            <Input
              id="text-editor-name"
              autoFocus
              value={state.name}
              disabled={busy}
              onChange={(event) => session.setName(event.target.value)}
              placeholder="untitled.txt"
              aria-invalid={!!validateTextName(state.name)}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "支持 .txt、.md、.markdown；同名文件不会被覆盖。",
                "Supports .txt, .md and .markdown. Existing files are never overwritten on creation.",
              )}
            </p>
          </div>
        )}
        {!current && (
          <p
            role="alert"
            className="rounded-md border border-warning/30 bg-warning/5 p-2 text-xs text-warning"
          >
            {t(
              "目标账号或目录已变化，草稿已保留，暂不可保存。请返回原目标，或复制内容后关闭。",
              "The destination account or folder changed. Your draft is retained and saving is disabled. Return to its original destination, or copy the text before closing.",
            )}
          </p>
        )}
        {state.error && (
          <p
            role="alert"
            className="whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive"
          >
            {localize(state.error)}
          </p>
        )}
        {validation && state.loaded && (
          <p role="alert" className="text-xs text-destructive">
            {validation}
          </p>
        )}
        {session.blockedReason && (
          <p role="status" className="text-xs text-muted-foreground">
            {session.blockedReason}
          </p>
        )}
        {state.saved && (
          <p role="status" className="text-xs text-success">
            {t("已保存到上方目标。", "Saved to the destination shown above.")}
            {session.needsReload
              ? t(
                  "远端未返回新版本标识，请重新读取后再继续编辑保存。",
                  "Storage returned no new version identifier. Reload before saving further edits.",
                )
              : ""}
          </p>
        )}
        <div className="flex min-h-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="text-editor-content">{t("内容", "Content")}</Label>
          <Textarea
            id="text-editor-content"
            className="field-sizing-fixed h-[min(48vh,28rem)] min-h-40 resize-y whitespace-pre font-mono text-sm leading-6"
            value={state.content}
            disabled={busy || !state.loaded}
            onChange={(event) => session.setContent(event.target.value)}
            spellCheck={false}
            aria-busy={state.loading}
            placeholder={
              state.loading
                ? t("正在读取文本…", "Reading text…")
                : t(
                    "在这里输入文本或 Markdown 内容…",
                    "Write text or Markdown here…",
                  )
            }
          />
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              UTF-8 · {byteLength.toLocaleString()} / 1,048,576{" "}
              {t("字节", "bytes")}
            </span>
            <span>
              {t(
                "Ctrl / ⌘ + S 保存；保存前校验远端版本",
                "Ctrl / ⌘ + S to save; remote version checked before writing",
              )}
            </span>
          </div>
        </div>
        {confirm && (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs"
          >
            <p>
              {confirm === "close"
                ? t(
                    "有未保存内容，确定丢弃草稿并关闭吗？",
                    "Discard unsaved changes and close?",
                  )
                : t(
                    "重新读取将丢弃当前未保存内容。请先复制草稿，确定继续吗？",
                    "Reloading discards unsaved text. Copy your draft first. Continue?",
                  )}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirm(null)}
              >
                {t("保留草稿", "Keep draft")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  const action = confirm;
                  setConfirm(null);
                  if (action === "close") onClose();
                  else void session.read();
                }}
              >
                {confirm === "close"
                  ? t("丢弃并关闭", "Discard and close")
                  : t("丢弃并重新读取", "Discard and reload")}
              </Button>
            </div>
          </div>
        )}
        <DialogFooter className="mt-1">
          {!session.createOnly && target.provider === "r2" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !current || !!confirm}
              onClick={reload}
            >
              {t("重新读取", "Reload")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={state.saving || !!confirm}
            onClick={requestClose}
          >
            {t("关闭", "Close")}
          </Button>
          <Button
            size="sm"
            disabled={!canSave || !!confirm}
            onClick={() => void session.save()}
          >
            {state.saving
              ? t("正在保存…", "Saving…")
              : session.createOnly
                ? t("创建并保存", "Create and save")
                : t("保存", "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
