import { t, useT } from "@/lib/i18n";
import { IconMagnifyingGlass } from "@/lib/icons";
import { useBucketStore, useProfileStore, useUIStore } from "@/stores";
import { ObjectBreadcrumb } from "../objects/ObjectBreadcrumb";
import { ObjectToolbar } from "../objects/ObjectToolbar";

// Object-scoped actions and address/search only; window chrome is AppTitleBar.
export function TopBar() {
  useT();
  const activeProfile = useProfileStore((s) => s.activeProfile);
  const bucket = useBucketStore((s) => s.selectedBucket);
  const setObjectSearchOpen = useUIStore((s) => s.setObjectSearchOpen);

  return (
    <div className="flex shrink-0 flex-col border-b border-border bg-card/85">
      {/* Address/search precede the file-operation toolbar. */}
      <div className="no-drag flex min-w-0 flex-wrap items-center gap-2 border-b border-border/70 bg-muted/20 px-3 py-1.5">
        {activeProfile && bucket ? (
          <ObjectBreadcrumb profileName={activeProfile.name} bucket={bucket} />
        ) : (
          <span className="min-w-0 flex-1 truncate py-1 text-xs text-muted-foreground">
            {activeProfile
              ? t("从左侧选择存储桶", "Choose a bucket from the sidebar")
              : t(
                  "从左侧选择或添加存储账号",
                  "Select or add a storage account from the sidebar",
                )}
          </span>
        )}
        <button
          type="button"
          disabled={!activeProfile || !bucket}
          onClick={() => setObjectSearchOpen(true)}
          className="flex h-8 min-w-44 shrink-0 items-center gap-2 rounded-lg border border-border bg-background/80 px-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45"
          title={t(
            "搜索当前已加载目录中的文件和文件夹（Ctrl+F）",
            "Search files and folders in the currently loaded directory (Ctrl+F)",
          )}
          aria-label={t("搜索文件和文件夹", "Search files and folders")}
        >
          <IconMagnifyingGlass className="size-3.5 shrink-0" />
          <span>{t("搜索文件/文件夹", "Search files/folders")}</span>
          <kbd className="ml-auto rounded border border-border bg-muted px-1 py-0.5 text-[10px]">
            Ctrl+F
          </kbd>
        </button>
      </div>
      {activeProfile && bucket && <ObjectToolbar />}
    </div>
  );
}
