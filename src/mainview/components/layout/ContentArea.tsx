import { useEffect } from "react";
import { IconBoxOpen, IconCloud } from "@/lib/icons";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useTabStore,
  useVaultStore,
} from "@/stores";
import { EmptyState } from "../common/EmptyState";
import { DropZone } from "../objects/DropZone";
import { ObjectBrowser } from "../objects/ObjectBrowser";

export function ContentArea() {
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const setActiveProfile = useProfileStore((s) => s.setActiveProfile);
  const bucket = useBucketStore((s) => s.selectedBucket);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const tabs = useTabStore((s) => s.tabs);
  const setSelectedBucket = useBucketStore((s) => s.setSelectedBucket);
  const loadObjects = useObjectStore((s) => s.loadObjects);
  const navigateToPrefix = useObjectStore((s) => s.navigateToPrefix);
  const profiles = useVaultStore((s) => s.profiles);

  // Sync stores when active tab changes — switch profile + bucket + prefix
  // biome-ignore lint/correctness/useExhaustiveDependencies: only run on tab switch
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;

    const currentProfileId = useProfileStore.getState().activeProfileId;
    const currentBucket = useBucketStore.getState().selectedBucket;
    const currentPrefix = useObjectStore.getState().currentPrefix;

    // Switch profile if it differs from the tab's profile
    const profileChanged = tab.profileId !== currentProfileId;
    if (profileChanged) {
      const profile = profiles.find((p) => p.id === tab.profileId);
      if (profile) {
        setActiveProfile(profile);
      }
    }

    if (
      profileChanged ||
      tab.bucket !== currentBucket ||
      tab.prefix !== currentPrefix
    ) {
      setSelectedBucket(tab.bucket);
      navigateToPrefix(tab.prefix);
      loadObjects(tab.profileId, tab.bucket, tab.prefix);
    }
  }, [activeTabId]);

  if (!activeProfile) {
    return (
      <div className="flex-1 overflow-auto">
        <EmptyState
          icon={<IconCloud className="size-12" />}
          title={"欢迎使用 object0"}
          description={"从侧栏选择或添加存储账号以开始使用。"}
          hint={"存储账号的凭据保存在本机密码库中。"}
        />
      </div>
    );
  }

  if (!bucket) {
    return (
      <div className="flex-1 overflow-auto">
        <EmptyState
          icon={<IconBoxOpen className="size-12" />}
          title={"尚未选择存储桶"}
          description={"从侧栏选择存储桶以浏览其中的文件。"}
          hint={"提示：收藏常用存储桶后可以快速访问。"}
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
