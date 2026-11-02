import type {
  QiniuShareListResult,
  QiniuShareSessionInfo,
} from "@shared/qiniu.types";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes } from "@/lib/formatters";
import { intlLocale, t, useT } from "@/lib/i18n";
import { IconCloudArrowDown, IconFolder } from "@/lib/icons";
import { rpcCall } from "@/lib/rpc-client";
import { toast } from "../common/Toast";
import {
  isQiniuSharePrefixAllowed,
  normalizeQiniuSharePrefix,
  qiniuShareDisplayError,
} from "./QiniuDirectoryShare";

export function qiniuShareBreadcrumbs(root: string, prefix: string) {
  if (
    normalizeQiniuSharePrefix(root) !== root ||
    normalizeQiniuSharePrefix(prefix) !== prefix ||
    !isQiniuSharePrefixAllowed(prefix, root)
  )
    return [];
  const crumbs = [{ prefix: root, label: t("共享根目录", "Shared root") }];
  let path = root;
  const relative = prefix.slice(root.length);
  if (relative)
    for (const segment of relative.slice(0, -1).split("/")) {
      path += `${segment}/`;
      crumbs.push({
        prefix: path,
        label: segment || t("（空名称目录）", "(Unnamed folder)"),
      });
    }
  return crumbs;
}

export function parseQiniuSharePage(
  value: unknown,
  session: QiniuShareSessionInfo,
  prefix: string,
  cursor?: string,
  now = Date.now(),
): QiniuShareListResult {
  const invalid = () =>
    new Error(
      t(
        "共享目录返回的范围或分页无效，未显示文件。",
        "The shared directory returned an invalid scope or page. No files were displayed.",
      ),
    );
  if (
    !Number.isFinite(now) ||
    session.readOnly !== true ||
    !Number.isFinite(Date.parse(session.expiresAt)) ||
    Date.parse(session.expiresAt) <= now ||
    !isQiniuSharePrefixAllowed(prefix, session.prefix) ||
    normalizeQiniuSharePrefix(prefix) !== prefix ||
    !value ||
    typeof value !== "object"
  )
    throw invalid();
  const page = value as Record<string, unknown>;
  const validPath = (key: unknown): key is string =>
    typeof key === "string" &&
    key.length <= 8192 &&
    !key.includes("\\") &&
    !Array.from(key).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !key.split("/").some((part) => part === "." || part === "..") &&
    key.startsWith(prefix) &&
    isQiniuSharePrefixAllowed(prefix, session.prefix);
  if (
    !Array.isArray(page.objects) ||
    !Array.isArray(page.prefixes) ||
    page.objects.length + page.prefixes.length > 200 ||
    typeof page.isTruncated !== "boolean" ||
    (page.isTruncated &&
      (typeof page.nextCursor !== "string" ||
        !page.nextCursor ||
        page.nextCursor.length > 65536 ||
        page.nextCursor === cursor)) ||
    (!page.isTruncated && page.nextCursor != null)
  )
    throw invalid();
  const objects = page.objects.map((entry) => {
    const item = entry as Record<string, unknown> | null;
    if (
      !item ||
      !validPath(item.key) ||
      item.key === "" ||
      item.key === prefix ||
      item.key.slice(prefix.length).includes("/") ||
      !Number.isSafeInteger(item.size) ||
      (item.size as number) < 0 ||
      (item.lastModified != null &&
        (typeof item.lastModified !== "string" ||
          !Number.isFinite(Date.parse(item.lastModified)))) ||
      (item.etag != null && typeof item.etag !== "string") ||
      (item.storageClass != null && typeof item.storageClass !== "string")
    )
      throw invalid();
    return {
      key: item.key,
      size: item.size as number,
      ...(typeof item.lastModified === "string"
        ? { lastModified: item.lastModified }
        : {}),
      ...(typeof item.etag === "string" ? { etag: item.etag } : {}),
      ...(typeof item.storageClass === "string"
        ? { storageClass: item.storageClass }
        : {}),
    };
  });
  const prefixes = page.prefixes.map((item) => {
    if (
      !validPath(item) ||
      item === prefix ||
      normalizeQiniuSharePrefix(item) !== item ||
      item.slice(prefix.length, -1).includes("/")
    )
      throw invalid();
    return item;
  });
  return {
    objects,
    prefixes,
    isTruncated: page.isTruncated,
    ...(page.isTruncated ? { nextCursor: page.nextCursor as string } : {}),
  };
}

