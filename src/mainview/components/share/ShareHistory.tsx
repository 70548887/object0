import type { ShareHistoryEntry } from "@shared/s3.types";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatRelativeDate, getFileName } from "@/lib/formatters";
import { t, useT } from "@/lib/i18n";
import {
  IconBroom,
  IconClockRotateLeft,
  IconCopy,
  IconLink,
  IconLinkSlash,
  IconTrash,
  IconXmark,
} from "@/lib/icons";
import { useShareHistoryStore, useUIStore } from "@/stores";
import { toast } from "../common/Toast";
import { shareLinkState } from "./share-expiration";

type FilterMode = "all" | "active" | "expired";
type Presentation = "sheet" | "workspace";

export function ShareHistory({
  presentation = "sheet",
}: {
  presentation?: Presentation;
} = {}) {
  const shareHistoryOpen = useUIStore((s) => s.shareHistoryOpen);
  const setShareHistoryOpen = useUIStore((s) => s.setShareHistoryOpen);
  if (presentation === "workspace") return <ShareHistoryPanel />;
  return (
    <Sheet open={shareHistoryOpen} onOpenChange={setShareHistoryOpen}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-[min(360px,100vw)] min-w-0 flex-col gap-0 p-0 sm:max-w-none"
      >
        <ShareHistoryPanel
          presentation="sheet"
          onClose={() => setShareHistoryOpen(false)}
        />
      </SheetContent>
    </Sheet>
  );
}

