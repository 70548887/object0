import type { QiniuDownloadOptions } from "@shared/qiniu.types";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { localizeDownloadHint } from "./qiniu-share-options";

export function QiniuShareDomains({
  options,
  loading,
  error,
  selectedDomain,
  disabled,
  onSelect,
  onReload,
}: {
  options: QiniuDownloadOptions | null;
  loading: boolean;
  error: string | null;
  selectedDomain: string;
  disabled: boolean;
  onSelect: (domain: string) => void;
  onReload: () => void;
}) {
  const t = useT();
  const id = useId();
  return (
    <fieldset
      className="min-w-0 space-y-2"
      aria-describedby={`${id}-hint`}
      disabled={disabled || loading}
    >
      <legend className="mb-1 text-sm font-semibold">
        {t("七牛下载域名", "Qiniu download domain")}
      </legend>
      <p
        id={`${id}-hint`}
        className="text-xs leading-relaxed text-muted-foreground"
      >
        {t(
          "默认选择列表中第一个可用域名，可手动切换；仅用于本次分享和下载，不修改账号配置。",
          "The first available domain is selected by default. You can choose another for this share/download; account settings stay unchanged.",
        )}
      </p>
      {loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t(
            "正在读取域名与访问限制…",
            "Loading domains and access restrictions…",
          )}
        </p>
      ) : error ? (
        <div role="alert" className="space-y-2 text-xs text-destructive">
          <p className="break-words">{localizeDownloadHint(error)}</p>
          <Button type="button" variant="outline" size="sm" onClick={onReload}>
            {t("重新读取", "Reload")}
          </Button>
        </div>
      ) : options ? (
        <>
          <div className="max-h-44 overflow-y-auto rounded-lg border border-border/70 px-3">
            <label className="flex gap-2 py-2.5 text-xs">
              <input
                className="mt-0.5 accent-primary"
                type="radio"
                name={`${id}-domain`}
                checked={!selectedDomain}
                onChange={() => onSelect("")}
                value=""
              />
              <span>{t("不选择域名", "No domain selected")}</span>
            </label>
            {options.domains.map((domain, index) => (
              <label
                key={domain.url}
                className="flex gap-2 border-t border-border/60 py-2.5 text-xs has-disabled:opacity-65"
              >
                <input
                  className="mt-0.5 accent-primary"
                  type="radio"
                  name={`${id}-domain`}
                  value={domain.url}
                  checked={selectedDomain === domain.url}
                  disabled={!domain.available}
                  aria-describedby={
                    domain.reason ? `${id}-reason-${index}` : undefined
                  }
                  onChange={() => domain.available && onSelect(domain.url)}
                />
                <span className="min-w-0 space-y-1">
                  <span className="block select-text break-all font-mono">
                    {domain.url}
                  </span>
                  <span className="block text-muted-foreground">
                    {domain.kind === "configured"
                      ? t("账号已配置域名", "Account-configured domain")
                      : domain.kind === "origin"
                        ? t("原生源站域名", "Native origin domain")
                        : domain.kind === "cdn"
                          ? t("CDN 域名", "CDN domain")
                          : domain.kind === "test"
                            ? t("测试域名", "Test domain")
                            : t("其他域名", "Other domain")}
                    {!domain.available
                      ? t(" · 暂不可选", " · Unavailable")
                      : ""}
                  </span>
                  {domain.reason && (
                    <span
                      id={`${id}-reason-${index}`}
                      className="block break-words text-muted-foreground"
                    >
                      {localizeDownloadHint(domain.reason)}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
          {options.domains.every((domain) => !domain.available) && (
            <p role="status" className="text-xs text-warning">
              {t(
                "没有当前可选域名。请检查域名读取权限，或配置已绑定此空间的下载域名后重新读取。",
                "No domain is currently selectable. Check domain-list permissions, or configure a download domain bound to this bucket and reload.",
              )}
            </p>
          )}
          <p className="break-words text-xs leading-relaxed text-muted-foreground">
            {localizeDownloadHint(options.policyNote)}
          </p>
          {selectedDomain.startsWith("http://") && (
            <p
              role="status"
              className="rounded-md border border-warning/30 bg-warning/5 p-2 text-xs leading-relaxed text-warning"
            >
              {t(
                "所选域名使用 HTTP：链接和下载令牌会明文传输。仅在确认使用该地址时继续；如已配置 HTTPS 证书，建议选择 HTTPS 域名。",
                "The selected domain uses HTTP: links and download tokens travel without transport encryption. Continue only if you intend to use this address; prefer an HTTPS domain when a certificate is configured.",
              )}
            </p>
          )}
        </>
      ) : null}
    </fieldset>
  );
}
