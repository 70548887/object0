import type { ProfileInfo } from "@shared/profile.types";
import type { BucketInfo } from "@shared/s3.types";
import { create } from "zustand";
import { rpcCall } from "@/lib/rpc-client";
import { useBucketStore } from "./useBucketStore";
import { useObjectStore } from "./useObjectStore";
import { useTabStore } from "./useTabStore";
import { useUIStore } from "./useUIStore";

interface ProfileState {
  activeProfileId: string | null;
  activeProfile: ProfileInfo | null;
  buckets: BucketInfo[];
  bucketsLoading: boolean;
  bucketsLoaded: boolean;
  error: string | null;

  setActiveProfile: (profile: ProfileInfo | null) => void;
  adoptConnectedProfile: (profile: ProfileInfo, buckets: BucketInfo[]) => void;
  loadBuckets: (profileId: string) => Promise<void>;
  clearBuckets: () => void;
  reconcileActiveProfile: (profiles: readonly ProfileInfo[]) => void;
}

/** Reconcile only a successfully listed Qiniu account, never a failed request. */
function reconcileQiniuBuckets(profile: ProfileInfo, buckets: BucketInfo[]) {
  if (profile.provider !== "qiniu") return;
  const canonical = (name: string) =>
    buckets.find((bucket) => bucket.name === name)?.name ??
    buckets.find((bucket) => bucket.s3Name === name)?.name;
  useTabStore.setState((state) => {
    const tabs = state.tabs.flatMap((tab) => {
      if (tab.profileId !== profile.id) return [tab];
      const bucket = canonical(tab.bucket);
      if (!bucket) return [];
      return [{ ...tab, bucket, profileName: profile.name }];
    });
    return {
      tabs,
      activeTabId: tabs.some((tab) => tab.id === state.activeTabId)
        ? state.activeTabId
        : null,
    };
  });
  const selected = useBucketStore.getState().selectedBucket;
  if (selected && canonical(selected) !== selected) {
    // Clear old keys/actions instead of silently reusing them under a new name.
    useBucketStore.getState().setSelectedBucket(null);
    useObjectStore.getState().reset();
    useUIStore.getState().setDetailKey(null);
    useUIStore.getState().closeTransferDialog();
    if (useUIStore.getState().shareTarget?.profileId === profile.id)
      useUIStore.getState().closeShareDialog();
  }
}

export const useProfileStore = create<ProfileState>()((set, get) => {
  let bucketRequestGeneration = 0;

  return {
    activeProfileId: null,
    activeProfile: null,
    buckets: [],
    bucketsLoading: false,
    bucketsLoaded: false,
    error: null,

    reconcileActiveProfile: (profiles) => {
      const current = get().activeProfile;
      if (!current) return;
      const replacement = profiles.find((profile) => profile.id === current.id);
      if (
        replacement &&
        JSON.stringify(replacement) === JSON.stringify(current)
      )
        return;

      // A saved id can now refer to another provider, environment, or set of
      // credentials. Old object keys, capabilities, tabs and dialog targets
      // must not silently become actions against this replacement identity.
      useObjectStore.getState().reset();
      useBucketStore.getState().setSelectedBucket(null);
      useUIStore.getState().setDetailKey(null);
      useUIStore.getState().closeTransferDialog();
      if (useUIStore.getState().shareTarget?.profileId === current.id)
        useUIStore.getState().closeShareDialog();
      useTabStore.setState((state) => {
        const removed = new Set(
          state.tabs
            .filter((tab) => tab.profileId === current.id)
            .map((tab) => tab.id),
        );
        return {
          tabs: state.tabs.filter((tab) => !removed.has(tab.id)),
          activeTabId:
            state.activeTabId && removed.has(state.activeTabId)
              ? null
              : state.activeTabId,
        };
      });
      get().setActiveProfile(replacement ?? null);
    },

    setActiveProfile: (profile) => {
      bucketRequestGeneration += 1;
      useObjectStore.getState().reset();
      useBucketStore.getState().setSelectedBucket(null);
      useUIStore.getState().setDetailKey(null);
      useUIStore.getState().closeTransferDialog();
      useUIStore.getState().closeShareDialog();
      set({
        activeProfileId: profile?.id ?? null,
        activeProfile: profile,
        buckets: [],
        bucketsLoading: false,
        bucketsLoaded: false,
        error: null,
      });
      if (profile) {
        void get().loadBuckets(profile.id);
      }
    },

    adoptConnectedProfile: (profile, buckets) => {
      bucketRequestGeneration += 1;
      useObjectStore.getState().reset();
      useBucketStore.getState().setSelectedBucket(null);
      useUIStore.getState().setDetailKey(null);
      useUIStore.getState().closeTransferDialog();
      if (useUIStore.getState().shareTarget)
        useUIStore.getState().closeShareDialog();
      // Keep other accounts' tabs for later, but the newly connected account
      // is currently showing its bucket list rather than an old active tab.
      useTabStore.setState({ activeTabId: null });
      reconcileQiniuBuckets(profile, buckets);
      set({
        activeProfileId: profile.id,
        activeProfile: profile,
        buckets: [...buckets],
        bucketsLoading: false,
        bucketsLoaded: true,
        error: null,
      });
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
        const profile = get().activeProfile;
        if (profile) reconcileQiniuBuckets(profile, buckets);
        set({ buckets, bucketsLoading: false, bucketsLoaded: true });
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
          bucketsLoaded: false,
        });
      }
    },

    clearBuckets: () => {
      bucketRequestGeneration += 1;
      set({
        buckets: [],
        bucketsLoading: false,
        bucketsLoaded: false,
        error: null,
        activeProfileId: null,
        activeProfile: null,
      });
    },
  };
});