/** Shared record list for the workspace and the optional quick sheet. */
export function ShareHistoryPanel({
  presentation = "workspace",
  onClose,
}: {
  presentation?: Presentation;
  onClose?: () => void;
} = {}) {
  useT();
  const entries = useShareHistoryStore((s) => s.entries);
  const removeEntry = useShareHistoryStore((s) => s.removeEntry);
  const clearExpired = useShareHistoryStore((s) => s.clearExpired);
  const clearAll = useShareHistoryStore((s) => s.clearAll);
  const persistShareHistory = useUIStore((s) => s.persistShareHistory);
  const [filter, setFilter] = useState<FilterMode>("all");
  const [now, setNow] = useState(() => Date.now());

  // Viewing history never removes records. Refresh expiry labels and filters only.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  const filtered = useMemo(() => {
    switch (filter) {
      case "active":
        return entries.filter((e) =>
          ["active", "public"].includes(shareLinkState(e, now)),
        );
      case "expired":
        return entries.filter((e) => shareLinkState(e, now) === "expired");
      default:
        return entries;
    }
  }, [entries, filter, now]);
  const activeCount = entries.filter((e) =>
    ["active", "public"].includes(shareLinkState(e, now)),
  ).length;
  const expiredCount = entries.filter(
    (e) => shareLinkState(e, now) === "expired",
  ).length;

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("链接已复制！", "Link copied!"));
    } catch {
      toast.error(t("复制失败", "Copy failed"));
    }
  };

  const formatExpiry = (entry: ShareHistoryEntry): string => {
    const state = shareLinkState(entry, now);
    if (state === "public")
      return t("公开 · 无固定到期", "Public · No fixed expiry");
    if (state === "unknown" || !entry.expiresAt)
      return t("有效期未知", "Expiration unknown");
    if (state === "expired") return t("已过期", "Expired");
    const diff = new Date(entry.expiresAt).getTime() - now;
    if (diff < 3600000) {
      const mins = Math.round(diff / 60000);
      return t(`剩余 ${mins} 分钟`, `${mins} minutes left`);
    }
    if (diff < 86400000) {
      const hours = Math.round(diff / 3600000);
      return t(`剩余 ${hours} 小时`, `${hours} hours left`);
    }
    const days = Math.round(diff / 86400000);
    return t(`剩余 ${days} 天`, `${days} days left`);
  };

  const title = (
    <>
      <IconClockRotateLeft className="size-4 shrink-0 text-foreground/60" />
      <span className="min-w-0 break-words">
        {t("分享记录", "Sharing history")}
      </span>
      {entries.length > 0 && (
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-foreground/55">
          {entries.length}
        </span>
      )}
    </>
  );

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {presentation === "sheet" ? (
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0 border-border border-b px-4 py-3">
          <SheetTitle className="flex min-w-0 items-center gap-2 font-semibold text-sm">
            {title}
          </SheetTitle>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("关闭", "Close")}
            title={t("关闭", "Close")}
          >
            <IconXmark className="size-4" />
          </Button>
        </SheetHeader>
      ) : (
        <header className="shrink-0 border-border border-b px-4 py-3">
          <h1 className="flex min-w-0 items-center gap-2 font-semibold text-sm">
            {title}
          </h1>
        </header>
      )}

      {!persistShareHistory && (
        <p className="shrink-0 border-border border-b px-4 py-2 text-foreground/55 text-xs">
          {t(
            "尚未开启保存分享记录，新分享不会记录；已有记录仍显示。可在设置中开启。",
            "Saving sharing history is off. New shares are not recorded; existing records remain visible. Enable it in Settings.",
          )}
        </p>
      )}

      {entries.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-1 border-border border-b px-4 py-2">
          <Button
            variant={filter === "all" ? "default" : "ghost"}
            size="xs"
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            {t("全部（", "All (")}
            {entries.length})
          </Button>
          <Button
            variant={filter === "active" ? "default" : "ghost"}
            size="xs"
            aria-pressed={filter === "active"}
            onClick={() => setFilter("active")}
          >
            {t("有效（", "Active (")}
            {activeCount})
          </Button>
          <Button
            variant={filter === "expired" ? "default" : "ghost"}
            size="xs"
            aria-pressed={filter === "expired"}
            onClick={() => setFilter("expired")}
          >
            {t("已过期（", "Expired (")}
            {expiredCount})
          </Button>
        </div>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-foreground/40">
            <IconLinkSlash className="size-8" />
            <span className="text-sm">
              {entries.length === 0
                ? t("暂无分享记录", "No sharing history yet")
                : t("没有匹配记录", "No matching entries")}
            </span>
          </div>
        ) : (
          <ul className="min-w-0 divide-y divide-border">
            {filtered.map((entry) => {
              const state = shareLinkState(entry, now);
              const isExpired = state === "expired";
              const statusColor = isExpired
                ? "bg-warning/15 text-warning"
                : state === "unknown"
                  ? "bg-muted text-foreground/60"
                  : "bg-success/15 text-success";
              return (
                <li key={entry.id} className="flex min-w-0 gap-3 px-4 py-3">
                  {isExpired ? (
                    <IconLinkSlash className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  ) : (
                    <IconLink
                      className={`mt-0.5 size-3.5 shrink-0 ${state === "unknown" ? "text-foreground/50" : "text-success"}`}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="min-w-0 break-all font-medium text-xs">
                        {getFileName(entry.key)}
                      </span>
                      <span
                        className={`rounded-full px-1.5 py-px text-[10px] ${statusColor}`}
                      >
                        {formatExpiry(entry)}
                      </span>
                    </div>
                    <div className="mt-0.5 break-all text-[10px] text-foreground/50">
                      {entry.bucket}/{entry.key}
                    </div>
                    <div className="mt-0.5 text-[10px] text-foreground/50">
                      {t("分享时间 ", "Shared ")}
                      {formatRelativeDate(entry.createdAt)}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {!isExpired && (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="min-h-8"
                          onClick={() => handleCopy(entry.url)}
                          title={t("复制链接", "Copy link")}
                        >
                          <IconCopy className="size-3" />
                          {t("复制链接", "Copy link")}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="xs"
                        className="min-h-8 text-destructive"
                        onClick={() => removeEntry(entry.id)}
                        title={t("移除", "Remove")}
                      >
                        <IconTrash className="size-3" />
                        {t("移除", "Remove")}
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {entries.length > 0 && (
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-border border-t px-4 py-2">
          {expiredCount > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className="min-h-8 text-warning"
              onClick={clearExpired}
            >
              <IconBroom className="size-3" />
              {t("清除已过期（", "Clear expired (")}
              {expiredCount})
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            className="min-h-8 text-destructive"
            onClick={clearAll}
          >
            <IconTrash className="size-3" />
            {t("全部清除", "Clear all")}
          </Button>
        </footer>
      )}
    </section>
  );
}
