// Isolated actual UI/store handlers. Memory-only persistence; all RPCs mocked.
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
const calls: unknown[][] = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  onEvent: () => () => {},
  rpcCall: async (...args: unknown[]) => {
    calls.push(args);
    return [];
  },
}));
const actual = await import("../src/mainview/stores");
const recentModule = await import(
  "../src/mainview/stores/useRecentLocationsStore"
);
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
mock.module("../src/mainview/stores/useRecentLocationsStore", () => ({
  ...recentModule,
  useRecentLocationsStore: hook(recentModule.useRecentLocationsStore),
}));
const react = await import("react");
const effects: Array<() => unknown> = [];
mock.module("react", () => ({
  ...react,
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useState: (initial: unknown) => [initial, () => {}],
  useRef: () => ({ current: null }),
  useEffect: (fn: () => unknown) => effects.push(fn),
}));
let language = "zh";
const translate = (zh: string, en: string) => (language === "zh" ? zh : en);
mock.module("../src/mainview/lib/i18n", () => ({
  t: translate,
  useT: () => translate,
  localize: (value: string) => value,
}));
let mobile = false;
let mobileClosed = 0;
const sidebar = await import("../src/mainview/components/ui/sidebar");
mock.module("../src/mainview/components/ui/sidebar", () => ({
  ...sidebar,
  useSidebar: () => ({
    isMobile: mobile,
    setOpenMobile: (open: boolean) => {
      if (!open) mobileClosed++;
    },
  }),
}));
mock.module("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({ getVirtualItems: () => [], measure: () => {} }),
}));
const { NavigationWorkspace } = await import(
  "../src/mainview/components/layout/NavigationWorkspace"
);
const { SidebarQuickNav, openRecentLocation } = await import(
  "../src/mainview/components/layout/SidebarQuickNav"
);
const { useS3Buckets } = await import("../src/mainview/hooks/useS3Buckets");
const { JobPanel } = await import("../src/mainview/components/jobs/JobPanel");
type Node = ReactElement<Record<string, unknown>>;
const nodes = (value: unknown): Node[] =>
  !value || typeof value !== "object"
    ? []
    : Array.isArray(value)
      ? value.flatMap(nodes)
      : [value as Node, ...nodes((value as Node).props?.children)];
const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : Array.isArray(value)
      ? value.map(text).join(" ")
      : value && typeof value === "object"
        ? text((value as Node).props?.children)
        : "";
const click = (node: Node | undefined) => {
  assert(node);
  (node.props.onClick as () => void)();
};
function Actions() {
  return useS3Buckets();
}
const ui = () => actual.useUIStore.getState();
const p = {
  id: "fixture-r2",
  name: "Very long R2 account 中文 ".repeat(12),
  provider: "r2" as const,
  createdAt: "t",
  updatedAt: "revision-1",
  hasR2AnalyticsToken: false,
};
const q = {
  ...p,
  id: "fixture-qiniu",
  name: "七牛账号",
  provider: "qiniu" as const,
};
const bucket = "long-bucket-".repeat(20);
actual.useVaultStore.setState({ unlocked: true, profiles: [p, q] });
actual.useProfileStore.setState({ activeProfileId: p.id, activeProfile: p });
actual.useFavoritesStore.setState({
  favorites: new Set([
    `${p.id}:${bucket}`,
    `${q.id}:qiniu-bucket`,
    "removed:missing",
  ]),
});
actual.useBucketStore.setState({ selectedBucket: bucket });
actual.useTabStore.getState().openBucket(p.id, p.name, bucket);
actual.useObjectStore.setState({ currentPrefix: "" });
assert.equal(ui().mainSection, "storage");
actual.useUIStore.setState({
  objectSearchOpen: true,
  jobPanelOpen: true,
  textEditorTarget: { fixture: "draft" } as never,
});
ui().setMainSection("favorites");
assert.equal(ui().objectSearchOpen, false);
assert.equal(ui().jobPanelOpen, false);
assert.deepEqual(ui().textEditorTarget, { fixture: "draft" });
ui().setJobPanelOpen(true);
assert.equal(ui().jobPanelOpen, true, "other sections retain the task popover");
ui().setMainSection("transfers");
for (let attempt = 0; attempt < 3; attempt++) {
  ui().setJobPanelOpen(true);
  assert.equal(
    ui().jobPanelOpen,
    false,
    "Ctrl+J cannot duplicate the workspace task panel",
  );
  assert.equal(ui().mainSection, "transfers");
}
ui().setJobPanelOpen(false);
assert.equal(ui().jobPanelOpen, false);
ui().setMainSection("favorites");
assert.equal(
  JSON.parse(memory.get("object0-ui") ?? "{}").state.mainSection,
  undefined,
);

let scrolled = 0;
const navProps = {
  profiles: [p, q],
  favorites: [{ profileId: p.id, bucket }],
  onSelectBucket: () => {},
  onToggleFavorite: () => {},
  onShowStorage: () => scrolled++,
};
const nav = () => SidebarQuickNav(navProps);
for (const section of [
  "favorites",
  "recent",
  "transfers",
  "shares",
  "storage",
] as const) {
  const button = nodes(nav()).find((node) => node.key === section);
  assert(button);
  click(button);
  assert.equal(ui().mainSection, section);
  const selected = nodes(nav()).filter(
    (node) => node.props["aria-current"] === "page",
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0].key, section);
}
assert.equal(scrolled, 1);
mobile = true;
click(nodes(nav()).find((node) => node.key === "recent"));
assert.equal(mobileClosed, 1);
mobile = false;
recentModule.useRecentLocationsStore.setState({ entries: [] });
effects.length = 0;
ui().setMainSection("favorites");
nav();
effects.splice(0).forEach((effect) => {
  effect();
});
assert.equal(recentModule.useRecentLocationsStore.getState().entries.length, 0);
ui().setMainSection("storage");
nav();
effects.splice(0).forEach((effect) => {
  effect();
});
assert.equal(recentModule.useRecentLocationsStore.getState().entries.length, 1);

