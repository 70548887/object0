import type { ProfileInfo } from "@shared/profile.types";
import type { RPCSchema } from "@shared/rpc-schema";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
import { t, useT } from "@/lib/i18n";
import { rpcCall } from "@/lib/rpc-client";
import { useProfileStore, useVaultStore } from "@/stores";
import { toast } from "../common/Toast";

type Connected = RPCSchema["profile:connect-qiniu"]["res"];
export function isSavedQuickConnectionCurrent(
  result: Connected,
  profiles: readonly ProfileInfo[],
) {
  return profiles.some(
    (profile) =>
      profile.id === result.profile.id &&
      profile.updatedAt === result.profile.updatedAt &&
      profile.provider === "qiniu",
  );
}

/** Return fixed diagnostics only. Provider text may contain URLs or secrets. */
export function quickConnectionError(
  cause: unknown,
  backendCommitted = false,
): string {
  if (backendCommitted)
    return t(
      "账号可能已保存，但当前列表未能确认或账号已变化。请先刷新账号列表核对，不要重复新增。",
      "The account may already be saved, but the current list could not confirm it or the account changed. Refresh the account list before adding another account.",
    );
  const text =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "";
  if (/\(HTTP 401\)$/.test(text))
    return t(
      "七牛认证被拒绝（401）。请核对 AccessKey / SecretKey 是否成对、有效。",
      "Qiniu authentication was rejected (401). Verify that AccessKey and SecretKey are a valid matching pair.",
    );
  if (/\(HTTP 403\)$/.test(text))
    return t(
      "七牛拒绝列出空间（403）。请检查账号的空间列表权限；受限账号可进入高级设置配置限定空间。",
      "Qiniu denied bucket listing (403). Check bucket-list permissions. Restricted accounts can configure scoped buckets in Advanced settings.",
    );
  if (
    text.includes("[timeout]") ||
    text ===
      "七牛连接超时，未保存账号 / Qiniu connection timed out; account was not saved"
  )
    return t(
      "七牛连接超时，尚未完成账号保存。请检查网络后重试。",
      "The Qiniu connection timed out before saving the account. Check the network and retry.",
    );
  if (
    text.includes("[connection-failed]") ||
    text.includes("[transport-failed]")
  )
    return t(
      "无法连接七牛服务。请检查网络、代理及证书，不要先认定密钥错误。",
      "Could not connect to Qiniu. Check the network, proxy and certificates; this does not establish that the keys are wrong.",
    );
  if (
    text ===
    "无法安全保存本地明文账号文件，原文件未替换 / Could not safely save local plaintext accounts; the original file was not replaced"
  )
    return t(
      "认证后无法保存本地账号文件。请检查 C 盘空间、目录写入权限及文件状态。",
      "Authentication completed, but the local account file could not be saved. Check C-drive space, directory permissions and file state.",
    );
  if (
    text ===
      "本地账号库已变化，请重新连接 / Local account store changed; connect again" ||
    text ===
      "连接请求已取消或账号状态已变化，未保存新账号 / Connection cancelled or account state changed; no new account was saved"
  )
    return t(
      "连接已取消或本地账号状态已变化，旧请求不会继续保存。请核对账号列表后重新连接。",
      "The connection was cancelled or local account state changed. The old request will not save further data. Check the account list before reconnecting.",
    );
  return t(
    "连接结果尚未确认。请检查服务诊断；账号可能已保存，请先刷新账号列表核对，不要反复新增。",
    "The connection result is unconfirmed. Review the service diagnostics. The account may already be saved; refresh the account list before adding it again.",
  );
}
export function validateQuickConnection(value: Connected): Connected {
  if (
    value.accountConnected !== true ||
    !value.profile ||
    value.profile.provider !== "qiniu" ||
    !value.profile.id ||
    !value.profile.updatedAt ||
    !Array.isArray(value.buckets) ||
    value.buckets.some(
      (bucket) =>
        !bucket ||
        typeof bucket.name !== "string" ||
        !bucket.name ||
        bucket.name.length > 255,
    ) ||
    new Set(value.buckets.map((bucket) => bucket.name)).size !==
      value.buckets.length
  )
    throw new Error(
      t(
        "连接结果无法确认，请重新打开账号列表核对。",
        "The connection result could not be confirmed. Reopen the account list to check.",
      ),
    );
  const profile = value.profile;
  return {
    accountConnected: true,
    bucketReadsVerified: false,
    downloadVerified: false,
    profile: {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      hasR2AnalyticsToken: profile.hasR2AnalyticsToken,
      hasSessionToken: profile.hasSessionToken,
      ...(profile.qiniu ? { qiniu: profile.qiniu } : {}),
    },
    buckets: value.buckets.map((bucket) => ({
      name: bucket.name,
      ...(bucket.creationDate ? { creationDate: bucket.creationDate } : {}),
      ...(bucket.regionId ? { regionId: bucket.regionId } : {}),
      ...(bucket.s3Name ? { s3Name: bucket.s3Name } : {}),
      ...(bucket.permission ? { permission: bucket.permission } : {}),
    })),
  };
}
export async function requestQuickConnection(
  input: RPCSchema["profile:connect-qiniu"]["req"],
  connect: (
    input: RPCSchema["profile:connect-qiniu"]["req"],
  ) => Promise<Connected>,
  isCurrent: () => boolean,
): Promise<Connected | null> {
  if (
    !input.accessKeyId.trim() ||
    !input.secretAccessKey.trim() ||
    !input.requestId ||
    !isCurrent()
  )
    return null;
  const response = await connect(input);
  return isCurrent() ? validateQuickConnection(response) : null;
}

