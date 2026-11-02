import type { QiniuBucketBinding } from "@shared/profile.types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n";

export type QiniuBindingRow = QiniuBucketBinding & { uiId: string };

export function QiniuBucketBindings({
  rows,
  onChange,
}: {
  rows: QiniuBindingRow[];
  onChange: (rows: QiniuBindingRow[]) => void;
}) {
  const t = useT();
  const update = (
    uiId: string,
    field: keyof QiniuBucketBinding,
    value: string,
  ) =>
    onChange(
      rows.map((row) => (row.uiId === uiId ? { ...row, [field]: value } : row)),
    );
  return (
    <details
      className="rounded-md border border-border/70 p-3"
      open={rows.length > 0 ? true : undefined}
    >
      <summary className="cursor-pointer text-xs font-medium">
        {t(
          "限定空间 / S3 绑定（受限账号、临时凭据）",
          "Scoped buckets / S3 bindings (restricted or temporary credentials)",
        )}
      </summary>
      <div className="mt-3 space-y-3">
        <p
          className="text-xs leading-relaxed text-muted-foreground"
          role="note"
        >
          {t(
            "配置后只显示下面的空间，直接验证 S3 对象读取，不调用账号级列桶。S3 空间 ID 必须从七牛后台或管理员取得，不能用原生空间名猜测；不会把认证失败自动降级为成功。",
            "Only these buckets will be shown. Access is verified with an S3 object read instead of account-wide bucket listing. Obtain the S3 bucket ID from Qiniu or your administrator; do not guess it from the native name. Authentication failures are never treated as success.",
          )}
        </p>
        {rows.map((row, index) => (
          <fieldset
            key={row.uiId}
            className="min-w-0 space-y-2 rounded border border-border/60 p-2"
          >
            <legend className="px-1 text-xs">
              {t(`限定空间 ${index + 1}`, `Scoped bucket ${index + 1}`)}
            </legend>
            {(
              [
                [
                  "nativeName",
                  t("原生空间名", "Native bucket name"),
                  "my-bucket",
                ],
                [
                  "s3Name",
                  t(
                    "S3 空间 ID（不是显示名称）",
                    "S3 bucket ID (not a display name)",
                  ),
                  "",
                ],
                ["s3RegionId", t("S3 区域 ID", "S3 region ID"), "cn-east-1"],
                [
                  "s3Endpoint",
                  t("该空间的 S3 地址", "S3 endpoint for this bucket"),
                  "https://s3.cn-east-1.qiniucs.com",
                ],
              ] as const
            ).map(([field, label, placeholder]) => (
              <div key={field} className="space-y-1">
                <Label
                  htmlFor={`binding-${row.uiId}-${field}`}
                  className="text-xs"
                >
                  {label}
                </Label>
                <Input
                  id={`binding-${row.uiId}-${field}`}
                  value={row[field]}
                  placeholder={placeholder}
                  onChange={(event) =>
                    update(row.uiId, field, event.target.value)
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 font-mono text-xs"
                />
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                onChange(rows.filter((item) => item.uiId !== row.uiId))
              }
              aria-label={t(
                `移除限定空间 ${index + 1}`,
                `Remove scoped bucket ${index + 1}`,
              )}
            >
              {t("移除此绑定", "Remove binding")}
            </Button>
          </fieldset>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={rows.length >= 32}
          onClick={() =>
            onChange([
              ...rows,
              {
                uiId: crypto.randomUUID(),
                nativeName: "",
                s3Name: "",
                s3RegionId: "",
                s3Endpoint: "",
              },
            ])
          }
        >
          {t("添加限定空间", "Add scoped bucket")}
        </Button>
        {rows.length > 0 && (
          <p className="text-xs text-warning">
            {t(
              "绑定模式使用 S3 路径；目前支持读取和已授权的文件删除，上传、原生空间管理及目录分享仍未接通。私有云待实机验收。",
              "Binding mode uses S3. Reads and permitted file deletion are available; uploads, native bucket management and directory sharing are not yet connected. Private deployments still require live validation.",
            )}
          </p>
        )}
      </div>
    </details>
  );
}
