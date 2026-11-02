import type { ProfileInfo } from "@shared/profile.types";
import { useCallback } from "react";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useTabStore,
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
      if (activeProfileId && activeProfile) {
        openBucket(activeProfileId, activeProfile.name, bucket);
      }
    },
    [activeProfileId, activeProfile, openBucket],
  );

  const switchProfile = useCallback(
    (profile: ProfileInfo | null) => {
      resetObjects();
      setSelectedBucket(null);
      useTabStore.getState().setActiveTab(null);
      setActiveProfile(profile);
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
      const profiles = useVaultStore.getState().profiles;
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) return;
      // ContentArea binds the account and validates Qiniu discovery before load.
      openBucket(profileId, profile.name, bucket);
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
