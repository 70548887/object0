import type { ProfileInfo } from "@shared/profile.types";
import { PROVIDER_LABELS } from "@shared/profile.types";
import { t } from "@/lib/i18n";
import { rpcCall } from "@/lib/rpc-client";
import { toast } from "../common/Toast";

export type CredentialField = "accessKeyId" | "secretAccessKey";

export async function readCredential(
  profileId: string,
  field: CredentialField,
): Promise<string> {
  // Keep the native-only token boundary even when a JavaScript caller bypasses
  // the TypeScript union. Session tokens must never be requested for display.
  if (field !== "accessKeyId" && field !== "secretAccessKey")
    throw new Error(
      t(
        "会话令牌不能读取、显示或复制。",
        "Session tokens cannot be read, displayed or copied.",
      ),
    );
  const result = await rpcCall("profile:credential", { profileId, field });
  return result.value;
}

export async function copyValue(value: string, label: string): Promise<void> {
  if (!value) {
    toast.info(t(`${label}未设置`, `${label} is not set`));
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast.success(t(`${label}已复制`, `${label} copied`));
  } catch {
    toast.error(
      t(
        "复制失败，请选择内容后使用系统复制功能",
        "Copy failed. Select the text and use the system copy command.",
      ),
    );
  }
}

export async function copyCredential(
  profile: ProfileInfo,
  field: CredentialField,
  label: string,
): Promise<void> {
  try {
    await copyValue(await readCredential(profile.id, field), label);
  } catch {
    toast.error(
      t(
        "读取凭据失败，请先解锁密码库",
        "Could not read credentials. Unlock the vault first.",
      ),
    );
  }
}

export function profileConnectionDetails(
  profile: ProfileInfo,
): { label: string; value: string }[] {
  if (profile.provider !== "qiniu")
    return [
      { label: t("接口地址", "Endpoint"), value: profile.endpoint ?? "" },
      { label: t("区域", "Region"), value: profile.region ?? "" },
    ];
  const config = profile.qiniu;
  const isPrivate = config?.mode === "private";
  return [
    {
      label: t("七牛部署环境", "Qiniu deployment"),
      value: isPrivate
        ? t("私有云", "Private cloud")
        : t("公有云", "Public cloud"),
    },
    {
      label: t("UC 管理地址", "UC management URL"),
      value: isPrivate ? (config?.ucUrl ?? "") : "https://uc.qbox.me",
    },
    {
      label: t("区域解析", "Region resolution"),
      value: config?.regions?.length
        ? t("按空间匹配手工区域", "Manual regions matched per bucket")
        : t("按空间自动发现", "Discovered per bucket"),
    },
    ...(config?.regions ?? []).map((region) => ({
      label: `${t("S3 区域", "S3 region")} ${region.id}${region.label ? ` (${region.label})` : ""}`,
      value: region.s3Endpoint,
    })),
    ...(config?.bucketBindings ?? []).map((binding) => ({
      label: `${t("限定空间", "Scoped bucket")} ${binding.nativeName}`,
      value: `${binding.s3Name} · ${binding.s3RegionId} · ${binding.s3Endpoint}`,
    })),
    {
      label: t("下载域名", "Download domain"),
      value: config?.downloadDomain ?? "",
    },
    {
      label: t("目录分享门户", "Directory-share portal"),
      value: config?.sharePortal ?? "",
    },
    {
      label: t("目录分享 API", "Directory-share API"),
      value: config?.shareApiUrl ?? "",
    },
    ...(config?.trustedCaPath
      ? [
          {
            label: t("私有云可信 CA 文件", "Private-cloud trusted CA file"),
            value: config.trustedCaPath,
          },
        ]
      : []),
  ];
}

export function profileInformation(profile: ProfileInfo): string {
  return [
    `${t("账号名称：", "Account name: ")}${profile.name}`,
    `${t("存储服务商：", "Provider: ")}${PROVIDER_LABELS[profile.provider]}`,
    ...profileConnectionDetails(profile).map(
      ({ label, value }) => `${label}: ${value}`,
    ),
    `${t("默认存储桶：", "Default bucket: ")}${profile.defaultBucket ?? ""}`,
  ].join("\n");
}

export async function copyAllProfileInformation(
  profile: ProfileInfo,
): Promise<void> {
  try {
    const [accessKeyId, secretAccessKey] = await Promise.all([
      readCredential(profile.id, "accessKeyId"),
      readCredential(profile.id, "secretAccessKey"),
    ]);
    const lines = [
      profileInformation(profile),
      `${t("访问密钥 ID：", "Access key ID: ")}${accessKeyId}`,
      `${t("访问密钥：", "Secret access key: ")}${secretAccessKey}`,
    ];
    await copyValue(
      lines.join("\n"),
      t("账号连接信息（含 AK/SK）", "Account connection details (AK/SK)"),
    );
  } catch {
    toast.error(
      t(
        "读取凭据失败，请先解锁密码库",
        "Could not read credentials. Unlock the vault first.",
      ),
    );
  }
}
