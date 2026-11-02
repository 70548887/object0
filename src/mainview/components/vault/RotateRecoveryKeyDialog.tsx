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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { localize, t, useT } from "@/lib/i18n";
import { IconSpinner } from "@/lib/icons";
import { useVaultStore } from "@/stores";

export function canRotateRecoveryKey(input: {
  unlocked: boolean;
  needsPassphraseChange: boolean;
  busy: boolean;
  pendingKey: boolean;
  passphrase: string;
  acknowledged: boolean;
}): boolean {
  return (
    input.unlocked &&
    !input.needsPassphraseChange &&
    !input.busy &&
    !input.pendingKey &&
    input.passphrase.length > 0 &&
    input.passphrase.length <= 4096 &&
    input.acknowledged
  );
}

export function RecoveryRotationNotice() {
  useT();
  return (
    <div className="space-y-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed">
      <p className="font-medium">
        {t(
          "这会使旧恢复密钥在当前密码库上失效。",
          "This invalidates the old recovery key for the current vault.",
        )}
      </p>
      <p>
        {t(
          "加密备份保留更换前的状态，旧恢复密钥仍可解锁对应旧备份；请妥善保管备份文件。",
          "The encrypted backup retains the previous state, and its old recovery key can still unlock that backup. Keep backup files secure.",
        )}
      </p>
      <p>
        {t(
          "输入当前云仓密码库密码，不是七牛 SecretKey，也不是旧恢复密钥。后端会先验证密码并建立加密备份，再生成新恢复密钥。",
          "Enter the current Yuncang vault passphrase, not a Qiniu SecretKey or the old recovery key. The backend verifies the passphrase and creates an encrypted backup before generating a new recovery key.",
        )}
      </p>
      <p>
        {t(
          "账号、文件和当前解锁密码不会因此删除或更改。新密钥只显示一次，完成后必须确认已安全保存；不要把密码或密钥发到聊天中。",
          "Accounts, files and the current unlock passphrase are not deleted or changed. The new key is shown once and must be saved safely before you continue. Do not send passphrases or keys in chat.",
        )}
      </p>
    </div>
  );
}

export function RotateRecoveryKeyDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useT();
  const id = useId();
  const [passphrase, setPassphrase] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const unlocked = useVaultStore((state) => state.unlocked);
  const recoveryOnly = useVaultStore((state) => state.needsPassphraseChange);
  const busy = useVaultStore((state) => state.rotatingRecoveryKey);
  const pendingKey = useVaultStore((state) => state.pendingRecoveryKey);
  const rotate = useVaultStore((state) => state.rotateRecoveryKey);

  useEffect(() => {
    if (!open || !unlocked) {
      setPassphrase("");
      setAcknowledged(false);
      setError(null);
    }
  }, [open, unlocked]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const allowed = canRotateRecoveryKey({
    unlocked,
    needsPassphraseChange: recoveryOnly,
    busy,
    pendingKey: Boolean(pendingKey),
    passphrase,
    acknowledged,
  });
  const close = () => {
    if (busy || pending.current) return;
    setPassphrase("");
    setAcknowledged(false);
    setError(null);
    onClose();
  };
  const submit = async () => {
    if (!allowed || pending.current) return;
    pending.current = true;
    setError(null);
    try {
      const ok = await rotate(passphrase, acknowledged);
      if (!mounted.current) return;
      if (ok) onClose();
      else
        setError(
          useVaultStore.getState().error ??
            t(
              "恢复密钥未生成，请核对当前密码后重试。",
              "A recovery key was not generated. Verify the current passphrase and retry.",
            ),
        );
    } finally {
      pending.current = false;
      if (mounted.current) setPassphrase("");
    }
  };
  return (
    <Dialog
      open={open && unlocked}
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
            {t("重新生成恢复密钥", "Generate a new recovery key")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "仅由你在本机确认后执行；不会自动更换。",
              "Runs only after your local confirmation; never automatically.",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <RecoveryRotationNotice />
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-passphrase`}>
              {t("当前云仓密码库密码", "Current Yuncang vault passphrase")}
            </Label>
            <Input
              id={`${id}-passphrase`}
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
            />
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id={`${id}-confirm`}
              checked={acknowledged}
              onCheckedChange={(value) => setAcknowledged(value === true)}
              disabled={busy}
            />
            <Label
              htmlFor={`${id}-confirm`}
              className="cursor-pointer text-xs font-normal leading-relaxed"
            >
              {t(
                "我确认使旧恢复密钥在当前密码库上失效，并在生成后保存新密钥。操作前会保留加密备份。",
                "I confirm invalidating the old recovery key for the current vault and will save the new key after generation. An encrypted backup will be kept first.",
              )}
            </Label>
          </div>
          {busy && (
            <p role="status" className="text-xs text-muted-foreground">
              {t(
                "正在验证并保存，请勿关闭或锁定密码库。",
                "Verifying and saving. Do not close or lock the vault.",
              )}
            </p>
          )}
          {error && (
            <p role="alert" className="break-words text-xs text-destructive">
              {localize(error)}
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
            <Button type="submit" disabled={!allowed} aria-busy={busy}>
              {busy ? (
                <IconSpinner className="size-3.5 animate-spin" />
              ) : (
                t("验证密码并生成", "Verify passphrase and generate")
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
