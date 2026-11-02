import type { ProfileInfo } from "@shared/profile.types";
import type { QiniuDownloadOptions } from "@shared/qiniu.types";
import type { ShareRes } from "@shared/s3.types";
import { localize, t } from "@/lib/i18n";

export const NATIVE_APPLICATION_SHARE_MAX_SECONDS = 30 * 86400;

export function sharingProtocol(
  profile: ProfileInfo | undefined,
): "native" | "s3" | "unknown" {
  if (!profile) return "unknown";
  if (profile.provider !== "qiniu") return "s3";
  if (
    profile.qiniu?.mode === "private" ||
    profile.hasSessionToken === true ||
    (profile.qiniu?.bucketBindings?.length ?? 0) > 0
  )
    return "s3";
  return profile.qiniu?.mode === "public" && profile.hasSessionToken === false
    ? "native"
    : "unknown";
}

function validDownloadOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.port &&
      (value === url.origin || value === `${url.origin}/`)
    );
  } catch {
    return false;
  }
}

/** Values are usability hints, not authority. Rust rechecks the profile, bucket
 * and domain for every signing/download operation. */
export function validatedDownloadOptions(
  value: QiniuDownloadOptions,
): QiniuDownloadOptions {
  if (
    !value ||
    !Array.isArray(value.domains) ||
    value.domains.length > 200 ||
    !Number.isSafeInteger(value.maxShareSeconds) ||
    value.maxShareSeconds < 60 ||
    value.maxShareSeconds > NATIVE_APPLICATION_SHARE_MAX_SECONDS ||
    typeof value.policyNote !== "string" ||
    value.policyNote.length > 4096
  )
    throw new Error(
      t(
        "下载选项响应无效，请重新读取",
        "Invalid download options; reload them",
      ),
    );
  const seen = new Set<string>();
  const domains = value.domains.map((domain) => {
    if (
      !domain ||
      typeof domain.url !== "string" ||
      domain.url.length > 2048 ||
      typeof domain.kind !== "string" ||
      domain.kind.length > 64 ||
      typeof domain.available !== "boolean" ||
      (domain.accessMode !== undefined &&
        domain.accessMode !== "public" &&
        domain.accessMode !== "signed") ||
      (domain.reason !== undefined &&
        (typeof domain.reason !== "string" || domain.reason.length > 4096)) ||
      seen.has(domain.url)
    )
      throw new Error(
        t(
          "下载域名响应无效，请重新读取",
          "Invalid download-domain response; reload it",
        ),
      );
    seen.add(domain.url);
    return {
      ...domain,
      available: domain.available && validDownloadOrigin(domain.url),
    };
  });
  // Only the account's explicit configured selection can be the default. A
  // first discovered domain, even if available, is never selected implicitly.
  const selectedDomain =
    typeof value.selectedDomain === "string" &&
    value.selectedDomain.startsWith("https://") &&
    domains.some(
      (domain) => domain.available && domain.url === value.selectedDomain,
    )
      ? value.selectedDomain
      : undefined;
  return { ...value, domains, selectedDomain };
}

/** UI default only: use the returned list order after origin validation.
 * Selection never generates a link, sends a download or changes the account. */
export function defaultDownloadDomain(
  options: QiniuDownloadOptions | null,
): string {
  return options?.domains.find((domain) => domain.available)?.url ?? "";
}

/** New public results must be explicit; a missing expiry never implies public access. */
export function validatedShareResult(
  value: ShareRes,
  expected: { key?: string; domain?: string; nowMs?: number } = {},
): ShareRes {
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error(t("分享结果格式无效", "Invalid sharing result"));
  }
  if (
    !value ||
    typeof value.key !== "string" ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    (expected.key !== undefined && value.key !== expected.key) ||
    (expected.domain !== undefined &&
      url.origin !== new URL(expected.domain).origin) ||
    (value.accessMode !== undefined &&
      value.accessMode !== "public" &&
      value.accessMode !== "signed") ||
    (value.accessMode === "public"
      ? value.expiresAt !== null ||
        url.searchParams.has("e") ||
        url.searchParams.has("token")
      : typeof value.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(value.expiresAt)) ||
        Date.parse(value.expiresAt) <= (expected.nowMs ?? Date.now()))
  )
    throw new Error(t("分享结果格式无效", "Invalid sharing result"));
  return value;
}

export function isSelectedDomainAvailable(
  options: QiniuDownloadOptions | null,
  domain: string,
): boolean {
  return Boolean(
    domain &&
      options?.domains.some((item) => item.available && item.url === domain),
  );
}

/** Only backend-owned hint fields use this bilingual format; URLs and object
 * names never enter this function and are never split or translated. */
export function localizeDownloadHint(message: string): string {
  const parts = message.split(" / ");
  return parts.length === 2 &&
    /[\u3400-\u9fff]/.test(parts[0]) &&
    /^[A-Z]/.test(parts[1])
    ? t(parts[0], parts[1])
    : localize(message);
}

/** A native Windows download target must be one ordinary basename, never a
 * remote path, drive prefix, device name, or platform-normalized sibling. */
export function safeDownloadFileName(key: string): string | null {
  if (!key || key.endsWith("/")) return null;
  const name = key.split("/").pop() ?? "";
  if (
    !name ||
    name.length > 255 ||
    name === "." ||
    name === ".." ||
    /[\\/:<>"|?*]/.test(name) ||
    /[.\s]$/.test(name) ||
    [...name].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    return null;
  return name;
}

/** Production requests use this scope guard to invalidate both same-id account
 * revisions and domain changes before a late promise may update UI/clipboard. */
export class ShareRequestGuard {
  private scope = "";
  private active: symbol | null = null;
  bind(scope: string) {
    if (scope !== this.scope) {
      this.scope = scope;
      this.active = null;
    }
  }
  begin(): symbol {
    const token = Symbol("share-request");
    this.active = token;
    return token;
  }
  isCurrent(token: symbol): boolean {
    return this.active === token;
  }
  invalidate() {
    this.active = null;
  }
  finish(token: symbol) {
    if (this.active === token) this.active = null;
  }
  get pending(): boolean {
    return this.active !== null;
  }
}
