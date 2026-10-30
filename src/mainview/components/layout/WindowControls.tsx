import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
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
        title={"最小化"}
        aria-label={"最小化窗口"}
      >
        <IconWindowMinimize className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => win.toggleMaximize()}
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原窗口" : "最大化窗口"}
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
        title={"关闭"}
        aria-label={"关闭窗口"}
      >
        <IconXmark className="size-4" />
      </Button>
    </div>
  );
}
