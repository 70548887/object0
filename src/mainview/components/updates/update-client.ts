import { useSyncExternalStore } from "react";
import { onEvent, rpcCall } from "@/lib/rpc-client";
import { useUpdaterPreferencesStore } from "@/stores/useUpdaterPreferencesStore";
import { updateExitBlockers } from "./update-exit-guard";
import { UpdateSession } from "./update-session";

export const updateSession = new UpdateSession(
  {
    info: () => rpcCall("updates:info", undefined),
    check: (channel) => rpcCall("updates:check", { channel }),
    download: (releaseId) => rpcCall("updates:download", { releaseId }),
    cancel: (releaseId) => rpcCall("updates:cancel", { releaseId }),
    apply: (releaseId) =>
      rpcCall("updates:apply", {
        releaseId,
        exitConfirmed: true,
        draftsSaved: true,
      }),
    exitBlockers: () => updateExitBlockers(),
    rememberChannel: (channel) =>
      useUpdaterPreferencesStore.getState().setChannel(channel),
  },
  useUpdaterPreferencesStore.getState().channel,
);
export const useUpdateState = () =>
  useSyncExternalStore(
    updateSession.subscribe,
    updateSession.getSnapshot,
    updateSession.getSnapshot,
  );
let consumers = 0;
let unsubscribe: (() => void) | null = null;
export function startUpdateClient() {
  consumers++;
  if (consumers === 1) {
    unsubscribe = onEvent("updates:progress", updateSession.progress);
    void updateSession.loadInfo();
    const prefs = useUpdaterPreferencesStore.getState();
    if (
      prefs.autoCheck &&
      Date.now() - prefs.lastAutoCheck >= 24 * 60 * 60 * 1000
    ) {
      prefs.markAutoCheck();
      void updateSession.check();
    }
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    consumers--;
    if (!consumers) {
      unsubscribe?.();
      unsubscribe = null;
    }
  };
}
