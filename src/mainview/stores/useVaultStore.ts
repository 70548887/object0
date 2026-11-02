import type { ProfileInfo } from "@shared/profile.types";
import type {
  KeychainUnlockFailureReason,
  VaultStorageMode,
} from "@shared/rpc-schema";
import { create } from "zustand";
import { t } from "@/lib/i18n";
import { rpcCall } from "@/lib/rpc-client";
import { useJobStore } from "./useJobStore";
import { useProfileStore } from "./useProfileStore";

function restoreTransferRows() {
  // Restoring encrypted rows is read-only with respect to cloud storage.
  // The user must explicitly resume an interrupted transfer.
  void useJobStore
    .getState()
    .restoreJobs()
    .then((result) => {
      if (result.unreadable > 0)
        useJobStore.setState({
          error: t(
            `${result.unreadable} 条传输记录无法读取或保存，请检查原密码库和磁盘；不会自动传输。`,
            `${result.unreadable} transfer record(s) could not be read or saved. Check the original vault and disk; no transfers will start automatically.`,
          ),
        });
    })
    .catch(() => {});
}

interface VaultState {
  exists: boolean;
  unlocked: boolean;
  profiles: ProfileInfo[];
  loading: boolean;
  error: string | null;
  hasRecoveryKey: boolean;
  vaultVersion: number | null;
  storageMode: VaultStorageMode;
  configPath: string | null;
  switchingToPlaintext: boolean;
  legacyImportRequired: boolean;
  legacyAvailable: boolean;
  importingLegacy: boolean;
  /** Set after setup or change-passphrase — shown once, then cleared */
  pendingRecoveryKey: string | null;
  /** Encrypted backup path, not a credential; cleared with the key acknowledgement. */
  pendingRecoveryBackupPath: string | null;
  rotatingRecoveryKey: boolean;
  /** True when vault was unlocked via recovery (needs new passphrase) */
  needsPassphraseChange: boolean;

  checkStatus: () => Promise<void>;
  openLocalAccounts: (skipLegacyImport?: boolean) => Promise<boolean>;
  importLegacyAccounts: (passphrase: string) => Promise<boolean>;
  setup: (passphrase: string, remember?: boolean) => Promise<boolean>;
  enablePlaintext: (confirmPlaintext: boolean) => Promise<boolean>;
  unlock: (passphrase: string, remember?: boolean) => Promise<boolean>;
  unlockWithKeychain: () => Promise<boolean>;
  lock: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  recoverViaKey: (recoveryKey: string) => Promise<boolean>;
  changePassphrase: (
    newPassphrase: string,
    remember?: boolean,
  ) => Promise<boolean>;
  rotateRecoveryKey: (
    passphrase: string,
    confirmInvalidateOldKey: boolean,
  ) => Promise<boolean>;
  resetVault: () => Promise<boolean>;
  clearPendingRecoveryKey: () => void;
  clearError: () => void;
}

function formatKeychainUnlockError(
  reason?: KeychainUnlockFailureReason,
  detail?: string,
): string {
  const suffix = detail ? `: ${detail}` : "";
  switch (reason) {
    case "vault_missing":
      return "未找到密码库";
    case "no_stored_passphrase":
      return "系统钥匙串中没有保存的密码";
    case "stale_stored_passphrase":
      return "保存的密码已过期，请手动解锁并重新保存。";
    case "keychain_unavailable":
      return `此设备的系统钥匙串不可用${suffix}`;
    default:
      return "使用系统钥匙串解锁失败";
  }
}

let profileRefreshGeneration = 0;
let vaultSessionGeneration = 0;

