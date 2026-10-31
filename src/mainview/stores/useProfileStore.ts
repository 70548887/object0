import type { ProfileInfo } from "@shared/profile.types";
import type { BucketInfo } from "@shared/s3.types";
import { create } from "zustand";
import { rpcCall } from "@/lib/rpc-client";

interface ProfileState {
  activeProfileId: string | null;
  activeProfile: ProfileInfo | null;
  buckets: BucketInfo[];
  bucketsLoading: boolean;
  error: string | null;

  setActiveProfile: (profile: ProfileInfo | null) => void;
  loadBuckets: (profileId: string) => Promise<void>;
  clearBuckets: () => void;
}

export const useProfileStore = create<ProfileState>()((set, get) => {
  let bucketRequestGeneration = 0;

  return {
    activeProfileId: null,
    activeProfile: null,
    buckets: [],
    bucketsLoading: false,
    error: null,

    setActiveProfile: (profile) => {
      bucketRequestGeneration += 1;
      set({
        activeProfileId: profile?.id ?? null,
        activeProfile: profile,
        buckets: [],
        bucketsLoading: false,
        error: null,
      });
      if (profile) {
        void get().loadBuckets(profile.id);
      }
    },

    loadBuckets: async (profileId) => {
      if (get().activeProfileId !== profileId) return;
      const requestGeneration = ++bucketRequestGeneration;
      const isCurrentRequest = () =>
        requestGeneration === bucketRequestGeneration &&
        get().activeProfileId === profileId;
      try {
        set({ bucketsLoading: true, error: null });
        const buckets = await rpcCall("buckets:list", { profileId });
        if (!isCurrentRequest()) return;
        set({ buckets, bucketsLoading: false });
      } catch (err: unknown) {
        if (!isCurrentRequest()) return;
        set({
          error:
            err instanceof Error
              ? err.message
              : typeof err === "string" && err.trim()
                ? err
                : "未知错误",
          bucketsLoading: false,
        });
      }
    },

    clearBuckets: () => {
      bucketRequestGeneration += 1;
      set({
        buckets: [],
        bucketsLoading: false,
        error: null,
        activeProfileId: null,
        activeProfile: null,
      });
    },
  };
});
