import type { ProfileInfo } from "@shared/profile.types";
import { PROVIDER_LABELS } from "@shared/profile.types";
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
    toast.info(`${label}未设置`);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label}已复制`);
  } catch {
    toast.error("复制失败，请选择内容后使用系统复制功能");
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
    toast.error("读取凭据失败，请先解锁密码库");
  }
}

export function profileInformation(profile: ProfileInfo): string {
  return [
    `账号名称：${profile.name}`,
    `存储服务商：${PROVIDER_LABELS[profile.provider]}`,
    `接口地址：${profile.endpoint ?? ""}`,
    `区域：${profile.region ?? ""}`,
    `默认存储桶：${profile.defaultBucket ?? ""}`,
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
      `访问密钥 ID：${accessKeyId}`,
      `访问密钥：${secretAccessKey}`,
    ];
    if (sessionToken) lines.push(`会话令牌：${sessionToken}`);
    await copyValue(lines.join("\n"), "账号全部信息（含密钥）");
  } catch {
    toast.error("读取凭据失败，请先解锁密码库");
  }
}