/** Only match fixed native diagnostics; never echo arbitrary password/path text. */
export function legacyImportError(cause: unknown): string {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : "";
  switch (message) {
    case "旧账号库密码验证失败，未导入或更改任何账号 / Legacy passphrase verification failed; no account was imported or changed":
      return t(
        "原云仓密码验证失败，未导入或更改账号。请核对旧账号库的解锁密码，不是恢复密钥或云服务 SecretKey。",
        "The original Yuncang passphrase was not accepted. No accounts were imported or changed. Use the old account store's unlock passphrase, not a recovery key or cloud SecretKey.",
      );
    case "旧账号与本地账号 ID 冲突，未覆盖任何账号 / Legacy and local account IDs conflict; no account was overwritten":
      return t(
        "旧账号与当前账号存在 ID 冲突，未覆盖任何账号。请保留两个文件并核对冲突账号；这不是密码错误。",
        "Old and current accounts have conflicting IDs. No account was overwritten. Preserve both files and review the conflicting accounts; this is not a password error.",
      );
    case "新旧传输密钥不同，未导入以避免丢失任务恢复身份 / Transfer keys differ; import was stopped to preserve resumable-task identities":
      return t(
        "新旧传输任务身份不同，已停止导入以保留任务恢复能力。请保留两个文件并先处理各自未完成的传输任务；这不是密码错误。",
        "Old and current transfer identities differ. Import was stopped to preserve resumable tasks. Keep both files and resolve their unfinished transfers first; this is not a password error.",
      );
    case "未找到旧加密账号库 / No legacy encrypted account store was found":
      return t(
        "未找到旧加密账号库，请保留现有账号文件并核对旧库位置。",
        "No old encrypted account store was found. Preserve the current account file and check the old store's location.",
      );
    case "账号文件或当前会话已变化，请重新打开后导入 / Account files or the current session changed; reopen before importing":
      return t(
        "账号文件或当前会话已变化，已停止本次导入。请重新打开并核对账号后再试。",
        "The account files or current session changed, so this import was stopped. Reopen and review the accounts before retrying.",
      );
    default:
      return t(
        "旧账号导入结果无法确认，可能已经导入。请先刷新或重新打开账号列表核对，保留新旧文件，不要反复导入。",
        "The old-account import result is unconfirmed and may already have completed. Refresh or reopen the account list first, preserve both files and avoid repeatedly importing.",
      );
  }
}

