import { useId } from "react";
import { intlLocale, localize, useT } from "@/lib/i18n";
import { QiniuCapabilityNote } from "./QiniuCapabilityNote";
import { isQiniuCapabilityAllowed, type QiniuCapability } from "./types";

export interface QiniuDomainOption {
  id: string;
  url: string;
  kind: "origin" | "cdn" | "custom";
  available: boolean;
  reason?: string;
  expiresAt?: string;
}

export interface QiniuBucketDomainsProps {
  domains: readonly QiniuDomainOption[];
  capability: QiniuCapability;
  selectedDomainId?: string;
  loading?: boolean;
  disabled?: boolean;
  onSelect: (domainId: string | undefined) => void;
}

export function validateQiniuDomainUrl(value: string): {
  valid: boolean;
  insecure: boolean;
} {
  try {
    const url = new URL(value);
    return {
      valid:
        ["https:", "http:"].includes(url.protocol) &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      insecure: url.protocol === "http:",
    };
  } catch {
    return { valid: false, insecure: false };
  }
}

export function QiniuBucketDomains({
  domains,
  capability,
  selectedDomainId,
  loading = false,
  disabled = false,
  onSelect,
}: QiniuBucketDomainsProps) {
  const t = useT();
  const id = useId();
  const allowed = isQiniuCapabilityAllowed(capability) && !disabled && !loading;
  return (
    <fieldset
      disabled={!allowed}
      aria-describedby={`${id}-hint ${id}-capability`}
      className="min-w-0 space-y-2"
    >
      <legend className="mb-2 text-xs font-semibold">
        {t("下载域名", "Download domain")}
      </legend>
      <p
        id={`${id}-hint`}
        className="text-xs leading-relaxed text-muted-foreground"
      >
        {t(
          "只选择已绑定或已由你配置的域名，不创建、绑定或修改任何云端域名配置。",
          "Choose an already-bound or user-configured domain. No cloud domain is created, bound or changed.",
        )}
      </p>
      <QiniuCapabilityNote id={`${id}-capability`} capability={capability} />
      {loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("正在读取已绑定域名…", "Loading bound domains…")}
        </p>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border/70 px-3">
          <label className="flex cursor-pointer items-start gap-2 py-2.5 text-xs has-disabled:cursor-not-allowed has-disabled:opacity-60">
            <input
              type="radio"
              name={`${id}-domain`}
              value=""
              checked={!selectedDomainId}
              onChange={() => onSelect(undefined)}
              className="mt-0.5 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
            <span className="min-w-0 space-y-1">
              <span className="block font-medium">
                {t("自动选择可用地址", "Automatically select an available URL")}
              </span>
              <span className="block leading-relaxed text-muted-foreground">
                {t(
                  "实际下载协议和限制由后端确认。",
                  "The backend determines the available protocol and restrictions.",
                )}
              </span>
            </span>
          </label>
          {domains.map((domain, index) => {
            const url = validateQiniuDomainUrl(domain.url);
            const invalidExpiry =
              Boolean(domain.expiresAt) &&
              !Number.isFinite(Date.parse(domain.expiresAt ?? ""));
            const expired = domain.expiresAt
              ? Date.parse(domain.expiresAt) <= Date.now()
              : false;
            const selectable =
              domain.available && url.valid && !expired && !invalidExpiry;
            const reason = domain.reason
              ? localize(domain.reason)
              : !url.valid
                ? t("域名地址格式无效。", "The domain URL is invalid.")
                : invalidExpiry
                  ? t(
                      "无法确认域名有效期，请先刷新域名信息。",
                      "The domain expiry could not be verified. Refresh domain information first.",
                    )
                  : expired
                    ? t("此域名已过期。", "This domain has expired.")
                    : !domain.available
                      ? t(
                          "此域名目前不可用。",
                          "This domain is currently unavailable.",
                        )
                      : null;
            const expiry = domain.expiresAt ? new Date(domain.expiresAt) : null;
            return (
              <label
                key={domain.id}
                className="flex cursor-pointer items-start gap-2 py-2.5 text-xs has-disabled:cursor-not-allowed has-disabled:opacity-60"
              >
                <input
                  type="radio"
                  name={`${id}-domain`}
                  value={domain.id}
                  checked={selectedDomainId === domain.id}
                  disabled={!selectable}
                  onChange={() => onSelect(domain.id)}
                  aria-describedby={`${id}-${index}-reason`}
                  className="mt-0.5 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="break-all font-mono">{domain.url}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {domain.kind === "origin"
                        ? t("源站", "Origin")
                        : domain.kind === "cdn"
                          ? "CDN"
                          : t("自定义", "Custom")}
                    </span>
                  </span>
                  <span
                    id={`${id}-${index}-reason`}
                    className="block space-y-1 leading-relaxed text-muted-foreground"
                  >
                    {reason && <span className="block">{reason}</span>}
                    {url.insecure && (
                      <span className="block text-warning">
                        {t(
                          "HTTP 未加密，请确认网络环境。",
                          "HTTP is unencrypted. Review the network environment.",
                        )}
                      </span>
                    )}
                    {expiry && !Number.isNaN(expiry.getTime()) && (
                      <span className="block">
                        {t("有效至", "Valid until")}{" "}
                        {expiry.toLocaleString(intlLocale(), { hour12: false })}
                      </span>
                    )}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}
      {!loading && domains.length === 0 && (
        <p
          role="status"
          className="text-xs leading-relaxed text-muted-foreground"
        >
          {t(
            "没有可列举的自定义域名。默认地址仍可能受预览和文件类型策略限制。",
            "No custom domains are available. Default URLs may still be subject to preview and file-type restrictions.",
          )}
        </p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          "源站和 CDN 的流量计费口径可能不同；测试域名也可能有到期时间。",
          "Origin and CDN traffic may be billed differently; test domains may expire.",
        )}
      </p>
    </fieldset>
  );
}
