import type { ProfileInfo } from "@shared/profile.types";
import type {
  QiniuShareLoginInput,
  QiniuSharePrivateEnvironment,
  QiniuShareSessionInfo,
  QiniuShareSessionSource,
} from "@shared/qiniu.types";
import { t } from "@/lib/i18n";
import type { QiniuShareCreateTarget } from "@/stores/useQiniuShareStore";
import { validateQiniuProfileConfig } from "../profiles/providerHints";
import { normalizeQiniuSharePrefix } from "./QiniuDirectoryShare";

/** This enables an action, not a claim that the account has remote permission. */
export function canCreateQiniuDirectoryShare(
  profile: ProfileInfo | null | undefined,
) {
  return (
    profile?.provider === "qiniu" &&
    profile.qiniu?.mode === "public" &&
    profile.hasSessionToken === false &&
    !profile.qiniu.bucketBindings?.length
  );
}

export function isCurrentQiniuShareTarget(
  target: QiniuShareCreateTarget,
  profile: ProfileInfo | null | undefined,
  bucket: string | null,
  prefix: string,
) {
  return (
    canCreateQiniuDirectoryShare(profile) &&
    profile?.id === target.profileId &&
    profile.updatedAt === target.profileRevision &&
    bucket === target.bucketName &&
    prefix === target.prefix &&
    normalizeQiniuSharePrefix(prefix) === prefix
  );
}

/** Origin validation never repairs an invalid configured address or reads a link. */
function configuredOrigin(value: string | undefined): string | undefined {
  if (
    !value ||
    value.includes("\\") ||
    !/^https?:\/\/[^/?#\s\\]+\/?$/i.test(value.trim()) ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return;
  try {
    const url = new URL(value.trim());
    if (
      !["https:", "http:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return;
    return url.origin;
  } catch {
    return;
  }
}

export function qiniuShareProfileSetFingerprint(
  profiles: readonly ProfileInfo[],
): string {
  return JSON.stringify(
    [...profiles]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((profile) => [
        profile.id,
        profile.provider,
        profile.updatedAt,
        profile.qiniu ?? null,
      ]),
  );
}

export function qiniuPrivateShareEnvironment(
  profile: ProfileInfo,
): QiniuSharePrivateEnvironment | null {
  if (profile.provider !== "qiniu" || profile.qiniu?.mode !== "private")
    return null;
  const config = profile.qiniu;
  const portalOrigin = configuredOrigin(config.sharePortal);
  const apiOrigin = configuredOrigin(config.shareApiUrl);
  const configured = Boolean(
    portalOrigin && apiOrigin && config.regions?.length && profile.updatedAt,
  );
  const validation = validateQiniuProfileConfig(config);
  const reason =
    !portalOrigin || !apiOrigin
      ? t(
          "请在账号高级设置中填写有效的分享门户和分享 API。",
          "Configure a valid share portal and share API in the account advanced settings.",
        )
      : !config.regions?.length
        ? t(
            "请为私有分享配置手工区域 ID 和 S3 地址。",
            "Configure a manual region ID and S3 endpoint for private sharing.",
          )
        : (validation.error ??
          (!profile.updatedAt
            ? t(
                "保存的环境版本无效，请重新保存账号。",
                "The saved environment revision is invalid; save the account again.",
              )
            : undefined));
  const origins = [
    portalOrigin,
    apiOrigin,
    ...(config.regions ?? []).map((region) =>
      configuredOrigin(region.s3Endpoint),
    ),
  ];
  return {
    id: profile.id,
    label: profile.name,
    revision: profile.updatedAt,
    configFingerprint: JSON.stringify(config),
    ...(portalOrigin ? { portalOrigin } : {}),
    ...(apiOrigin ? { apiOrigin } : {}),
    insecure:
      validation.insecure ||
      origins.some((origin) => origin?.startsWith("http:")),
    disabled: !configured || Boolean(validation.error),
    ...(reason ? { reason } : {}),
  };
}

export function qiniuShareSessionSource(
  input: QiniuShareLoginInput,
  profiles: readonly ProfileInfo[],
): QiniuShareSessionSource {
  const profileSetFingerprint = qiniuShareProfileSetFingerprint(profiles);
  if (input.privateEnvironmentId === undefined) {
    if (input.expectedPrivateEnvironmentRevision !== undefined)
      throw new Error(
        t(
          "公有云登录不能携带私有环境版本。",
          "Public login must not include a private environment revision.",
        ),
      );
    return { profileSetFingerprint };
  }
  const environment = profiles
    .map(qiniuPrivateShareEnvironment)
    .find((value) => value?.id === input.privateEnvironmentId);
  if (
    !environment ||
    environment.disabled ||
    !environment.revision ||
    environment.revision !== input.expectedPrivateEnvironmentRevision
  )
    throw new Error(
      t(
        "私有分享环境已变更、移除或配置不完整，请重新选择。",
        "The private share environment changed, was removed or is incomplete. Select it again.",
      ),
    );
  let matchesPortal = false;
  try {
    const link = new URL(input.url);
    matchesPortal =
      !link.username &&
      !link.password &&
      !link.hash &&
      link.pathname.replace(/\/$/, "") === "/kodo-shares/verify" &&
      link.origin === environment.portalOrigin;
  } catch {
    /* Return a fixed diagnostic, never an invalid URL containing a token. */
  }
  if (!matchesPortal)
    throw new Error(
      t(
        "分享链接不属于所选环境的已保存门户，未发送提取码。",
        "The share link does not belong to the selected saved portal. The extraction code was not sent.",
      ),
    );
  return {
    profileSetFingerprint,
    privateEnvironmentId: environment.id,
    privateEnvironmentRevision: environment.revision,
    privateEnvironmentFingerprint: environment.configFingerprint,
  };
}

export function isCurrentQiniuShareSessionSource(
  source: QiniuShareSessionSource,
  profiles: readonly ProfileInfo[],
): boolean {
  if (
    source.profileSetFingerprint !== qiniuShareProfileSetFingerprint(profiles)
  )
    return false;
  if (!source.privateEnvironmentId) return true;
  const environment = profiles
    .map(qiniuPrivateShareEnvironment)
    .find((value) => value?.id === source.privateEnvironmentId);
  return Boolean(
    environment &&
      !environment.disabled &&
      environment.revision === source.privateEnvironmentRevision &&
      environment.configFingerprint === source.privateEnvironmentFingerprint,
  );
}

export async function verifyConfiguredQiniuShareSession(
  input: QiniuShareLoginInput,
  snapshot: () => { unlocked: boolean; profiles: readonly ProfileInfo[] },
  verify: (input: QiniuShareLoginInput) => Promise<QiniuShareSessionInfo>,
  discard: (id: string) => void,
): Promise<{
  session: QiniuShareSessionInfo;
  source: QiniuShareSessionSource;
}> {
  const before = snapshot();
  if (!before.unlocked)
    throw new Error(
      t("密码库已锁定，请重新解锁。", "The vault is locked. Unlock it again."),
    );
  const source = qiniuShareSessionSource(input, before.profiles);
  const session = await verify(input);
  const after = snapshot();
  if (
    !after.unlocked ||
    !isCurrentQiniuShareSessionSource(source, after.profiles)
  ) {
    if (typeof session?.sessionId === "string" && session.sessionId)
      discard(session.sessionId);
    throw new Error(
      t(
        "分享环境已变化或密码库已锁定，已丢弃验证结果。",
        "The share environment changed or the vault was locked. The verification result was discarded.",
      ),
    );
  }
  return { session, source };
}
