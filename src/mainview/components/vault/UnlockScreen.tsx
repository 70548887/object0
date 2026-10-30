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
              alt="object0"
              className="mx-auto mb-3 h-16 w-16"
            />
            <h1 className="font-bold text-3xl text-primary">object0</h1>
            <p className="mt-2 text-muted-foreground text-sm">
              S3 存储桶管理器
            </p>
          </div>
          <CardTitle className="flex items-center gap-2">
            <IconLock className="size-4" />
            密码库已锁定
          </CardTitle>
          <CardDescription>
            通过系统钥匙串或输入密码来解锁存储账号。
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
              使用系统钥匙串解锁
            </Button>

            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-xs text-muted-foreground">或</span>
              <Separator className="flex-1" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="unlock-passphrase">密码</Label>
              <Input
                id="unlock-passphrase"
                type="password"
                placeholder={"输入密码库密码"}
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
                在系统钥匙串中记住密码
              </Label>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              type="submit"
              className="w-full"
              disabled={loading || !passphrase}
            >
              {loading ? (
                <IconSpinner className="size-4 animate-spin" />
              ) : (
                "解锁"
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
                忘记密码？
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