let tree = NavigationWorkspace({ section: "favorites" });
assert.equal(nodes(tree).filter((node) => node.type === "li").length, 2);
assert(text(tree).includes(bucket));
assert(
  nodes(tree).some((node) => String(node.props.className).includes("min-w-0")),
);
const favoriteButtons = nodes(tree).filter(
  (node) => text(node) === "打开" && node.props.onClick,
);
ui().setMainSection("favorites");
click(favoriteButtons[1]);
assert.equal(ui().mainSection, "storage");
assert.equal(
  actual.useTabStore
    .getState()
    .tabs.find((tab) => tab.id === actual.useTabStore.getState().activeTabId)
    ?.profileId,
  q.id,
);
ui().setMainSection("favorites");
actual.useVaultStore.setState({
  profiles: [{ ...p, updatedAt: "changed" }, q],
});
click(favoriteButtons[0]);
assert.equal(
  ui().mainSection,
  "favorites",
  "stale rendered account cannot open a replacement identity",
);
actual.useVaultStore.setState({ profiles: [p, q] });
click(nodes(tree).find((node) => node.props["aria-label"] === "取消收藏"));
assert.equal(
  actual.useFavoritesStore.getState().isFavorite(p.id, bucket),
  false,
);

const entry = {
  profileId: p.id,
  revision: p.updatedAt,
  bucket,
  prefix: "目录/+%?#/".repeat(12),
  visitedAt: 1700000000000,
};
for (const visitedAt of [
  1e100,
  -1e100,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "1700000000000",
  null,
]) {
  assert.deepEqual(
    recentModule.cleanRecentLocations([{ ...entry, visitedAt }]),
    [],
    "invalid history timestamps are rejected before persistence/hydration",
  );
}
for (const visitedAt of [0, -8640000000000000, 8640000000000000]) {
  assert.equal(
    recentModule.cleanRecentLocations([{ ...entry, visitedAt }]).length,
    1,
  );
}
// A single corrupt record injected after cleaning still cannot crash the view.
recentModule.useRecentLocationsStore.setState({
  entries: [{ ...entry, visitedAt: 1e100 }],
});
for (language of ["zh", "en"]) {
  const damagedTree = NavigationWorkspace({ section: "recent" });
  assert.equal(
    nodes(damagedTree).filter((node) => node.type === "li").length,
    1,
  );
  assert(text(damagedTree).includes(translate("未知时间", "Unknown time")));
  assert.equal(
    nodes(damagedTree).find((node) => node.type === "time")?.props.dateTime,
    undefined,
  );
}
language = "zh";
recentModule.useRecentLocationsStore.setState({
  entries: [entry, { ...entry, profileId: q.id, revision: "obsolete" }],
});
tree = NavigationWorkspace({ section: "recent" });
assert.equal(nodes(tree).filter((node) => node.type === "li").length, 1);
assert(text(tree).includes(entry.prefix));
assert(text(tree).includes("访问时间"));
assert(nodes(tree).some((node) => node.type === "time"));
assert(nodes(tree).some((node) => node.props.role === "status"));
ui().setMainSection("recent");
click(nodes(tree).find((node) => node.props.onClick && text(node) === "打开"));
assert.equal(ui().mainSection, "storage");
assert.equal(
  actual.useTabStore
    .getState()
    .tabs.find((tab) => tab.id === actual.useTabStore.getState().activeTabId)
    ?.prefix,
  entry.prefix,
);
ui().setMainSection("recent");
actual.useVaultStore.setState({ unlocked: false });
assert.equal(
  openRecentLocation(entry, () => {
    throw Error("must not select while locked");
  }),
  false,
);
assert.equal(ui().mainSection, "recent");
actual.useVaultStore.setState({ unlocked: true });
ui().setMainSection("transfers");
Actions().selectFavoriteBucket("missing", "missing");
assert.equal(ui().mainSection, "transfers");
Actions().selectBucket(bucket);
assert.equal(ui().mainSection, "storage");
ui().setMainSection("recent");
Actions().switchProfile(null);
assert.equal(ui().mainSection, "storage");

assert(
  nodes(NavigationWorkspace({ section: "transfers" })).some(
    (node) => node.type === JobPanel && node.props.presentation === "workspace",
  ),
);
assert(
  String(JobPanel({ presentation: "workspace" }).props.className).includes(
    "h-full",
  ),
);
assert(
  !String(JobPanel({ presentation: "workspace" }).props.className).includes(
    "70vh",
  ),
);
assert(String(JobPanel().props.className).includes("70vh"));
actual.useFavoritesStore.setState({ favorites: new Set() });
recentModule.useRecentLocationsStore.setState({ entries: [] });
for (language of ["zh", "en"]) {
  assert(
    text(NavigationWorkspace({ section: "favorites" })).includes(
      translate("暂无收藏", "No favorites yet"),
    ),
  );
  assert(
    text(NavigationWorkspace({ section: "recent" })).includes(
      translate("暂无最近访问", "No recent locations yet"),
    ),
  );
}
assert(
  calls.every(([method]) => method === "favorites:save"),
  "no real listing/transfer RPC is needed by navigation pages",
);
console.log(
  "PASS navigation workspace: five routes, memory-only state, selected/mobile navigation, storage-only recents, cross-account favorites, stale/locked guards, recent prefix/time, corrupt timestamp filtering and bilingual fallback, transfer presentation and duplicate-popover guard, bilingual empty states; no live cloud",
);
