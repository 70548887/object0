import { useEffect, useId, useRef, useState } from "react";
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
import { intlLocale, localize, useT } from "@/lib/i18n";
import { QiniuCapabilityNote } from "./QiniuCapabilityNote";
import {
  isQiniuCapabilityAllowed,
  type QiniuCapability,
  type QiniuRestoreState,
  type QiniuStorageClassOption,
} from "./types";

export interface QiniuObjectActionsProps {
  scopeId: string;
  objectKeys: readonly string[];
  currentStorageClass?: string;
  restoreState: QiniuRestoreState;
  restoredUntil?: string;
  storageClasses: readonly QiniuStorageClassOption[];
  capabilities: { changeType: QiniuCapability; restore: QiniuCapability };
  busy?: boolean;
  /** Native interfaces are confirmed, but permission may be validated by an explicit request. */
  allowUnknownPermissionAttempt?: boolean;
  onChangeStorageClass: (input: {
    objectKeys: string[];
    storageClass: string;
  }) => Promise<void>;
  onRestore: (input: { objectKeys: string[]; days: number }) => Promise<void>;
}

export function parseQiniuRestoreDays(value: string): number | null {
  if (!/^[1-7]$/.test(value.trim())) return null;
  return Number(value.trim());
}

export function canReadQiniuObject(state: QiniuRestoreState): boolean {
  return state === "normal" || state === "restored";
}

