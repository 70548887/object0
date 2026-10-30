import type { ProfileInfo } from "@shared/profile.types";
import { PROVIDER_LABELS } from "@shared/profile.types";
import { useEffect, useState } from "react";
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
import { IconCopy, IconEye } from "@/lib/icons";
import { toast } from "../common/Toast";
import {
  type CredentialField,
  copyAllProfileInformation,
  copyCredential,
  copyValue,
  readCredential,
} from "./profileCredentials";

interface ProfileDetailsDialogProps {
  profile: ProfileInfo;
  onClose: () => void;
}

function InformationRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input aria-label={label} value={value} readOnly placeholder="未设置" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!value}
          onClick={() => void copyValue(value, label)}
        >
          <IconCopy className="size-3.5" /> 复制
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
      else toast.info(`${label}未设置`);
    } catch {
      toast.error("读取凭据失败，请先解锁密码库");
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
          placeholder="点击显示或复制已保存的凭据"
          autoComplete="off"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void toggle()}
        >
          <IconEye className="size-3.5" /> {value === null ? "显示" : "隐藏"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void copyCredential(profile, field, label)}
        >
          <IconCopy className="size-3.5" /> 复制
        </Button>
      </div>
    </div>
  );
}

export function ProfileDetailsDialog({
  profile,
  onClose,
}: ProfileDetailsDialogProps) {
  const [accessKeyId, setAccessKeyId] = useState("");

  useEffect(() => {
    let active = true;
    void readCredential(profile.id, "accessKeyId")
      .then((value) => {
        if (active) setAccessKeyId(value);
      })
      .catch(() => {
        if (active) toast.error("读取访问密钥 ID 失败，请先解锁密码库");
      });
    return () => {
      active = false;
    };
  }, [profile.id]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>账号信息</DialogTitle>
          <DialogDescription>
            查看已保存的连接信息；右键字段可使用系统复制菜单。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <InformationRow label="账号名称" value={profile.name} />
          <InformationRow
            label="存储服务商"
            value={PROVIDER_LABELS[profile.provider]}
          />
          <InformationRow label="接口地址" value={profile.endpoint ?? ""} />
          <InformationRow label="区域" value={profile.region ?? ""} />
          <InformationRow
            label="默认存储桶"
            value={profile.defaultBucket ?? ""}
          />
          <InformationRow label="访问密钥 ID" value={accessKeyId} />
          <HiddenCredentialRow
            profile={profile}
            field="secretAccessKey"
            label="访问密钥"
          />
          <HiddenCredentialRow
            profile={profile}
            field="sessionToken"
            label="会话令牌（如有）"
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => void copyAllProfileInformation(profile)}
          >
            <IconCopy className="size-3.5" /> 复制全部信息（含密钥）
          </Button>
          <Button type="button" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
