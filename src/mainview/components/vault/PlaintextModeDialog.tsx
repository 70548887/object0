import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { localize, t, useT } from "@/lib/i18n";
import { useVaultStore } from "@/stores";

export function PlaintextModeNotice() {
  useT();
  return (
    <div className="space-y-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed">
      <p className="font-medium">
        {t(
          "AK/SK 将直接明文保存在本机文件中。",
          "AK/SK will be stored as plaintext in a local file.",
        )}
      </p>
      <p>
        {t(
          "能读取该文件的程序或用户都能看到账号密钥。此模式不提供密码、恢复密钥或 Windows 凭据加密保护。",
          "Any program or user that can read that file can see the account keys. This mode provides no passphrase, recovery-key or Windows credential encryption protection.",
        )}
      </p>
      <p>
        {t(
          "现有加密密码库会原样保留，不会删除或覆盖；它只是切换前的快照，不会继续同步新改动。明文账号文件存放于当前用户 C 盘配置目录。今后启动无需输入云仓密码，添加七牛也不要求恢复密钥。",
          "The existing encrypted vault is preserved unchanged, not deleted or overwritten. It is a pre-switch snapshot and does not receive later changes. The plaintext account file is stored in the current user's C-drive configuration folder. Future startup needs no Yuncang passphrase, and adding Qiniu needs no recovery key.",
        )}
      </p>
      <p>
        {t(
          "请一次只运行一个版本；不要共享、上传或把账号文件包含进便携包。传输记录所需本地密钥也保存在该文件中，不能再视作秘密加密边界。",
          "Run only one edition at a time. Do not share, upload or package the account file. The local key required for transfer records is also stored in this file and is no longer a secret encryption boundary.",
        )}
      </p>
    </div>
  );
}

export function PlaintextModeDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useT();
  const id = useId();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useVaultStore((state) => state.switchingToPlaintext);
  const enable = useVaultStore((state) => state.enablePlaintext);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    if (!open) {
      setConfirmed(false);
      setError(null);
    }
  }, [open]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const close = () => {
    if (busy || pending.current) return;
    setConfirmed(false);
    setError(null);
    onClose();
  };
  const submit = async () => {
    if (!confirmed || busy || pending.current) return;
    pending.current = true;
    setError(null);
    try {
      const ok = await enable(true);
      if (!mounted.current) return;
      if (ok) {
        setConfirmed(false);
        onClose();
      } else
        setError(
          useVaultStore.getState().error ??
            t(
              "未能确认明文模式，请保留原文件并重新打开程序核对。",
              "Plaintext mode was not confirmed. Preserve the original files and reopen the app to check.",
            ),
        );
    } finally {
      pending.current = false;
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>
            {t("使用本地明文模式", "Use local plaintext mode")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "仅在你明确确认后切换；不会自动转换现有密码库。",
              "Switches only after your explicit confirmation; an existing vault is never converted automatically.",
            )}
          </DialogDescription>
        </DialogHeader>
        <PlaintextModeNotice />
        <div className="flex items-start gap-2">
          <Checkbox
            id={id}
            checked={confirmed}
            disabled={busy}
            onCheckedChange={(value) => setConfirmed(value === true)}
          />
          <Label
            htmlFor={id}
            className="cursor-pointer text-xs font-normal leading-relaxed"
          >
            {t(
              "我确认将全部账号凭据以明文保存在本机，并自行承担本地文件被读取的风险。",
              "I confirm plaintext storage of all account credentials on this device and accept the risk of local file access.",
            )}
          </Label>
        </div>
        {error && (
          <p role="alert" className="break-words text-xs text-destructive">
            {localize(error)}
          </p>
        )}
        {busy && (
          <p role="status" className="text-xs text-muted-foreground">
            {t(
              "正在保存本地明文配置…",
              "Saving local plaintext configuration…",
            )}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={close}
          >
            {t("取消", "Cancel")}
          </Button>
          <Button
            type="button"
            disabled={!confirmed || busy}
            onClick={() => void submit()}
          >
            {t("确认使用明文模式", "Confirm plaintext mode")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
