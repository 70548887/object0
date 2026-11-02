import { Button } from "@/components/ui/button";
import { t, useT } from "@/lib/i18n";
import { IconSpinner } from "@/lib/icons";

export interface QiniuBucketChoice {
  name: string;
  regionId?: string;
  s3Name?: string;
  permission?: "readonly" | "readwrite";
}

function safeText(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

/** Accept only the already-authenticated list, never credentials or a guessed S3 ID. */
export function parseQiniuBucketChoices(
  value: unknown,
): QiniuBucketChoice[] | null {
  const invalid = () =>
    new Error(
      t(
        "空间列表格式或认证结果无效，未采用这些空间；默认空间保持不变。",
        "The bucket list or authentication result is invalid. These buckets were not used; the default bucket is unchanged.",
      ),
    );
  if (!value || typeof value !== "object") throw invalid();
  const response = value as Record<string, unknown>;
  if (response.buckets === undefined) return null;
  if (
    !Array.isArray(response.checks) ||
    response.checks.filter(
      (check) =>
        check && typeof check === "object" && check.name === "authentication",
    ).length !== 1 ||
    !response.checks.some(
      (check) =>
        check &&
        typeof check === "object" &&
        check.name === "authentication" &&
        check.status === "ok",
    ) ||
    !Array.isArray(response.buckets) ||
    response.buckets.length > 10_000
  )
    throw invalid();
  const names = new Set<string>();
  return response.buckets.map((raw) => {
    if (!raw || typeof raw !== "object") throw invalid();
    const bucket = raw as Record<string, unknown>;
    if (
      !safeText(bucket.name, 255) ||
      names.has(bucket.name) ||
      (bucket.regionId !== undefined && !safeText(bucket.regionId, 255)) ||
      (bucket.s3Name !== undefined && !safeText(bucket.s3Name, 255)) ||
      (bucket.permission !== undefined &&
        !["readonly", "readwrite"].includes(bucket.permission as string))
    )
      throw invalid();
    names.add(bucket.name);
    return {
      name: bucket.name,
      ...(bucket.regionId !== undefined
        ? { regionId: bucket.regionId as string }
        : {}),
      ...(bucket.s3Name !== undefined
        ? { s3Name: bucket.s3Name as string }
        : {}),
      ...(bucket.permission !== undefined
        ? { permission: bucket.permission as QiniuBucketChoice["permission"] }
        : {}),
    };
  });
}

/** The stale predicate is checked before parsing and again before publication. */
export function currentQiniuBucketChoices(
  value: unknown,
  isCurrent: () => boolean,
) {
  if (!isCurrent()) return null;
  const choices = parseQiniuBucketChoices(value);
  return isCurrent() ? choices : null;
}

export function requiresQiniuMigration(input: {
  provider: string;
  storageMode?: "encrypted" | "plaintext";
  vaultVersion: number | null;
  editingQiniu: boolean;
  hasQiniu: boolean;
}) {
  return (
    input.provider === "qiniu" &&
    input.storageMode !== "plaintext" &&
    input.vaultVersion !== 5 &&
    input.vaultVersion !== 4 &&
    !input.editingQiniu &&
    !input.hasQiniu
  );
}

export function QiniuBucketPicker({
  choices,
  value,
  busy,
  disabled,
  onRead,
  onSelect,
}: {
  choices: readonly QiniuBucketChoice[] | null;
  value: string;
  busy: boolean;
  disabled: boolean;
  onRead: () => void;
  onSelect: (value: string) => void;
}) {
  useT();
  return (
    <div className="min-w-0 space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        disabled={disabled || busy}
        onClick={onRead}
        aria-busy={busy}
      >
        {busy ? <IconSpinner className="size-3.5 animate-spin" /> : null}
        {busy ? t("正在读取…", "Reading…") : t("读取空间", "Read buckets")}
      </Button>
      {choices !== null && choices.length > 0 && (
        <select
          aria-label={t(
            "从已读取空间选择默认存储桶",
            "Choose a default bucket from the retrieved list",
          )}
          className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          value={value}
          disabled={busy}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">
            {t("暂不选择默认空间", "No default bucket selected")}
          </option>
          {value && !choices.some((choice) => choice.name === value) && (
            <option value={value}>
              {value} · {t("手动填写", "Entered manually")}
            </option>
          )}
          {choices.map((bucket) => (
            <option key={bucket.name} value={bucket.name}>
              {bucket.name}
              {bucket.regionId ? ` · ${bucket.regionId}` : ""}
              {bucket.permission === "readonly"
                ? ` · ${t("只读", "Read-only")}`
                : ""}
            </option>
          ))}
        </select>
      )}
      {choices !== null && (
        <p
          role="status"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {choices.length > 0
            ? t(
                `已读取 ${choices.length} 个空间。请选择或手动填写；不会自动替你选中。选定后重新测试，可验证对象列表权限。`,
                `Retrieved ${choices.length} buckets. Choose one or enter a name manually; none is selected automatically. Test again after selecting to verify object-list permission.`,
              )
            : t(
                "当前凭据未列出任何空间；这不表示账号没有受限空间。受限账号请配置明确的空间绑定或手动填写原始名称后验证。",
                "No buckets were listed by these credentials. This does not prove the account has no scoped buckets. Configure explicit bucket bindings or manually enter the native name and verify it.",
              )}
        </p>
      )}
    </div>
  );
}
