import { lazy, Suspense } from "react";
import { useTabStore, useUIStore } from "@/stores";
import { DetailPanel } from "../objects/DetailPanel";
import { TextEditorHost } from "../objects/TextEditorDialog";
import { SidebarInset, SidebarProvider } from "../ui/sidebar";
import { UpdateHost } from "../updates/UpdateDialog";
import { AppTitleBar } from "./AppTitleBar";
import { ContentArea } from "./ContentArea";
import { NavigationWorkspace } from "./NavigationWorkspace";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";
import { TopBar } from "./TopBar";

const SettingsPanel = lazy(() =>
  import("../settings/SettingsPanel").then((module) => ({
    default: module.SettingsPanel,
  })),
);
const ShareHistory = lazy(() =>
  import("../share/ShareHistory").then((module) => ({
    default: module.ShareHistory,
  })),
);
const FolderSyncPanel = lazy(() =>
  import("../sync/FolderSyncPanel").then((module) => ({
    default: module.FolderSyncPanel,
  })),
);
const SyncDialog = lazy(() =>
  import("../sync/SyncDialog").then((module) => ({
    default: module.SyncDialog,
  })),
);
const SyncTypeChooserDialog = lazy(() =>
  import("../sync/SyncTypeChooserDialog").then((module) => ({
    default: module.SyncTypeChooserDialog,
  })),
);
const TransferDialog = lazy(() =>
  import("../transfer/TransferDialog").then((module) => ({
    default: module.TransferDialog,
  })),
);
const ShareDialog = lazy(() =>
  import("../share/ShareDialog").then((module) => ({
    default: module.ShareDialog,
  })),
);
const CommandPalette = lazy(() =>
  import("../common/CommandPalette").then((module) => ({
    default: module.CommandPalette,
  })),
);
const ObjectSearchDialog = lazy(() =>
  import("../objects/ObjectSearchDialog").then((module) => ({
    default: module.ObjectSearchDialog,
  })),
);
const QiniuShareWorkspace = lazy(() =>
  import("../qiniu/QiniuShareWorkspace").then((module) => ({
    default: module.QiniuShareWorkspace,
  })),
);

export function MainLayout() {
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const shareHistoryOpen = useUIStore((s) => s.shareHistoryOpen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const folderSyncPanelOpen = useUIStore((s) => s.folderSyncPanelOpen);
  const hasTabs = useTabStore((s) => s.tabs.length > 0);
  const mainSection = useUIStore((s) => s.mainSection);

  return (
    // SidebarProvider is the outermost wrapper; controlled open state wired
    // to useUIStore so Ctrl+B (toggleSidebar) and the trigger both work.
    <SidebarProvider
      open={!sidebarCollapsed}
      onOpenChange={() => toggleSidebar()}
      style={
        {
          "--sidebar-width": "16rem",
          "--sidebar-width-icon": "3rem",
        } as React.CSSProperties
      }
      className="h-screen flex-col"
    >
      <AppTitleBar />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Shadcn Sidebar primitive — collapse wired to useUIStore */}
        <Sidebar />

        {/* Main content area — slightly translucent so the ambient particle
            background shows faintly through the file/folder view. */}
        <SidebarInset className="flex flex-col overflow-hidden bg-background/85">
          {mainSection === "storage" ? (
            <>
              <TopBar />
              {hasTabs && <TabBar />}
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <ContentArea />
              </div>
              {/* Bucket context belongs only to its visible file workspace. */}
              <StatusBar />
            </>
          ) : (
            <NavigationWorkspace section={mainSection} />
          )}
        </SidebarInset>
      </div>

      {/* DetailPanel self-manages as a Sheet (open={!!detailKey}) */}
      <DetailPanel />
      <TextEditorHost />
      <UpdateHost />

      {/* Right-side panel Sheets — each self-manages open state via useUIStore */}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsPanel />
        </Suspense>
      )}
      {shareHistoryOpen && mainSection !== "shares" && (
        <Suspense fallback={null}>
          <ShareHistory />
        </Suspense>
      )}
      {folderSyncPanelOpen && (
        <Suspense fallback={null}>
          <FolderSyncPanel />
        </Suspense>
      )}

      <Suspense fallback={null}>
        <SyncDialog />
      </Suspense>
      <Suspense fallback={null}>
        <SyncTypeChooserDialog />
      </Suspense>
      <Suspense fallback={null}>
        <TransferDialog />
      </Suspense>
      <Suspense fallback={null}>
        <ShareDialog />
      </Suspense>
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
      {mainSection === "storage" && (
        <Suspense fallback={null}>
          <ObjectSearchDialog />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <QiniuShareWorkspace />
      </Suspense>
    </SidebarProvider>
  );
}
