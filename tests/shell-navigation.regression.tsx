// Actual stores/hooks/component handlers; no DOM, native app or real cloud.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
});
const calls: unknown[] = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  onEvent: () => () => {},
  rpcCall: async (...args: unknown[]) => {
    calls.push(args);
    return { objects: [], prefixes: [], isTruncated: false };
  },
}));
const actual = await import("../src/mainview/stores");
const hook = <S,>(store: { getState(): S }) =>
  Object.assign(
    (selector?: (state: S) => unknown) =>
      selector ? selector(store.getState()) : store.getState(),
    store,
  );
mock.module("../src/mainview/stores", () =>
  Object.fromEntries(
    Object.entries(actual).map(([name, store]) => [
      name,
      typeof store?.getState === "function" ? hook(store) : store,
    ]),
  ),
);
const react = await import("react");
const effects: Array<() => unknown> = [];
mock.module("react", () => ({
  ...react,
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useState: (initial: unknown) => [
    typeof initial === "function" ? initial() : initial,
    () => {},
  ],
  useEffect: (fn: () => unknown) => effects.push(fn),
}));
mock.module("../src/mainview/lib/i18n", () => ({
  t: (zh: string) => zh,
  localize: (text: string) => text,
  useT: () => (zh: string) => zh,
}));
const { useS3Objects, isNavigationScopeCurrent } = await import(
  "../src/mainview/hooks/useS3Objects"
);
const { directoryCrumbs, parentDirectory } = await import(
  "../src/mainview/lib/file-navigation"
);
const { shouldIgnoreFileSearchShortcut } = await import(
  "../src/mainview/lib/search-shortcut"
);
const { useRecentLocationsStore, cleanRecentLocations } = await import(
  "../src/mainview/stores/useRecentLocationsStore"
);
const { openRecentLocation } = await import(
  "../src/mainview/components/layout/SidebarQuickNav"
);
const { TopBar } = await import("../src/mainview/components/layout/TopBar");
const { AppTitleBar } = await import(
  "../src/mainview/components/layout/AppTitleBar"
);
const { ObjectBreadcrumb } = await import(
  "../src/mainview/components/objects/ObjectBreadcrumb"
);
const p = {
  id: "p",
  name: "Fixture",
  provider: "r2" as const,
  createdAt: "t",
  updatedAt: "r1",
  hasR2AnalyticsToken: false,
};
actual.useVaultStore.setState({ unlocked: true, profiles: [p] });
actual.useProfileStore.setState({ activeProfileId: p.id, activeProfile: p });
actual.useBucketStore.setState({ selectedBucket: "bucket" });
actual.useTabStore.setState({
  tabs: [
    {
      id: "tab",
      profileId: p.id,
      profileName: p.name,
      bucket: "bucket",
      prefix: "",
    },
  ],
  activeTabId: "tab",
});
actual.useObjectStore.getState().reset();
actual.useUIStore.setState({ platform: "windows", textEditorTarget: null });
function Actions() {
  return useS3Objects();
}
const state = () => actual.useObjectStore.getState();
Actions().navigate("a/");
Actions().navigate("a/b/");
assert.deepEqual(state().prefixHistory, ["", "a/"]);
state().toggleSelect("stale");
Actions().goBack();
assert.equal(state().currentPrefix, "a/");
assert.deepEqual(state().prefixForward, ["a/b/"]);
Actions().goForward();
assert.equal(state().currentPrefix, "a/b/");
assert.deepEqual(state().prefixForward, []);
assert.equal(state().selectedKeys.size, 0);
Actions().goUp();
assert.equal(state().currentPrefix, "a/");
Actions().goBack();
assert.equal(state().currentPrefix, "a/b/");
Actions().navigate("new/");
assert.deepEqual(state().prefixForward, []);
assert.equal(
  calls.length,
  0,
  "address actions never add a second automatic listing owner",
);
const stale = Actions();
actual.useBucketStore.setState({ selectedBucket: "elsewhere" });
stale.navigate("wrong/");
stale.goBack();
stale.goForward();
stale.goUp();
stale.refresh();
assert.equal(state().currentPrefix, "new/");
assert.equal(calls.length, 0);
actual.useBucketStore.setState({ selectedBucket: "bucket" });
actual.useVaultStore.setState({ profiles: [{ ...p, updatedAt: "r2" }] });
assert.equal(isNavigationScopeCurrent(p.id, "bucket", "new/", "r1"), false);
stale.navigate("wrong/");
assert.equal(state().currentPrefix, "new/");
actual.useVaultStore.setState({ profiles: [p] });
state().reset();
assert.deepEqual(state().prefixForward, []);
assert.deepEqual(directoryCrumbs("中文//+%?#/./"), [
  { label: "中文", prefix: "中文/" },
  { label: "", prefix: "中文//" },
  { label: "+%?#", prefix: "中文//+%?#/" },
  { label: ".", prefix: "中文//+%?#/./" },
]);
assert.equal(parentDirectory("中文//+%?#/"), "中文//");
assert.equal(parentDirectory(""), "");
const event = (matched: boolean, extra = {}) =>
  ({
    target: { closest: () => (matched ? {} : null) },
    defaultPrevented: false,
    isComposing: false,
    keyCode: 70,
    ...extra,
  }) as unknown as KeyboardEvent;
