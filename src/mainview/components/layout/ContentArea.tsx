import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { t, useT } from "@/lib/i18n";
import { IconBoxOpen, IconCloud } from "@/lib/icons";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useTabStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import { EmptyState } from "../common/EmptyState";
import { DropZone } from "../objects/DropZone";
import { ObjectBrowser } from "../objects/ObjectBrowser";

export function ContentArea() {
  useT();
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const setActiveProfile = useProfileStore((s) => s.setActiveProfile);
  const bucket = useBucketStore((s) => s.selectedBucket);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const tabs = useTabStore((s) => s.tabs);
  const setSelectedBucket = useBucketStore((s) => s.setSelectedBucket);
  const loadObjects = useObjectStore((s) => s.loadObjects);
  const navigateToPrefix = useObjectStore((s) => s.navigateToPrefix);
  const profiles = useVaultStore((s) => s.profiles);
  const buckets = useProfileStore((s) => s.buckets);
  const bucketsLoaded = useProfileStore((s) => s.bucketsLoaded);
  const bucketsLoading = useProfileStore((s) => s.bucketsLoading);
  const bucketError = useProfileStore((s) => s.error);
  const loadBuckets = useProfileStore((s) => s.loadBuckets);

  // A persisted tab is a navigation hint, not proof that its account/bucket
  // still exists. Qiniu discovery must finish before requesting its objects.
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) {
      useTabStore.getState().setActiveTab(null);
      return;
    }
    const profile = profiles.find((p) => p.id === tab.profileId);
    if (!profile) {
      setSelectedBucket(null);
      useObjectStore.getState().reset();
      useUIStore.getState().setDetailKey(null);
      useUIStore.getState().closeTransferDialog();
      useUIStore.getState().closeShareDialog();
      useTabStore.setState((state) => ({
        tabs: state.tabs.filter((item) => item.id !== tab.id),
        activeTabId: null,
      }));
      return;
    }

    const currentProfileId = activeProfile?.id;
    const currentBucket = useBucketStore.getState().selectedBucket;
    const currentPrefix = useObjectStore.getState().currentPrefix;

    // Switch profile if it differs from the tab's profile
    const profileChanged =
      tab.profileId !== currentProfileId ||
      profile.updatedAt !== activeProfile?.updatedAt;
    if (profileChanged) {
      setActiveProfile(profile);
      return;
    }

    if (profile.provider === "qiniu") {
      if (bucketsLoading || !bucketsLoaded || bucketError) return;
      const resolved =
        buckets.find((item) => item.name === tab.bucket) ??
        buckets.find((item) => item.s3Name === tab.bucket);
      if (!resolved) {
        setSelectedBucket(null);
        useObjectStore.getState().reset();
        useUIStore.getState().setDetailKey(null);
        useUIStore.getState().closeTransferDialog();
        useUIStore.getState().closeShareDialog();
        useTabStore.setState((state) => ({
          tabs: state.tabs.filter((item) => item.id !== tab.id),
          activeTabId: null,
        }));
        return;
      }
      if (resolved.name !== tab.bucket) {
        useTabStore.setState((state) => ({
          tabs: state.tabs.map((item) =>
            item.id === tab.id ? { ...item, bucket: resolved.name } : item,
          ),
        }));
        return;
      }
    }

    if (tab.bucket !== currentBucket || tab.prefix !== currentPrefix) {
      // Clear old rows/actions before their UI can bind to the new bucket.
      useObjectStore.getState().reset();
      useUIStore.getState().setDetailKey(null);
      useUIStore.getState().closeTransferDialog();
      useUIStore.getState().closeShareDialog();
      setSelectedBucket(tab.bucket);
      navigateToPrefix(tab.prefix);
      loadObjects(tab.profileId, tab.bucket, tab.prefix);
    }
  }, [
    activeTabId,
    tabs,
    profiles,
    activeProfile,
    buckets,
    bucketsLoaded,
    bucketsLoading,
    bucketError,
    setActiveProfile,
    setSelectedBucket,
    navigateToPrefix,
    loadObjects,
  ]);

  if (!activeProfile) {
    return (
      <div className="flex-1 overflow-auto">
        <EmptyState
          icon={<IconCloud className="size-12" />}
          title={t("欢迎使用 云仓", "Welcome to Yuncang")}
          description={t(
            "从侧栏选择或添加存储账号以开始使用。",
            "Select or add a profile from the sidebar to get started.",
          )}
          hint={t(
            "账号凭据以明文保存在本机账号文件中，请勿共享该文件。",
            "Account credentials are stored in the local plaintext account file. Do not share that file.",
          )}
        />
      </div>
    );
  }

  if (
    activeProfile.provider === "qiniu" &&
    (!bucketsLoaded || bucketsLoading || bucketError)
  ) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p
          role={bucketError ? "alert" : "status"}
          className="text-sm text-muted-foreground"
        >
          {bucketError
            ? t(
                "空间列表读取失败，请重试；不会将旧标签当作可访问空间。",
                "Could not load buckets. Retry; saved tabs do not establish bucket access.",
              )
            : t("正在核对当前账号的空间…", "Checking this account's buckets…")}
        </p>
        {bucketError && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadBuckets(activeProfile.id)}
          >
            {t("重试", "Retry")}
          </Button>
        )}
      </div>
    );
  }

  if (!bucket) {
    return (
      <div className="flex-1 overflow-auto">
        <EmptyState
          icon={<IconBoxOpen className="size-12" />}
          title={t("尚未选择存储桶", "No bucket selected")}
          description={t(
            "从侧栏选择存储桶以浏览其中的文件。",
            "Choose a bucket from the sidebar to browse its contents.",
          )}
          hint={t(
            "提示：收藏常用存储桶后可以快速访问。",
            "Tip: Star your favorite buckets for quick access.",
          )}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden">
      <DropZone>
        <ObjectBrowser />
      </DropZone>
    </div>
  );
}
