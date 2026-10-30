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
import { IconLockOpen, IconSpinner } from "@/lib/icons";
import { useVaultStore } from "@/stores";

interface ChangePassphraseDialogProps {
  onComplete: () => void;
}

export function ChangePassphraseDialog({
  onComplete,
}: ChangePassphraseDialogProps) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const { changePassphrase, loading } = useVaultStore();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (passphrase.length < 8) {
      setError("密码至少需要 8 个字符");
      return;
    }
    if (passphrase !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }

    const ok = await changePassphrase(passphrase, remember);
    if (ok) {
      onComplete();
    } else {
      setError("修改密码失败");
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background/50">
      <Card className="w-full max-w-md shadow-xl">
        <CardHeader>
          <div className="mb-4 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-success/20">
              <IconLockOpen className="size-6 text-success" />
            </div>
            <CardTitle>密码库已恢复</CardTitle>
            <CardDescription className="mt-1">
              请设置新密码以保护密码库，系统也会生成新的恢复密钥。
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cp-passphrase">新密码</Label>
              <Input
                id="cp-passphrase"
                type="password"
                placeholder={"输入新密码，至少 8 个字符"}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="cp-confirm">确认密码</Label>
              <Input
                id="cp-confirm"
                type="password"
                placeholder={"再次输入新密码"}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-3">
              <Checkbox
                id="cp-remember"
                checked={remember}
                onCheckedChange={(v) => setRemember(!!v)}
              />
              <Label
                htmlFor="cp-remember"
                className="text-sm font-normal cursor-pointer"
              >
                在系统钥匙串中记住密码
              </Label>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button
              type="submit"
              className="w-full"
              disabled={loading || !passphrase || !confirm}
            >
              {loading ? (
                <IconSpinner className="size-4 animate-spin" />
              ) : (
                "设置新密码"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
