import type {
  ProfileInfo,
  QiniuProfileConfig,
  QiniuRegionConfig,
} from "@shared/profile.types";
import { PROVIDER_ENDPOINTS, PROVIDER_REGIONS } from "@shared/profile.types";
import { useEffect, useRef, useState } from "react";
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
import {
  type ConnectionTestPresentation,
  connectionCheckMessage,
  connectionTestPresentation,
  profileSaveBlockers,
} from "./connection-test-feedback";
import { ProviderChooser } from "./ProviderChooser";
import {
  PROVIDER_HINTS,
  type Provider,
  validateQiniuProfileConfig,
} from "./providerHints";
import {
  type QiniuBindingRow,
  QiniuBucketBindings,
} from "./QiniuBucketBindings";
import {
  currentQiniuBucketChoices,
  type QiniuBucketChoice,
  QiniuBucketPicker,
  requiresQiniuMigration,
} from "./QiniuBucketPicker";
import { QiniuQuickConnect } from "./QiniuQuickConnect";

type RegionRow = QiniuRegionConfig & { uiId: string };

interface ProfileFormProps {
  open: boolean;
  onClose: () => void;
  editProfile?: ProfileInfo;
}

export function QiniuProfileCapabilityNotice({
  kind,
  id,
}: {
  kind: "session-token" | "directory-share";
  id?: string;
}) {
  useT();
  return (
    <p
      id={id}
      role="status"
      className="text-xs leading-relaxed text-muted-foreground"
    >
      {kind === "session-token"
        ? t(
            "Session Token 需配合“限定空间 / S3 绑定”进行对象读取验证；保存成功不代表连接验证成功，凭据到期后需更新。此账号模式未开放上传或分享创建；分享链接登录不复用这些凭据。",
            "Session Tokens require scoped S3 bucket bindings for object-read verification. Saving does not prove connectivity; expired credentials must be updated. This account mode cannot upload or create shares; share-link login does not reuse these credentials.",
          )
        : t(
            "公有云原生账号已接入目录分享创建。私有云登录需明确配置门户、分享 API 和区域/S3 地址；仅完成本地契约验证，仍待目标部署实机验收。账号“测试连接”不验证分享服务，分享访问需另用链接和提取码验证。",
            "Public native accounts can create directory shares. Private login requires an explicit portal, share API and region/S3 URL. Only local contract tests are complete; deployment acceptance is still pending. Account connection tests do not validate the share service; verify share access separately with its URL and extraction code.",
          )}
    </p>
  );
}

/** Shared by connection-test drafts and saved profiles; never infer API trust. */
export function qiniuSharingConfiguration(
  mode: QiniuProfileConfig["mode"],
  sharePortal: string,
  shareApiUrl: string,
): Pick<QiniuProfileConfig, "sharePortal" | "shareApiUrl"> {
  return {
    ...(sharePortal.trim() ? { sharePortal: sharePortal.trim() } : {}),
    ...(mode === "private" && shareApiUrl.trim()
      ? { shareApiUrl: shareApiUrl.trim() }
      : {}),
  };
}

export function QiniuProfileSharingFields({
  mode,
  portal,
  apiUrl,
  onPortalChange,
  onApiUrlChange,
}: {
  mode: QiniuProfileConfig["mode"];
  portal: string;
  apiUrl: string;
  onPortalChange: (value: string) => void;
  onApiUrlChange: (value: string) => void;
}) {
  useT();
  return (
    <div className="min-w-0 space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="pf-qiniu-share" className="text-xs">
          {t("目录分享门户源地址", "Directory-share portal origin")}
        </Label>
        <Input
          id="pf-qiniu-share"
          className="h-8 font-mono text-xs"
          placeholder={
            mode === "private"
              ? "https://portal.example.com"
              : "https://portal.qiniu.com"
          }
          value={portal}
          onChange={(event) => onPortalChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="pf-qiniu-share-availability"
        />
        {mode === "public" && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(
              "留空使用七牛官方门户；公有分享仅允许官方 HTTPS 服务。",
              "Leave blank for Qiniu's official portal; public sharing accepts only official HTTPS services.",
            )}
          </p>
        )}
      </div>
      {mode === "private" && (
        <div className="space-y-1.5">
          <Label htmlFor="pf-qiniu-share-api" className="text-xs">
            {t(
              "分享 API 源地址（启用私有分享时必填）",
              "Share API origin (required for private sharing)",
            )}
          </Label>
          <Input
            id="pf-qiniu-share-api"
            className="h-8 font-mono text-xs"
            value={apiUrl}
            onChange={(event) => onApiUrlChange(event.target.value)}
            placeholder="https://share-api.example.com"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="pf-qiniu-share-api-help"
          />
          <p
            id="pf-qiniu-share-api-help"
            className="text-xs leading-relaxed text-muted-foreground"
          >
            {t(
              "填写部署方明确提供的 API 源地址（不含路径或凭据）。不会从 UC、门户或分享链接推断；验证时仅向此 API 发送分享令牌和提取码，不发送已保存的账号密钥。留空不启用私有分享登录。",
              "Use the deployment's explicit API origin, without paths or credentials. It is never inferred from UC, the portal or a share link. Verification sends the share token and extraction code only to this API, never saved account keys. Leave blank to keep private share login disabled.",
            )}
          </p>
        </div>
      )}
      <QiniuProfileCapabilityNotice
        kind="directory-share"
        id="pf-qiniu-share-availability"
      />
    </div>
  );
}

