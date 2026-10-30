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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  IconArrowLeft,
  IconKey,
  IconSpinner,
  IconTrashCan,
  IconTriangleExclamation,
} from "@/lib/icons";
import { useVaultStore } from "@/stores";

type RecoveryTab = "recovery-key" | "reset";

interface RecoveryFlowProps {
  onBack: () => void;
}

export function RecoveryFlow({ onBack }: RecoveryFlowProps) {
  const [tab, setTab] = useState<RecoveryTab>("recovery-key");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const {
    recoverViaKey,
    resetVault,
    hasRecoveryKey,
    loading,
    error,
    clearError,
  } = useVaultStore();

  const handleRecoveryKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!recoveryKey.trim()) return;
    await recoverViaKey(recoveryKey.trim().toUpperCase());
  };

  const handleReset = async () => {
    if (confirmText !== "DELETE") return;
    await resetVault();
  };

  const switchTab = (newTab: RecoveryTab) => {
    setTab(newTab);
    clearError();
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background/50">
      <Card className="w-full max-w-lg shadow-xl">
        <CardHeader>
          <div className="mb-4 text-center">
            <img
              src="/logo.png"
              alt="object0"
              className="mx-auto mb-3 h-16 w-16"
            />
            <h1 className="font-bold text-3xl text-primary">object0</h1>
            <p className="mt-2 text-muted-foreground text-sm">恢复密码库</p>
          </div>
          <CardTitle>恢复</CardTitle>
          <CardDescription>
            使用恢复密钥找回密码库，或将其完全重置。
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Tab selector */}
          <Tabs value={tab} onValueChange={(v) => switchTab(v as RecoveryTab)}>
            <TabsList className="w-full">
              <TabsTrigger value="recovery-key" className="flex-1">
                <IconKey className="size-4 mr-1.5" />
                恢复密钥
              </TabsTrigger>
              <TabsTrigger value="reset" className="flex-1">
                <IconTrashCan className="size-4 mr-1.5" />
                重置
              </TabsTrigger>
            </TabsList>

            {/* Recovery key tab */}
            <TabsContent value="recovery-key" className="space-y-4 mt-4">
              <div className="rounded-lg bg-muted p-4">
                <h3 className="mb-2 font-semibold text-sm flex items-center gap-2">
                  <IconKey className="size-4 text-warning" />
                  输入恢复密钥
                </h3>
                <p className="text-muted-foreground text-sm">
                  输入创建密码库时保存的恢复密钥。解锁后请设置新密码，并可选择将其保存在系统钥匙串中。
                </p>
              </div>

              {!hasRecoveryKey && (
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 flex items-start gap-2 text-sm">
                  <IconTriangleExclamation className="size-4 text-warning shrink-0 mt-0.5" />
                  <span>此密码库没有配置恢复密钥，可能需要重置密码库。</span>
                </div>
              )}

              <form onSubmit={handleRecoveryKeySubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="recovery-key-input">恢复密钥</Label>
                  <Input
                    id="recovery-key-input"
                    type="text"
                    className="font-mono uppercase tracking-wider"
                    placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                    value={recoveryKey}
                    onChange={(e) => setRecoveryKey(e.target.value)}
                  />
                </div>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <Button
                  type="submit"
                  variant="default"
                  className="w-full"
                  disabled={loading || !recoveryKey.trim()}
                >
                  {loading ? (
                    <IconSpinner className="size-4 animate-spin" />
                  ) : (
                    "使用密钥恢复"
                  )}
                </Button>
              </form>
            </TabsContent>

            {/* Reset tab */}
            <TabsContent value="reset" className="space-y-4 mt-4">
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
                <h3 className="mb-2 font-semibold text-destructive text-sm flex items-center gap-2">
                  <IconTriangleExclamation className="size-4" />
                  危险操作
                </h3>
                <p className="text-sm">
                  这将永久删除本地密码库及其中所有存储账号。S3
                  中的数据不受影响，但本地保存的 API 密钥和连接配置将丢失。
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirm-delete">输入 DELETE 以确认</Label>
                <Input
                  id="confirm-delete"
                  type="text"
                  className="border-destructive/50 focus-visible:ring-destructive/50"
                  placeholder="DELETE"
                  value={confirmText}
                  onChange={(e) => {
                    setConfirmText(e.target.value);
                    setConfirmReset(e.target.value === "DELETE");
                  }}
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button
                type="button"
                variant="destructive"
                className="w-full"
                disabled={loading || !confirmReset}
                onClick={handleReset}
              >
                {loading ? (
                  <IconSpinner className="size-4 animate-spin" />
                ) : (
                  <>
                    <IconTrashCan className="size-4 mr-2" />
                    删除密码库并重新开始
                  </>
                )}
              </Button>
            </TabsContent>
          </Tabs>

          {/* Back button */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={onBack}
          >
            <IconArrowLeft className="size-4 mr-2" />
            返回解锁
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
