import type { BucketInfo } from "@shared/s3.types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { t, useT } from "@/lib/i18n";
import { IconBucket, IconStar } from "@/lib/icons";
import { useFavoritesStore, useProfileStore } from "@/stores";

interface BucketListProps {
  buckets: BucketInfo[];
  loading: boolean;
  selectedBucket: string | null;
  profileId: string | null;
  onSelect: (bucket: string) => void;
}

export function BucketList({
  buckets,
  loading,
  selectedBucket,
  profileId,
  onSelect,
}: BucketListProps) {
  useT();
  const favorites = useFavoritesStore((s) => s.favorites);
  const toggleFavorite = useFavoritesStore((s) => s.toggleFavorite);
  const isQiniu = useProfileStore(
    (s) =>
      s.activeProfile?.id === profileId && s.activeProfile.provider === "qiniu",
  );

  if (loading) {
    return (
      <div className="space-y-1 px-2 py-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
            key={`skel-${i}`}
            className="flex items-center gap-2 rounded px-2 py-1.5"
          >
            <Skeleton className="h-3 w-3 rounded" />
            <Skeleton className="h-3 flex-1 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (buckets.length === 0) {
    return (
      <div className="px-3 py-4 text-center text-muted-foreground/60 text-xs">
        {t("未找到存储桶", "No buckets found")}
      </div>
    );
  }

  const isFav = (name: string) =>
    profileId ? favorites.has(`${profileId}:${name}`) : false;

  const pinned = buckets.filter((b) => isFav(b.name));
  const unpinned = buckets.filter((b) => !isFav(b.name));

  const renderBucket = (b: BucketInfo, showStar: boolean) => {
    const permissionLabel =
      b.permission === "readonly"
        ? t("只读", "Read only")
        : b.permission === "readwrite"
          ? t("可读写", "Read/write")
          : t("权限未确认", "Permissions unverified");
    const regionLabel = b.regionId ?? t("区域待发现", "Region pending");
    const title = isQiniu
      ? [
          b.name,
          `${t("区域", "Region")}: ${regionLabel}`,
          `${t("权限", "Permissions")}: ${permissionLabel}`,
          ...(b.remark ? [b.remark] : []),
        ].join("\n")
      : b.name;
    return (
      <li key={b.name}>
        <div
          className={`group/bucket flex w-full items-center gap-1 rounded-none text-sm ${b.name === selectedBucket ? "bg-accent text-accent-foreground" : ""}`}
        >
          <button
            type="button"
            title={title}
            className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-none px-3 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2"
            onClick={() => onSelect(b.name)}
          >
            <IconBucket className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
              <span className="block truncate">{b.name}</span>
              {isQiniu && (
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] leading-tight">
                  <span className="min-w-0 truncate text-muted-foreground">
                    {regionLabel}
                  </span>
                  <span
                    className={`min-w-0 max-w-[50%] truncate rounded px-1 py-px ${b.permission === "readonly" ? "bg-warning/10 text-warning" : b.permission === "readwrite" ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}
                  >
                    {permissionLabel}
                  </span>
                </span>
              )}
            </span>
          </button>
          {profileId && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={`size-6 shrink-0 group-data-[collapsible=icon]:hidden ${
                showStar
                  ? "text-warning"
                  : "opacity-0 group-hover/bucket:opacity-100 text-muted-foreground"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                toggleFavorite(profileId, b.name);
              }}
              title={
                showStar
                  ? t("取消固定存储桶", "Unpin bucket")
                  : t("固定存储桶", "Pin bucket")
              }
            >
              <IconStar
                className={`size-3 ${showStar ? "fill-current" : ""}`}
              />
            </Button>
          )}
        </div>
      </li>
    );
  };

  return (
    <ul className="w-full px-0">
      {/* Pinned section */}
      {pinned.length > 0 && (
        <>
          <li className="flex items-center gap-1 px-3 py-1 text-[10px] text-muted-foreground/60 group-data-[collapsible=icon]:hidden">
            <IconStar className="size-2.5" />
            {t("已固定", "Pinned")}
          </li>
          {pinned.map((b) => renderBucket(b, true))}
          {unpinned.length > 0 && (
            <li className="px-3 py-1 text-[10px] text-muted-foreground/60 group-data-[collapsible=icon]:hidden">
              {t("所有存储桶", "All Buckets")}
            </li>
          )}
        </>
      )}
      {/* Regular buckets */}
      {unpinned.map((b) => renderBucket(b, false))}
    </ul>
  );
}
