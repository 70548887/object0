import type { S3StatResult } from "@shared/s3.types";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatBytes,
  formatDate,
  getExtension,
  getFileName,
} from "@/lib/formatters";
import { localize, t, useT } from "@/lib/i18n";
import {
  IconCircleInfo,
  IconClipboard,
  IconImage,
  IconXmark,
} from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import { useBucketStore, useProfileStore, useUIStore } from "@/stores";
import { FileIcon } from "../common/FileIcon";
import { QiniuDetailsActions } from "../qiniu/QiniuDetailsActions";
import { qiniuRestoreInfo, qiniuStorageTypeLabel } from "./qiniu-object-info";

const PREVIEWABLE_IMAGES = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
  "avif",
]);

export function DetailPanel() {
  useT();
  const detailKey = useUIStore((s) => s.detailKey);
  const setDetailKey = useUIStore((s) => s.setDetailKey);
  const profileId = useProfileStore((s) => s.activeProfileId);
  const profileRevision = useProfileStore(
    (s) => s.activeProfile?.updatedAt ?? "",
  );
  const isQiniu = useProfileStore((s) => s.activeProfile?.provider === "qiniu");
  const bucket = useBucketStore((s) => s.selectedBucket);

  const scope = JSON.stringify([profileId, profileRevision, bucket, detailKey]);
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const requestGeneration = useRef(0);
  const [statState, setStatState] = useState<{
    scope: string;
    data: S3StatResult;
  } | null>(null);
  const stat = statState?.scope === scope ? statState.data : null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDetails = useCallback(
    async (silent = false) => {
      const generation = ++requestGeneration.current;
      if (!detailKey || !profileId || !bucket) {
        setStatState(null);
        setLoading(false);
        return;
      }

      if (!silent) setLoading(true);
      setError(null);
      try {
        const result = await rpcCall("objects:stat", {
          profileId,
          bucket,
          key: detailKey,
        });
        if (
          generation === requestGeneration.current &&
          latestScope.current === scope
        )
          setStatState({ scope, data: result });
      } catch (err: unknown) {
        if (
          generation !== requestGeneration.current ||
          latestScope.current !== scope
        )
          return;
        if (silent) throw err;
        setError(
          err instanceof Error ? err.message : t("未知错误", "Unknown error"),
        );
      } finally {
        if (
          generation === requestGeneration.current &&
          latestScope.current === scope
        )
          setLoading(false);
      }
    },
    [profileId, bucket, detailKey, scope],
  );
  useEffect(() => {
    void refreshDetails();
    return () => {
      requestGeneration.current++;
    };
  }, [refreshDetails]);

  const fileName = detailKey ? getFileName(detailKey) : "";
  const ext = detailKey ? getExtension(detailKey).toLowerCase() : "";
  const isImage = PREVIEWABLE_IMAGES.has(ext);

  return (
    <Sheet
      open={!!detailKey}
      onOpenChange={(open) => !open && setDetailKey(null)}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-0 p-0 sm:max-w-xs"
      >
        <SheetHeader className="flex-row items-center justify-between gap-2 space-y-0 border-border border-b px-4 py-3">
          <SheetTitle className="flex min-w-0 items-center gap-2 font-semibold text-sm">
            <IconCircleInfo className="size-4 shrink-0 text-foreground/60" />
            <span className="truncate">{t("详细信息", "Details")}</span>
          </SheetTitle>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-foreground/50 hover:text-foreground"
              onClick={() => setDetailKey(null)}
              title={t("关闭", "Close")}
            >
              <IconXmark className="size-4" />
            </Button>
          </div>
        </SheetHeader>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="space-y-3">
              <div className="flex flex-col items-center gap-2 py-4">
                <Skeleton className="h-10 w-10 rounded" />
                <Skeleton className="h-3 w-32 rounded" />
              </div>
              {Array.from({ length: 4 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
                <div key={`ds-${i}`} className="space-y-1">
                  <Skeleton className="h-2 w-12 rounded" />
                  <Skeleton className="h-3 w-full rounded" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="py-4 text-center text-destructive text-xs">
              {localize(error)}
            </div>
          ) : stat && detailKey ? (
            <div className="space-y-4">
              {/* File icon + name */}
              <div className="flex flex-col items-center gap-2 py-2">
                <FileIcon name={detailKey} className="text-3xl" />
                <span className="max-w-full break-all text-center font-medium text-sm">
                  {fileName}
                </span>
              </div>

              {/* Image preview notice */}
              {isImage && profileId && bucket && (
                <div className="overflow-hidden rounded-lg bg-muted">
                  <div className="flex items-center justify-center p-2 text-foreground/30 text-xs">
                    <IconImage className="mr-1 size-3" />
                    {isQiniu
                      ? t(
                          "此七牛对象暂不支持直接预览图片",
                          "Image previews are not available for this Qiniu object",
                        )
                      : t(
                          "此 S3 对象暂不支持直接预览图片",
                          "Image previews are not available for this S3 object",
                        )}
                  </div>
                </div>
              )}

              {/* Metadata table */}
              <table className="w-full text-xs">
                <tbody>
                  <DetailRow
                    label={t("完整对象路径", "Full object key")}
                    value={detailKey}
                    mono
                  />
                  <DetailRow
                    label={t("大小", "Size")}
                    value={formatBytes(stat.size)}
                  />
                  <DetailRow
                    label={t("最后修改时间", "Last modified")}
                    value={formatDate(stat.lastModified)}
                  />
                  <DetailRow label="ETag" value={stat.etag} mono />
                  <DetailRow
                    label={t("内容类型", "Content type")}
                    value={stat.type || "—"}
                  />
                  <DetailRow
                    label={t("扩展名", "Extension")}
                    value={ext || "—"}
                  />
                </tbody>
              </table>
              {isQiniu && <QiniuStatDetails stat={stat} />}
              {isQiniu && profileId && bucket && (
                <QiniuDetailsActions
                  key={scope}
                  profileId={profileId}
                  profileRevision={profileRevision}
                  bucket={bucket}
                  objectKey={detailKey}
                  stat={stat}
                  onRefresh={() => refreshDetails(true)}
                />
              )}

              {/* Quick actions */}
              <div className="space-y-1 pt-2">
                <Button
                  variant="ghost"
                  size="xs"
                  className="w-full justify-start"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(detailKey);
                    } catch {
                      // ignore
                    }
                  }}
                >
                  <IconClipboard /> {t("复制对象路径", "Copy object key")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function QiniuStatDetails({ stat }: { stat: S3StatResult }) {
  useT();
  const restore = qiniuRestoreInfo(
    stat.storageType,
    stat.restoreStatus,
    "stat",
  );
  const metadata = Object.entries(stat.metadata ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return (
    <section
      className="min-w-0 space-y-3 border-t border-border pt-3"
      aria-label={t("七牛对象信息", "Qiniu object information")}
    >
      <table className="w-full table-fixed text-xs">
        <tbody>
          <DetailRow
            label={t("存储类型", "Storage type")}
            value={qiniuStorageTypeLabel(stat.storageType)}
          />
          <DetailRow
            label={t("恢复状态", "Restore state")}
            value={restore.label}
          />
        </tbody>
      </table>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {restore.hint}
      </p>
      <div className="min-w-0 space-y-2">
        <h4 className="text-xs font-semibold">
          {t("自定义元信息（只读）", "Custom metadata (read-only)")}
        </h4>
        {metadata.length > 0 ? (
          <dl className="min-w-0 space-y-2 text-xs">
            {metadata.map(([key, value]) => (
              <div key={key} className="min-w-0 space-y-0.5">
                <dt className="break-all font-mono text-[10px] text-muted-foreground">
                  {key}
                </dt>
                <dd className="m-0 break-all font-mono text-[10px] text-foreground/80">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">
            {stat.metadata === undefined
              ? t(
                  "服务未返回自定义元信息。",
                  "The service did not return custom metadata.",
                )
              : t("无自定义元信息。", "No custom metadata.")}
          </p>
        )}
      </div>
    </section>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <tr>
      <td className="whitespace-nowrap py-1.5 pr-3 align-top font-semibold text-foreground/50">
        {label}
      </td>
      <td
        className={`break-all py-1.5 text-foreground/80 ${mono ? "font-mono text-[10px]" : ""}`}
      >
        {value}
      </td>
    </tr>
  );
}
