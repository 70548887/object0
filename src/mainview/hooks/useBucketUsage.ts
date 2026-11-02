import type { ProfileInfo } from "@shared/profile.types";
import type {
  BucketUsage,
  QiniuClassUsage,
  QiniuUsageAnalytics,
} from "@shared/s3.types";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BUCKET_USAGE_INVALIDATED,
  type BucketUsageInvalidation,
} from "@/lib/bucket-usage-events";
import { t } from "@/lib/i18n";
import { onEvent, rpcCall } from "@/lib/rpc-client";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 20;
const QINIU_CLASSES = new Set([
  "standard",
  "line",
  "intelligent_tiering",
  "archive_ir",
  "archive",
  "deep_archive",
]);

function metric(value: unknown): value is number | null {
  return (
    value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
  );
}
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function optionalText(value: unknown): value is string | undefined {
  return (
    value === undefined || (typeof value === "string" && value.length <= 4000)
  );
}

/** Validate IPC data before rendering or caching it. Never repair bad metrics to zero. */
export function parseBucketUsage(
  value: unknown,
  expectedProfileId: string,
  expectedBucket: string,
  expectedProvider?: string,
): BucketUsage {
  const invalid = () =>
    new Error(
      t(
        "用量统计的范围、数值或时间无效，未采用此结果。",
        "The usage scope, values or timestamps are invalid. This result was not used.",
      ),
    );
  if (
    !record(value) ||
    value.profileId !== expectedProfileId ||
    value.bucket !== expectedBucket ||
    !metric(value.bytes) ||
    !metric(value.objectCount) ||
    !["r2", "scan", "qiniu"].includes(value.source as string) ||
    typeof value.complete !== "boolean" ||
    !instant(value.fetchedAt) ||
    (value.measuredAt !== null && !instant(value.measuredAt)) ||
    !optionalText(value.warning) ||
    (value.metadataBytes !== undefined &&
      (!metric(value.metadataBytes) || value.metadataBytes === null)) ||
    (value.scannedPages !== undefined &&
      (!Number.isSafeInteger(value.scannedPages) ||
        (value.scannedPages as number) < 0)) ||
    (value.source === "r2" && expectedProvider && expectedProvider !== "r2") ||
    (value.source === "qiniu" &&
      expectedProvider &&
      expectedProvider !== "qiniu") ||
    (value.source !== "qiniu" &&
      (value.bytes === null ||
        value.objectCount === null ||
        value.measuredAt === null))
  )
    throw invalid();
  let analytics: QiniuUsageAnalytics | undefined;
  if (value.qiniuAnalytics !== undefined) {
    const raw = value.qiniuAnalytics;
    if (
      !record(raw) ||
      (expectedProvider && expectedProvider !== "qiniu") ||
      value.source === "r2" ||
      typeof raw.complete !== "boolean" ||
      (raw.measuredAt !== null && !instant(raw.measuredAt)) ||
      !Array.isArray(raw.classes) ||
      raw.classes.length > 32 ||
      !optionalText(raw.warning)
    )
      throw invalid();
    const seen = new Set<string>();
    const classes: QiniuClassUsage[] = raw.classes.map((item) => {
      if (
        !record(item) ||
        typeof item.storageClass !== "string" ||
        !item.storageClass ||
        item.storageClass.length > 128 ||
        seen.has(item.storageClass) ||
        !metric(item.bytes) ||
        !metric(item.objectCount) ||
        (item.measuredAt !== null && !instant(item.measuredAt)) ||
        ![
          "available",
          "partial",
          "forbidden",
          "unsupported",
          "unavailable",
        ].includes(item.state as string) ||
        !optionalText(item.reason)
      )
        throw invalid();
      seen.add(item.storageClass);
      const incompleteRow =
        item.state === "available" &&
        (item.bytes === null ||
          item.objectCount === null ||
          item.measuredAt === null);
      return {
        storageClass: item.storageClass,
        bytes: item.bytes,
        objectCount: item.objectCount,
        measuredAt: item.measuredAt,
        state: incompleteRow
          ? "partial"
          : (item.state as QiniuClassUsage["state"]),
        ...(item.reason ? { reason: item.reason } : {}),
      };
    });
    const aligned =
      raw.measuredAt !== null &&
      classes.length === QINIU_CLASSES.size &&
      classes.every(
        (item) =>
          QINIU_CLASSES.has(item.storageClass) &&
          item.state === "available" &&
          item.bytes !== null &&
          item.objectCount !== null &&
          item.measuredAt !== null &&
          Date.parse(item.measuredAt) === Date.parse(raw.measuredAt as string),
      );
    const sums = classes.reduce(
      (result, item) => [
        result[0] + (item.bytes ?? 0),
        result[1] + (item.objectCount ?? 0),
      ],
      [0, 0],
    );
    analytics = {
      complete: raw.complete && aligned && sums.every(Number.isSafeInteger),
      measuredAt: raw.measuredAt,
      classes,
      ...(raw.warning ? { warning: raw.warning } : {}),
    };
  }
  if (value.source === "qiniu" && !analytics) throw invalid();
  let complete = value.complete;
  let bytes = value.bytes;
  let objectCount = value.objectCount;
  let measuredAt = value.measuredAt;
  let warning = value.warning;
  if (value.source === "qiniu") {
    if (!analytics) throw invalid();
    const sums = analytics.classes.reduce(
      (result, item) => [
        result[0] + (item.bytes ?? 0),
        result[1] + (item.objectCount ?? 0),
      ],
      [0, 0],
    );
    const consistent =
      analytics.complete &&
      bytes !== null &&
      objectCount !== null &&
      measuredAt !== null &&
      analytics.measuredAt !== null &&
      Date.parse(measuredAt) === Date.parse(analytics.measuredAt) &&
      Number.isSafeInteger(sums[0]) &&
      Number.isSafeInteger(sums[1]) &&
      bytes === sums[0] &&
      objectCount === sums[1];
    if (!complete || !consistent) {
      complete = false;
      bytes = null;
      objectCount = null;
      measuredAt = null;
      warning ??= t(
        "官方分类统计尚未齐全或时间不一致，总量待确认；缺失数据不是零。",
        "Official class metrics are incomplete or not time-aligned. The total is unconfirmed; missing data is not zero.",
      );
    }
  }
  return {
    profileId: expectedProfileId,
    bucket: expectedBucket,
    bytes,
    objectCount,
    source: value.source as BucketUsage["source"],
    measuredAt,
    fetchedAt: value.fetchedAt,
    complete,
    ...(value.metadataBytes !== undefined
      ? { metadataBytes: value.metadataBytes as number }
      : {}),
    ...(value.scannedPages !== undefined
      ? { scannedPages: value.scannedPages as number }
      : {}),
    ...(warning ? { warning } : {}),
    ...(analytics ? { qiniuAnalytics: analytics } : {}),
  };
}

