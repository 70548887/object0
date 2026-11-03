import { t } from "@/lib/i18n";
import {
  useFolderSyncStore,
  useJobStore,
  useUIStore,
  useVaultStore,
} from "@/stores";

export interface EditorExitState {
  dirty: boolean;
  busy: boolean;
}
const editors = new Map<string, EditorExitState>();
const listeners = new Set<() => void>();
let revision = 0;
export const subscribeEditorExitState = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getEditorExitRevision = () => revision;
export function reportEditorExitState(
  id: string,
  state: EditorExitState | null,
) {
  const before = editors.get(id);
  if (state && before?.dirty === state.dirty && before.busy === state.busy)
    return;
  if (!state && !before) return;
  if (state) editors.set(id, { ...state });
  else editors.delete(id);
  revision++;
  for (const listener of listeners) listener();
}
export function updateExitBlockers(includeOtherDialogs = true) {
  const reasons: string[] = [];
  if ([...editors.values()].some((state) => state.dirty))
    reasons.push(
      t(
        "有未保存的文本草稿，请先保存或复制并关闭编辑器。",
        "There are unsaved text drafts. Save or copy them and close the editor first.",
      ),
    );
  if ([...editors.values()].some((state) => state.busy))
    reasons.push(
      t(
        "文本正在读取或保存，请等待完成。",
        "Text is being read or saved. Wait for it to finish.",
      ),
    );
  const ui = useUIStore.getState();
  if (ui.textEditorTarget)
    reasons.push(
      t(
        "请先关闭文本编辑器，再安装更新。",
        "Close the text editor before installing the update.",
      ),
    );
  if (
    ui.shareDialogOpen ||
    ui.transferDialogOpen ||
    ui.syncDialogOpen ||
    ui.syncChooserOpen ||
    ui.objectSearchOpen
  )
    reasons.push(
      t(
        "还有文件操作表单，请先处理并关闭。",
        "File-operation forms are still open. Finish and close them first.",
      ),
    );
  if (
    useJobStore
      .getState()
      .jobs.some((job) => job.status === "running" || job.status === "queued")
  )
    reasons.push(
      t(
        "仍有运行或排队的传输任务，请完成或安全暂停后重试。",
        "Transfers are running or queued. Finish or safely pause them before retrying.",
      ),
    );
  if (
    [...useFolderSyncStore.getState().statuses.values()].some(
      (state) => state.status === "syncing" || state.status === "watching",
    )
  )
    reasons.push(
      t(
        "实时同步仍在运行，请先停止同步。",
        "Live sync is still active. Stop it first.",
      ),
    );
  if (useVaultStore.getState().importingLegacy)
    reasons.push(
      t(
        "旧账号导入尚未完成，请稍候。",
        "The legacy account import is not finished. Wait for it to complete.",
      ),
    );
  if (
    includeOtherDialogs &&
    typeof document !== "undefined" &&
    [
      ...document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
    ].some(
      (dialog) =>
        !dialog.closest("[data-update-dialog]") &&
        !dialog.hasAttribute("data-closed"),
    )
  )
    reasons.push(
      t(
        "还有其他弹窗或表单，请先处理并关闭，避免丢失输入。",
        "Other dialogs or forms are still open. Finish and close them to avoid losing input.",
      ),
    );
  return reasons;
}
