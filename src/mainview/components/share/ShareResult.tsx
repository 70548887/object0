import { QRCodeSVG } from "qrcode.react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t, useT } from "@/lib/i18n";
import { IconChevronDown, IconClock, IconCopy, IconQrcode } from "@/lib/icons";

interface ShareResultProps {
  url: string;
  expiresLabel: string;
  showQR: boolean;
  onCopy: () => void;
  onToggleQR: () => void;
}

export function ShareResult({
  url,
  expiresLabel,
  showQR,
  onCopy,
  onToggleQR,
}: ShareResultProps) {
  useT();
  const linkId = useId();
  return (
    <>
      {/* Generated URL */}
      <div className="space-y-2">
        <label htmlFor={linkId} className="font-medium text-foreground text-sm">
          {t("分享链接", "Sharing link")}
        </label>
        <div className="flex gap-2">
          <Input
            id={linkId}
            type="text"
            readOnly
            value={url}
            className="h-10 min-w-0 flex-1 bg-background font-mono text-xs"
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-10 shrink-0"
            onClick={onCopy}
            title={t("复制到剪贴板", "Copy to clipboard")}
            aria-label={t("复制分享链接", "Copy sharing link")}
          >
            <IconCopy className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Expiration info */}
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <IconClock className="size-4" />
        <span>
          {expiresLabel === t("已过期", "Expired") ||
          expiresLabel === t("有效期未知", "Expiration unknown")
            ? expiresLabel
            : t(`剩余有效期 ${expiresLabel}`, `Expires in ${expiresLabel}`)}
        </span>
      </div>

      {/* QR Code toggle */}
      <div className="space-y-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-10 w-full"
          aria-expanded={showQR}
          aria-controls={`${linkId}-qr`}
          onClick={onToggleQR}
        >
          {showQR ? (
            <>
              <IconChevronDown className="size-3.5 mr-1" />
              {t("隐藏二维码", "Hide QR code")}
            </>
          ) : (
            <>
              <IconQrcode className="size-3.5 mr-1" />
              {t("显示二维码", "Show QR code")}
            </>
          )}
        </Button>

        {showQR && (
          <div
            id={`${linkId}-qr`}
            className="flex justify-center rounded-lg border border-border bg-white p-4"
          >
            <QRCodeSVG
              value={url}
              size={200}
              level="M"
              includeMargin
              className="max-w-full h-auto"
              title={t("分享链接二维码", "Sharing link QR code")}
            />
          </div>
        )}
      </div>
    </>
  );
}
