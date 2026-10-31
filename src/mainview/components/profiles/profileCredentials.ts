import type { ProfileInfo } from "@shared/profile.types";
import { PROVIDER_LABELS } from "@shared/profile.types";
import { t } from "@/lib/i18n";
import { rpcCall } from "@/lib/rpc-client";
import { toast } from "../common/Toast";

export type CredentialField =
  | "accessKeyId"
  | "secretAccessKey"
  | "sessionToken";

export async function readCredential(
  profileId: string,
  field: CredentialField,
): Promise<string> {
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

export function profileInformation(profile: ProfileInfo): string {
  return [
    `${t("账号名称：", "Account name: ")}${profile.name}`,
    `${t("存储服务商：", "Provider: ")}${PROVIDER_LABELS[profile.provider]}`,
    `${t("接口地址：", "Endpoint: ")}${profile.endpoint ?? ""}`,
    `${t("区域：", "Region: ")}${profile.region ?? ""}`,
    `${t("默认存储桶：", "Default bucket: ")}${profile.defaultBucket ?? ""}`,
  ].join("\n");
}

export async function copyAllProfileInformation(
  profile: ProfileInfo,
): Promise<void> {
  try {
    const [accessKeyId, secretAccessKey, sessionToken] = await Promise.all([
      readCredential(profile.id, "accessKeyId"),
      readCredential(profile.id, "secretAccessKey"),
      readCredential(profile.id, "sessionToken"),
    ]);
    const lines = [
      profileInformation(profile),
      `${t("访问密钥 ID：", "Access key ID: ")}${accessKeyId}`,
      `${t("访问密钥：", "Secret access key: ")}${secretAccessKey}`,
    ];
    if (sessionToken)
      lines.push(`${t("会话令牌：", "Session token: ")}${sessionToken}`);
    await copyValue(
      lines.join("\n"),
      t("账号全部信息（含密钥）", "All account details (including secrets)"),
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
