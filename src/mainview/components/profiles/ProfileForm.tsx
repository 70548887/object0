import type { ProfileInfo } from "@shared/profile.types";
import { PROVIDER_ENDPOINTS, PROVIDER_REGIONS } from "@shared/profile.types";
import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVIDERS } from "@/lib/constants";
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
  const refreshProfiles = useVaultStore((s) => s.refreshProfiles);
  const isEditing = !!editProfile;

  const [provider, setProvider] = useState<Provider>(
    editProfile?.provider ?? "aws",
  );
  const [name, setName] = useState(editProfile?.name ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
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

  const handleProviderChange = (p: Provider) => {
    setProvider(p);
    setEndpoint(PROVIDER_ENDPOINTS[p] ?? "");
    setRegion(PROVIDER_REGIONS[p]);
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
          ? `连接成功，发现 ${result.bucketCount} 个存储桶`
          : (result.error ?? "连接失败"),
      });
    } catch (err: unknown) {
      setTestResult({
        ok: false,
        msg: err instanceof Error ? err.message : "未知错误",
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

    if (!trimmedName) {
      toast.error("请输入存储账号名称");
      return;
    }

    if (!isEditing && (!trimmedAccessKeyId || !trimmedSecretAccessKey)) {
      toast.error("请输入访问密钥 ID 和访问密钥");
      return;
    }

    if (
      isEditing &&
      Boolean(trimmedAccessKeyId) !== Boolean(trimmedSecretAccessKey)
    ) {
      toast.error("更新凭据时需要同时提供访问密钥 ID 和访问密钥");
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
        });
        await refreshProfiles();
        toast.success(`存储账号“${trimmedName}”已更新`);
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
        });
        await refreshProfiles();
        toast.success(`存储账号“${trimmedName}”已添加`);
      }
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "未知错误");
    }
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "编辑存储账号" : "添加存储账号"}
          </DialogTitle>
          <DialogDescription>
            填写存储服务商和凭据，连接 S3 兼容存储。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="pf-name" className="text-xs">
              账号名称（必填）
            </Label>
            <Input
              id="pf-name"
              className="h-8 text-sm"
              placeholder={"请填写账号名称，例如 R2-工作账号"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground/50">
              为此连接设置一个便于识别的名称
            </p>
          </div>

          {/* ── Connection ── */}
          <div className="space-y-3 rounded-lg border border-border/60 p-3">
            <p className="font-semibold text-[11px] text-foreground/50 uppercase tracking-wider">
              连接信息
            </p>

            {/* Provider */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-provider" className="text-xs">
                存储服务商
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
                  接口地址（Endpoint）
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
                  区域（Region）
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
                  默认存储桶{" "}
                  <span className="font-normal opacity-40">可选</span>
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
                    ? "当 R2 凭据仅允许访问指定存储桶时必填"
                    : "默认选择的存储桶"}
                </p>
              </div>
            </div>
          </div>

          {/* ── Credentials ── */}
          <div className="space-y-3 rounded-lg border border-border/60 p-3">
            <p className="font-semibold text-[11px] text-foreground/50 uppercase tracking-wider">
              访问凭据
            </p>
            {isEditing && (
              <p className="text-xs text-muted-foreground">
                已保存的密钥默认隐藏。关闭此窗口后，右键左侧账号可查看或复制。
              </p>
            )}

            {/* Access Key */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-access-key" className="text-xs">
                访问密钥 ID（Access Key ID）
              </Label>
              <Input
                id="pf-access-key"
                className="h-8 font-mono text-sm"
                placeholder={
                  isEditing ? "输入新的访问密钥 ID 以修改" : "AKIA..."
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
                  留空则保留当前值
                </p>
              )}
            </div>

            {/* Secret Key */}
            <div className="space-y-1.5">
              <Label htmlFor="pf-secret-key" className="text-xs">
                访问密钥（Secret Access Key）
              </Label>
              <Input
                id="pf-secret-key"
                type="password"
                className="h-8 font-mono text-sm"
                placeholder={isEditing ? "输入新的访问密钥以修改" : "••••••••"}
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
                  留空则保留当前值
                </p>
              )}
            </div>
          </div>

          {/* Test result */}
          {testResult && (
            <div
              className={`rounded-lg border p-2 text-xs ${
                testResult.ok
                  ? "border-success/30 bg-success/10 text-success"
                  : "border-destructive/30 bg-destructive/10 text-destructive"
              }`}
            >
              {testResult.msg}
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
              "测试连接"
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
              "更新"
            ) : (
              "保存"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
