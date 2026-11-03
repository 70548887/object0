import { useState } from "react";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useS3Objects } from "@/hooks/useS3Objects";
import { directoryCrumbs } from "@/lib/file-navigation";
import { t, useT } from "@/lib/i18n";
import {
  IconArrowLeft,
  IconArrowUp,
  IconBucket,
  IconCheck,
  IconChevronRight,
  IconCloud,
  IconCopy,
} from "@/lib/icons";
import { useObjectStore } from "@/stores";

interface ObjectBreadcrumbProps {
  profileName: string;
  bucket: string;
}

export function ObjectBreadcrumb({
  profileName,
  bucket,
}: ObjectBreadcrumbProps) {
  useT();
  const { currentPrefix, navigate, goBack, goForward, goUp } = useS3Objects();
  const hasBack = useObjectStore((s) => s.prefixHistory.length > 0);
  const hasForward = useObjectStore((s) => s.prefixForward.length > 0);
  const [copied, setCopied] = useState(false);
  const parts = directoryCrumbs(currentPrefix);
  const collapsed = parts.length > 4;
  const visible = collapsed ? [parts[0], ...parts.slice(-2)] : parts;
  const fullPath = `${bucket}${currentPrefix ? `/${currentPrefix}` : ""}`;
  const label = (name: string) => name || t("（空目录段）", "(empty segment)");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fullPath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-1 items-center gap-2 border-0 p-0"
      aria-label={t("地址导航", "Address navigation")}
    >
      <div className="flex shrink-0 items-center gap-0.5 border-r border-border pr-2">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!hasBack}
          onClick={goBack}
          title={t("后退", "Back")}
          aria-label={t("后退", "Back")}
        >
          <IconArrowLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!hasForward}
          onClick={goForward}
          title={t("前进", "Forward")}
          aria-label={t("前进", "Forward")}
        >
          <IconChevronRight className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!currentPrefix}
          onClick={goUp}
          title={t("上一级", "Up one level")}
          aria-label={t("上一级", "Up one level")}
        >
          <IconArrowUp className="size-4" />
        </Button>
      </div>
      <div
        className="min-w-0 flex-1 overflow-hidden"
        title={`${profileName} / ${fullPath}`}
      >
        <Breadcrumb>
          <BreadcrumbList className="flex-nowrap gap-1.5 text-xs">
            <BreadcrumbItem className="min-w-0 max-w-28 shrink">
              <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
                <IconCloud className="size-3 shrink-0" />
                <span className="truncate">{profileName}</span>
              </span>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0 max-w-36 shrink">
              <BreadcrumbLink
                render={<button type="button" />}
                className="flex min-w-0 items-center gap-1 font-medium"
                onClick={() => navigate("")}
                title={bucket}
              >
                <IconBucket className="size-3 shrink-0" />
                <span className="truncate">{bucket}</span>
              </BreadcrumbLink>
            </BreadcrumbItem>
            {visible.flatMap((part, index) => {
              const isLast = part.prefix === parts[parts.length - 1]?.prefix;
              const element = (
                <BreadcrumbItem
                  key={part.prefix}
                  className="min-w-0 max-w-48 shrink"
                >
                  {isLast ? (
                    <BreadcrumbPage
                      className="block truncate font-medium"
                      title={part.prefix}
                    >
                      {label(part.label)}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      render={<button type="button" />}
                      className="block truncate"
                      onClick={() => navigate(part.prefix)}
                      title={part.prefix}
                    >
                      {label(part.label)}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              );
              const result = [
                <BreadcrumbSeparator key={`sep-${part.prefix}`} />,
                element,
              ];
              if (collapsed && index === 0)
                result.push(
                  <BreadcrumbSeparator key="sep-all" />,
                  <BreadcrumbItem key="all">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <button
                            type="button"
                            className="flex size-6 items-center justify-center rounded-md hover:bg-muted"
                            aria-label={t("展开完整路径", "Expand full path")}
                            title={t("展开完整路径", "Expand full path")}
                          />
                        }
                      >
                        <BreadcrumbEllipsis />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        className="min-w-64 max-w-[min(30rem,90vw)]"
                        align="start"
                      >
                        <DropdownMenuItem
                          onClick={() => navigate("")}
                          title={bucket}
                        >
                          <IconBucket className="size-3" />
                          <span className="truncate">{bucket}/</span>
                        </DropdownMenuItem>
                        {parts.map((ancestor) => (
                          <DropdownMenuItem
                            key={ancestor.prefix}
                            onClick={() => navigate(ancestor.prefix)}
                            title={ancestor.prefix}
                          >
                            <span className="truncate font-mono text-xs">
                              {ancestor.prefix}
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </BreadcrumbItem>,
                );
              return result;
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground"
        onClick={() => void copy()}
        title={t(`复制路径：${fullPath}`, `Copy path: ${fullPath}`)}
        aria-label={t("复制当前路径", "Copy current path")}
      >
        {copied ? (
          <IconCheck className="size-3.5 text-success" />
        ) : (
          <IconCopy className="size-3.5" />
        )}
      </Button>
    </fieldset>
  );
}
