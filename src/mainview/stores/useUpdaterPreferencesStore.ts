import type { UpdateChannel } from "@shared/updater.types";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface UpdatePreferences {
  channel: UpdateChannel;
  autoCheck: boolean;
  lastAutoCheck: number;
  setChannel(channel: UpdateChannel): void;
  setAutoCheck(value: boolean): void;
  markAutoCheck(): void;
}
export const useUpdaterPreferencesStore = create<UpdatePreferences>()(
  persist(
    (set) => ({
      channel: "stable",
      autoCheck: false,
      lastAutoCheck: 0,
      setChannel: (channel) => set({ channel }),
      setAutoCheck: (autoCheck) => set({ autoCheck }),
      markAutoCheck: () => set({ lastAutoCheck: Date.now() }),
    }),
    {
      name: "yuncang-update-preferences",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ channel, autoCheck, lastAutoCheck }) => ({
        channel,
        autoCheck,
        lastAutoCheck,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<UpdatePreferences> | undefined;
        return {
          ...current,
          channel: saved?.channel === "preview" ? "preview" : "stable",
          autoCheck: saved?.autoCheck === true,
          lastAutoCheck:
            typeof saved?.lastAutoCheck === "number" &&
            Number.isFinite(saved.lastAutoCheck)
              ? saved.lastAutoCheck
              : 0,
        };
      },
    },
  ),
);
