import type { ProfileInfo } from "@shared/profile.types";
import { PROVIDER_LABELS } from "@shared/profile.types";
import { useEffect, useId, useState } from "react";
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
import { t, useT } from "@/lib/i18n";
import { IconCopy, IconEye } from "@/lib/icons";
import { toast } from "../common/Toast";
import {
  type CredentialField,
  copyAllProfileInformation,
  copyCredential,
  copyValue,
  profileConnectionDetails,
  readCredential,
} from "./profileCredentials";

interface ProfileDetailsDialogProps {
  profile: ProfileInfo;
  onClose: () => void;
}

export function SessionTokenStatus({
  hasSessionToken,
}: {
  hasSessionToken?: boolean;
}) {
  useT();
  const id = useId();
  const status =
    hasSessionToken === true
      ? t("已设置", "Configured")
      : hasSessionToken === false
        ? t("未设置", "Not configured")
        : t(
            "未知（服务未返回状态）",
            "Unknown (the service did not return a status)",
          );
  return (
    <div className="space-y-1.5">
      <p id={id} className="text-sm font-medium">
        {t("会话令牌状态", "Session token status")}
      </p>
      <p role="status" aria-labelledby={id} className="text-sm">
        {status}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          "仅显示配置状态。令牌值保留在本机后端，不读取、不显示、不复制。",
          "Only configuration status is shown. The token stays in the local backend and is not read, displayed or copied.",
        )}
      </p>
    </div>
  );
}

function InformationRow({ label, value }: { label: string; value: string }) {
  useT();
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input
          aria-label={label}
          value={value}
          readOnly
          placeholder={t("未设置", "Not set")}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!value}
          onClick={() => void copyValue(value, label)}
        >
          <IconCopy className="size-3.5" /> {t("复制", "Copy")}
        </Button>
      </div>
    </div>
  );
}

function HiddenCredentialRow({
  profile,
  field,
  label,
}: {
  profile: ProfileInfo;
  field: CredentialField;
  label: string;
}) {
  useT();
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (value !== null) {
      setValue(null);
      return;
    }
    setLoading(true);
    try {
      const savedValue = await readCredential(profile.id, field);
      if (savedValue) setValue(savedValue);
      else toast.info(t(`${label}未设置`, `${label} is not set`));
    } catch {
      toast.error(
        t(
          "读取凭据失败，请先解锁密码库",
          "Could not read credentials. Unlock the vault first.",
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input
          aria-label={label}
          value={value ?? ""}
          readOnly
          placeholder={t(
            "点击显示或复制已保存的凭据",
            "Show or copy the saved credential",
          )}
          autoComplete="off"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void toggle()}
        >
          <IconEye className="size-3.5" />{" "}
          {value === null ? t("显示", "Show") : t("隐藏", "Hide")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void copyCredential(profile, field, label)}
        >
          <IconCopy className="size-3.5" /> {t("复制", "Copy")}
        </Button>
      </div>
    </div>
  );
}

export function ProfileDetailsDialog({
  profile,
  onClose,
}: ProfileDetailsDialogProps) {
  useT();
  const [accessKeyId, setAccessKeyId] = useState("");

  useEffect(() => {
    let active = true;
    void readCredential(profile.id, "accessKeyId")
      .then((value) => {
        if (active) setAccessKeyId(value);
      })
      .catch(() => {
        if (active)
          toast.error(
            t(
              "读取访问密钥 ID 失败，请先解锁密码库",
              "Could not read the access key ID. Unlock the vault first.",
            ),
          );
      });
    return () => {
      active = false;
    };
  }, [profile.id]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("账号信息", "Account details")}</DialogTitle>
          <DialogDescription>
            {t(
              "查看已保存的连接信息；右键字段可使用系统复制菜单。",
              "View saved connection details. Right-click a field to use the system copy menu.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <InformationRow
            label={t("账号名称", "Account name")}
            value={profile.name}
          />
          <InformationRow
            label={t("存储服务商", "Provider")}
            value={PROVIDER_LABELS[profile.provider]}
          />
          {profileConnectionDetails(profile).map(({ label, value }) => (
            <InformationRow key={label} label={label} value={value} />
          ))}
          <InformationRow
            label={t("默认存储桶", "Default bucket")}
            value={profile.defaultBucket ?? ""}
          />
          <InformationRow
            label={t("访问密钥 ID", "Access key ID")}
            value={accessKeyId}
          />
          <HiddenCredentialRow
            profile={profile}
            field="secretAccessKey"
            label={t("访问密钥", "Secret access key")}
          />
          <SessionTokenStatus hasSessionToken={profile.hasSessionToken} />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => void copyAllProfileInformation(profile)}
          >
            <IconCopy className="size-3.5" />{" "}
            {t("复制连接信息（含 AK/SK）", "Copy connection details (AK/SK)")}
          </Button>
          <Button type="button" onClick={onClose}>
            {t("关闭", "Close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