export async function requestQiniuSharePage(
  session: QiniuShareSessionInfo,
  prefix: string,
  cursor: string | undefined,
  list: (input: {
    sessionId: string;
    prefix: string;
    cursor?: string;
  }) => Promise<unknown>,
  isCurrent: () => boolean,
): Promise<QiniuShareListResult | null> {
  if (
    !isCurrent() ||
    Date.parse(session.expiresAt) <= Date.now() ||
    !isQiniuSharePrefixAllowed(prefix, session.prefix) ||
    normalizeQiniuSharePrefix(prefix) !== prefix
  )
    return null;
  const response = await list({ sessionId: session.sessionId, prefix, cursor });
  if (!isCurrent()) return null;
  return parseQiniuSharePage(response, session, prefix, cursor);
}

export function QiniuShareFileList({
  prefix,
  page,
  busy,
  downloading,
  unavailable = false,
  onNavigate,
  onDownload,
}: {
  prefix: string;
  page: QiniuShareListResult;
  busy: boolean;
  downloading: string | null;
  unavailable?: boolean;
  onNavigate: (prefix: string) => void;
  onDownload: (key: string) => void;
}) {
  useT();
  return (
    <div className="min-h-36 overflow-auto rounded-lg border border-border">
      <table className="w-full table-fixed text-left text-xs">
        <thead className="sticky top-0 bg-muted text-foreground/65">
          <tr>
            <th className="px-3 py-2 font-medium">{t("名称", "Name")}</th>
            <th className="w-24 px-3 py-2 text-right font-medium">
              {t("大小", "Size")}
            </th>
            <th className="w-24 px-3 py-2 text-right font-medium">
              <span className="sr-only">{t("操作", "Actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {page.prefixes.map((folder) => (
            <tr key={`p:${folder}`} className="border-t border-border/70">
              <td className="px-3 py-1.5">
                <button
                  type="button"
                  className="flex max-w-full items-center gap-2 rounded text-left hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  disabled={busy}
                  onClick={() => onNavigate(folder)}
                  title={folder}
                >
                  <IconFolder className="size-4 shrink-0 text-primary/75" />
                  <span className="truncate">
                    {folder.slice(prefix.length)}
                  </span>
                </button>
              </td>
              <td className="px-3 py-2 text-right text-foreground/50">—</td>
              <td />
            </tr>
          ))}
          {page.objects.map((file) => (
            <tr key={`o:${file.key}`} className="border-t border-border/70">
              <td className="truncate px-3 py-1.5" title={file.key}>
                {file.key.slice(prefix.length)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-foreground/65">
                {formatBytes(file.size)}
              </td>
              <td className="px-2 py-1 text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || downloading !== null}
                  onClick={() => onDownload(file.key)}
                  aria-label={t(`下载 ${file.key}`, `Download ${file.key}`)}
                >
                  <IconCloudArrowDown className="size-3" />
                  {downloading === file.key
                    ? t("下载中", "Downloading")
                    : t("下载", "Download")}
                </Button>
              </td>
            </tr>
          ))}
          {page.objects.length === 0 && page.prefixes.length === 0 && !busy && (
            <tr>
              <td
                colSpan={3}
                className="px-4 py-10 text-center text-foreground/55"
              >
                {unavailable
                  ? t(
                      "列表暂不可用，请刷新或重新连接。",
                      "The listing is unavailable. Refresh or connect again.",
                    )
                  : page.isTruncated
                    ? t(
                        "本页暂无条目，请加载下一页。",
                        "No entries on this page. Load the next page.",
                      )
                    : t("此共享目录为空。", "This shared directory is empty.")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const emptyPage: QiniuShareListResult = {
  objects: [],
  prefixes: [],
  isTruncated: false,
};

export function QiniuShareBrowser({
  session,
  onClose,
  onExpire,
}: {
  session: QiniuShareSessionInfo;
  onClose: () => void;
  onExpire: (sessionId: string) => void;
}) {
  const t = useT();
  const [prefix, setPrefix] = useState(session.prefix);
  const [page, setPage] = useState<QiniuShareListResult>(emptyPage);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(
    Date.parse(session.expiresAt) <= Date.now(),
  );
  const [downloading, setDownloading] = useState<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const busy = useRef(false);
  const downloadBusy = useRef(false);
  const cursors = useRef(new Set<string>());
  const currentPrefix = useRef(prefix);
  currentPrefix.current = prefix;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      busy.current = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        if (!mounted.current) return;
        generation.current++;
        busy.current = false;
        setPending(false);
        setExpired(true);
        setPage(emptyPage);
        onExpire(session.sessionId);
      },
      Math.max(
        0,
        Math.min(2147483647, Date.parse(session.expiresAt) - Date.now()),
      ),
    );
    return () => window.clearTimeout(timer);
  }, [session.expiresAt, session.sessionId, onExpire]);

  const load = async (nextPrefix: string, cursor?: string) => {
    if (!mounted.current || busy.current || expired) return;
    if (!isQiniuSharePrefixAllowed(nextPrefix, session.prefix)) return;
    const request = ++generation.current;
    busy.current = true;
    setPending(true);
    setError(null);
    if (!cursor) {
      cursors.current.clear();
      setPage(emptyPage);
      setPrefix(nextPrefix);
      currentPrefix.current = nextPrefix;
    }
    const isCurrent = () =>
      mounted.current &&
      generation.current === request &&
      currentPrefix.current === nextPrefix;
    try {
      const result = await requestQiniuSharePage(
        session,
        nextPrefix,
        cursor,
        (input) => rpcCall("qiniu:share-list", input),
        isCurrent,
      );
      if (!result) return;
      if (result.nextCursor && cursors.current.has(result.nextCursor))
        throw new Error(
          t(
            "分享分页游标重复，已停止继续加载。",
            "The share cursor repeated. Further loading was stopped.",
          ),
        );
      if (result.nextCursor) cursors.current.add(result.nextCursor);
      setPage((previous) => ({
        objects: cursor
          ? [
              ...new Map(
                [...previous.objects, ...result.objects].map((file) => [
                  file.key,
                  file,
                ]),
              ).values(),
            ]
          : result.objects,
        prefixes: cursor
          ? [...new Set([...previous.prefixes, ...result.prefixes])]
          : result.prefixes,
        isTruncated: result.isTruncated,
        nextCursor: result.nextCursor,
      }));
    } catch (cause) {
      if (isCurrent())
        setError(
          qiniuShareDisplayError(
            cause,
            t(
              "无法读取共享目录，请检查权限、有效期或网络。",
              "Could not read the shared directory. Check permissions, expiry, or your connection.",
            ),
          ),
        );
    } finally {
      if (isCurrent()) {
        busy.current = false;
        setPending(false);
      }
    }
  };

  // The parent keys this component by session ID, giving each session a fresh request epoch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run only for this keyed session
  useEffect(() => {
    void load(session.prefix);
  }, [session.sessionId]);

  const download = async (key: string) => {
    if (
      downloadBusy.current ||
      expired ||
      Date.parse(session.expiresAt) <= Date.now()
    )
      return;
    downloadBusy.current = true;
    setDownloading(key);
    setError(null);
    try {
      const result = await rpcCall("qiniu:share-download", {
        sessionId: session.sessionId,
        key,
      });
      if (
        mounted.current &&
        Date.parse(session.expiresAt) > Date.now() &&
        !result.cancelled
      )
        toast.success(
          t(
            "文件已下载，未覆盖已有目标。",
            "File downloaded without overwriting an existing destination.",
          ),
        );
    } catch (cause) {
      if (mounted.current && Date.parse(session.expiresAt) > Date.now())
        setError(
          qiniuShareDisplayError(
            cause,
            t(
              "下载失败，原有文件保持不变。",
              "Download failed. Existing files were preserved.",
            ),
          ),
        );
    } finally {
      downloadBusy.current = false;
      if (mounted.current) setDownloading(null);
    }
  };

  const close = () => {
    mounted.current = false;
    generation.current++;
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[90dvh] min-w-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("七牛共享目录", "Qiniu shared directory")}
          </DialogTitle>
          <DialogDescription className="break-all pr-6">
            {session.bucketName} ·{" "}
            {t(
              "只读 · 不保存临时凭据",
              "Read-only · Temporary credentials are not saved",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <nav
            aria-label={t("共享目录路径", "Shared directory path")}
            className="flex flex-wrap items-center gap-1 text-xs"
          >
            {qiniuShareBreadcrumbs(session.prefix, prefix).map(
              (crumb, index) => (
                <span
                  key={crumb.prefix}
                  className="flex min-w-0 items-center gap-1"
                >
                  {index > 0 && (
                    <span aria-hidden="true" className="text-foreground/40">
                      /
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={pending || expired}
                    onClick={() => void load(crumb.prefix)}
                    aria-current={
                      crumb.prefix === prefix ? "location" : undefined
                    }
                    className="max-w-52 truncate rounded px-1 py-0.5 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  >
                    {crumb.label}
                  </button>
                </span>
              ),
            )}
          </nav>
          <p className="break-all text-[11px] text-foreground/55">
            {t("授权范围：", "Allowed scope: ")}
            {session.prefix || "/"}
          </p>
          {(error || expired) && (
            <p
              role="alert"
              className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              {expired
                ? t(
                    "共享会话已过期。请关闭此窗口后重新连接。",
                    "This share session has expired. Close this window and connect again.",
                  )
                : error}
            </p>
          )}
        </div>
        <QiniuShareFileList
          prefix={prefix}
          page={page}
          busy={pending || expired}
          downloading={downloading}
          unavailable={expired || error !== null}
          onNavigate={(value) => void load(value)}
          onDownload={(key) => void download(key)}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <div
            role="status"
            aria-live="polite"
            className="max-w-full text-[11px] text-foreground/55"
          >
            {expired
              ? t(
                  "会话已失效；文件列表已清除。",
                  "The session expired; the file list was cleared.",
                )
              : error && page.objects.length === 0 && page.prefixes.length === 0
                ? t(
                    "列表尚未成功读取，不代表目录为空。",
                    "The listing could not be read; this does not mean the directory is empty.",
                  )
                : pending
                  ? t("正在读取共享目录…", "Reading shared directory…")
                  : t(
                      `已加载 ${page.objects.length} 个文件、${page.prefixes.length} 个目录；仅授权范围，不代表全桶用量。`,
                      `Loaded ${page.objects.length} files and ${page.prefixes.length} folders; this scope is not whole-bucket usage.`,
                    )}
            <p>
              {t("到期：", "Expires: ")}
              {new Date(session.expiresAt).toLocaleString(intlLocale())}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pending || expired}
              onClick={() => void load(prefix)}
            >
              {t("刷新", "Refresh")}
            </Button>
            {page.isTruncated && (
              <Button
                variant="outline"
                size="sm"
                disabled={pending || expired}
                onClick={() => void load(prefix, page.nextCursor)}
              >
                {t("加载更多", "Load more")}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={close}>
              {t("关闭会话", "Close session")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
