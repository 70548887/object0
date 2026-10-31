import type { ProfileInfo } from "@shared/profile.types";
import type { BucketUsage } from "@shared/s3.types";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BUCKET_USAGE_INVALIDATED,
  type BucketUsageInvalidation,
} from "@/lib/bucket-usage-events";
import { onEvent, rpcCall } from "@/lib/rpc-client";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 20;

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
        const data = await rpcCall("buckets:usage", {
          profileId,
          bucket,
          requestId,
          force,
        });
        if (active.current?.id !== requestId || latestKey.current !== key)
          return;
        if (data.profileId !== profileId || data.bucket !== bucket) {
          throw new Error("统计结果与当前存储桶不一致，请重新刷新");
        }
        if (data.complete) {
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
  }, [key, bucket, profileId, online, revision, cancelActive]);

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
