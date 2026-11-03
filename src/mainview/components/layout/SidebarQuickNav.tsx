import type { ProfileInfo } from "@shared/profile.types";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { t, useT } from "@/lib/i18n";
import {
  IconClock,
  IconClockRotateLeft,
  IconFolder,
  IconListCheck,
  IconStar,
} from "@/lib/icons";
import {
  useBucketStore,
  useJobStore,
  useObjectStore,
  useProfileStore,
  useShareHistoryStore,
  useTabStore,
  useUIStore,
  useVaultStore,
} from "@/stores";
import {
  type RecentLocation,
  useRecentLocationsStore,
} from "@/stores/useRecentLocationsStore";
import type { MainSection } from "@/stores/useUIStore";
import { useSidebar } from "../ui/sidebar";

interface Props {
  profiles: ProfileInfo[];
  favorites: { profileId: string; bucket: string }[];
  onSelectBucket: (profileId: string, bucket: string) => void;
  onToggleFavorite: (profileId: string, bucket: string) => void;
  onShowStorage: () => void;
}

/** Recent records are navigation hints only; ContentArea still validates the
 * selected account and Qiniu bucket discovery before any list request. */
export function openRecentLocation(
  entry: RecentLocation,
  onSelectBucket: Props["onSelectBucket"],
) {
  const vault = useVaultStore.getState();
  const profile = vault.profiles.find((item) => item.id === entry.profileId);
  if (!vault.unlocked || !profile || profile.updatedAt !== entry.revision)
    return false;
  onSelectBucket(entry.profileId, entry.bucket);
  const state = useTabStore.getState();
  const tab = state.tabs.find((item) => item.id === state.activeTabId);
  if (tab?.profileId !== entry.profileId || tab.bucket !== entry.bucket)
    return false;
  state.updateTabPrefix(tab.id, entry.prefix);
  useUIStore.getState().setMainSection("storage");
  return true;
}

export function SidebarQuickNav({ profiles, favorites, onShowStorage }: Props) {
  useT();
  const { isMobile, setOpenMobile } = useSidebar();
  const mainSection = useUIStore((s) => s.mainSection);
  const setMainSection = useUIStore((s) => s.setMainSection);
  const profileId = useProfileStore((s) => s.activeProfileId);
  const bucket = useBucketStore((s) => s.selectedBucket);
  const prefix = useObjectStore((s) => s.currentPrefix);
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const unlocked = useVaultStore((s) => s.unlocked);
  const record = useRecentLocationsStore((s) => s.record);
  const jobs = useJobStore((s) => s.jobs);
  const shareCount = useShareHistoryStore((s) => s.entries.length);
  const activeJobs = jobs.filter(
    (job) => job.status === "running" || job.status === "queued",
  ).length;
  const profile = profiles.find((item) => item.id === profileId);
  const validFavorites = favorites.filter((entry) =>
    profiles.some((item) => item.id === entry.profileId),
  );
  useEffect(() => {
    const tab = tabs.find((item) => item.id === activeTabId);
    if (
      mainSection === "storage" &&
      unlocked &&
      profile?.updatedAt &&
      bucket &&
      tab?.profileId === profile.id &&
      tab.bucket === bucket &&
      tab.prefix === prefix
    )
      record({
        profileId: profile.id,
        revision: profile.updatedAt,
        bucket,
        prefix,
      });
  }, [
    mainSection,
    unlocked,
    profile?.id,
    profile?.updatedAt,
    bucket,
    prefix,
    tabs,
    activeTabId,
    record,
  ]);
  const classes =
    "h-8 w-full justify-start gap-2.5 rounded-lg px-2.5 text-xs group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-1";
  const items: {
    section: MainSection;
    label: string;
    title: string;
    icon: typeof IconFolder;
    count?: number;
  }[] = [
    {
      section: "storage",
      label: t("我的存储", "My storage"),
      title: t("浏览存储账号与空间", "Browse storage accounts and buckets"),
      icon: IconFolder,
    },
    {
      section: "favorites",
      label: t("收藏", "Favorites"),
      title: t("收藏的存储桶", "Favorite buckets"),
      icon: IconStar,
      count: validFavorites.length,
    },
    {
      section: "recent",
      label: t("最近", "Recent"),
      title: t("最近访问的位置", "Recently visited locations"),
      icon: IconClock,
    },
    {
      section: "transfers",
      label: t("传输列表", "Transfers"),
      title: t("查看传输任务与历史", "View transfer jobs and history"),
      icon: IconListCheck,
      count: activeJobs || undefined,
    },
    {
      section: "shares",
      label: t("分享记录", "Sharing history"),
      title: t("查看分享记录", "View sharing history"),
      icon: IconClockRotateLeft,
      count: shareCount || undefined,
    },
  ];
  return (
    <nav
      aria-label={t("存储导航", "Storage navigation")}
      className="shrink-0 space-y-0.5 px-2 py-1 group-data-[collapsible=icon]:px-1"
    >
      {items.map(({ section, label, title, icon: Icon, count }) => (
        <Button
          key={section}
          type="button"
          variant="ghost"
          className={`${classes}${mainSection === section ? " bg-primary/8 text-primary" : ""}`}
          aria-current={mainSection === section ? "page" : undefined}
          aria-label={title}
          title={title}
          onClick={() => {
            setMainSection(section);
            if (section === "storage") onShowStorage();
            if (isMobile) setOpenMobile(false);
          }}
        >
          <Icon className="size-4 shrink-0" />
          <span className="truncate group-data-[collapsible=icon]:hidden">
            {label}
          </span>
          {count !== undefined && (
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground group-data-[collapsible=icon]:hidden">
              {count}
            </span>
          )}
        </Button>
      ))}
    </nav>
  );
}
