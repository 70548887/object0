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
import { localize, t, useT } from "@/lib/i18n";
import { IconSpinner, IconVault } from "@/lib/icons";
import { useVaultStore } from "@/stores";

export function SetupScreen() {
  useT();
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const setup = useVaultStore((s) => s.setup);
  const loading = useVaultStore((s) => s.loading);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (passphrase.length < 8) {
      setError(
        t("密码至少需要 8 个字符", "Passphrase must be at least 8 characters"),
      );
      return;
    }
    if (passphrase !== confirm) {
      setError(t("两次输入的密码不一致", "Passphrases do not match"));
      return;
    }

    const ok = await setup(passphrase, remember);
    if (!ok) {
      setError(t("创建密码库失败", "Failed to create vault"));
    }
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
            <IconVault className="size-4" />
            {t("创建密码库", "Create Vault")}
          </CardTitle>
          <CardDescription>
            {t(
              "设置密码以加密保存的 API 密钥。完成后将生成恢复密钥。",
              "Set a passphrase to encrypt your API keys. A recovery key will be generated after setup.",
            )}
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="setup-passphrase">
                {t("密码", "Passphrase")}
              </Label>
              <Input
                id="setup-passphrase"
                type="password"
                placeholder={t(
                  "输入密码，至少 8 个字符",
                  "Enter passphrase (min 8 characters)",
                )}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="setup-confirm">
                {t("确认密码", "Confirm Passphrase")}
              </Label>
              <Input
                id="setup-confirm"
                type="password"
                placeholder={t("再次输入密码", "Re-enter passphrase")}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-3">
              <Checkbox
                id="setup-remember"
                checked={remember}
                onCheckedChange={(v) => setRemember(!!v)}
              />
              <Label
                htmlFor="setup-remember"
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
              disabled={loading || !passphrase || !confirm}
            >
              {loading ? (
                <IconSpinner className="size-4 animate-spin" />
              ) : (
                t("创建密码库", "Create Vault")
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