export const useVaultStore = create<VaultState>()((set, _get) => ({
  exists: false,
  unlocked: false,
  profiles: [],
  loading: true,
  error: null,
  hasRecoveryKey: false,
  vaultVersion: null,
  storageMode: "plaintext",
  configPath: null,
  switchingToPlaintext: false,
  legacyImportRequired: false,
  legacyAvailable: false,
  importingLegacy: false,
  pendingRecoveryKey: null,
  pendingRecoveryBackupPath: null,
  rotatingRecoveryKey: false,
  needsPassphraseChange: false,

  checkStatus: async () => {
    await _get().openLocalAccounts(false);
  },

  openLocalAccounts: async (skipLegacyImport = false) => {
    if (_get().switchingToPlaintext || _get().importingLegacy) return false;
    const generation = ++vaultSessionGeneration;
    profileRefreshGeneration++;
    set({ loading: true, error: null });
    try {
      const result = await rpcCall("vault:open-local", { skipLegacyImport });
      if (generation !== vaultSessionGeneration) return false;
      if (
        result.storageMode !== "plaintext" ||
        !Array.isArray(result.profiles) ||
        typeof result.configPath !== "string" ||
        !result.configPath ||
        typeof result.ready !== "boolean" ||
        typeof result.legacyImportRequired !== "boolean" ||
        typeof result.legacyAvailable !== "boolean" ||
        (result.ready && result.legacyImportRequired)
      )
        throw new Error("Invalid local account response");
      set({
        exists: true,
        unlocked: result.ready,
        loading: false,
        storageMode: "plaintext",
        configPath: result.configPath,
        vaultVersion: 5,
        profiles: result.ready ? result.profiles : [],
        legacyImportRequired: result.legacyImportRequired,
        legacyAvailable: result.legacyAvailable,
        hasRecoveryKey: false,
        needsPassphraseChange: false,
        pendingRecoveryKey: null,
        pendingRecoveryBackupPath: null,
      });
      useProfileStore
        .getState()
        .reconcileActiveProfile(result.ready ? result.profiles : []);
      if (result.ready) restoreTransferRows();
      return result.ready;
    } catch {
      if (generation !== vaultSessionGeneration) return false;
      useJobStore.getState().resetJobs();
      set({
        loading: false,
        unlocked: false,
        profiles: [],
        storageMode: "plaintext",
        pendingRecoveryKey: null,
        pendingRecoveryBackupPath: null,
        error: t(
          "本地账号文件无法打开。请保留账号文件和旧库后重试；不会回退、覆盖或创建替代空库。",
          "The local account file could not be opened. Preserve the account file and old vault, then retry; no fallback, overwrite or replacement empty store was used.",
        ),
      });
      useProfileStore.getState().reconcileActiveProfile([]);
      return false;
    }
  },

  importLegacyAccounts: async (passphrase) => {
    if (_get().importingLegacy || !passphrase || passphrase.length > 4096)
      return false;
    const generation = ++vaultSessionGeneration;
    profileRefreshGeneration++;
    set({ importingLegacy: true, error: null });
    try {
      const result = await rpcCall("vault:import-legacy", { passphrase });
      if (generation !== vaultSessionGeneration) return false;
      if (
        !result.ready ||
        result.storageMode !== "plaintext" ||
        !Array.isArray(result.profiles) ||
        typeof result.configPath !== "string" ||
        !result.configPath
      )
        throw new Error("Invalid import response");
      useJobStore.getState().resetJobs();
      set({
        exists: true,
        unlocked: true,
        loading: false,
        storageMode: "plaintext",
        configPath: result.configPath,
        vaultVersion: 5,
        profiles: result.profiles,
        legacyImportRequired: false,
        legacyAvailable: result.legacyAvailable,
        hasRecoveryKey: false,
        needsPassphraseChange: false,
        pendingRecoveryKey: null,
        pendingRecoveryBackupPath: null,
      });
      useProfileStore.getState().reconcileActiveProfile(result.profiles);
      restoreTransferRows();
      return true;
    } catch (cause) {
      if (generation === vaultSessionGeneration)
        set({
          error: legacyImportError(cause),
        });
      return false;
    } finally {
      set({ importingLegacy: false });
    }
  },

  enablePlaintext: async (confirmed) => {
    const current = _get();
    if (
      !confirmed ||
      current.switchingToPlaintext ||
      current.rotatingRecoveryKey ||
      current.pendingRecoveryKey ||
      current.needsPassphraseChange ||
      (current.exists && !current.unlocked)
    ) {
      set({
        error: t(
          "请先正常解锁现有密码库，并明确确认凭据将明文保存。",
          "Normally unlock the existing vault and explicitly confirm plaintext credential storage.",
        ),
      });
      return false;
    }
    if (current.storageMode === "plaintext" && current.unlocked) return true;
    const generation = ++vaultSessionGeneration;
    profileRefreshGeneration++;
    set({ switchingToPlaintext: true, error: null });
    try {
      const result = await rpcCall("vault:enable-plaintext", {
        confirmPlaintext: true,
      });
      if (generation !== vaultSessionGeneration) {
        set({
          error: t(
            "存储模式切换可能已完成；请重新打开或刷新程序确认，不会自动重试。",
            "The storage-mode switch may have completed. Reopen or refresh the app to confirm; no automatic retry will run.",
          ),
        });
        return false;
      }
      if (
        result?.success !== true ||
        result.storageMode !== "plaintext" ||
        !Array.isArray(result.profiles) ||
        typeof result.configPath !== "string" ||
        !result.configPath ||
        result.configPath.length > 32768
      ) {
        set({
          error: t(
            "明文模式结果无法确认，请保留原密码库并重新打开程序核对。",
            "Plaintext mode could not be confirmed. Preserve the original vault and reopen the app to check.",
          ),
        });
        return false;
      }
      useJobStore.getState().resetJobs();
      set({
        exists: true,
        unlocked: true,
        storageMode: "plaintext",
        configPath: result.configPath,
        vaultVersion: 5,
        hasRecoveryKey: false,
        needsPassphraseChange: false,
        pendingRecoveryKey: null,
        pendingRecoveryBackupPath: null,
        profiles: result.profiles,
        loading: false,
      });
      useProfileStore.getState().reconcileActiveProfile(result.profiles);
      restoreTransferRows();
      return true;
    } catch {
      if (generation === vaultSessionGeneration)
        set({
          error: t(
            "无法确认明文模式切换结果。原加密库不会被此流程删除；请重新打开程序核对，勿自动重复转换。",
            "The plaintext-mode result could not be confirmed. This flow does not delete the original encrypted vault. Reopen the app to check rather than automatically retrying.",
          ),
        });
      return false;
    } finally {
      set({ switchingToPlaintext: false });
    }
  },

  setup: async (passphrase, remember) => {
    if (
      _get().rotatingRecoveryKey ||
      _get().switchingToPlaintext ||
      _get().storageMode === "plaintext"
    )
      return false;
    vaultSessionGeneration++;
    set({ pendingRecoveryKey: null, pendingRecoveryBackupPath: null });
    try {
      set({ loading: true, error: null });
      const result = await rpcCall("vault:setup", { passphrase, remember });
      if (result.success) {
        set({
          exists: true,
          unlocked: true,
          profiles: [],
          hasRecoveryKey: true,
          vaultVersion: 3,
          storageMode: "encrypted",
          pendingRecoveryKey: result.recoveryKey ?? null,
          loading: false,
        });
        restoreTransferRows();
      }
      return result.success;
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : "未知错误",
        loading: false,
      });
      return false;
    }
  },

  unlock: async (passphrase, remember) => {
    if (_get().rotatingRecoveryKey || _get().switchingToPlaintext) return false;
    if (_get().storageMode === "plaintext") {
      await _get().checkStatus();
      return _get().unlocked;
    }
    vaultSessionGeneration++;
    set({ pendingRecoveryKey: null, pendingRecoveryBackupPath: null });
    try {
      set({ loading: true, error: null });
      const result = await rpcCall("vault:unlock", { passphrase, remember });
      if (result.success) {
        set({
          unlocked: true,
          profiles: result.profiles,
          hasRecoveryKey: result.hasRecoveryKey,
          loading: false,
        });
        restoreTransferRows();
      } else {
        set({ error: "密码错误", loading: false });
      }
      return result.success;
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : "未知错误",
        loading: false,
      });
      return false;
    }
  },

  unlockWithKeychain: async () => {
    if (_get().rotatingRecoveryKey || _get().switchingToPlaintext) return false;
    if (_get().storageMode === "plaintext") {
      await _get().checkStatus();
      return _get().unlocked;
    }
    vaultSessionGeneration++;
    set({ pendingRecoveryKey: null, pendingRecoveryBackupPath: null });
    try {
      set({ loading: true, error: null });
      const result = await rpcCall("vault:unlock-keychain", undefined);
      if (result.success) {
        set({
          unlocked: true,
          profiles: result.profiles,
          hasRecoveryKey: result.hasRecoveryKey,
          loading: false,
        });
        restoreTransferRows();
      } else {
        set({
          error: formatKeychainUnlockError(result.reason, result.detail),
          loading: false,
        });
      }
      return result.success;
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : "未知错误",
        loading: false,
      });
      return false;
    }
  },

  lock: async () => {
    if (_get().storageMode === "plaintext") {
      set({
        error: t(
          "本地明文模式没有密码锁定保护；请退出程序，注意保护本地账号文件。",
          "Local plaintext mode has no password-lock protection. Exit the app and protect the local account file.",
        ),
      });
      return;
    }
    vaultSessionGeneration++;
    // Lock remains an unconditional safety action. Forget a displayed or
    // in-flight key rather than carrying it into another vault session.
    set({ pendingRecoveryKey: null, pendingRecoveryBackupPath: null });
    // Invalidate pending profile reads before asking the backend to lock, so
    // a late pre-lock response cannot restore profiles in a later session.
    profileRefreshGeneration++;
    useJobStore.getState().resetJobs();
    try {
      await rpcCall("vault:lock", undefined);
      set({
        unlocked: false,
        profiles: [],
        needsPassphraseChange: false,
        pendingRecoveryKey: null,
        pendingRecoveryBackupPath: null,
      });
      useJobStore.getState().resetJobs();
    } catch (err: unknown) {
      set({ error: err instanceof Error ? err.message : "未知错误" });
    }
  },

  refreshProfiles: async () => {
    const generation = ++profileRefreshGeneration;
    if (!_get().unlocked) return;
    try {
      const profiles = await rpcCall("profile:list", undefined);
      if (generation !== profileRefreshGeneration || !_get().unlocked) return;
      set((state) => ({
        profiles,
        vaultVersion:
          state.storageMode === "plaintext"
            ? 5
            : profiles.some((profile) => profile.provider === "qiniu")
              ? 4
              : state.vaultVersion,
      }));
      useProfileStore.getState().reconcileActiveProfile(profiles);
    } catch (err: unknown) {
      if (generation !== profileRefreshGeneration || !_get().unlocked) return;
      set({ error: err instanceof Error ? err.message : "未知错误" });
    }
  },

  recoverViaKey: async (recoveryKey) => {
    if (
      _get().storageMode === "plaintext" ||
      _get().switchingToPlaintext ||
      _get().rotatingRecoveryKey ||
      _get().pendingRecoveryKey
    )
      return false;
    vaultSessionGeneration++;
    try {
      set({ loading: true, error: null });
      const result = await rpcCall("vault:recover-key", { recoveryKey });
      if (result.success) {
        set({
          unlocked: true,
          profiles: result.profiles,
          needsPassphraseChange: true,
          loading: false,
        });
        useJobStore.getState().resetJobs();
        restoreTransferRows();
      } else {
        set({ error: "恢复密钥无效", loading: false });
      }
      return result.success;
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : "未知错误",
        loading: false,
      });
      return false;
    }
  },

  changePassphrase: async (newPassphrase, remember) => {
    if (
      _get().storageMode === "plaintext" ||
      _get().switchingToPlaintext ||
      _get().rotatingRecoveryKey ||
      _get().pendingRecoveryKey
    )
      return false;
    vaultSessionGeneration++;
    try {
      set({ loading: true, error: null });
      const result = await rpcCall("vault:change-passphrase", {
        newPassphrase,
        remember,
      });
      if (result.success) {
        set({
          needsPassphraseChange: false,
          pendingRecoveryKey: result.recoveryKey,
          hasRecoveryKey: true,
          loading: false,
        });
      }
      return result.success;
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : "未知错误",
        loading: false,
      });
      return false;
    }
  },

  rotateRecoveryKey: async (passphrase, confirmInvalidateOldKey) => {
    const current = _get();
    if (
      current.storageMode === "plaintext" ||
      current.switchingToPlaintext ||
      current.rotatingRecoveryKey
    )
      return false;
    if (
      !current.unlocked ||
      current.needsPassphraseChange ||
      current.pendingRecoveryKey ||
      !confirmInvalidateOldKey ||
      !passphrase ||
      passphrase.length > 4096
    ) {
      set({
        error: t(
          "请在密码库正常解锁后输入当前密码，并明确确认旧恢复密钥将失效。",
          "Normally unlock the vault, enter its current passphrase, and confirm that the old recovery key will be invalidated.",
        ),
      });
      return false;
    }
    const generation = vaultSessionGeneration;
    set({ rotatingRecoveryKey: true, error: null });
    try {
      const result = await rpcCall("vault:rotate-recovery-key", {
        passphrase,
        confirmInvalidateOldKey: true,
      });
      if (
        generation !== vaultSessionGeneration ||
        !_get().unlocked ||
        _get().needsPassphraseChange
      ) {
        set({
          error: t(
            "密码库状态在请求期间发生变化；恢复密钥更换可能已完成，不能假定旧密钥仍有效。请用当前密码解锁后手动重新生成。",
            "Vault state changed during the request. Recovery-key rotation may have completed; do not assume the old key still works. Unlock with the current passphrase and manually generate another key.",
          ),
        });
        return false;
      }
      if (
        typeof result?.recoveryKey !== "string" ||
        !result.recoveryKey ||
        result.recoveryKey.length > 1024 ||
        typeof result.backupPath !== "string" ||
        !result.backupPath ||
        result.backupPath.length > 32768
      ) {
        set({
          error: t(
            "恢复密钥更换结果无法确认；更换可能已完成。请保留密码库和备份，用当前密码解锁后手动重新生成。",
            "The recovery-key result could not be verified; rotation may have completed. Preserve the vault and backups, then unlock with the current passphrase and manually generate another key.",
          ),
        });
        return false;
      }
      set({
        pendingRecoveryKey: result.recoveryKey,
        pendingRecoveryBackupPath: result.backupPath,
        hasRecoveryKey: true,
      });
      return true;
    } catch (cause) {
      // Transport failures may occur after the atomic backend write. Avoid
      // logging/echoing an error that could contain the supplied passphrase.
      const native =
        cause instanceof Error
          ? cause.message
          : typeof cause === "string"
            ? cause
            : "";
      const known: ReadonlyArray<readonly [string, string, string]> = [
        [
          "当前密码验证失败，恢复密钥未更换 / Current password verification failed; the recovery key was not changed",
          "当前密码验证失败，恢复密钥未更换。",
          "Current passphrase verification failed; the recovery key was not changed.",
        ],
        [
          "密码库已在其他操作中变化，请重新解锁后再更换恢复密钥 / The vault changed; unlock it again before rotating the recovery key",
          "密码库已变化，请重新解锁后再更换恢复密钥。",
          "The vault changed. Unlock it again before rotating the recovery key.",
        ],
        [
          "恢复密钥更换未完成，原密码库与内存状态保持不变；请检查磁盘和加密备份 / Recovery-key rotation did not complete; the original vault and runtime were preserved. Check the disk and encrypted backup",
          "恢复密钥更换未完成，原密码库保持不变。请检查磁盘和加密备份。",
          "Recovery-key rotation did not complete; the original vault was preserved. Check the disk and encrypted backup.",
        ],
        [
          "Vault is locked",
          "密码库已锁定，请重新解锁。",
          "The vault is locked. Unlock it again.",
        ],
        [
          "Vault must be rekeyed before writing",
          "请先完成密码库恢复并设置新密码，再更换恢复密钥。",
          "Finish vault recovery and set a new passphrase before rotating the recovery key.",
        ],
      ];
      const safe = known.find(([match]) => match === native);
      set({
        error: safe
          ? t(safe[1], safe[2])
          : t(
              "未能确认恢复密钥更换结果。连接中断不会触发自动重试；若请求已提交，请勿假定旧密钥仍有效。请保留密码库和备份，核对当前密码后手动重试。",
              "The recovery-key result could not be confirmed. An interrupted connection will not trigger an automatic retry. If the request was submitted, do not assume the old key is still valid. Preserve the vault and backups, verify the current passphrase and retry manually.",
            ),
      });
      return false;
    } finally {
      set({ rotatingRecoveryKey: false });
    }
  },

  resetVault: async () => {
    if (
      _get().storageMode === "plaintext" ||
      _get().switchingToPlaintext ||
      _get().rotatingRecoveryKey ||
      _get().pendingRecoveryKey
    )
      return false;
    vaultSessionGeneration++;
    profileRefreshGeneration++;
    useJobStore.getState().resetJobs();
    try {
      set({ loading: true, error: null });
      const result = await rpcCall("vault:reset", undefined);
      if (result.success) {
        set({
          exists: false,
          unlocked: false,
          profiles: [],
          hasRecoveryKey: false,
          needsPassphraseChange: false,
          pendingRecoveryKey: null,
          pendingRecoveryBackupPath: null,
          loading: false,
        });
        useJobStore.getState().resetJobs();
      }
      return result.success;
    } catch (err: unknown) {
      set({
        error: err instanceof Error ? err.message : "未知错误",
        loading: false,
      });
      return false;
    }
  },

  clearPendingRecoveryKey: () => {
    if (_get().rotatingRecoveryKey) return;
    set({ pendingRecoveryKey: null, pendingRecoveryBackupPath: null });
  },
  clearError: () => set({ error: null }),
}));
