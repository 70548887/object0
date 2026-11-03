import { useCallback } from "react";
import { parentDirectory } from "@/lib/file-navigation";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useTabStore,
  useUIStore,
  useVaultStore,
} from "@/stores";

/** Reject a stale address/row callback before it can navigate another scope. */
export function isNavigationScopeCurrent(
  profileId: string | null,
  bucket: string | null,
  prefix: string,
  revision: string | undefined,
) {
  if (!profileId || !bucket || !revision) return false;
  const vault = useVaultStore.getState();
  const saved = vault.profiles.find((profile) => profile.id === profileId);
  const tabs = useTabStore.getState();
  const tab = tabs.tabs.find((item) => item.id === tabs.activeTabId);
  return (
    vault.unlocked &&
    saved?.updatedAt === revision &&
    useProfileStore.getState().activeProfileId === profileId &&
    useProfileStore.getState().activeProfile?.updatedAt === revision &&
    useBucketStore.getState().selectedBucket === bucket &&
    useObjectStore.getState().currentPrefix === prefix &&
    tab?.profileId === profileId &&
    tab.bucket === bucket &&
    tab.prefix === prefix
  );
}

/** Persist only explicit folder navigation, never a stale render after tab switch. */
export function updateNavigationTab(
  profileId: string,
  bucket: string,
  prefix: string,
) {
  const state = useTabStore.getState();
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  if (tab?.profileId === profileId && tab.bucket === bucket)
    state.updateTabPrefix(tab.id, prefix);
}

/**
 * Convenience hook to manage S3 object listing with currently-selected
 * profile and bucket.
 */
export function useS3Objects() {
  const profileId = useProfileStore((s) => s.activeProfileId);
  const profileRevision = useProfileStore((s) => s.activeProfile?.updatedAt);
  const bucket = useBucketStore((s) => s.selectedBucket);
  const pageSize = useUIStore((s) => s.pageSize);
  const {
    objects,
    prefixes,
    loading,
    error,
    currentPrefix,
    isTruncated,
    nextCursor,
    selectedKeys,
    sortField,
    sortDir,
    filters,
    loadObjects,
    navigateToPrefix,
    navigateBack,
    navigateForward,
    setSort,
    setFilters,
    toggleSelect,
    selectAll,
    clearSelection,
    reset,
  } = useObjectStore();

  const refresh = useCallback(() => {
    if (
      !isNavigationScopeCurrent(
        profileId,
        bucket,
        currentPrefix,
        profileRevision,
      ) ||
      !profileId ||
      !bucket
    )
      return;
    loadObjects(profileId, bucket, currentPrefix, pageSize);
  }, [
    profileId,
    profileRevision,
    bucket,
    currentPrefix,
    pageSize,
    loadObjects,
  ]);

  const navigate = useCallback(
    (prefix: string) => {
      if (
        !isNavigationScopeCurrent(
          profileId,
          bucket,
          currentPrefix,
          profileRevision,
        )
      )
        return;
      navigateToPrefix(prefix);
      if (!profileId || !bucket) return;
      updateNavigationTab(profileId, bucket, prefix);
    },
    [profileId, profileRevision, bucket, currentPrefix, navigateToPrefix],
  );

  const goBack = useCallback(() => {
    if (
      !isNavigationScopeCurrent(
        profileId,
        bucket,
        useObjectStore.getState().currentPrefix,
        profileRevision,
      )
    )
      return;
    const history = useObjectStore.getState().prefixHistory;
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    navigateBack();
    if (!profileId || !bucket) return;
    updateNavigationTab(profileId, bucket, prev);
  }, [profileId, profileRevision, bucket, navigateBack]);

  const goForward = useCallback(() => {
    if (
      !isNavigationScopeCurrent(
        profileId,
        bucket,
        useObjectStore.getState().currentPrefix,
        profileRevision,
      )
    )
      return;
    const forward = useObjectStore.getState().prefixForward;
    if (forward.length === 0) return;
    const next = forward[forward.length - 1];
    navigateForward();
    if (!profileId || !bucket) return;
    updateNavigationTab(profileId, bucket, next);
  }, [profileId, profileRevision, bucket, navigateForward]);

  const goUp = useCallback(() => {
    const prefix = useObjectStore.getState().currentPrefix;
    if (!prefix) return;
    if (
      !isNavigationScopeCurrent(profileId, bucket, prefix, profileRevision) ||
      !profileId ||
      !bucket
    )
      return;
    const parent = parentDirectory(prefix);
    navigateToPrefix(parent);
    updateNavigationTab(profileId, bucket, parent);
  }, [profileId, profileRevision, bucket, navigateToPrefix]);

  const nextPage = useCallback(() => {
    if (
      !isNavigationScopeCurrent(
        profileId,
        bucket,
        currentPrefix,
        profileRevision,
      ) ||
      !profileId ||
      !bucket ||
      !nextCursor
    )
      return;
    loadObjects(profileId, bucket, currentPrefix, pageSize, nextCursor);
  }, [
    profileId,
    profileRevision,
    bucket,
    currentPrefix,
    pageSize,
    nextCursor,
    loadObjects,
  ]);

  return {
    objects,
    prefixes,
    loading,
    error,
    currentPrefix,
    isTruncated,
    selectedKeys,
    sortField,
    sortDir,
    filters,
    refresh,
    navigate,
    goBack,
    goForward,
    goUp,
    nextPage,
    setSort,
    setFilters,
    toggleSelect,
    selectAll,
    clearSelection,
    reset,
  };
}
