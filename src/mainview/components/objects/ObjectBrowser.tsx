import { useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { useS3Objects } from "@/hooks";
import { getFileName } from "@/lib/formatters";
import { localize, t, useT } from "@/lib/i18n";
import {
  IconArrowLeft,
  IconFolderOpen,
  IconMagnifyingGlass,
  IconTriangleExclamation,
} from "@/lib/icons";
import {
  useBucketStore,
  useObjectStore,
  useProfileStore,
  useUIStore,
} from "@/stores";
import { EmptyState } from "../common/EmptyState";
import { ObjectGrid } from "./ObjectGrid";
import { ObjectTable } from "./ObjectTable";

export function ObjectBrowser() {
  useT();
  const profileId = useProfileStore((s) => s.activeProfileId);
  const bucket = useBucketStore((s) => s.selectedBucket);
  const hasPreviousPage = useObjectStore((s) => s.pageHistory.length > 0);
  const viewMode = useUIStore((s) => s.viewMode);
  const {
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
    nextPage,
    setSort,
    toggleSelect,
    selectAll,
    clearSelection,
  } = useS3Objects();

  // Load objects when profile/bucket change
  useEffect(() => {
    if (profileId && bucket) {
      refresh();
    }
  }, [profileId, bucket, refresh]);

  // Apply client-side search filter
  const searchTerm = filters.search.toLowerCase();
  const filteredObjects = useMemo(
    () =>
      searchTerm
        ? objects.filter((o) =>
            getFileName(o.key).toLowerCase().includes(searchTerm),
          )
        : objects,
    [objects, searchTerm],
  );
  const filteredPrefixes = useMemo(
    () =>
      searchTerm
        ? prefixes.filter((p) => {
            const name = p.prefix.split("/").filter(Boolean).pop() ?? "";
            return name.toLowerCase().includes(searchTerm);
          })
        : prefixes,
    [prefixes, searchTerm],
  );

  if (error) {
    return (
      <EmptyState
        icon={<IconTriangleExclamation className="size-12 opacity-40" />}
        title={t("加载文件失败", "Failed to load files")}
        description={localize(error)}
        action={
          <Button size="sm" onClick={refresh}>
            {t("重试", "Retry")}
          </Button>
        }
      />
    );
  }

  if (loading && objects.length === 0) {
    return (
      <div className="flex-1 overflow-auto">
        <table className="w-full caption-bottom text-sm">
          <thead className="[&_tr]:border-b sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
            <tr>
              <th className="h-10 px-2 text-left align-middle font-medium w-8">
                <div className="size-3 animate-pulse rounded bg-muted-foreground/20" />
              </th>
              <th className="h-10 px-2 text-left align-middle font-medium">
                <div className="h-3 w-16 animate-pulse rounded bg-muted-foreground/20" />
              </th>
              <th className="h-10 px-2 text-left align-middle font-medium w-24">
                <div className="h-3 w-10 animate-pulse rounded bg-muted-foreground/20" />
              </th>
              <th className="h-10 px-2 text-left align-middle font-medium w-36">
                <div className="h-3 w-14 animate-pulse rounded bg-muted-foreground/20" />
              </th>
            </tr>
          </thead>
          <tbody className="[&_tr:last-child]:border-0">
            {Array.from({ length: 12 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
              <tr key={`skel-${i}`} className="border-b">
                <td className="p-2 align-middle">
                  <div className="size-3 animate-pulse rounded bg-muted-foreground/20" />
                </td>
                <td className="p-2 align-middle">
                  <div className="flex items-center gap-2">
                    <div className="size-3.5 animate-pulse rounded bg-muted-foreground/20" />
                    <div
                      className="h-3 animate-pulse rounded bg-muted-foreground/20"
                      style={{ width: `${100 + ((i * 17) % 160)}px` }}
                    />
                  </div>
                </td>
                <td className="p-2 align-middle">
                  <div className="ml-auto h-3 w-12 animate-pulse rounded bg-muted-foreground/20" />
                </td>
                <td className="p-2 align-middle">
                  <div className="ml-auto h-3 w-16 animate-pulse rounded bg-muted-foreground/20" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (objects.length === 0 && prefixes.length === 0 && !isTruncated) {
    return (
      <EmptyState
        icon={<IconFolderOpen className="size-12 opacity-40" />}
        title={
          hasPreviousPage
            ? t("本页暂无条目", "No entries on this page")
            : currentPrefix
              ? t("文件夹为空", "Folder is empty")
              : t("存储桶为空", "Bucket is empty")
        }
        description={
          hasPreviousPage
            ? t(
                "已到分页末尾；这不表示整个存储桶为空。",
                "The end of pagination was reached; this does not mean the whole bucket is empty.",
              )
            : t("此位置没有文件。", "There are no files here.")
        }
        action={
          hasPreviousPage ? (
            <Button variant="ghost" size="sm" onClick={refresh}>
              <IconArrowLeft /> {t("返回第一页", "Return to first page")}
            </Button>
          ) : currentPrefix ? (
            <Button variant="ghost" size="sm" onClick={goBack}>
              <IconArrowLeft /> {t("返回", "Back")}
            </Button>
          ) : undefined
        }
        hint={
          hasPreviousPage
            ? t(
                "可返回第一页重新查看列表。",
                "Return to the first page to review the listing.",
              )
            : t(
                "将文件拖到这里，或使用工具栏上的上传按钮。",
                "Drop files here, or use Upload in the toolbar.",
              )
        }
      />
    );
  }

  // Show empty filter state
  if (
    searchTerm &&
    filteredObjects.length === 0 &&
    filteredPrefixes.length === 0
  ) {
    return (
      <EmptyState
        icon={<IconMagnifyingGlass className="size-12 opacity-40" />}
        title={t("没有匹配结果", "No matching results")}
        description={t(
          `当前页未找到与“${filters.search}”匹配的文件`,
          `No files on this page match “${filters.search}”`,
        )}
        action={
          isTruncated ? (
            <Button size="sm" onClick={nextPage} disabled={loading}>
              {t("加载更多", "Load more")}
            </Button>
          ) : undefined
        }
        hint={
          isTruncated
            ? t(
                "筛选仅针对当前页，后续页可能还有匹配结果。",
                "Filtering applies to this page; later pages may contain matching files.",
              )
            : t(
                "试试更短或范围更广的搜索词。",
                "Try a shorter or broader search term.",
              )
        }
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {objects.length === 0 && prefixes.length === 0 && isTruncated && (
        <p role="status" className="px-4 py-3 text-xs text-muted-foreground">
          {t(
            "本页暂无条目，仍有后续页面；请继续加载。",
            "This page has no entries, but more pages are available. Continue loading.",
          )}
        </p>
      )}
      {viewMode === "table" ? (
        <ObjectTable
          objects={filteredObjects}
          prefixes={filteredPrefixes}
          selectedKeys={selectedKeys}
          sortField={sortField}
          sortDir={sortDir}
          loading={loading}
          onNavigate={navigate}
          onSort={setSort}
          onToggleSelect={toggleSelect}
          onSelectAll={selectAll}
          onClearSelection={clearSelection}
        />
      ) : (
        <ObjectGrid
          objects={filteredObjects}
          prefixes={filteredPrefixes}
          selectedKeys={selectedKeys}
          onNavigate={navigate}
          onToggleSelect={toggleSelect}
        />
      )}

      {/* Load more */}
      {isTruncated && (
        <div className="flex justify-center border-t border-border py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={nextPage}
            disabled={loading}
          >
            {loading ? (
              <div className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              t("加载更多", "Load more")
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
