import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { t, useT } from "@/lib/i18n";
import { IconCheck, IconCopy, IconDownload, IconKey } from "@/lib/icons";

interface RecoveryKeyDisplayProps {
  recoveryKey: string;
  onDone: () => void;
}

export function RecoveryKeyDisplay({
  recoveryKey,
  onDone,
}: RecoveryKeyDisplayProps) {
  useT();
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob(
      [
        [
          t("云仓 密码库恢复密钥", "Yuncang vault recovery key"),
          "=".repeat(30),
          "",
          recoveryKey,
          "",
          t(
            "请妥善保存此密钥。忘记密码时需要用它恢复密码库。",
            "Keep this key safe. You will need it to recover the vault if you forget your passphrase.",
          ),
          t(
            "此密钥之后无法再次获取。",
            "This key cannot be retrieved again later.",
          ),
          "",
        ].join("\n"),
      ],
      { type: "text/plain;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "yuncang-recovery-key.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={true} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="sr-only">
            {t("保存恢复密钥", "Save Your Recovery Key")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-warning/20">
              <IconKey className="size-6 text-warning" />
            </div>
            <h3 className="font-bold text-lg">
              {t("保存恢复密钥", "Save Your Recovery Key")}
            </h3>
            <p className="mt-1 text-muted-foreground text-sm">
              {t(
                "忘记密码时只能使用此密钥恢复密码库。请妥善保存，它不会再次显示。",
                "This key is the only way to recover your vault if you forget your passphrase. Store it somewhere safe — it won't be shown again.",
              )}
            </p>
          </div>

          <div className="rounded-lg border border-border bg-background p-4">
            <code className="block select-all text-center font-mono text-lg tracking-wider">
              {recoveryKey}
            </code>
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={handleCopy}
            >
              {copied ? (
                <IconCheck className="size-4 mr-1" />
              ) : (
                <IconCopy className="size-4 mr-1" />
              )}
              {copied ? t("已复制！", "Copied!") : t("复制", "Copy")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={handleDownload}
            >
              <IconDownload className="size-4 mr-1" />
              {t("下载", "Download")}
            </Button>
          </div>

          <div className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3">
            <Checkbox
              id="recovery-confirmed"
              checked={confirmed}
              onCheckedChange={(v) => setConfirmed(!!v)}
            />
            <Label
              htmlFor="recovery-confirmed"
              className="text-sm font-normal cursor-pointer"
            >
              {t(
                "我已将恢复密钥保存在安全的位置",
                "I've saved this recovery key in a safe place",
              )}
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            className="w-full"
            disabled={!confirmed}
            onClick={onDone}
          >
            {t("我已保存恢复密钥", "I've saved my recovery key")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
