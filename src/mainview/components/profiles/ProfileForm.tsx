import type { ProfileInfo } from "@shared/profile.types";
import { PROVIDER_ENDPOINTS, PROVIDER_REGIONS } from "@shared/profile.types";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVIDERS } from "@/lib/constants";
import { localize, t, useT } from "@/lib/i18n";
import { IconSpinner } from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import { useVaultStore } from "@/stores";
import { toast } from "../common/Toast";
import { PROVIDER_HINTS, type Provider } from "./providerHints";

interface ProfileFormProps {
  open: boolean;
  onClose: () => void;
  editProfile?: ProfileInfo;
}

export function ProfileForm({ open, onClose, editProfile }: ProfileFormProps) {
  useT();
  const refreshProfiles = useVaultStore((s) => s.refreshProfiles);
  const isEditing = !!editProfile;

  const [provider, setProvider] = useState<Provider>(
    editProfile?.provider ?? "aws",
  );
  const [name, setName] = useState(editProfile?.name ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [r2AnalyticsToken, setR2AnalyticsToken] = useState("");
  const [clearR2AnalyticsToken, setClearR2AnalyticsToken] = useState(false);
  const [analyticsExpanded, setAnalyticsExpanded] = useState(false);
  const [endpoint, setEndpoint] = useState(editProfile?.endpoint ?? "");
  const [region, setRegion] = useState(
    editProfile?.region ?? PROVIDER_REGIONS[editProfile?.provider ?? "aws"],
  );
  const [defaultBucket, setDefaultBucket] = useState(
    editProfile?.defaultBucket ?? "",
  );
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);

  const hints = PROVIDER_HINTS[provider];

  const needsEndpoint =
    provider === "r2" ||
    provider === "spaces" ||
    provider === "minio" ||
    provider === "backblaze" ||
    provider === "custom";

  useEffect(() => {
    if (!open) {
      setR2AnalyticsToken("");
      setClearR2AnalyticsToken(false);
      setAnalyticsExpanded(false);
    }
  }, [open]);

  const handleProviderChange = (p: Provider) => {
    setProvider(p);
    setEndpoint(PROVIDER_ENDPOINTS[p] ?? "");
    setRegion(PROVIDER_REGIONS[p]);
    if (p !== "r2") {
      setR2AnalyticsToken("");
      setClearR2AnalyticsToken(false);
      setAnalyticsExpanded(false);
    }
    setTestResult(null);
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await rpcCall("profile:test", {
        provider,
        endpoint: needsEndpoint ? endpoint : undefined,
        region,
        accessKeyId,
        secretAccessKey,
        defaultBucket: defaultBucket || undefined,
      });
      setTestResult({
        ok: result.success,
        msg: result.success
          ? t(
              `连接成功，发现 ${result.bucketCount} 个存储桶`,
              `Connected. Found ${result.bucketCount} buckets`,
            )
          : (result.error ?? t("连接失败", "Connection failed")),
      });
    } catch (err: unknown) {
      setTestResult({
        ok: false,
        msg:
          err instanceof Error ? err.message : t("未知错误", "Unknown error"),
      });
    }
    setTesting(false);
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    const trimmedAccessKeyId = accessKeyId.trim();
    const trimmedSecretAccessKey = secretAccessKey.trim();
    const trimmedEndpoint = endpoint.trim();
    const trimmedRegion = region.trim();
    const trimmedDefaultBucket = defaultBucket.trim();
    const trimmedAnalyticsToken = r2AnalyticsToken.trim();
    const analyticsSettings =
      provider === "r2"
        ? {
            ...(trimmedAnalyticsToken
              ? { r2AnalyticsToken: trimmedAnalyticsToken }
              : {}),
            ...(clearR2AnalyticsToken && !trimmedAnalyticsToken
              ? { clearR2AnalyticsToken: true }
              : {}),
          }
        : {};

    if (!trimmedName) {
      toast.error(t("请输入存储账号名称", "Enter an account name"));
      return;
    }

    if (!isEditing && (!trimmedAccessKeyId || !trimmedSecretAccessKey)) {
      toast.error(
        t(
          "请输入访问密钥 ID 和访问密钥",
          "Enter an access key ID and secret access key",
        ),
      );
      return;
    }

    if (
      isEditing &&
      Boolean(trimmedAccessKeyId) !== Boolean(trimmedSecretAccessKey)
    ) {
      toast.error(
        t(
          "更新凭据时需要同时提供访问密钥 ID 和访问密钥",
          "To update credentials, provide both the access key ID and secret access key",
        ),
      );
      return;
    }

    setSaving(true);
    try {
      if (isEditing) {
        await rpcCall("profile:update", {
          id: editProfile.id,
          provider,
          name: trimmedName,
          ...(trimmedAccessKeyId ? { accessKeyId: trimmedAccessKeyId } : {}),
          ...(trimmedSecretAccessKey
            ? { secretAccessKey: trimmedSecretAccessKey }
            : {}),
          endpoint:
            needsEndpoint && trimmedEndpoint ? trimmedEndpoint : undefined,
          region: trimmedRegion,
          defaultBucket: trimmedDefaultBucket || undefined,
          ...analyticsSettings,
        });
        await refreshProfiles();
        toast.success(
          t(
            `存储账号“${trimmedName}”已更新`,
            `Account “${trimmedName}” updated`,
          ),
        );
      } else {
        await rpcCall("profile:add", {
          provider,
          name: trimmedName,
          accessKeyId: trimmedAccessKeyId,
          secretAccessKey: trimmedSecretAccessKey,
          endpoint:
            needsEndpoint && trimmedEndpoint ? trimmedEndpoint : undefined,
          region: trimmedRegion,
          defaultBucket: trimmedDefaultBucket || undefined,
          ...analyticsSettings,
        });
        await refreshProfiles();
        toast.success(
          t(`存储账号“${trimmedName}”已添加`, `Account “${trimmedName}” added`),
        );
      }
      onClose();
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : t("未知错误", "Unknown error"),
      );
    }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? t("编辑存储账号", "Edit Profile")
              : t("添加存储账号", "Add Profile")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "填写存储服务商和凭据，连接 S3 兼容存储。",
              "Connect an S3-compatible bucket by entering its provider and credentials.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="pf-name" className="text-xs">
              {t("账号名称（必填）", "Profile Name")}
            </Label>
            <Input
              id="pf-name"
              className="h-8 text-sm"
              placeholder={t(
                "请填写账号名称，例如 R2-工作账号",
                "For example, R2 work account",
              )}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground/50">
              {t(
                "为此连接设置一个便于识别的名称",
                "A friendly name to identify this connection",
              )}
            </p>
          </div>

          {/* ── Connection ── */}
          <div className="space-y-3 rounded-lg border border-border/60 p-3">
            <p className="font-semibold text-[11px] text-foreground/50 uppercase tracking-wider">
              {t("连接信息", "Connection")}
            </p>

            {/* Provider */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-provider" className="text-xs">
                {t("存储服务商", "Provider")}
              </Label>
              <Select
                value={provider}
                onValueChange={(v) => handleProviderChange(v as Provider)}
              >
                <SelectTrigger id="pf-provider" className="h-8 w-full text-sm">
                  <SelectValue>
                    {(value) =>
                      PROVIDERS.find((p) => p.value === value)?.label ??
                      (value as string)
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Endpoint (conditional) */}
            {needsEndpoint && (
              <div className="space-y-1.5">
                <Label htmlFor="pf-endpoint" className="text-xs">
                  {t("接口地址（Endpoint）", "Endpoint URL")}
                </Label>
                <Input
                  id="pf-endpoint"
                  className="h-8 font-mono text-sm"
                  placeholder="https://..."
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                />
                {hints?.endpoint && (
                  <p className="text-xs text-muted-foreground/50">
                    {hints.endpoint}
                  </p>
                )}
              </div>
            )}

            {/* Region + Default Bucket */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pf-region" className="text-xs">
                  {t("区域（Region）", "Region")}
                </Label>
                <Input
                  id="pf-region"
                  className="h-8 text-sm"
                  placeholder="us-east-1"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                />
                {hints?.region && (
                  <p className="text-xs text-muted-foreground/50">
                    {hints.region}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pf-default-bucket" className="text-xs">
                  {t("默认存储桶", "Default bucket")}{" "}
                  <span className="font-normal opacity-40">
                    {t("可选", "optional")}
                  </span>
                </Label>
                <Input
                  id="pf-default-bucket"
                  className="h-8 text-sm"
                  placeholder="my-bucket"
                  value={defaultBucket}
                  onChange={(e) => setDefaultBucket(e.target.value)}
                />
                <p className="text-xs text-muted-foreground/50">
                  {provider === "r2"
                    ? t(
                        "当 R2 凭据仅允许访问指定存储桶时必填",
                        "Required for R2 tokens scoped to a specific bucket",
                      )
                    : t("默认选择的存储桶", "Bucket to select by default")}
                </p>
              </div>
            </div>
          </div>

          {/* ── Credentials ── */}
          <div className="space-y-3 rounded-lg border border-border/60 p-3">
            <p className="font-semibold text-[11px] text-foreground/50 uppercase tracking-wider">
              {t("访问凭据", "Credentials")}
            </p>
            {isEditing && (
              <p className="text-xs text-muted-foreground">
                {t(
                  "已保存的密钥默认隐藏。关闭此窗口后，右键左侧账号可查看或复制。",
                  "Saved secrets are hidden by default. Close this dialog and right-click the account to view or copy them.",
                )}
              </p>
            )}

            {/* Access Key */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-access-key" className="text-xs">
                {t("访问密钥 ID（Access Key ID）", "Access Key ID")}
              </Label>
              <Input
                id="pf-access-key"
                className="h-8 font-mono text-sm"
                placeholder={
                  isEditing
                    ? t("输入新的访问密钥 ID 以修改", "Enter new key to change")
                    : "AKIA..."
                }
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
              />
              {hints?.accessKey && (
                <p className="text-xs text-muted-foreground/50">
                  {hints.accessKey}
                </p>
              )}
              {isEditing && (
                <p className="text-xs text-muted-foreground/50">
                  {t(
                    "留空则保留当前值",
                    "Leave blank to keep the current value",
                  )}
                </p>
              )}
            </div>

            {/* Secret Key */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-secret-key" className="text-xs">
                {t("访问密钥（Secret Access Key）", "Secret Access Key")}
              </Label>
              <Input
                id="pf-secret-key"
                type="password"
                className="h-8 font-mono text-sm"
                placeholder={
                  isEditing
                    ? t("输入新的访问密钥以修改", "Enter new secret to change")
                    : "••••••••"
                }
                value={secretAccessKey}
                onChange={(e) => setSecretAccessKey(e.target.value)}
              />
              {hints?.secretKey && (
                <p className="text-xs text-muted-foreground/50">
                  {hints.secretKey}
                </p>
              )}
              {isEditing && (
                <p className="text-xs text-muted-foreground/50">
                  {t(
                    "留空则保留当前值",
                    "Leave blank to keep the current value",
                  )}
                </p>
              )}
            </div>
          </div>

          {provider === "r2" && (
            <details
              className="group rounded-lg border border-border/60 p-3"
              open={analyticsExpanded}
              onToggle={(event) =>
                setAnalyticsExpanded(event.currentTarget.open)
              }
            >
              <summary className="cursor-pointer text-xs font-medium text-foreground/70 marker:text-foreground/40">
                {t("用量统计（可选）", "Usage analytics (optional)")}
                {editProfile?.hasR2AnalyticsToken && (
                  <span className="ml-2 text-foreground/45">
                    {clearR2AnalyticsToken
                      ? t("待移除", "Will be removed")
                      : r2AnalyticsToken.trim()
                        ? t("待更新", "Will be updated")
                        : t("已配置", "Configured")}
                  </span>
                )}
              </summary>
              <div className="mt-3 space-y-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t(
                    "现有密钥可扫描文件统计用量。填写 Cloudflare API Token 后，可读取 R2 官方统计。",
                    "Existing S3 credentials can scan objects to calculate usage. Add a Cloudflare API token to read official R2 analytics.",
                  )}
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="pf-r2-analytics-token" className="text-xs">
                    {t("统计 API Token", "Analytics API token")}
                  </Label>
                  <Input
                    id="pf-r2-analytics-token"
                    type="password"
                    className="h-8 font-mono text-sm"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={
                      editProfile?.hasR2AnalyticsToken
                        ? t(
                            "留空保留已保存的 Token",
                            "Leave blank to keep the saved token",
                          )
                        : t(
                            "填写有统计读取权限的 API Token",
                            "Enter an API token with analytics read permissions",
                          )
                    }
                    value={r2AnalyticsToken}
                    onChange={(e) => {
                      setR2AnalyticsToken(e.target.value);
                      if (e.target.value.trim())
                        setClearR2AnalyticsToken(false);
                    }}
                  />
                  <p className="text-xs text-muted-foreground/70">
                    {t(
                      "与账号凭据一同加密保存在本机密码库中。",
                      "Encrypted with the account credentials in your local vault.",
                    )}
                  </p>
                </div>
                {isEditing && editProfile?.hasR2AnalyticsToken && (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="pf-clear-r2-analytics-token"
                      checked={clearR2AnalyticsToken}
                      onCheckedChange={(checked) => {
                        setClearR2AnalyticsToken(checked === true);
                        if (checked === true) setR2AnalyticsToken("");
                      }}
                    />
                    <Label
                      htmlFor="pf-clear-r2-analytics-token"
                      className="cursor-pointer text-xs font-normal"
                    >
                      {t(
                        "保存时移除已配置的统计 Token",
                        "Remove the saved analytics token on save",
                      )}
                    </Label>
                  </div>
                )}
              </div>
            </details>
          )}

          {/* Test result */}
          {testResult && (
            <div
              className={`rounded-lg border p-2 text-xs ${
                testResult.ok
                  ? "border-success/30 bg-success/10 text-success"
                  : "border-destructive/30 bg-destructive/10 text-destructive"
              }`}
            >
              {localize(testResult.msg)}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={testConnection}
            disabled={testing || !accessKeyId || !secretAccessKey}
          >
            {testing ? (
              <IconSpinner className="size-3.5 animate-spin" />
            ) : (
              t("测试连接", "Test connection")
            )}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={
              saving ||
              !name.trim() ||
              (!isEditing && (!accessKeyId || !secretAccessKey))
            }
          >
            {saving ? (
              <IconSpinner className="size-3.5 animate-spin" />
            ) : isEditing ? (
              t("更新", "Update")
            ) : (
              t("保存", "Save")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
