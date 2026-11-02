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
import { localize, useT } from "@/lib/i18n";
import { QiniuCapabilityNote } from "./QiniuCapabilityNote";
import {
  isQiniuCapabilityAllowed,
  type QiniuCapability,
  type QiniuRegionOption,
} from "./types";

export interface QiniuBucketActionsProps {
  /** Stable account/environment identity; changing it dismisses stale dialogs. */
  scopeId: string;
  bucketName?: string;
  remark?: string;
  regions: readonly QiniuRegionOption[];
  emptyState: "empty" | "not-empty" | "unknown";
  capabilities: {
    create: QiniuCapability;
    remove: QiniuCapability;
    remark: QiniuCapability;
  };
  busy?: boolean;
  /** An explicitly labelled server-verified attempt is permitted for unknown
   * write permission only after the container has confirmed native endpoints. */
  allowUnverifiedAttempt?: boolean;
  onCreate: (input: {
    name: string;
    regionId: string;
    access: "private";
  }) => Promise<void>;
  onRemove: (input: { bucketName: string }) => Promise<void>;
  onUpdateRemark: (input: {
    bucketName: string;
    remark: string;
  }) => Promise<void>;
}

export function isValidQiniuBucketName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value);
}

export function canConfirmQiniuBucketRemoval(input: {
  bucketName?: string;
  confirmation: string;
  emptyState: QiniuBucketActionsProps["emptyState"];
  capability: QiniuCapability;
  allowUnverifiedAttempt?: boolean;
}): boolean {
  return (
    Boolean(input.bucketName) &&
    input.confirmation === input.bucketName &&
    input.emptyState === "empty" &&
    canAttemptQiniuBucketAction(input.capability, input.allowUnverifiedAttempt)
  );
}

export function canAttemptQiniuBucketAction(
  capability: QiniuCapability,
  allowUnverifiedAttempt = false,
): boolean {
  return (
    isQiniuCapabilityAllowed(capability) ||
    (allowUnverifiedAttempt && capability.state === "unknown")
  );
}

