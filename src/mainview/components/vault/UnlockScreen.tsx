import type React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { localize, t, useT } from "@/lib/i18n";
import {
  IconCircleQuestion,
  IconFingerprint,
  IconLock,
  IconSpinner,
} from "@/lib/icons";
import { useVaultStore } from "@/stores";

interface UnlockScreenProps {
  onForgotPassphrase: () => void;
}

export function UnlockScreen({ onForgotPassphrase }: UnlockScreenProps) {
  useT();
  const [passphrase, setPassphrase] = useState("");
  const [remember, setRemember] = useState(false);
  const { unlock, unlockWithKeychain, loading, error, clearError } =
    useVaultStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase) return;
    await unlock(passphrase, remember);
  };

  const handleKeychainUnlock = async () => {
    await unlockWithKeychain();
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background/50">
      <Card className="w-full max-w-md shadow-xl">
        <CardHeader>
          <div className="mb-4 text-center">
            <img
              src="/logo.png"
              alt={t("云仓", "Yuncang")}
              className="mx-auto mb-3 h-16 w-16"
            />
            <h1 className="font-bold text-3xl text-primary">
              {t("云仓", "Yuncang")}
            </h1>
            <p className="mt-2 text-muted-foreground text-sm">
              {t("S3 存储桶管理器", "S3 Bucket Manager")}
            </p>
          </div>
          <CardTitle className="flex items-center gap-2">
            <IconLock className="size-4" />
            {t("密码库已锁定", "Vault Locked")}
          </CardTitle>
          <CardDescription>
            {t(
              "通过系统钥匙串或输入密码来解锁存储账号。",
              "Unlock with OS keychain or enter your passphrase to access profiles.",
            )}
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={loading}
              onClick={handleKeychainUnlock}
            >
              <IconFingerprint className="size-4 mr-2" />
              {t("使用系统钥匙串解锁", "Unlock with OS Keychain")}
            </Button>

            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-xs text-muted-foreground">
                {t("或", "OR")}
              </span>
              <Separator className="flex-1" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="unlock-passphrase">
                {t("密码", "Passphrase")}
              </Label>
              <Input
                id="unlock-passphrase"
                type="password"
                placeholder={t("输入密码库密码", "Enter vault passphrase")}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-3">
              <Checkbox
                id="unlock-remember"
                checked={remember}
                onCheckedChange={(v) => setRemember(!!v)}
              />
              <Label
                htmlFor="unlock-remember"
                className="text-sm font-normal cursor-pointer"
              >
                {t("在系统钥匙串中记住密码", "Remember in OS keychain")}
              </Label>
            </div>

            {error && (
              <p className="text-sm text-destructive">{localize(error)}</p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={loading || !passphrase}
            >
              {loading ? (
                <IconSpinner className="size-4 animate-spin" />
              ) : (
                t("解锁", "Unlock")
              )}
            </Button>

            <div className="text-center">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  clearError();
                  onForgotPassphrase();
                }}
              >
                <IconCircleQuestion className="size-4 mr-1.5" />
                {t("忘记密码？", "Forgot passphrase?")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
