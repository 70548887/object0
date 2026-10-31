import { useEffect, useState } from "react";
import { localize, useT } from "@/lib/i18n";
import { rpcCall } from "@/lib/rpc-client";

// Tracks whether the vault passphrase is stored in the OS keychain, exposes
// display-ready status text/badge, and a handler to forget the stored entry.
export function useKeychainStatus() {
  const t = useT();
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
      ? t("系统钥匙串不可用", "System keychain unavailable")
      : hasStoredPassphrase === null
        ? t("正在检查系统钥匙串...", "Checking the system keychain...")
        : hasStoredPassphrase
          ? t("已保存在系统钥匙串中", "Saved in the system keychain")
          : t("未保存在系统钥匙串中", "Not saved in the system keychain");

  const keychainBadge = keychainBusy
    ? { label: t("正在处理", "Working") }
    : keychainAvailable === false
      ? { label: t("不可用", "Unavailable") }
      : hasStoredPassphrase === null
        ? { label: t("正在检查", "Checking") }
        : hasStoredPassphrase
          ? { label: t("已保存", "Saved") }
          : { label: t("未保存", "Not saved") };

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
          setKeychainError(
            t(
              "无法读取系统钥匙串状态",
              "Unable to read system keychain status",
            ),
          );
        }
      }
    };

    loadKeychainStatus();
    return () => {
      mounted = false;
    };
  }, [t]);

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
            ? t(
                "已从系统钥匙串中移除保存的密码",
                "Saved passphrase removed from the system keychain",
              )
            : t(
                "系统钥匙串中没有保存的密码",
                "No passphrase saved in the system keychain",
              ),
        );
      } else {
        setKeychainError(
          t(
            "清除系统钥匙串中的记录失败",
            "Failed to clear the system keychain entry",
          ),
        );
      }
    } catch {
      setKeychainError(
        t(
          "清除系统钥匙串中的记录失败",
          "Failed to clear the system keychain entry",
        ),
      );
    } finally {
      setKeychainBusy(false);
    }
  };

  return {
    hasStoredPassphrase,
    keychainAvailable,
    keychainBusy,
    keychainMessage: keychainMessage ? localize(keychainMessage) : null,
    keychainError: keychainError ? localize(keychainError) : null,
    keychainStatusText,
    keychainBadge,
    keychainBadgeClass,
    forgetStoredPassphrase,
  };
}
