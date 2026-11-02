import type {
  ObjectFilters,
  S3Object,
  S3Prefix,
  SortDirection,
  SortField,
} from "@shared/s3.types";
import { create } from "zustand";
import { DEFAULT_PAGE_SIZE } from "@/lib/constants";
import { t } from "@/lib/i18n";
import { rpcCall } from "@/lib/rpc-client";
import { useUIStore } from "./useUIStore";

interface ObjectState {
  objects: S3Object[];
  prefixes: S3Prefix[];
  loading: boolean;
  error: string | null;

  // Navigation
  currentPrefix: string;
  prefixHistory: string[];

  // Pagination
  isTruncated: boolean;
  nextCursor: string | undefined;
  pageHistory: string[]; // opaque cursors already consumed in the current scope

  // Sorting
  sortField: SortField;
  sortDir: SortDirection;

  // Filters
  filters: ObjectFilters;

  // Selection
  selectedKeys: Set<string>;

  // Actions
  loadObjects: (
    profileId: string,
    bucket: string,
    prefix?: string,
    pageSize?: number,
    cursor?: string,
  ) => Promise<void>;
  navigateToPrefix: (prefix: string) => void;
  navigateBack: () => void;
  setSort: (field: SortField) => void;
  setFilters: (filters: Partial<ObjectFilters>) => void;
  toggleSelect: (key: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  reset: () => void;
}

const defaultFilters: ObjectFilters = {
  fileType: "all",
  size: "any",
  date: { type: "any" },
  search: "",
};

// Monotonic token guarding against out-of-order objects:list responses. Each
// loadObjects call claims the next value; only the latest may commit its result.
let loadGeneration = 0;
let currentScope = "";
let consumedCursors = new Set<string>();

export const useObjectStore = create<ObjectState>()((set, get) => ({
  objects: [],
  prefixes: [],
  loading: false,
  error: null,
  currentPrefix: "",
  prefixHistory: [],
  isTruncated: false,
  nextCursor: undefined,
  pageHistory: [],
  sortField: "key",
  sortDir: "asc",
  filters: { ...defaultFilters },
  selectedKeys: new Set(),

  loadObjects: async (profileId, bucket, prefix, pageSize, cursor) => {
    const generation = ++loadGeneration;
    const resolvedPrefix = prefix ?? get().currentPrefix;
    const resolvedPageSize =
      pageSize ?? useUIStore.getState().pageSize ?? DEFAULT_PAGE_SIZE;
    const scope = JSON.stringify([
      profileId,
      bucket,
      resolvedPrefix,
      resolvedPageSize,
    ]);
    try {
      if (cursor && scope !== currentScope) {
        throw new Error(
          t(
            "分页范围已改变，请从第一页重新加载",
            "The listing scope changed. Reload from the first page",
          ),
        );
      }
      if (!cursor || scope !== currentScope) {
        currentScope = scope;
        consumedCursors = new Set();
      }
      set({ loading: true, error: null });

      const result = await rpcCall("objects:list", {
        profileId,
        bucket,
        prefix: resolvedPrefix,
        maxKeys: resolvedPageSize,
        cursor,
      });

      // A newer load started while this request was in flight — drop the stale
      // result so it can't overwrite the newer view (e.g. wrong bucket on a fast
      // tab switch).
      if (generation !== loadGeneration) return;

      if (cursor) consumedCursors.add(cursor);
      if (
        result.isTruncated &&
        (!result.nextCursor || consumedCursors.has(result.nextCursor))
      ) {
        throw new Error(
          t(
            "存储服务返回异常分页标识，请刷新列表后重试",
            "Storage returned an invalid or repeated cursor. Refresh the list and retry",
          ),
        );
      }

      set({
        objects: result.objects,
        prefixes: result.prefixes,
        isTruncated: result.isTruncated,
        nextCursor: result.isTruncated ? result.nextCursor : undefined,
        pageHistory: [...consumedCursors],
        loading: false,
        selectedKeys: new Set(),
      });
    } catch (err: unknown) {
      // Stale failure must not clobber a newer load's state either.
      if (generation !== loadGeneration) return;
      set({
        error: err instanceof Error ? err.message : "未知错误",
        loading: false,
      });
    }
  },

  navigateToPrefix: (prefix) => {
    ++loadGeneration;
    currentScope = "";
    consumedCursors = new Set();
    const current = get().currentPrefix;
    set((s) => ({
      currentPrefix: prefix,
      prefixHistory: [...s.prefixHistory, current],
      selectedKeys: new Set(),
      pageHistory: [],
    }));
  },

  navigateBack: () => {
    const history = get().prefixHistory;
    if (history.length === 0) return;
    ++loadGeneration;
    currentScope = "";
    consumedCursors = new Set();

    const previous = history[history.length - 1];
    set({
      currentPrefix: previous,
      prefixHistory: history.slice(0, -1),
      selectedKeys: new Set(),
      pageHistory: [],
    });
  },

  setSort: (field) => {
    const { sortField, sortDir } = get();
    if (sortField === field) {
      set({ sortDir: sortDir === "asc" ? "desc" : "asc" });
    } else {
      set({ sortField: field, sortDir: "asc" });
    }
  },

  setFilters: (partial) => {
    set((s) => ({ filters: { ...s.filters, ...partial } }));
  },

  toggleSelect: (key) => {
    set((s) => {
      const next = new Set(s.selectedKeys);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return { selectedKeys: next };
    });
  },

  selectAll: () => {
    set((s) => ({
      selectedKeys: new Set([
        ...s.objects.map((o) => o.key),
        ...s.prefixes.map((p) => p.prefix),
      ]),
    }));
  },

  clearSelection: () => set({ selectedKeys: new Set() }),

  reset: () => {
    ++loadGeneration;
    currentScope = "";
    consumedCursors = new Set();
    set({
      objects: [],
      prefixes: [],
      loading: false,
      error: null,
      currentPrefix: "",
      prefixHistory: [],
      isTruncated: false,
      nextCursor: undefined,
      pageHistory: [],
      selectedKeys: new Set(),
      filters: { ...defaultFilters },
    });
  },
}));
