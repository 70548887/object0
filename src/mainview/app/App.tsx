import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { useJobProgress, useKeyboardShortcuts } from "@/hooks";
import { clearMessageTranslations } from "@/lib/i18n";
import {
  dispatchObjectToolbarEvent,
  OBJECT_TOOLBAR_EVENTS,
} from "@/lib/object-toolbar-events";
import { rpcCall } from "@/lib/rpc-client";
import {
  useFavoritesStore,
  useFolderSyncStore,
  useShareHistoryStore,
  useThemeStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { useLocaleStore } from "@/stores/useLocaleStore";
import { ErrorBoundary } from "../components/common/ErrorBoundary";
import { LanguageSwitcher } from "../components/common/LanguageSwitcher";
import { ParticleBackground } from "../components/common/ParticleBackground";
import { Toast } from "../components/common/Toast";
import { MainLayout } from "../components/layout/MainLayout";
import { ResizeBorders } from "../components/layout/ResizeBorders";
import { WindowChrome } from "../components/layout/WindowChrome";
import { LocalAccountsStartScreen } from "../components/vault/LegacyImport";
import { RecoveryKeyDisplay } from "../components/vault/RecoveryKeyDisplay";
import { ThemeProvider } from "./ThemeProvider";

let nativeLanguageQueue: Promise<unknown> = Promise.resolve();

export default function App() {
  const locale = useLocaleStore((state) => state.locale);
  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
    document.title = locale === "en" ? "Yuncang" : "云仓";
    // Native window title and tray follow the UI; saved account identifiers and
    // vault paths do not change when switching language or application name.
    nativeLanguageQueue = nativeLanguageQueue
      .catch(() => {})
      .then(() => rpcCall("system:set-language", { locale }))
      .catch(() => {});
  }, [locale]);
  const {
    unlocked,
    loading,
    checkStatus,
    pendingRecoveryKey,
    pendingRecoveryBackupPath,
    clearPendingRecoveryKey,
  } = useVaultStore();

  useEffect(() => {
    if (!unlocked) clearMessageTranslations();
  }, [unlocked]);

  useJobProgress();

  useEffect(() => {
    checkStatus();
    useFavoritesStore.getState().init();
    useFolderSyncStore.getState().init();
    if (!useUIStore.getState().persistShareHistory) {
      useShareHistoryStore.getState().clearAll();
    }
    const concurrency = useUIStore.getState().jobConcurrency;
    if (concurrency) {
      rpcCall("jobs:set-concurrency", { concurrency });
    }
    // Resolve the host OS once, app-wide, so the window decorations (custom
    // controls on Windows/Linux, native on macOS) work on every screen —
    // including the lock/loading screens that have no AppTitleBar.
    rpcCall("system:platform", undefined).then(({ os }) =>
      useUIStore.getState().setPlatform(os),
    );
  }, [checkStatus]);

  useEffect(() => {
    if (unlocked) {
      useFolderSyncStore.getState().loadRules();
      rpcCall("folder-sync:start-all", undefined).catch(() => {});
    }
  }, [unlocked]);

  // Suppress the webview's native context menu (reload / back / forward /
  // inspect element) so right-clicking feels like a native app. Editable
  // fields keep their menu so cut/copy/paste still works, and the app's own
  // right-click menus (file rows, profiles) open via their own handlers.
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  const toggleTheme = useThemeStore((s) => s.toggle);
  const setJobPanelOpen = useUIStore((s) => s.setJobPanelOpen);
  const jobPanelOpen = useUIStore((s) => s.jobPanelOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);

  // NOTE: "ctrl+b" is intentionally absent — SidebarProvider (sidebar.tsx)
  // already registers its own Ctrl/Cmd+B listener. Adding a second handler
  // here would fire toggleSidebar twice, resulting in a net no-change.
  const shortcuts = useMemo(
    () => ({
      "ctrl+j": () => setJobPanelOpen(!jobPanelOpen),
      "ctrl+\\": () => toggleTheme(),
      "ctrl+,": () => setSettingsOpen(!settingsOpen),
      "ctrl+f": () =>
        dispatchObjectToolbarEvent(OBJECT_TOOLBAR_EVENTS.OPEN_SEARCH),
    }),
    [toggleTheme, setJobPanelOpen, jobPanelOpen, setSettingsOpen, settingsOpen],
  );
  useKeyboardShortcuts(shortcuts);

  const screenKey = loading ? "loading" : unlocked ? "main" : "local-accounts";

  const handleRecoveryKeyDismissed = useCallback(() => {
    clearPendingRecoveryKey();
  }, [clearPendingRecoveryKey]);

  return (
    <ThemeProvider>
      <ParticleBackground />
      <Toast />
      <ErrorBoundary>
        <div className="relative z-10 h-screen">
          {screenKey === "loading" && (
            <div className="flex h-screen items-center justify-center">
              <Loader2 className="size-8 animate-spin text-primary" />
            </div>
          )}
          {screenKey === "local-accounts" && <LocalAccountsStartScreen />}
          {screenKey === "main" && <MainLayout />}

          {/* Window decorations. The main screen's AppTitleBar carries its own
              controls; every other screen gets this lightweight title bar so
              the window stays draggable/closable on Windows & Linux. */}
          {screenKey !== "main" && <WindowChrome />}
          {screenKey !== "main" && (
            <div className="absolute right-4 top-12 z-50">
              <LanguageSwitcher />
            </div>
          )}
        </div>

        {/* Linux-only invisible resize grips — global so resizing works on the
            lock/loading screens too, not just the main view. */}
        <ResizeBorders />

        {pendingRecoveryKey && unlocked && (
          <RecoveryKeyDisplay
            key={pendingRecoveryKey}
            recoveryKey={pendingRecoveryKey}
            backupPath={pendingRecoveryBackupPath}
            onDone={handleRecoveryKeyDismissed}
          />
        )}
      </ErrorBoundary>
    </ThemeProvider>
  );
}