export function QuickConnectFields({
  accessKeyId,
  secretAccessKey,
  busy,
  onAccessKey,
  onSecretKey,
}: {
  accessKeyId: string;
  secretAccessKey: string;
  busy: boolean;
  onAccessKey: (v: string) => void;
  onSecretKey: (v: string) => void;
}) {
  const t = useT();
  const id = useId();
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-ak`}>AccessKey</Label>
        <Input
          id={`${id}-ak`}
          value={accessKeyId}
          onChange={(e) => onAccessKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          maxLength={4096}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-sk`}>SecretKey</Label>
        <Input
          id={`${id}-sk`}
          type="password"
          value={secretAccessKey}
          onChange={(e) => onSecretKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          maxLength={4096}
        />
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          "连接后自动读取空间并保存在本机明文账号文件中。无需默认空间、下载域名、云仓密码或恢复密钥。",
          "Connect to read your buckets and save the account in the local plaintext file. No default bucket, download domain, Yuncang password or recovery key is required.",
        )}
      </p>
    </div>
  );
}

export function QiniuQuickConnect({
  open,
  onClose,
  onAdvanced,
  onChooseProvider,
}: {
  open: boolean;
  onClose: () => void;
  onAdvanced: () => void;
  onChooseProvider?: () => void;
}) {
  const t = useT();
  const [ak, setAk] = useState("");
  const [sk, setSk] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const active = useRef<string | null>(null);
  const alive = useRef(true);
  const invalidate = useCallback(() => {
    epoch.current++;
    const requestId = active.current;
    active.current = null;
    if (requestId)
      void rpcCall("profile:connect-qiniu-cancel", { requestId }).catch(
        () => {},
      );
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      invalidate();
    };
  }, [invalidate]);
  useEffect(() => {
    if (!open) {
      invalidate();
      setAk("");
      setSk("");
      setError(null);
      setBusy(false);
    }
  }, [open, invalidate]);
  const close = () => {
    invalidate();
    setAk("");
    setSk("");
    setBusy(false);
    onClose();
  };
  const connect = async () => {
    if (active.current || busy || !ak.trim() || !sk.trim()) return;
    const state = useVaultStore.getState();
    if (!state.unlocked || state.storageMode !== "plaintext") {
      setError(
        t(
          "本地账号尚未准备好，请先完成旧账号导入或选择暂不导入。",
          "Local accounts are not ready. Finish importing old accounts or choose to skip import.",
        ),
      );
      return;
    }
    const requestId = crypto.randomUUID();
    const generation = ++epoch.current;
    active.current = requestId;
    setBusy(true);
    setError(null);
    const current = () =>
      alive.current &&
      active.current === requestId &&
      epoch.current === generation &&
      useVaultStore.getState().unlocked &&
      useVaultStore.getState().storageMode === "plaintext";
    let backendCommitted = false;
    try {
      const result = await requestQuickConnection(
        { requestId, accessKeyId: ak.trim(), secretAccessKey: sk.trim() },
        (payload) => rpcCall("profile:connect-qiniu", payload),
        current,
      );
      if (!result || !current()) return;
      backendCommitted = true;
      // The backend has already committed this account. Refresh only profile
      // metadata, then adopt its verified bucket list without a second list RPC.
      await useVaultStore.getState().refreshProfiles();
      if (!current()) return;
      if (
        !isSavedQuickConnectionCurrent(
          result,
          useVaultStore.getState().profiles,
        )
      ) {
        setError(quickConnectionError(null, true));
        return;
      }
      useProfileStore
        .getState()
        .adoptConnectedProfile(result.profile, result.buckets);
      toast.success(
        result.buckets.length
          ? t(
              `已读取 ${result.buckets.length} 个空间，请从左侧选择`,
              `Loaded ${result.buckets.length} buckets. Select one in the sidebar`,
            )
          : t(
              "连接成功，暂无可列出的空间",
              "Connected. No buckets are currently listed",
            ),
      );
      active.current = null;
      setAk("");
      setSk("");
      onClose();
    } catch (cause) {
      if (current()) setError(quickConnectionError(cause, backendCommitted));
    } finally {
      if (epoch.current === generation) {
        active.current = null;
        if (alive.current) setBusy(false);
      }
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("连接七牛云", "Connect to Qiniu")}</DialogTitle>
          <DialogDescription>
            {t(
              "七牛公有云 · 输入密钥即可连接",
              "Qiniu public cloud · Connect with your access keys",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <QuickConnectFields
            accessKeyId={ak}
            secretAccessKey={sk}
            busy={busy}
            onAccessKey={(v) => {
              invalidate();
              setAk(v);
            }}
            onSecretKey={(v) => {
              invalidate();
              setSk(v);
            }}
          />
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            {onChooseProvider && (
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                disabled={busy}
                onClick={() => {
                  invalidate();
                  setAk("");
                  setSk("");
                  onChooseProvider();
                }}
              >
                {t("更换服务商", "Change provider")}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                invalidate();
                setAk("");
                setSk("");
                onAdvanced();
              }}
            >
              {t("七牛高级设置", "Qiniu advanced settings")}
            </Button>
            <Button
              type="submit"
              disabled={busy || !ak.trim() || !sk.trim()}
              aria-busy={busy}
            >
              {busy ? t("连接中…", "Connecting…") : t("连接", "Connect")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