export function isBucketUsageCacheable(data: BucketUsage): boolean {
  return (
    data.complete &&
    data.bytes !== null &&
    data.objectCount !== null &&
    data.measuredAt !== null &&
    metric(data.bytes) &&
    metric(data.objectCount) &&
    instant(data.measuredAt) &&
    (data.source !== "qiniu" || data.qiniuAnalytics?.complete === true)
  );
}

export interface BucketUsageState {
  data: BucketUsage | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  cancelled: boolean;
}

interface ScopedState extends BucketUsageState {
  key: string;
}

interface CacheEntry {
  data: BucketUsage;
  receivedAt: number;
}

const emptyState: BucketUsageState = {
  data: null,
  loading: false,
  error: null,
  stale: false,
  cancelled: false,
};

export function useBucketUsage(
  profile: ProfileInfo | null,
  bucket: string | null,
  online: boolean,
) {
  const profileId = profile?.id ?? "";
  const key =
    profileId && bucket
      ? JSON.stringify([
          profileId,
          profile?.provider,
          profile?.updatedAt,
          !!profile?.hasR2AnalyticsToken,
          bucket,
        ])
      : "";
  const cache = useRef(new Map<string, CacheEntry>());
  const active = useRef<{ id: string; key: string } | null>(null);
  const latestKey = useRef(key);
  latestKey.current = key;
  const forceNext = useRef(false);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ScopedState>({ key: "", ...emptyState });

  const cancelActive = useCallback(() => {
    const previous = active.current;
    active.current = null;
    if (previous) {
      void rpcCall("buckets:usage-cancel", { requestId: previous.id }).catch(
        () => {},
      );
    }
  }, []);

  const refresh = useCallback(() => {
    if (!key || !online || active.current?.key === key) return;
    forceNext.current = true;
    cache.current.delete(key);
    setRevision((value) => value + 1);
  }, [key, online]);

  const cancel = useCallback(() => {
    cancelActive();
    setState((previous) =>
      previous.key === key
        ? {
            ...previous,
            loading: false,
            cancelled: true,
            stale: !!previous.data,
          }
        : previous,
    );
  }, [key, cancelActive]);

  useEffect(() => {
    cancelActive();
    const force = forceNext.current;
    forceNext.current = false;
    if (!key || !bucket) {
      setState({ key, ...emptyState });
      return;
    }

    const cached = cache.current.get(key);
    const fresh = cached && Date.now() - cached.receivedAt < CACHE_TTL_MS;
    if (!force && fresh) {
      setState({ key, ...emptyState, data: cached.data });
      return;
    }
    if (!online) {
      setState({ key, ...emptyState, data: cached?.data ?? null, stale: true });
      return;
    }

    const requestId = `${crypto.randomUUID()}-${revision}`;
    active.current = { id: requestId, key };
    setState((previous) => ({
      key,
      ...emptyState,
      data: cached?.data ?? (previous.key === key ? previous.data : null),
      loading: true,
      stale: true,
    }));
    const timer = window.setTimeout(async () => {
      if (active.current?.id !== requestId || latestKey.current !== key) return;
      try {
        const result = await rpcCall("buckets:usage", {
          profileId,
          bucket,
          requestId,
          force,
        });
        if (active.current?.id !== requestId || latestKey.current !== key)
          return;
        const data = parseBucketUsage(
          result,
          profileId,
          bucket,
          profile?.provider,
        );
        if (isBucketUsageCacheable(data)) {
          cache.current.delete(key);
          cache.current.set(key, { data, receivedAt: Date.now() });
          if (cache.current.size > MAX_CACHE_ENTRIES) {
            const oldest = cache.current.keys().next().value;
            if (oldest) cache.current.delete(oldest);
          }
        }
        setState({ key, ...emptyState, data });
      } catch (error: unknown) {
        if (active.current?.id !== requestId || latestKey.current !== key)
          return;
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "读取统计失败，请检查连接或权限";
        setState((previous) => ({
          key,
          ...emptyState,
          data: previous.key === key ? previous.data : null,
          stale: true,
          error: message,
        }));
      } finally {
        if (active.current?.id === requestId) active.current = null;
      }
    }, 300);

    return () => {
      window.clearTimeout(timer);
      if (active.current?.id === requestId) cancelActive();
    };
  }, [
    key,
    bucket,
    profileId,
    online,
    revision,
    cancelActive,
    profile?.provider,
  ]);

  useEffect(() => {
    let refreshTimer: number | undefined;
    const changed = (scope: BucketUsageInvalidation) => {
      for (const [cacheKey, entry] of cache.current) {
        if (
          entry.data.profileId === scope.profileId &&
          entry.data.bucket === scope.bucket
        ) {
          cache.current.delete(cacheKey);
        }
      }
      if (scope.profileId !== profileId || scope.bucket !== bucket) return;
      cancelActive();
      setState((previous) => ({
        ...previous,
        loading: false,
        stale: !!previous.data,
      }));
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        forceNext.current = true;
        setRevision((value) => value + 1);
      }, 1500);
    };
    const unlisten = onEvent("bucket-usage:changed", changed);
    const onMutation = (event: Event) => {
      const { detail } = event as CustomEvent<BucketUsageInvalidation>;
      changed(detail);
    };
    window.addEventListener(BUCKET_USAGE_INVALIDATED, onMutation);
    return () => {
      unlisten();
      window.removeEventListener(BUCKET_USAGE_INVALIDATED, onMutation);
      if (refreshTimer) window.clearTimeout(refreshTimer);
    };
  }, [profileId, bucket, cancelActive]);

  const fetchedAt = state.key === key ? state.data?.fetchedAt : undefined;
  useEffect(() => {
    if (!key || !fetchedAt) return;
    const fetchedMs = Date.parse(fetchedAt);
    if (!Number.isFinite(fetchedMs)) return;
    const markExpired = () => {
      setState((previous) =>
        previous.key === key && previous.data?.fetchedAt === fetchedAt
          ? { ...previous, stale: true }
          : previous,
      );
    };
    const timer = window.setTimeout(
      markExpired,
      Math.max(0, fetchedMs + CACHE_TTL_MS - Date.now()),
    );
    const onFocus = () => {
      if (online && Date.now() - fetchedMs >= CACHE_TTL_MS && !active.current) {
        setRevision((value) => value + 1);
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [key, fetchedAt, online]);

  const visible =
    state.key === key ? state : { ...emptyState, loading: !!key && online };
  return {
    data: visible.data,
    loading: visible.loading,
    error: visible.error,
    stale: visible.stale,
    cancelled: visible.cancelled,
    refresh,
    cancel,
  };
}
