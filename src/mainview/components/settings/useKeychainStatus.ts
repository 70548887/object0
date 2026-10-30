import { useEffect, useState } from "react";
import { rpcCall } from "@/lib/rpc-client";

// Tracks whether the vault passphrase is stored in the OS keychain, exposes
// display-ready status text/badge, and a handler to forget the stored entry.
export function useKeychainStatus() {
  const [hasStoredPassphrase, setHasStoredPassphrase] = useState<
    boolean | null
  >(null);
  const [keychainAvailable, setKeychainAvailable] = useState<boolean | null>(
    null,
  );
  const [keychainBusy, setKeychainBusy] = useState(false);
  const [keychainMessage, setKeychainMessage] = useState<string | null>(null);
  const [keychainError, setKeychainError] = useState<string | null>(null);

  const keychainStatusText =
    keychainAvailable === false
      ? "系统钥匙串不可用"
      : hasStoredPassphrase === null
        ? "正在检查系统钥匙串..."
        : hasStoredPassphrase
          ? "已保存在系统钥匙串中"
          : "未保存在系统钥匙串中";

  const keychainBadge = keychainBusy
    ? { label: "正在处理" }
    : keychainAvailable === false
      ? { label: "不可用" }
      : hasStoredPassphrase === null
        ? { label: "正在检查" }
        : hasStoredPassphrase
          ? { label: "已保存" }
          : { label: "未保存" };

  const keychainBadgeClass = keychainBusy
    ? "bg-info/15 text-info"
    : keychainAvailable === false
      ? "bg-destructive/15 text-destructive"
      : hasStoredPassphrase === null
        ? "bg-muted text-foreground/55"
        : hasStoredPassphrase
          ? "bg-success/15 text-success"
          : "bg-muted text-foreground/55";

  useEffect(() => {
    let mounted = true;
    const loadKeychainStatus = async () => {
      try {
        const result = await rpcCall("vault:keychain-status", undefined);
        if (mounted) {
          setHasStoredPassphrase(result.hasStoredPassphrase);
          setKeychainAvailable(result.available ?? true);
          setKeychainError(result.error || null);
        }
      } catch {
        if (mounted) {
          setHasStoredPassphrase(false);
          setKeychainAvailable(false);
          setKeychainError("无法读取系统钥匙串状态");
        }
      }
    };

    loadKeychainStatus();
    return () => {
      mounted = false;
    };
  }, []);

  const forgetStoredPassphrase = async () => {
    try {
      setKeychainBusy(true);
      setKeychainError(null);
      setKeychainMessage(null);
      const result = await rpcCall("vault:keychain-clear", undefined);
      const status = await rpcCall("vault:keychain-status", undefined);
      setHasStoredPassphrase(status.hasStoredPassphrase);
      setKeychainAvailable(status.available ?? true);
      setKeychainError(status.error || null);

      if (result.success) {
        setKeychainMessage(
          result.hadStoredPassphrase
            ? "已从系统钥匙串中移除保存的密码"
            : "系统钥匙串中没有保存的密码",
        );
      } else {
        setKeychainError("清除系统钥匙串中的记录失败");
      }
    } catch {
      setKeychainError("清除系统钥匙串中的记录失败");
    } finally {
      setKeychainBusy(false);
    }
  };

  return {
    hasStoredPassphrase,
    keychainAvailable,
    keychainBusy,
    keychainMessage,
    keychainError,
    keychainStatusText,
    keychainBadge,
    keychainBadgeClass,
    forgetStoredPassphrase,
  };
}
