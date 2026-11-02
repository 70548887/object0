import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { localize, useT } from "@/lib/i18n";
import { useVaultStore } from "@/stores";

export function LegacyImportFields({
  allowSkip,
  onDone,
}: {
  allowSkip: boolean;
  onDone?: () => void;
}) {
  const t = useT();
  const id = useId();
  const [passphrase, setPassphrase] = useState("");
  const busy = useVaultStore((s) => s.importingLegacy || s.loading);
  const error = useVaultStore((s) => s.error);
  const importAccounts = useVaultStore((s) => s.importLegacyAccounts);
  const openLocal = useVaultStore((s) => s.openLocalAccounts);
  useEffect(() => () => setPassphrase(""), []);
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !passphrase) return;
        const entered = passphrase;
        setPassphrase("");
        void importAccounts(entered).then((ok) => {
          if (ok) onDone?.();
        });
      }}
    >
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t(
          "发现旧加密账号库。可用原云仓密码一次性导入，之后无需密码或恢复密钥；原文件保留不变。",
          "An old encrypted account store was found. Import it once with the original Yuncang passphrase; future use needs no password or recovery key. The old file stays unchanged.",
        )}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          "新账号默认明文保存到本机，能读取账号文件的程序可以读取 AK/SK。",
          "New accounts are saved as local plaintext. Programs able to read the account file can read AK/SK.",
        )}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={id}>
          {t(
            "原云仓密码（仅用于导入）",
            "Original Yuncang passphrase (import only)",
          )}
        </Label>
        <Input
          id={id}
          type="password"
          autoComplete="off"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          disabled={busy}
          maxLength={4096}
        />
      </div>
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {localize(error)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {allowSkip && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setPassphrase("");
              void openLocal(true);
            }}
          >
            {t("暂不导入，直接使用", "Skip import and continue")}
          </Button>
        )}
        <Button type="submit" disabled={busy || !passphrase}>
          {busy
            ? t("正在导入…", "Importing…")
            : t("导入旧账号", "Import old accounts")}
        </Button>
      </div>
      {allowSkip && (
        <p className="text-xs text-muted-foreground">
          {t(
            "暂不导入不会读取或删除旧账号；之后可在设置中导入。",
            "Skipping does not read or delete the old accounts. You can import them later in Settings.",
          )}
        </p>
      )}
    </form>
  );
}

export function LocalAccountsStartScreen() {
  const t = useT();
  const needsImport = useVaultStore((s) => s.legacyImportRequired);
  const error = useVaultStore((s) => s.error);
  const check = useVaultStore((s) => s.checkStatus);
  return (
    <div className="flex h-screen items-center justify-center bg-background/50 p-5">
      <section className="w-full max-w-lg space-y-5 rounded-xl border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">
          {needsImport
            ? t("导入旧账号（可选）", "Import old accounts (optional)")
            : t("打开本地账号", "Open local accounts")}
        </h1>
        {needsImport ? (
          <LegacyImportFields allowSkip />
        ) : (
          <>
            <p role="alert" className="text-sm text-destructive">
              {localize(
                error ??
                  t("账号文件暂不可用。", "The account file is unavailable."),
              )}
            </p>
            <Button onClick={() => void check()}>{t("重试", "Retry")}</Button>
          </>
        )}
      </section>
    </div>
  );
}

export function LegacyImportDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const busy = useVaultStore((s) => s.importingLegacy);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[90dvh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{t("导入旧账号", "Import old accounts")}</DialogTitle>
        </DialogHeader>
        {open && <LegacyImportFields allowSkip={false} onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
