import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface RecentLocation {
  profileId: string;
  revision: string;
  bucket: string;
  prefix: string;
  visitedAt: number;
}
const MAX_RECENT = 12;
export const recentLocationKey = (
  entry: Pick<RecentLocation, "profileId" | "bucket" | "prefix">,
) => JSON.stringify([entry.profileId, entry.bucket, entry.prefix]);
export function cleanRecentLocations(value: unknown): RecentLocation[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { profileId, revision, bucket, prefix, visitedAt } = item;
      if (
        typeof profileId !== "string" ||
        !profileId ||
        profileId.length > 256 ||
        typeof revision !== "string" ||
        !revision ||
        revision.length > 256 ||
        typeof bucket !== "string" ||
        !bucket ||
        bucket.length > 1024 ||
        typeof prefix !== "string" ||
        new TextEncoder().encode(prefix).length > 1024 ||
        typeof visitedAt !== "number" ||
        !Number.isFinite(visitedAt) ||
        !Number.isFinite(new Date(visitedAt).getTime())
      )
        return [];
      const entry = { profileId, revision, bucket, prefix, visitedAt };
      const key = recentLocationKey(entry);
      if (seen.has(key)) return [];
      seen.add(key);
      return [entry];
    })
    .slice(0, MAX_RECENT);
}

interface RecentState {
  entries: RecentLocation[];
  record: (entry: Omit<RecentLocation, "visitedAt">) => void;
}
export const useRecentLocationsStore = create<RecentState>()(
  persist(
    (set) => ({
      entries: [],
      record: (entry) =>
        set((state) => ({
          entries: cleanRecentLocations([
            { ...entry, visitedAt: Date.now() },
            ...state.entries.filter(
              (old) => recentLocationKey(old) !== recentLocationKey(entry),
            ),
          ]),
        })),
    }),
    {
      name: "object0-recent-locations",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ entries: cleanRecentLocations(state.entries) }),
      merge: (persisted, current) => ({
        ...current,
        entries: cleanRecentLocations(
          (persisted as { entries?: unknown } | undefined)?.entries,
        ),
      }),
    },
  ),
);
