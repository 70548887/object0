import { useEffect, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useS3Objects } from "@/hooks";
import { getFileName } from "@/lib/formatters";
import { t, useT } from "@/lib/i18n";
import { IconFile, IconFolder, IconMagnifyingGlass } from "@/lib/icons";
import { useBucketStore, useProfileStore, useUIStore } from "@/stores";

/**
 * Centered command-palette overlay for searching objects in the current view.
 * Folders navigate; files open the detail panel. A "filter" item applies the
 * typed term to the live table filter.
 */
export function ObjectSearchDialog() {
  useT();
  const open = useUIStore((s) => s.objectSearchOpen);
  const setOpen = useUIStore((s) => s.setObjectSearchOpen);
  const setDetailKey = useUIStore((s) => s.setDetailKey);
  const profileId = useProfileStore((s) => s.activeProfileId);
  const bucket = useBucketStore((s) => s.selectedBucket);
  const { objects, prefixes, navigate, setFilters } = useS3Objects();

  const [query, setQuery] = useState("");

  // Reset the query each time the overlay opens.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  // Ctrl/Cmd+F opens the overlay (only when a bucket is in view).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        if (!profileId || !bucket) return;
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [profileId, bucket, setOpen]);

  const folderName = (prefix: string) =>
    prefix.split("/").filter(Boolean).pop() ?? prefix;

  const trimmed = query.trim();

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={t("搜索文件", "Search files")}
      description={t(
        "在当前目录中搜索文件和文件夹",
        "Search files and folders in the current directory",
      )}
    >
      <Command
        // cmdk filters by item value; folder/file values include their names.
        filter={(value, search) =>
          value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
        }
      >
        <CommandInput
          placeholder={t("搜索文件和文件夹…", "Search files and folders…")}
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>
            {t("没有匹配的文件", "No matching files")}
          </CommandEmpty>

          {trimmed && (
            <CommandGroup heading={t("操作", "Actions")}>
              <CommandItem
                value={`__filter__ ${trimmed}`}
                onSelect={() => {
                  setFilters({ search: trimmed });
                  setOpen(false);
                }}
              >
                <IconMagnifyingGlass className="size-4" />
                <span className="flex-1">
                  {t("筛选当前列表：“", "Filter current list: “")}
                  {trimmed}”
                </span>
              </CommandItem>
            </CommandGroup>
          )}

          {prefixes.length > 0 && (
            <CommandGroup heading={t("文件夹", "Folders")}>
              {prefixes.map((p) => (
                <CommandItem
                  key={p.prefix}
                  value={`folder ${folderName(p.prefix)}`}
                  onSelect={() => {
                    navigate(p.prefix);
                    setOpen(false);
                  }}
                >
                  <IconFolder className="size-4 text-warning" />
                  <span className="flex-1 truncate">
                    {folderName(p.prefix)}/
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {objects.length > 0 && (
            <CommandGroup heading={t("文件", "Files")}>
              {objects.map((o) => (
                <CommandItem
                  key={o.key}
                  value={`file ${getFileName(o.key)}`}
                  onSelect={() => {
                    setDetailKey(o.key);
                    setOpen(false);
                  }}
                >
                  <IconFile className="size-4 text-foreground/60" />
                  <span className="flex-1 truncate">{getFileName(o.key)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