assert(shouldIgnoreFileSearchShortcut(event(true)));
assert(shouldIgnoreFileSearchShortcut(event(false, { isComposing: true })));
assert(shouldIgnoreFileSearchShortcut(event(false, { keyCode: 229 })));
assert(
  shouldIgnoreFileSearchShortcut(event(false, { defaultPrevented: true })),
);
assert.equal(shouldIgnoreFileSearchShortcut(event(false)), false);

const record = {
  profileId: p.id,
  revision: "r1",
  bucket: "bucket",
  prefix: "a/",
};
useRecentLocationsStore.getState().record(record);
useRecentLocationsStore.getState().record(record);
assert.equal(useRecentLocationsStore.getState().entries.length, 1);
const cleaned = cleanRecentLocations([
  { ...record, visitedAt: 1, secretAccessKey: "must-never-persist" },
  { ...record, revision: "", visitedAt: 2 },
]);
assert.equal(cleaned.length, 1);
assert.equal("secretAccessKey" in cleaned[0], false);
assert.equal(
  openRecentLocation(cleaned[0], (profileId, bucket) =>
    actual.useTabStore.getState().openBucket(profileId, p.name, bucket),
  ),
  true,
);
assert.equal(
  actual.useTabStore.getState().tabs.find((tab) => tab.id === "tab")?.prefix,
  "a/",
);
actual.useVaultStore.setState({ profiles: [{ ...p, updatedAt: "r2" }] });
let selected = false;
assert.equal(
  openRecentLocation(cleaned[0], () => {
    selected = true;
  }),
  false,
);
assert.equal(selected, false);
actual.useVaultStore.setState({ profiles: [p] });
actual.useObjectStore.setState({ currentPrefix: "a/" });

type Node = ReactElement<Record<string, unknown>>;
const nodes = (value: unknown): Node[] =>
  !value || typeof value !== "object"
    ? []
    : Array.isArray(value)
      ? value.flatMap(nodes)
      : [
          value as Node,
          ...nodes((value as Node).props?.children),
          ...nodes((value as Node).props?.render),
        ];
const tree = TopBar();
// The full-width application title owns global tools; file navigation stays in TopBar.
const titleTree = AppTitleBar();
const all = [...nodes(titleTree), ...nodes(tree)];
const clickAction = (aria: string) => {
  const node = all.find((item) => item.props?.["aria-label"] === aria);
  assert(node);
  (node.props.onClick as () => void)();
};
const oldTheme = actual.useThemeStore.getState().theme;
clickAction("切换主题");
assert.notEqual(actual.useThemeStore.getState().theme, oldTheme);
clickAction("显示或隐藏分享记录");
assert.equal(actual.useUIStore.getState().shareHistoryOpen, true);
clickAction("显示或隐藏实时同步面板");
assert.equal(actual.useUIStore.getState().folderSyncPanelOpen, true);
clickAction("显示或隐藏设置面板");
assert.equal(actual.useUIStore.getState().settingsOpen, true);
for (const aria of [
  "切换主题",
  "显示或隐藏分享记录",
  "显示或隐藏任务面板",
  "显示或隐藏实时同步面板",
  "显示或隐藏设置面板",
  "搜索文件和文件夹",
])
  assert(
    all.some((node) => node.props?.["aria-label"] === aria),
    aria,
  );
for (const name of [
  "KeyboardShortcutsDialog",
  "WindowControls",
  "ObjectToolbar",
])
  assert(
    all.some(
      (node) => typeof node.type === "function" && node.type.name === name,
    ),
    name,
  );
const search = all.find(
  (node) => node.props?.["aria-label"] === "搜索文件和文件夹",
);
assert(search);
(search.props.onClick as () => void)();
assert(actual.useUIStore.getState().objectSearchOpen);
let copied = "";
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    clipboard: {
      writeText: async (value: string) => {
        copied = value;
      },
    },
  },
});
state().reset();
actual.useTabStore.getState().updateTabPrefix("tab", "");
const rootCrumb = nodes(
  ObjectBreadcrumb({ profileName: p.name, bucket: "bucket" }),
);
const copy = rootCrumb.find(
  (node) => node.props?.["aria-label"] === "复制当前路径",
);
assert(copy);
(copy.props.onClick as () => void)();
await Promise.resolve();
assert.equal(copied, "bucket");
console.log(
  "SHELL_NAVIGATION_PASS: brand/actions retained; actual search trigger; back/forward/up and one listing owner; stale account/bucket/revision refusal; opaque prefixes; root copy; editable/IME CtrlF; recent allowlist/revision checks; fixture IPC only",
);
