import { PROVIDER_LABELS, type ProfileInfo } from "@shared/profile.types";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useS3Buckets } from "@/hooks/useS3Buckets";
import { t, useT } from "@/lib/i18n";
import { IconBucket, IconClock, IconFolder, IconStar } from "@/lib/icons";
import { useFavoritesStore, useVaultStore } from "@/stores";
import {
  recentLocationKey,
  useRecentLocationsStore,
} from "@/stores/useRecentLocationsStore";
import type { MainSection } from "@/stores/useUIStore";
import { JobPanel } from "../jobs/JobPanel";
import { ShareHistory } from "../share/ShareHistory";
import { openRecentLocation } from "./SidebarQuickNav";

interface Props {
  section: Exclude<MainSection, "storage">;
}

function visitDate(timestamp: unknown): Date | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Navigation-only pages. Object shortcuts, drop targets and writes live in the
 * storage workspace, never in this cross-account index. */
export function NavigationWorkspace({ section }: Props) {
  useT();
  const profiles = useVaultStore((state) => state.profiles);
  const favorites = useFavoritesStore((state) => state.favorites);
  const toggleFavorite = useFavoritesStore((state) => state.toggleFavorite);
  const entries = useRecentLocationsStore((state) => state.entries);
  const { selectFavoriteBucket } = useS3Buckets();
  const [notice, setNotice] = useState<string | null>(null);
  const validFavorites = [...favorites].flatMap((key) => {
    const separator = key.indexOf(":");
    if (separator < 1) return [];
    const profile = profiles.find(
      (item) => item.id === key.slice(0, separator),
    );
    return profile ? [{ profile, bucket: key.slice(separator + 1) }] : [];
  });
  const recent = entries.flatMap((entry) => {
    const profile = profiles.find(
      (item) =>
        item.id === entry.profileId && item.updatedAt === entry.revision,
    );
    return profile
      ? [{ entry, profile, visitedDate: visitDate(entry.visitedAt) }]
      : [];
  });
  const mismatch = () =>
    setNotice(
      t(
        "此位置的账号已变化或未能打开，请从存储账号重新选择。",
        "This location's account changed or could not be opened. Select it again from your storage accounts.",
      ),
    );
  const isCurrent = (profile: ProfileInfo) => {
    const vault = useVaultStore.getState();
    return (
      vault.unlocked &&
      vault.profiles.some(
        (item) =>
          item.id === profile.id && item.updatedAt === profile.updatedAt,
      )
    );
  };
  if (section === "shares") {
    return (
      <section
        aria-label={t("分享记录", "Sharing history")}
        data-testid="navigation-workspace-shares"
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        <ShareHistory presentation="workspace" />
      </section>
    );
  }
  if (section === "transfers") {
    return (
      <section
        aria-label={t("传输列表", "Transfers")}
        data-testid="navigation-workspace-transfers"
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        <JobPanel presentation="workspace" />
      </section>
    );
  }
  const isFavorites = section === "favorites";
  const title = isFavorites
    ? t("收藏", "Favorites")
    : t("最近访问", "Recently visited");
  const count = isFavorites ? validFavorites.length : recent.length;
  const EmptyIcon = isFavorites ? IconStar : IconClock;
  return (
    <section
      aria-label={title}
      data-testid={`navigation-workspace-${section}`}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <header className="shrink-0 border-b border-border px-4 py-4 sm:px-6">
        <h1 className="flex min-w-0 items-center gap-2 text-base font-semibold">
          <EmptyIcon className="size-4 shrink-0 text-primary" />
          <span className="truncate">{title}</span>
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
            {count}
          </span>
        </h1>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {isFavorites
            ? t(
                "跨账号查看收藏的存储桶。",
                "Favorite buckets across your storage accounts.",
              )
            : t(
                "继续访问最近打开的存储桶和目录。",
                "Return to recently visited buckets and folders.",
              )}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
        {notice && (
          <p
            role="alert"
            className="mb-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs leading-relaxed text-warning"
          >
            {notice}
          </p>
        )}
        {!isFavorites && entries.length > recent.length && (
          <p
            role="status"
            className="mb-3 text-xs leading-relaxed text-muted-foreground"
          >
            {t(
              "账号已删除或配置已变化的历史位置已隐藏，请从存储账号重新选择。",
              "History for removed or changed accounts is hidden. Select those locations again from your storage accounts.",
            )}
          </p>
        )}
        {count === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-6 text-center">
            <EmptyIcon className="size-8 text-muted-foreground/50" />
            <p className="text-sm font-medium">
              {isFavorites
                ? t("暂无收藏", "No favorites yet")
                : t("暂无最近访问", "No recent locations yet")}
            </p>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              {isFavorites
                ? t(
                    "点击存储桶旁的星标即可添加到这里。",
                    "Star a bucket to add it here.",
                  )
                : t(
                    "访问存储桶或目录后会显示在这里。",
                    "Visited buckets and folders will appear here.",
                  )}
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {isFavorites
              ? validFavorites.map(({ profile, bucket }) => (
                  <li
                    key={JSON.stringify([profile.id, bucket])}
                    className="min-w-0 rounded-xl border border-border bg-card p-3 sm:p-4"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <IconBucket className="size-4 shrink-0 text-primary" />
                      <h2
                        className="min-w-0 flex-1 truncate text-sm font-medium"
                        title={bucket}
                      >
                        {bucket}
                      </h2>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-warning"
                        aria-label={t("取消收藏", "Remove favorite")}
                        title={t("取消收藏", "Remove favorite")}
                        onClick={() => toggleFavorite(profile.id, bucket)}
                      >
                        <IconStar className="size-4 fill-current" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => {
                          if (
                            !isCurrent(profile) ||
                            !selectFavoriteBucket(profile.id, bucket)
                          )
                            mismatch();
                        }}
                      >
                        {t("打开", "Open")}
                      </Button>
                    </div>
                    <AccountMetadata profile={profile} />
                  </li>
                ))
              : recent.map(({ entry, profile, visitedDate }) => (
                  <li
                    key={recentLocationKey(entry)}
                    className="min-w-0 rounded-xl border border-border bg-card p-3 sm:p-4"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <IconBucket className="size-4 shrink-0 text-primary" />
                      <h2
                        className="min-w-0 flex-1 truncate text-sm font-medium"
                        title={entry.bucket}
                      >
                        {entry.bucket}
                      </h2>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => {
                          if (!openRecentLocation(entry, selectFavoriteBucket))
                            mismatch();
                        }}
                      >
                        {t("打开", "Open")}
                      </Button>
                    </div>
                    <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      <IconFolder className="size-3.5 shrink-0" />
                      <span
                        className="min-w-0 truncate"
                        title={entry.prefix || "/"}
                      >
                        {entry.prefix || t("根目录 /", "Root /")}
                      </span>
                    </div>
                    <AccountMetadata profile={profile} />
                    <p className="mt-2 truncate text-[11px] text-muted-foreground">
                      {t("访问时间", "Visited")}
                      {" · "}
                      <time dateTime={visitedDate?.toISOString()}>
                        {visitedDate
                          ? visitedDate.toLocaleString(t("zh-CN", "en-US"))
                          : t("未知时间", "Unknown time")}
                      </time>
                    </p>
                  </li>
                ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AccountMetadata({ profile }: { profile: ProfileInfo }) {
  return (
    <dl className="mt-2 grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
      <div className="flex min-w-0 gap-1.5">
        <dt className="shrink-0">{t("账号", "Account")}</dt>
        <dd className="min-w-0 truncate" title={profile.name}>
          {profile.name}
        </dd>
      </div>
      <div className="flex min-w-0 gap-1.5">
        <dt className="shrink-0">{t("服务商", "Provider")}</dt>
        <dd
          className="min-w-0 truncate"
          title={PROVIDER_LABELS[profile.provider]}
        >
          {PROVIDER_LABELS[profile.provider]}
        </dd>
      </div>
    </dl>
  );
}