export function QiniuObjectActions({
  scopeId,
  objectKeys,
  currentStorageClass,
  restoreState,
  restoredUntil,
  storageClasses,
  capabilities,
  busy = false,
  allowUnknownPermissionAttempt = false,
  onChangeStorageClass,
  onRestore,
}: QiniuObjectActionsProps) {
  const t = useT();
  const id = useId();
  const selection = JSON.stringify([scopeId, objectKeys]);
  const [dialog, setDialog] = useState<"type" | "restore" | null>(null);
  const [storageClass, setStorageClass] = useState("");
  const [days, setDays] = useState("1");
  const [costConfirmed, setCostConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    if (!selection) return;
    generation.current++;
    setDialog(null);
    setPending(false);
    setError(null);
    setCostConfirmed(false);
    return () => {
      generation.current++;
    };
  }, [selection]);
  const processing = busy || pending;
  const selected = objectKeys.length > 0;
  const stateLabel =
    restoreState === "normal"
      ? t("正常", "Normal")
      : restoreState === "frozen"
        ? t("冻结", "Frozen")
        : restoreState === "restoring"
          ? t("解冻中", "Restoring")
          : restoreState === "restored"
            ? t("已解冻", "Restored")
            : restoreState === "expired"
              ? t("解冻已到期", "Restore expired")
              : restoreState === "mixed"
                ? t("状态不一致", "Mixed states")
                : t("状态未知", "Unknown state");
  const typeLabel =
    storageClasses.find((item) => item.id === currentStorageClass)?.label ??
    currentStorageClass ??
    t("未知", "Unknown");
  const readable = canReadQiniuObject(restoreState);
  const canAttempt = (capability: QiniuCapability) =>
    isQiniuCapabilityAllowed(capability) ||
    (allowUnknownPermissionAttempt && capability.state === "unknown");
  const canChange =
    selected &&
    readable &&
    canAttempt(capabilities.changeType) &&
    storageClasses.some(
      (item) => item.available && item.id !== currentStorageClass,
    );
  const canRestore =
    selected &&
    ["frozen", "expired"].includes(restoreState) &&
    canAttempt(capabilities.restore);
  const stateRestriction = !readable
    ? restoreState === "restoring"
      ? t(
          "解冻仍在进行中，完成前不能修改存储类型。",
          "Restoration is still running. Storage type changes remain unavailable until it completes.",
        )
      : restoreState === "unknown" || restoreState === "mixed"
        ? t(
            "请先刷新并选择恢复状态一致的文件，不能对未知状态直接修改类型或发起解冻。",
            "Refresh and select files with the same known restore state. Type changes and restore requests are disabled for unknown or mixed states.",
          )
        : t(
            "文件需要先完成解冻，才能修改存储类型。",
            "Restore the files before changing their storage type.",
          )
    : null;
  const open = (value: NonNullable<typeof dialog>) => {
    setDialog(value);
    setError(null);
    setCostConfirmed(false);
    setDays("1");
    setStorageClass(
      storageClasses.find(
        (item) => item.available && item.id !== currentStorageClass,
      )?.id ?? "",
    );
  };
  const validDays = parseQiniuRestoreDays(days);
  const validType =
    storageClasses.some((item) => item.id === storageClass && item.available) &&
    storageClass !== currentStorageClass;
  const allowed =
    costConfirmed &&
    (dialog === "type"
      ? canChange && validType
      : canRestore && validDays !== null);
  const submit = async () => {
    if (!allowed || processing || !dialog) return;
    const current = ++generation.current;
    setPending(true);
    setError(null);
    try {
      if (dialog === "type")
        await onChangeStorageClass({
          objectKeys: [...objectKeys],
          storageClass,
        });
      else if (validDays !== null)
        await onRestore({ objectKeys: [...objectKeys], days: validDays });
      if (current === generation.current) setDialog(null);
    } catch (cause) {
      if (current === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : t(
                "请求未完成，请重试。",
                "The request did not complete. Please retry.",
              ),
        );
    } finally {
      if (current === generation.current) setPending(false);
    }
  };
  const expiry = restoredUntil ? new Date(restoredUntil) : null;
  return (
    <section
      aria-label={t("七牛对象操作", "Qiniu object actions")}
      className="min-w-0 space-y-2"
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">
          {t("存储类型", "Storage type")}
        </dt>
        <dd className="m-0 break-words text-right">{typeLabel}</dd>
        <dt className="text-muted-foreground">
          {t("恢复状态", "Restore state")}
        </dt>
        <dd className="m-0 text-right" role="status" aria-live="polite">
          {stateLabel}
        </dd>
        {expiry && !Number.isNaN(expiry.getTime()) && (
          <>
            <dt className="text-muted-foreground">
              {t("解冻有效至", "Restored until")}
            </dt>
            <dd className="m-0 break-words text-right">
              {expiry.toLocaleString(intlLocale(), { hour12: false })}
            </dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={processing || !canChange}
          aria-describedby={`${id}-type-reason`}
          onClick={() => open("type")}
        >
          {t("修改存储类型", "Change storage type")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={processing || !canRestore}
          aria-describedby={`${id}-restore-reason`}
          onClick={() => open("restore")}
        >
          {restoreState === "restoring"
            ? t("正在解冻…", "Restoring…")
            : t("解冻文件", "Restore files")}
        </Button>
      </div>
      <div id={`${id}-type-reason`} className="space-y-1">
        <QiniuCapabilityNote capability={capabilities.changeType} />
        {stateRestriction && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {stateRestriction}
          </p>
        )}
      </div>
      <div id={`${id}-restore-reason`} className="space-y-1">
        <QiniuCapabilityNote capability={capabilities.restore} />
        {readable && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(
              "当前文件可读取，无需重复解冻。",
              "The selected files are readable and do not need another restore request.",
            )}
          </p>
        )}
      </div>
      {processing && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("正在处理请求，请稍候。", "Processing the request. Please wait.")}
        </p>
      )}
      {!selected && (
        <p className="text-xs text-muted-foreground">
          {t(
            "选择文件后可查看并执行七牛专有操作。",
            "Select files to inspect and use Qiniu-specific actions.",
          )}
        </p>
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(value) => {
          if (!value && !processing) setDialog(null);
        }}
      >
        <DialogContent
          showCloseButton={!processing}
          className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
        >
          <DialogHeader>
            <DialogTitle>
              {dialog === "type"
                ? t("修改存储类型", "Change storage type")
                : t("解冻文件", "Restore files")}
            </DialogTitle>
            <DialogDescription>
              {t(
                `选中了 ${objectKeys.length} 个文件。批量请求应逐项报告成功或失败。`,
                `${objectKeys.length} files selected. Batch requests must report individual successes and failures.`,
              )}
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-24 space-y-1 overflow-y-auto text-xs text-muted-foreground">
            {objectKeys.slice(0, 5).map((key) => (
              <li key={key} className="break-all">
                {key}
              </li>
            ))}
            {objectKeys.length > 5 && (
              <li>
                {t(
                  "其余文件将在请求中一并处理。",
                  "The remaining selected files are included in the request.",
                )}
              </li>
            )}
          </ul>
          {dialog === "type" ? (
            <div className="space-y-2">
              <Label htmlFor={`${id}-class`}>
                {t("目标存储类型", "Destination storage type")}
              </Label>
              <select
                id={`${id}-class`}
                className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                value={storageClass}
                disabled={processing}
                onChange={(event) => setStorageClass(event.target.value)}
              >
                <option value="" disabled>
                  {t("选择可用类型", "Choose an available type")}
                </option>
                {storageClasses.map((item) => (
                  <option
                    key={item.id}
                    value={item.id}
                    disabled={
                      !item.available || item.id === currentStorageClass
                    }
                  >
                    {item.label}
                  </option>
                ))}
              </select>
              {storageClasses
                .filter((item) => !item.available && item.reason)
                .map((item) => (
                  <p
                    key={item.id}
                    className="text-xs leading-relaxed text-muted-foreground"
                  >
                    {item.label}：{localize(item.reason ?? "")}
                  </p>
                ))}
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={`${id}-days`}>
                {t("解冻有效天数（1–7）", "Restore validity (1–7 days)")}
              </Label>
              <Input
                id={`${id}-days`}
                type="number"
                min={1}
                max={7}
                step={1}
                value={days}
                disabled={processing}
                onChange={(event) => setDays(event.target.value)}
                aria-invalid={validDays === null}
                aria-describedby={`${id}-days-help`}
              />
              <p
                id={`${id}-days-help`}
                className="text-xs leading-relaxed text-muted-foreground"
              >
                {t(
                  "提交成功仅表示解冻请求已受理，并不代表文件已经可读取；后续状态由服务端刷新确认。",
                  "An accepted restore request does not mean the file is readable yet. Refreshed server state determines when restoration completes.",
                )}
              </p>
            </div>
          )}
          <p className="text-xs leading-relaxed text-warning">
            {dialog === "type"
              ? t(
                  "修改类型可能产生类型转换费用，未达到最短存储期限还可能产生提前删除费用。费用以七牛实际账单为准。",
                  "Type changes may incur conversion charges and early-deletion charges before the minimum storage period. Actual charges are determined by Qiniu.",
                )
              : t(
                  "解冻可能产生数据取回和临时存储费用；不同归档类型的等待时间不同，不会自动重复提交。",
                  "Restoration may incur retrieval and temporary-storage charges. Waiting times depend on the archive type; requests are not automatically repeated.",
                )}
          </p>
          <label className="flex items-start gap-2 text-xs leading-relaxed">
            <input
              type="checkbox"
              className="mt-0.5 accent-primary focus-visible:outline-2 focus-visible:outline-primary"
              checked={costConfirmed}
              disabled={processing}
              onChange={(event) => setCostConfirmed(event.target.checked)}
            />
            {t(
              "我已了解可能产生费用，并确认本次操作。",
              "I understand possible charges and confirm this operation.",
            )}
          </label>
          {error && (
            <p
              role="alert"
              className="break-words text-xs leading-relaxed text-destructive"
            >
              {localize(error)}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={processing}
              onClick={() => setDialog(null)}
            >
              {t("取消", "Cancel")}
            </Button>
            <Button
              type="button"
              disabled={processing || !allowed}
              aria-busy={processing}
              onClick={() => void submit()}
            >
              {processing
                ? t("正在提交…", "Submitting…")
                : t("确认提交", "Confirm request")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