export function QiniuBucketActions({
  scopeId,
  bucketName,
  remark = "",
  regions,
  emptyState,
  capabilities,
  busy = false,
  allowUnverifiedAttempt = false,
  onCreate,
  onRemove,
  onUpdateRemark,
}: QiniuBucketActionsProps) {
  const t = useT();
  const id = useId();
  const [dialog, setDialog] = useState<"create" | "remove" | "remark" | null>(
    null,
  );
  const [name, setName] = useState("");
  const [regionId, setRegionId] = useState("");
  const [draftRemark, setDraftRemark] = useState(remark);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const scope = JSON.stringify([scopeId, bucketName]);
  useEffect(() => {
    if (!scope) return;
    generation.current++;
    setDialog(null);
    setPending(false);
    setError(null);
    setConfirmation("");
    setDraftRemark(remark);
    return () => {
      generation.current++;
    };
  }, [scope, remark]);
  const processing = pending || busy;
  const selected = Boolean(bucketName);
  const canCreate =
    canAttemptQiniuBucketAction(capabilities.create, allowUnverifiedAttempt) &&
    regions.length > 0;
  const canRemove =
    selected &&
    emptyState === "empty" &&
    canAttemptQiniuBucketAction(capabilities.remove, allowUnverifiedAttempt);
  const canRemark =
    selected &&
    canAttemptQiniuBucketAction(capabilities.remark, allowUnverifiedAttempt);
  const removeReason =
    emptyState === "not-empty"
      ? t(
          "空间非空：请先单独处理其中的数据，不能在这里强制清空。",
          "The bucket is not empty. Handle its data separately; this action never empties a bucket.",
        )
      : emptyState === "unknown"
        ? t(
            "空间是否为空尚未确认，删除已禁用。",
            "Bucket emptiness is not confirmed; deletion is disabled.",
          )
        : null;
  const open = (value: NonNullable<typeof dialog>) => {
    setError(null);
    setConfirmation("");
    setName("");
    setRegionId(regions[0]?.id ?? "");
    setDraftRemark(remark);
    setDialog(value);
  };
  const allowed =
    dialog === "create"
      ? canCreate &&
        isValidQiniuBucketName(name) &&
        regions.some((region) => region.id === regionId)
      : dialog === "remove"
        ? canConfirmQiniuBucketRemoval({
            bucketName,
            confirmation,
            emptyState,
            capability: capabilities.remove,
            allowUnverifiedAttempt,
          })
        : canRemark && Array.from(draftRemark.trim()).length <= 100;
  const submit = async () => {
    if (processing || !allowed || !dialog) return;
    const current = ++generation.current;
    setPending(true);
    setError(null);
    try {
      if (dialog === "create")
        await onCreate({ name, regionId, access: "private" });
      else if (dialog === "remove" && bucketName)
        await onRemove({ bucketName });
      else if (dialog === "remark" && bucketName)
        await onUpdateRemark({ bucketName, remark: draftRemark.trim() });
      if (current === generation.current) setDialog(null);
    } catch (cause) {
      if (current === generation.current)
        setError(
          cause instanceof Error
            ? cause.message
            : t("操作失败，请重试。", "The operation failed. Please retry."),
        );
    } finally {
      if (current === generation.current) setPending(false);
    }
  };
  const title =
    dialog === "create"
      ? t("创建空间", "Create bucket")
      : dialog === "remove"
        ? t("删除空空间", "Delete empty bucket")
        : t("编辑空间备注", "Edit bucket remark");
  return (
    <section
      aria-label={t("七牛空间操作", "Qiniu bucket actions")}
      className="min-w-0 space-y-2"
    >
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={processing || !canCreate}
          aria-describedby={`${id}-create-reason`}
          onClick={() => open("create")}
        >
          {t("创建空间", "Create bucket")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={processing || !canRemark}
          aria-describedby={`${id}-remark-reason`}
          onClick={() => open("remark")}
        >
          {t("编辑备注", "Edit remark")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive"
          disabled={processing || !canRemove}
          aria-describedby={`${id}-remove-reason`}
          onClick={() => open("remove")}
        >
          {t("删除空空间", "Delete empty bucket")}
        </Button>
      </div>
      <QiniuCapabilityNote
        id={`${id}-create-reason`}
        capability={capabilities.create}
      />
      {canAttemptQiniuBucketAction(
        capabilities.create,
        allowUnverifiedAttempt,
      ) &&
        regions.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {t(
              "尚未取得可用区域，创建空间已禁用。",
              "No available regions have been loaded; bucket creation is disabled.",
            )}
          </p>
        )}
      <QiniuCapabilityNote
        id={`${id}-remark-reason`}
        capability={capabilities.remark}
      />
      <div id={`${id}-remove-reason`} className="space-y-1">
        <QiniuCapabilityNote capability={capabilities.remove} />
        {removeReason && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {removeReason}
          </p>
        )}
      </div>
      {!selected && (
        <p className="text-xs text-muted-foreground">
          {t(
            "选择一个空间后可编辑备注或删除空空间。",
            "Select one bucket to edit its remark or delete it when empty.",
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
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {dialog === "remove"
                ? t(
                    "只删除当前这个空空间，不会递归删除对象。",
                    "Delete only this empty bucket; objects are never recursively removed.",
                  )
                : dialog === "create"
                  ? t(
                      "区域创建后不可直接更改，请核对访问属性。",
                      "The region cannot be changed after creation. Review the access setting.",
                    )
                  : t(
                      "备注仅用于识别空间，不会重命名空间。",
                      "A remark identifies the bucket; it does not rename it.",
                    )}
            </DialogDescription>
          </DialogHeader>
          {dialog === "create" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-name`}>
                  {t("空间名称", "Bucket name")}
                </Label>
                <Input
                  id={`${id}-name`}
                  value={name}
                  disabled={processing}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={63}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby={`${id}-name-help`}
                />
                <p
                  id={`${id}-name-help`}
                  className="text-xs leading-relaxed text-muted-foreground"
                >
                  {t(
                    "3–63 个小写字母、数字或短横线，首尾为字母或数字。",
                    "3–63 lowercase letters, numbers or hyphens; begin and end with a letter or number.",
                  )}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-region`}>{t("区域", "Region")}</Label>
                <select
                  id={`${id}-region`}
                  className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  value={regionId}
                  disabled={processing}
                  onChange={(event) => setRegionId(event.target.value)}
                >
                  {regions.map((region) => (
                    <option key={region.id} value={region.id}>
                      {region.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-access`}>
                  {t("访问属性", "Access")}
                </Label>
                <Input
                  id={`${id}-access`}
                  value={t(
                    "私有（当前仅支持此方式）",
                    "Private (the only supported option)",
                  )}
                  readOnly
                  aria-describedby={`${id}-access-help`}
                />
              </div>
              <p
                id={`${id}-access-help`}
                className="text-xs leading-relaxed text-muted-foreground"
              >
                {t(
                  "公开创建暂不支持。创建可能产生资源费用；后端确认私有设置成功前，上传保持禁用。",
                  "Public creation is not supported. Creating storage may incur charges; uploads remain blocked until the backend verifies private access.",
                )}
              </p>
            </div>
          )}
          {dialog === "remove" && (
            <div className="space-y-3">
              <p className="break-all font-medium">{bucketName}</p>
              <p className="text-xs leading-relaxed text-destructive">
                {t(
                  "此操作不能撤销。服务端仍会重新检查空间为空；有对象或权限不足时应拒绝删除。",
                  "This cannot be undone. The server must recheck that the bucket is empty and reject deletion if objects remain or permission is missing.",
                )}
              </p>
              <Label htmlFor={`${id}-confirm`}>
                {t(
                  "输入完整空间名称确认",
                  "Type the full bucket name to confirm",
                )}
              </Label>
              <Input
                id={`${id}-confirm`}
                value={confirmation}
                disabled={processing}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}
          {dialog === "remark" && (
            <div className="space-y-2">
              <p className="break-all text-xs text-muted-foreground">
                {bucketName}
              </p>
              <Label htmlFor={`${id}-remark`}>
                {t("空间备注", "Bucket remark")}
              </Label>
              <Input
                id={`${id}-remark`}
                value={draftRemark}
                disabled={processing}
                onChange={(event) => setDraftRemark(event.target.value)}
                maxLength={200}
                aria-describedby={`${id}-remark-help`}
              />
              <p
                id={`${id}-remark-help`}
                className="text-xs text-muted-foreground"
              >
                {t("最多 100 个字符。", "Up to 100 characters.")}
              </p>
            </div>
          )}
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
              variant={dialog === "remove" ? "destructive" : "default"}
              disabled={processing || !allowed}
              aria-busy={processing}
              onClick={() => void submit()}
            >
              {processing
                ? t("正在处理…", "Processing…")
                : dialog === "remove"
                  ? t("确认删除", "Confirm deletion")
                  : allowUnverifiedAttempt &&
                      (dialog === "create"
                        ? capabilities.create.state
                        : capabilities.remark.state) === "unknown"
                    ? t("验证并确认", "Verify and confirm")
                    : t("确认", "Confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
