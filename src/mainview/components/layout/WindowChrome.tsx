import { getCurrentWindow } from "@tauri-apps/api/window";
import { t, useT } from "@/lib/i18n";
import { IconCloud } from "@/lib/icons";
import { useUIStore } from "@/stores";
import { WindowControls } from "./WindowControls";

// A minimal, always-on title bar for screens that have no AppTitleBar of their own
// (loading, setup, unlock, recovery, change-passphrase). On Windows/Linux the
// native frame is gone, so without this the window can't be dragged or closed
// on those screens. macOS keeps its native decorations, so this renders nothing.
export function WindowChrome() {
  useT();
  const platform = useUIStore((s) => s.platform);
  if (!platform || platform === "macos") return null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: window title-bar drag/maximize chrome, not content
    <header
      data-tauri-drag-region
      className="fixed top-0 right-0 left-0 z-50 flex h-10 items-center justify-between border-b border-border/60 bg-card/80 px-2"
      onDoubleClick={(e) => {
        if (platform !== "linux") return;
        if (!(e.target as HTMLElement).hasAttribute("data-tauri-drag-region")) {
          return;
        }
        getCurrentWindow().toggleMaximize();
      }}
    >
      <div className="pointer-events-none flex items-center gap-2 px-1 text-xs font-medium">
        <IconCloud className="size-4 text-primary" />
        <span>{t("云仓（Yuncang）", "Yuncang")}</span>
      </div>
      <WindowControls />
    </header>
  );
}
