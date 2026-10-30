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
import { IconCheck, IconCopy, IconDownload, IconKey } from "@/lib/icons";

interface RecoveryKeyDisplayProps {
  recoveryKey: string;
  onDone: () => void;
}

export function RecoveryKeyDisplay({
  recoveryKey,
  onDone,
}: RecoveryKeyDisplayProps) {
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
        `object0 密码库恢复密钥\n${"=".repeat(30)}\n\n${recoveryKey}\n\n请妥善保存此密钥。忘记密码时需要用它恢复密码库。\n此密钥之后无法再次获取。\n`,
      ],
      { type: "text/plain;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "object0-recovery-key.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={true} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="sr-only">保存恢复密钥</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-warning/20">
              <IconKey className="size-6 text-warning" />
            </div>
            <h3 className="font-bold text-lg">保存恢复密钥</h3>
            <p className="mt-1 text-muted-foreground text-sm">
              忘记密码时只能使用此密钥恢复密码库。请妥善保存，它不会再次显示。
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
              {copied ? "已复制！" : "复制"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={handleDownload}
            >
              <IconDownload className="size-4 mr-1" />
              下载
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
              我已将恢复密钥保存在安全的位置
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
            我已保存恢复密钥
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