export function ProfileConnectionFeedback({
  result,
  provider,
}: {
  result: ConnectionTestPresentation;
  provider: string;
}) {
  useT();
  return (
    <div
      role="status"
      className={`rounded-lg border p-2 text-xs ${
        result.tone === "success"
          ? "border-success/30 bg-success/10 text-success"
          : result.tone === "warning"
            ? "border-warning/30 bg-warning/10 text-warning"
            : "border-destructive/30 bg-destructive/10 text-destructive"
      }`}
    >
      {localize(result.msg)}
      {provider === "qiniu" && Array.isArray(result.checks) && (
        <dl className="mt-2 space-y-1.5 border-t border-current/15 pt-2 text-foreground">
          {result.checks.map((check) => (
            <div key={check.name} className="space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                <dt className="font-medium">
                  {check.name === "authentication"
                    ? t("认证", "Authentication")
                    : check.name === "bucketAccess"
                      ? t("空间访问", "Bucket access")
                      : check.name === "regionDiscovery"
                        ? t("区域发现", "Region discovery")
                        : t("下载域名（可选）", "Download domain (optional)")}
                </dt>
                <dd
                  className={`m-0 shrink-0 ${check.status === "ok" ? "text-success" : check.status === "error" ? "text-destructive" : "text-warning"}`}
                >
                  {check.status === "ok"
                    ? t("通过", "Passed")
                    : check.status === "warning"
                      ? t("尚未验证", "Not verified")
                      : check.status === "unsupported"
                        ? t("不支持", "Unsupported")
                        : t("失败", "Failed")}
                </dd>
              </div>
              {check.message && (
                <p className="break-words leading-relaxed text-muted-foreground">
                  {connectionCheckMessage(check)}
                </p>
              )}
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function ProfileForm(props: ProfileFormProps) {
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(
    null,
  );
  const [advanced, setAdvanced] = useState(false);
  const chooseProvider = () => {
    setSelectedProvider(null);
    setAdvanced(false);
  };
  const close = () => {
    chooseProvider();
    props.onClose();
  };
  const selectProvider = (provider: Provider) => {
    setSelectedProvider(provider);
    setAdvanced(false);
  };
  useEffect(() => {
    if (!props.open) {
      setSelectedProvider(null);
      setAdvanced(false);
    }
  }, [props.open]);
  // Unmount closed forms so credentials and pending requests cannot carry over.
  if (!props.open) return null;
  if (props.editProfile)
    return (
      <AdvancedProfileForm
        {...props}
        key={`edit-${props.editProfile.id}-${props.editProfile.updatedAt}`}
        onClose={close}
      />
    );
  if (!selectedProvider)
    return (
      <ProviderChooser
        open={props.open}
        onClose={close}
        onSelect={selectProvider}
      />
    );
  if (selectedProvider === "qiniu" && !advanced)
    return (
      <QiniuQuickConnect
        open={props.open}
        onClose={close}
        onChooseProvider={chooseProvider}
        onAdvanced={() => setAdvanced(true)}
      />
    );
  return (
    <AdvancedProfileForm
      {...props}
      key={`add-${selectedProvider}`}
      initialProvider={selectedProvider}
      onClose={close}
      onChooseProvider={chooseProvider}
      onProviderChange={selectProvider}
    />
  );
}

export function AdvancedProfileForm({
  open,
  onClose,
  editProfile,
  initialProvider = "aws",
  onChooseProvider,
  onProviderChange,
}: ProfileFormProps & {
  initialProvider?: Provider;
  onChooseProvider?: () => void;
  onProviderChange?: (provider: Provider) => void;
}) {
  useT();
  const refreshProfiles = useVaultStore((s) => s.refreshProfiles);
  const profiles = useVaultStore((s) => s.profiles);
  const hasRecoveryKey = useVaultStore((s) => s.hasRecoveryKey);
  const vaultVersion = useVaultStore((s) => s.vaultVersion);
  const storageMode = useVaultStore((s) => s.storageMode);
  const isEditing = !!editProfile;

  const [provider, setProvider] = useState<Provider>(
    editProfile?.provider ?? initialProvider,
  );
  const [name, setName] = useState(editProfile?.name ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [clearSessionToken, setClearSessionToken] = useState(false);
  const [qiniuMode, setQiniuMode] = useState<"public" | "private">(
    editProfile?.qiniu?.mode ?? "public",
  );
  const [qiniuUcUrl, setQiniuUcUrl] = useState(editProfile?.qiniu?.ucUrl ?? "");
  const [qiniuRegions, setQiniuRegions] = useState<RegionRow[]>(() =>
    (editProfile?.qiniu?.regions ?? []).map((item) => ({
      ...item,
      uiId: crypto.randomUUID(),
    })),
  );
  const [qiniuDownloadDomain, setQiniuDownloadDomain] = useState(
    editProfile?.qiniu?.downloadDomain ?? "",
  );
  const [qiniuBindings, setQiniuBindings] = useState<QiniuBindingRow[]>(() =>
    (editProfile?.qiniu?.bucketBindings ?? []).map((item) => ({
      ...item,
      uiId: crypto.randomUUID(),
    })),
  );
  const [qiniuSharePortal, setQiniuSharePortal] = useState(
    editProfile?.qiniu?.sharePortal ?? "",
  );
  const [qiniuShareApiUrl, setQiniuShareApiUrl] = useState(
    editProfile?.qiniu?.shareApiUrl ?? "",
  );
  const [qiniuTrustedCaPath, setQiniuTrustedCaPath] = useState(
    editProfile?.qiniu?.trustedCaPath ?? "",
  );
  const [qiniuBackupAcknowledged, setQiniuBackupAcknowledged] = useState(
    editProfile?.provider === "qiniu",
  );
  const [r2AnalyticsToken, setR2AnalyticsToken] = useState("");
  const [migrationRecoveryKey, setMigrationRecoveryKey] = useState("");
  const [clearR2AnalyticsToken, setClearR2AnalyticsToken] = useState(false);
  const [analyticsExpanded, setAnalyticsExpanded] = useState(false);
  const [endpoint, setEndpoint] = useState(
    editProfile?.endpoint ??
      PROVIDER_ENDPOINTS[editProfile?.provider ?? initialProvider] ??
      "",
  );
  const [region, setRegion] = useState(
    editProfile?.region ??
      PROVIDER_REGIONS[editProfile?.provider ?? initialProvider],
  );
  const [defaultBucket, setDefaultBucket] = useState(
    editProfile?.defaultBucket ?? "",
  );
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] =
    useState<ConnectionTestPresentation | null>(null);
  const testGeneration = useRef(0);
  const [bucketRead, setBucketRead] = useState<{
    epoch: number;
    choices: QiniuBucketChoice[] | null;
    error?: string;
  } | null>(null);
  // No serialized credential fingerprint: only compare transient draft values.
  // Rendering a new draft immediately hides old choices before effects run.
  const bucketScope = useRef<{ values: readonly unknown[]; epoch: number }>({
    values: [],
    epoch: 0,
  });
  const bucketScopeValues = [
    open,
    provider,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    clearSessionToken,
    editProfile?.id,
    editProfile?.updatedAt,
    qiniuMode,
    qiniuUcUrl,
    qiniuRegions,
    qiniuBindings,
    qiniuDownloadDomain,
    qiniuSharePortal,
    qiniuShareApiUrl,
    qiniuTrustedCaPath,
  ];
  if (
    bucketScope.current.values.length !== bucketScopeValues.length ||
    bucketScopeValues.some(
      (value, index) => !Object.is(value, bucketScope.current.values[index]),
    )
  ) {
    bucketScope.current = {
      values: bucketScopeValues,
      epoch: bucketScope.current.epoch + 1,
    };
  }
  const visibleBucketRead =
    bucketRead?.epoch === bucketScope.current.epoch ? bucketRead : null;
  useEffect(
    () => () => {
      testGeneration.current++;
      bucketScope.current.epoch++;
    },
    [],
  );
  useEffect(() => {
    if (storageMode === "plaintext") {
      setMigrationRecoveryKey("");
      setQiniuBackupAcknowledged(false);
    }
  }, [storageMode]);

  const hints = PROVIDER_HINTS[provider];

  const needsEndpoint =
    provider === "r2" ||
    provider === "spaces" ||
    provider === "minio" ||
    provider === "backblaze" ||
    provider === "custom";

  const qiniuConfig: QiniuProfileConfig = {
    mode: qiniuMode,
    ...(qiniuBindings.length
      ? {
          bucketBindings: qiniuBindings.map(
            ({ nativeName, s3Name, s3RegionId, s3Endpoint, kodoRegionId }) => ({
              nativeName: nativeName.trim(),
              s3Name: s3Name.trim(),
              s3RegionId: s3RegionId.trim(),
              s3Endpoint: s3Endpoint.trim(),
              ...(kodoRegionId?.trim()
                ? { kodoRegionId: kodoRegionId.trim() }
                : {}),
            }),
          ),
        }
      : {}),
    ...(qiniuMode === "private" && qiniuUcUrl.trim()
      ? { ucUrl: qiniuUcUrl.trim() }
      : {}),
    ...(qiniuMode === "private" && qiniuRegions.length
      ? {
          regions: qiniuRegions.map(({ id, label, s3Endpoint }) => ({
            id: id.trim(),
            ...(label?.trim() ? { label: label.trim() } : {}),
            s3Endpoint: s3Endpoint.trim(),
          })),
        }
      : {}),
    ...(qiniuDownloadDomain.trim()
      ? { downloadDomain: qiniuDownloadDomain.trim() }
      : {}),
    ...qiniuSharingConfiguration(qiniuMode, qiniuSharePortal, qiniuShareApiUrl),
    ...(qiniuMode === "private" && qiniuTrustedCaPath.trim()
      ? { trustedCaPath: qiniuTrustedCaPath.trim() }
      : {}),
  };
  const qiniuValidation = validateQiniuProfileConfig(qiniuConfig);
  const needsQiniuMigration = requiresQiniuMigration({
    provider,
    storageMode,
    vaultVersion,
    editingQiniu: editProfile?.provider === "qiniu",
    hasQiniu: profiles.some((profile) => profile.provider === "qiniu"),
  });
  const needsMigrationRecoveryKey = needsQiniuMigration && hasRecoveryKey;
  const saveBlockers = profileSaveBlockers({
    saving,
    name,
    provider,
    qiniuValidationError: qiniuValidation.error,
    needsQiniuMigration,
    backupAcknowledged: qiniuBackupAcknowledged,
    needsMigrationRecoveryKey,
    recoveryKeyProvided: Boolean(migrationRecoveryKey.trim()),
    isEditing,
    accessKeyProvided: Boolean(accessKeyId),
    secretKeyProvided: Boolean(secretAccessKey),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: each connection input change must invalidate a result even though the new values are not read by the cleanup.
  useEffect(() => {
    // A result must describe the inputs it tested, never newer edits.
    testGeneration.current += 1;
    setTestResult(null);
    setTesting(false);
  }, [
    open,
    provider,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    clearSessionToken,
    editProfile?.updatedAt,
    defaultBucket,
    qiniuMode,
    qiniuUcUrl,
    qiniuRegions,
    qiniuBindings,
    qiniuDownloadDomain,
    qiniuSharePortal,
    qiniuShareApiUrl,
    qiniuTrustedCaPath,
  ]);

  useEffect(() => {
    if (!open) {
      setAccessKeyId("");
      setSecretAccessKey("");
      setR2AnalyticsToken("");
      setClearR2AnalyticsToken(false);
      setAnalyticsExpanded(false);
      setSessionToken("");
      setClearSessionToken(false);
      setMigrationRecoveryKey("");
      setQiniuBackupAcknowledged(editProfile?.provider === "qiniu");
    }
  }, [open, editProfile?.provider]);

  const handleProviderChange = (p: Provider) => {
    if (p === provider || testing || saving) return;
    if (!isEditing && onProviderChange) {
      // Parent remounts the selected form; never send a previous provider's keys.
      onProviderChange(p);
      return;
    }
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
    if (provider === "qiniu" && qiniuValidation.error) {
      setTestResult({ ok: false, tone: "error", msg: qiniuValidation.error });
      return;
    }
    const generation = ++testGeneration.current;
    const bucketEpoch = bucketScope.current.epoch;
    setTesting(true);
    setTestResult(null);
    if (provider === "qiniu") setBucketRead(null);
    try {
      const result = await rpcCall("profile:test", {
        ...(editProfile
          ? {
              profileId: editProfile.id,
              expectedProfileRevision: editProfile.updatedAt,
              clearSessionToken,
            }
          : {}),
        provider,
        endpoint: needsEndpoint ? endpoint : undefined,
        region,
        accessKeyId,
        secretAccessKey,
        ...(provider === "qiniu" && sessionToken.trim()
          ? { sessionToken: sessionToken.trim() }
          : {}),
        defaultBucket: defaultBucket || undefined,
        ...(provider === "qiniu" ? { qiniu: qiniuConfig } : {}),
      });
      if (
        testGeneration.current !== generation ||
        bucketScope.current.epoch !== bucketEpoch
      )
        return;
      setTestResult(connectionTestPresentation(provider, result));
      if (provider === "qiniu") {
        try {
          const choices = currentQiniuBucketChoices(
            result,
            () =>
              testGeneration.current === generation &&
              bucketScope.current.epoch === bucketEpoch,
          );
          setBucketRead({ epoch: bucketEpoch, choices });
        } catch (cause) {
          setBucketRead({
            epoch: bucketEpoch,
            choices: null,
            error:
              cause instanceof Error
                ? cause.message
                : t("空间列表未能读取。", "The bucket list could not be read."),
          });
        }
      }
    } catch (err: unknown) {
      if (testGeneration.current !== generation) return;
      setTestResult({
        ok: false,
        tone: "error",
        msg:
          err instanceof Error ? err.message : t("未知错误", "Unknown error"),
      });
    }
    if (testGeneration.current === generation) setTesting(false);
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

    if (provider === "qiniu" && qiniuValidation.error) {
      toast.error(qiniuValidation.error);
      return;
    }
    if (
      provider === "qiniu" &&
      needsQiniuMigration &&
      !qiniuBackupAcknowledged
    ) {
      toast.error(
        t(
          "请先阅读并确认密码库升级说明。",
          "Read and acknowledge the vault upgrade notice first.",
        ),
      );
      return;
    }
    if (needsMigrationRecoveryKey && !migrationRecoveryKey.trim()) {
      toast.error(
        t(
          "首次升级需要输入现有恢复密钥，用于验证旧恢复快照。",
          "Enter the existing recovery key to verify the old recovery snapshot before this first upgrade.",
        ),
      );
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
      editProfile &&
      editProfile.provider !== provider &&
      (!trimmedAccessKeyId || !trimmedSecretAccessKey)
    ) {
      toast.error(
        t(
          "更换服务商时必须重新填写访问密钥 ID 和密钥；旧凭据不会转发给新服务。",
          "Re-enter both credentials when changing provider; old credentials will not be forwarded.",
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
          ...(provider === "qiniu"
            ? {
                qiniu: qiniuConfig,
                ...(needsMigrationRecoveryKey
                  ? { migrationRecoveryKey: migrationRecoveryKey.trim() }
                  : {}),
                ...(clearSessionToken
                  ? { sessionToken: null }
                  : sessionToken.trim()
                    ? { sessionToken: sessionToken.trim() }
                    : {}),
              }
            : {}),
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
          ...(provider === "qiniu"
            ? {
                qiniu: qiniuConfig,
                ...(needsMigrationRecoveryKey
                  ? { migrationRecoveryKey: migrationRecoveryKey.trim() }
                  : {}),
                ...(sessionToken.trim()
                  ? { sessionToken: sessionToken.trim() }
                  : {}),
              }
            : {}),
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
              "填写存储服务商和凭据，连接对象存储。",
              "Connect object storage by entering its provider and credentials.",
            )}
          </DialogDescription>
        </DialogHeader>

        {!isEditing && onChooseProvider && (
          <div className="space-y-1">
            <Button
              type="button"
              variant="ghost"
              className="-ml-2"
              disabled={testing || saving}
              onClick={onChooseProvider}
            >
              {t("更换服务商", "Change provider")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t(
                "切换服务商会清空未保存的输入。",
                "Changing providers clears unsaved input.",
              )}
            </p>
          </div>
        )}

        <div className="space-y-4">
          {storageMode === "plaintext" && (
            <p
              role="status"
              className="rounded-md border border-warning/30 bg-warning/5 p-2 text-xs leading-relaxed text-warning"
            >
              {t(
                "当前为本地明文模式：AK/SK 将直接保存在本机账号文件中，不需要云仓密码或恢复密钥。能读取该文件的程序也能读取密钥。",
                "Local plaintext mode: AK/SK are saved directly in the local account file without a vault passphrase or recovery key. Programs that can read that file can also read the credentials.",
              )}
            </p>
          )}
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
                disabled={testing || saving}
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

            {provider === "qiniu" && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="pf-qiniu-mode" className="text-xs">
                    {t("七牛部署环境", "Qiniu deployment")}
                  </Label>
                  <Select
                    value={qiniuMode}
                    onValueChange={(value) => {
                      if (value === "public" || value === "private") {
                        setQiniuMode(value);
                        if (value === "public") setQiniuShareApiUrl("");
                      }
                    }}
                  >
                    <SelectTrigger
                      id="pf-qiniu-mode"
                      className="h-8 w-full text-sm"
                    >
                      <SelectValue>
                        {(value) =>
                          value === "private"
                            ? t("私有云", "Private cloud")
                            : t("公有云", "Public cloud")
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="public">
                        {t("公有云", "Public cloud")}
                      </SelectItem>
                      <SelectItem value="private">
                        {t("私有云", "Private cloud")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {hints?.region}
                  </p>
                </div>

                {qiniuMode === "private" && (
                  <div className="space-y-3 rounded-md border border-border/70 p-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="pf-qiniu-uc" className="text-xs">
                        {t(
                          "UC 管理地址（必填）",
                          "UC management URL (required)",
                        )}
                      </Label>
                      <Input
                        id="pf-qiniu-uc"
                        className="h-8 font-mono text-sm"
                        placeholder="https://uc.example.com"
                        value={qiniuUcUrl}
                        onChange={(event) => setQiniuUcUrl(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t(
                        "私有云能力取决于部署版本和账号权限，目前待真实环境验收。网络或权限错误不会被视为连接成功。",
                        "Private-cloud capabilities depend on the deployment version and permissions; real-environment verification is pending. Network and permission errors are not treated as a successful connection.",
                      )}
                    </p>
                    <details className="space-y-2">
                      <summary className="cursor-pointer text-xs font-medium">
                        {t(
                          "手工区域（自动发现不可用时补充）",
                          "Manual regions (fallback for unavailable discovery)",
                        )}
                      </summary>
                      <div className="mt-2 space-y-3">
                        {qiniuRegions.map((item, index) => (
                          <div
                            key={item.uiId}
                            className="space-y-2 rounded-md border border-border/60 p-2"
                          >
                            <div className="grid grid-cols-2 gap-2">
                              <div className="space-y-1">
                                <Label
                                  htmlFor={`pf-qiniu-region-${item.uiId}`}
                                  className="text-xs"
                                >
                                  {t("区域 ID", "Region ID")}
                                </Label>
                                <Input
                                  id={`pf-qiniu-region-${item.uiId}`}
                                  className="h-8 text-xs"
                                  placeholder="cn-east-1"
                                  value={item.id}
                                  onChange={(event) =>
                                    setQiniuRegions((current) =>
                                      current.map((row) =>
                                        row.uiId === item.uiId
                                          ? { ...row, id: event.target.value }
                                          : row,
                                      ),
                                    )
                                  }
                                />
                              </div>
                              <div className="space-y-1">
                                <Label
                                  htmlFor={`pf-qiniu-label-${item.uiId}`}
                                  className="text-xs"
                                >
                                  {t(
                                    "显示名称（可选）",
                                    "Display name (optional)",
                                  )}
                                </Label>
                                <Input
                                  id={`pf-qiniu-label-${item.uiId}`}
                                  className="h-8 text-xs"
                                  value={item.label ?? ""}
                                  onChange={(event) =>
                                    setQiniuRegions((current) =>
                                      current.map((row) =>
                                        row.uiId === item.uiId
                                          ? {
                                              ...row,
                                              label: event.target.value,
                                            }
                                          : row,
                                      ),
                                    )
                                  }
                                />
                              </div>
                            </div>
                            <div className="space-y-1">
                              <Label
                                htmlFor={`pf-qiniu-endpoint-${item.uiId}`}
                                className="text-xs"
                              >
                                {t("S3 地址", "S3 URL")}
                              </Label>
                              <Input
                                id={`pf-qiniu-endpoint-${item.uiId}`}
                                className="h-8 font-mono text-xs"
                                placeholder="https://s3.example.com"
                                value={item.s3Endpoint}
                                onChange={(event) =>
                                  setQiniuRegions((current) =>
                                    current.map((row) =>
                                      row.uiId === item.uiId
                                        ? {
                                            ...row,
                                            s3Endpoint: event.target.value,
                                          }
                                        : row,
                                    ),
                                  )
                                }
                                autoComplete="off"
                                spellCheck={false}
                              />
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              onClick={() =>
                                setQiniuRegions((current) =>
                                  current.filter(
                                    (row) => row.uiId !== item.uiId,
                                  ),
                                )
                              }
                              aria-label={t(
                                `移除第 ${index + 1} 个区域`,
                                `Remove region ${index + 1}`,
                              )}
                            >
                              {t("移除此区域", "Remove region")}
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={qiniuRegions.length >= 32}
                          onClick={() =>
                            setQiniuRegions((current) => [
                              ...current,
                              {
                                uiId: crypto.randomUUID(),
                                id: "",
                                s3Endpoint: "",
                              },
                            ])
                          }
                        >
                          {t("添加区域", "Add region")}
                        </Button>
                      </div>
                    </details>
                    <div className="space-y-1.5">
                      <Label htmlFor="pf-qiniu-ca" className="text-xs">
                        {t(
                          "可信 CA 证书文件路径（可选）",
                          "Trusted CA certificate path (optional)",
                        )}
                      </Label>
                      <Input
                        id="pf-qiniu-ca"
                        className="h-8 font-mono text-xs"
                        value={qiniuTrustedCaPath}
                        onChange={(event) =>
                          setQiniuTrustedCaPath(event.target.value)
                        }
                        placeholder={t(
                          "本机 PEM 证书路径",
                          "Local PEM certificate path",
                        )}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t(
                          "留空沿用程序默认 TLS 信任根；填写 PEM 路径仅为此账号附加信任指定 CA，不关闭 TLS 证书验证。分享服务与 S3 使用同一 CA 配置。",
                          "Leave blank to use the application's default TLS trust roots. A PEM path adds CA trust only for this account; certificate verification stays enabled. Sharing and S3 use the same CA configuration.",
                        )}
                      </p>
                    </div>
                  </div>
                )}

                <QiniuBucketBindings
                  rows={qiniuBindings}
                  onChange={setQiniuBindings}
                />
                <details className="rounded-md border border-border/70 p-3">
                  <summary className="cursor-pointer text-xs font-medium">
                    {t(
                      "下载地址与目录分享配置（可选）",
                      "Download URL and directory sharing (optional)",
                    )}
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="pf-qiniu-download" className="text-xs">
                        {t(
                          "已配置的自定义下载域名",
                          "Configured custom download domain",
                        )}
                      </Label>
                      <Input
                        id="pf-qiniu-download"
                        className="h-8 font-mono text-xs"
                        placeholder="https://files.example.com"
                        value={qiniuDownloadDomain}
                        onChange={(event) =>
                          setQiniuDownloadDomain(event.target.value)
                        }
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t(
                          "填写空间已绑定的域名，不是 S3 API 地址。默认域名可能限制预览和部分文件下载；这里不会自动绑定或创建域名。",
                          "Use a domain already bound to the bucket, not an S3 API endpoint. Default domains may restrict previews and some downloads; no domain is created or bound here.",
                        )}
                      </p>
                    </div>
                    <QiniuProfileSharingFields
                      mode={qiniuMode}
                      portal={qiniuSharePortal}
                      apiUrl={qiniuShareApiUrl}
                      onPortalChange={setQiniuSharePortal}
                      onApiUrlChange={setQiniuShareApiUrl}
                    />
                  </div>
                </details>
                {qiniuValidation.error && (
                  <p
                    role="status"
                    className="text-xs leading-relaxed text-destructive"
                  >
                    {qiniuValidation.error}
                  </p>
                )}
                {qiniuValidation.insecure && (
                  <p
                    role="status"
                    className="rounded-md border border-warning/25 bg-warning/5 p-2 text-xs leading-relaxed text-warning"
                  >
                    {t(
                      "你配置了 HTTP 地址：连接未加密，凭据和文件可能通过明文网络传输。建议为服务配置 HTTPS；程序不会自动降级到 HTTP。",
                      "You configured an HTTP URL: the connection is unencrypted and credentials or files may travel over plaintext. Configure HTTPS where possible; the app does not automatically downgrade to HTTP.",
                    )}
                  </p>
                )}
              </div>
            )}

            {/* Region + Default Bucket */}
            <div
              className={`grid gap-3 ${provider === "qiniu" ? "grid-cols-1" : "grid-cols-2"}`}
            >
              {provider !== "qiniu" && (
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
              )}

              <div className="space-y-1.5">
                <Label htmlFor="pf-default-bucket" className="text-xs">
                  {t("默认存储桶", "Default bucket")}{" "}
                  <span className="font-normal opacity-40">
                    {t("可选", "optional")}
                  </span>
                </Label>
                {provider === "qiniu" && (
                  <QiniuBucketPicker
                    choices={visibleBucketRead?.choices ?? null}
                    value={defaultBucket}
                    busy={testing}
                    disabled={
                      Boolean(qiniuValidation.error) ||
                      (isEditing && editProfile?.provider === provider
                        ? Boolean(accessKeyId.trim()) !==
                          Boolean(secretAccessKey.trim())
                        : !accessKeyId.trim() || !secretAccessKey.trim())
                    }
                    onRead={() => void testConnection()}
                    onSelect={setDefaultBucket}
                  />
                )}
                {provider === "qiniu" && visibleBucketRead?.error && (
                  <p role="alert" className="text-xs text-destructive">
                    {localize(visibleBucketRead.error)}
                  </p>
                )}
                <Input
                  id="pf-default-bucket"
                  className="h-8 text-sm"
                  placeholder="my-bucket"
                  value={defaultBucket}
                  onChange={(e) => setDefaultBucket(e.target.value)}
                />
                <p className="text-xs text-muted-foreground/50">
                  {provider === "qiniu"
                    ? t(
                        "可点击“读取空间”后选择，无需先保存账号；也可手动填写原始空间名。读取列表不代表已验证对象权限，选定后可重新测试。受限凭据请配置明确的空间绑定。",
                        "Read and choose a bucket without saving the account first, or enter its native name manually. Listing buckets does not verify object permissions; test again after selecting. Scoped credentials require explicit bucket bindings.",
                      )
                    : provider === "r2"
                      ? t(
                          "可留空，保存账号后再选择空间；填写后可在测试连接时验证该空间的列表读取权限。受限凭据请填写空间原始名称。下载域名可另行配置，不影响账号保存或空间列表。",
                          "Optional: save the account, then choose a bucket. Filling this field lets Test connection verify its object-list permission. For scoped credentials, enter the native bucket name. A download domain can be configured separately and does not block saving or bucket listing.",
                        )
                      : t("默认选择的存储桶", "Bucket to select by default")}
                </p>
              </div>
            </div>

            {provider === "qiniu" && (
              <details className="rounded-md border border-border/60 p-3">
                <summary className="cursor-pointer text-xs font-medium">
                  {t(
                    "临时会话凭据（连接未完整支持）",
                    "Temporary credentials (connection support incomplete)",
                  )}
                </summary>
                <div className="mt-3 space-y-2">
                  <Label htmlFor="pf-qiniu-session-token" className="text-xs">
                    {t("会话令牌（Session Token）", "Session Token")}
                  </Label>
                  <Input
                    id="pf-qiniu-session-token"
                    type="password"
                    className="h-8 font-mono text-xs"
                    value={sessionToken}
                    onChange={(event) => {
                      setSessionToken(event.target.value);
                      if (event.target.value.trim())
                        setClearSessionToken(false);
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="pf-qiniu-session-availability"
                    placeholder={
                      isEditing
                        ? t(
                            "留空保留已保存的令牌",
                            "Leave blank to keep the saved token",
                          )
                        : t(
                            "预留临时凭据字段",
                            "Reserved temporary-credential field",
                          )
                    }
                  />
                  <QiniuProfileCapabilityNotice
                    kind="session-token"
                    id="pf-qiniu-session-availability"
                  />
                  {isEditing && (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t(
                        "更新临时 AK/SK 时，请同时更新会话令牌，或明确移除旧令牌。",
                        "When updating temporary AK/SK, update the session token too, or explicitly remove the old token.",
                      )}
                    </p>
                  )}
                  {isEditing && (
                    <div className="flex items-start gap-2">
                      <Checkbox
                        id="pf-clear-qiniu-session-token"
                        checked={clearSessionToken}
                        onCheckedChange={(checked) => {
                          setClearSessionToken(checked === true);
                          if (checked === true) setSessionToken("");
                        }}
                      />
                      <Label
                        htmlFor="pf-clear-qiniu-session-token"
                        className="cursor-pointer text-xs leading-relaxed font-normal"
                      >
                        {t(
                          "保存时明确移除已保存的会话令牌",
                          "Explicitly remove the saved session token on save",
                        )}
                      </Label>
                    </div>
                  )}
                </div>
              </details>
            )}
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
                      storageMode === "plaintext"
                        ? "与账号凭据一同明文保存在本机账号文件中。"
                        : "与账号凭据一同加密保存在本机密码库中。",
                      storageMode === "plaintext"
                        ? "Saved in plaintext with the account credentials in the local account file."
                        : "Encrypted with the account credentials in your local vault.",
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

          {needsQiniuMigration && (
            <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
              <p className="text-xs leading-relaxed text-foreground">
                {t(
                  "首次保存七牛账号会升级密码库并先建立加密备份。旧版程序不能保证读取新格式；降级时需恢复升级前的备份。",
                  "Saving the first Qiniu account upgrades the vault after creating an encrypted backup. Older versions may not read the new format; downgrading requires restoring the pre-upgrade backup.",
                )}
              </p>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="pf-qiniu-backup-ack"
                  checked={qiniuBackupAcknowledged}
                  onCheckedChange={(checked) =>
                    setQiniuBackupAcknowledged(checked === true)
                  }
                />
                <Label
                  htmlFor="pf-qiniu-backup-ack"
                  className="cursor-pointer text-xs leading-relaxed font-normal"
                >
                  {t(
                    "我已了解密码库升级和回退方式",
                    "I understand the vault upgrade and downgrade requirements",
                  )}
                </Label>
              </div>
              {needsMigrationRecoveryKey && (
                <div className="space-y-1.5 pt-1">
                  <Label
                    htmlFor="pf-qiniu-migration-recovery"
                    className="text-xs"
                  >
                    {t(
                      "云仓密码库现有恢复密钥（不是七牛 SecretKey）",
                      "Existing Yuncang vault recovery key (not the Qiniu SecretKey)",
                    )}
                  </Label>
                  <Input
                    id="pf-qiniu-migration-recovery"
                    type="password"
                    className="h-8 font-mono text-xs"
                    value={migrationRecoveryKey}
                    onChange={(event) =>
                      setMigrationRecoveryKey(event.target.value)
                    }
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={1024}
                  />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t(
                      "填写云仓密码库当前有效的恢复密钥，不是七牛 SecretKey；仅在本机验证，不要发到聊天中。若遗失且仍知道云仓解锁密码，请关闭此表单，进入“设置 → 密码库 → 重新生成恢复密钥”，验证当前密码并保存新密钥后再添加账号。不要重置或删除密码库。",
                      "Enter the currently valid Yuncang vault recovery key, not the Qiniu SecretKey. It is verified locally; do not send it in chat. If it is lost and you still know the unlock passphrase, close this form and open Settings → Vault → Regenerate recovery key. Verify the current passphrase and save the new key before adding the account. Do not reset or delete the vault.",
                    )}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <ProfileConnectionFeedback
              result={testResult}
              provider={provider}
            />
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-col">
          {saveBlockers.length > 0 && (
            <div
              id="pf-save-blockers"
              role="status"
              className="w-full space-y-1 rounded-md border border-warning/25 bg-warning/5 px-2 py-1.5 text-xs leading-relaxed text-warning"
            >
              <p className="font-medium">
                {t("暂不能保存：", "Save requirements:")}
              </p>
              <ul className="list-disc space-y-0.5 pl-4">
                {saveBlockers.map((reason) => (
                  <li key={reason}>{localize(reason)}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex w-full justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={testConnection}
              disabled={
                testing ||
                (isEditing && editProfile?.provider === provider
                  ? Boolean(accessKeyId.trim()) !==
                    Boolean(secretAccessKey.trim())
                  : !accessKeyId.trim() || !secretAccessKey.trim())
              }
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
              aria-describedby={
                saveBlockers.length > 0 ? "pf-save-blockers" : undefined
              }
              disabled={
                saving ||
                !name.trim() ||
                (provider === "qiniu" &&
                  (Boolean(qiniuValidation.error) ||
                    (needsQiniuMigration && !qiniuBackupAcknowledged) ||
                    (needsMigrationRecoveryKey &&
                      !migrationRecoveryKey.trim()))) ||
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
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
