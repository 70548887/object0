import { TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";
import type { Webview } from "@tauri-apps/api/webview";

type DropPosition = { x: number; y: number };
export type NativeFileDrop =
  | { type: "enter" | "drop"; paths: string[]; position: DropPosition }
  | { type: "over"; position: DropPosition }
  | { type: "leave" };

/** Own each registration immediately, including ones that resolve after stop.
 * Tauri's convenience onDragDropEvent cannot return its disposer if an
 * intermediate registration rejects. Do not activate a partial subscription. */
export function listenNativeFileDrop(
  webview: Pick<Webview, "listen">,
  handler: (payload: NativeFileDrop) => void,
) {
  let active = true;
  let registered = false;
  const disposers: UnlistenFn[] = [];
  const stop = () => {
    active = false;
    registered = false;
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* Continue removing the other registrations. */
      }
    }
  };
  const ready = (async () => {
    try {
      for (const [event, type] of [
        [TauriEvent.DRAG_ENTER, "enter"],
        [TauriEvent.DRAG_OVER, "over"],
        [TauriEvent.DRAG_DROP, "drop"],
        [TauriEvent.DRAG_LEAVE, "leave"],
      ] as const) {
        const dispose = await webview.listen<{
          paths: string[];
          position: DropPosition;
        }>(event, ({ payload }) => {
          if (!active || !registered) return;
          if (type === "leave") handler({ type });
          else if (type === "over")
            handler({ type, position: payload.position });
          else
            handler({ type, paths: payload.paths, position: payload.position });
        });
        if (!active) {
          dispose();
          return;
        }
        disposers.push(dispose);
      }
      registered = true;
    } catch (error) {
      stop();
      throw error;
    }
  })();
  return { ready, stop };
}
