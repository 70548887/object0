import type { ProfileInfo } from "@shared/profile.types";
import { useCallback } from "react";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useTabStore,
  useUIStore,
  useVaultStore,
} from "@/stores";

/**
 * Manages bucket selection lifecycle.
 * When a bucket is selected, loads its objects and opens a tab.
 * When profile changes, resets bucket/object state.
 */
export function useS3Buckets() {
  const {
    activeProfile,
    activeProfileId,
    buckets,
    bucketsLoading,
    error,
    setActiveProfile,
    loadBuckets,
  } = useProfileStore();
  const { selectedBucket, setSelectedBucket } = useBucketStore();
  const resetObjects = useObjectStore((s) => s.reset);
  const openBucket = useTabStore((s) => s.openBucket);

  const selectBucket = useCallback(
    (bucket: string) => {
      const live = useProfileStore.getState();
      const vault = useVaultStore.getState();
      if (
        activeProfileId &&
        activeProfile &&
        vault.unlocked &&
        live.activeProfileId === activeProfileId &&
        live.activeProfile?.updatedAt === activeProfile.updatedAt &&
        vault.profiles.some(
          (profile) =>
            profile.id === activeProfileId &&
            profile.updatedAt === activeProfile.updatedAt,
        )
      ) {
        openBucket(activeProfileId, activeProfile.name, bucket);
        useUIStore.getState().setMainSection("storage");
      }
    },
    [activeProfileId, activeProfile, openBucket],
  );

  const switchProfile = useCallback(
    (profile: ProfileInfo | null) => {
      if (profile) {
        const vault = useVaultStore.getState();
        if (
          !vault.unlocked ||
          !vault.profiles.some(
            (item) =>
              item.id === profile.id && item.updatedAt === profile.updatedAt,
          )
        )
          return;
      }
      resetObjects();
      setSelectedBucket(null);
      useTabStore.getState().setActiveTab(null);
      setActiveProfile(profile);
      useUIStore.getState().setMainSection("storage");
    },
    [setActiveProfile, setSelectedBucket, resetObjects],
  );

  const refreshBuckets = useCallback(() => {
    if (activeProfileId) {
      loadBuckets(activeProfileId);
    }
  }, [activeProfileId, loadBuckets]);

  /**
   * Open a favorited bucket, auto-switching to its profile if needed.
   */
  const selectFavoriteBucket = useCallback(
    (profileId: string, bucket: string) => {
      const { profiles, unlocked } = useVaultStore.getState();
      const profile = profiles.find((p) => p.id === profileId);
      if (!unlocked || !profile) return false;
      // ContentArea binds the account and validates Qiniu discovery before load.
      openBucket(profileId, profile.name, bucket);
      const state = useTabStore.getState();
      const tab = state.tabs.find((item) => item.id === state.activeTabId);
      if (tab?.profileId === profileId && tab.bucket === bucket) {
        useUIStore.getState().setMainSection("storage");
        return true;
      }
      return false;
    },
    [openBucket],
  );

  return {
    activeProfile,
    buckets,
    bucketsLoading,
    error,
    selectedBucket,
    selectBucket,
    selectFavoriteBucket,
    switchProfile,
    refreshBuckets,
  };
}
