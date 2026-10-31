import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { t, useT } from "@/lib/i18n";
import {
  IconWindowMaximize,
  IconWindowMinimize,
  IconWindowRestore,
  IconXmark,
} from "@/lib/icons";
import { Button } from "../ui/button";

// Custom window controls for Windows/Linux, where native decorations are off.
// macOS keeps its native traffic lights, so this component is never rendered
// there (the parent gates on platform).
export function WindowControls() {
  useT();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setMaximized);
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setMaximized);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const win = getCurrentWindow();

  return (
    <div className="no-drag flex items-center">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => win.minimize()}
        title={t("最小化", "Minimize")}
        aria-label={t("最小化窗口", "Minimize window")}
      >
        <IconWindowMinimize className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => win.toggleMaximize()}
        title={maximized ? t("还原", "Restore") : t("最大化", "Maximize")}
        aria-label={
          maximized
            ? t("还原窗口", "Restore window")
            : t("最大化窗口", "Maximize window")
        }
      >
        {maximized ? (
          <IconWindowRestore className="size-4" />
        ) : (
          <IconWindowMaximize className="size-4" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="hover:bg-destructive hover:text-destructive-foreground"
        onClick={() => win.close()}
        title={t("关闭", "Close")}
        aria-label={t("关闭窗口", "Close window")}
      >
        <IconXmark className="size-4" />
      </Button>
    </div>
  );
}
