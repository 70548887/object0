// Real component/store handlers, mocked clipboard/RPC, memory-only fixtures; no live account or network.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => memory.set(k, v),
    removeItem: (k: string) => memory.delete(k),
  },
});
const rpcCalls: unknown[][] = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  onEvent: () => () => {},
  rpcCall: async (...args: unknown[]) => {
    rpcCalls.push(args);
    throw Error("RPC forbidden in share workspace");
  },
}));
const copied: string[] = [];
let copyFails = false;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    userAgent: "fixture",
    platform: "Win32",
    maxTouchPoints: 0,
    clipboard: {
      writeText: async (s: string) => {
        if (copyFails) throw Error("fixture clipboard failure");
        copied.push(s);
      },
    },
  },
});
const notices: string[] = [];
mock.module("../src/mainview/components/common/Toast", () => ({
  toast: {
    success: (s: string) => notices.push(s),
    error: (s: string) => notices.push(s),
  },
}));
const timers = new Map<number, () => void>();
let timerId = 0;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    setInterval: (f: () => void, ms: number) => {
      assert(ms > 0);
      timers.set(++timerId, f);
      return timerId;
    },
    clearInterval: (id: number) => timers.delete(id),
  },
});
const actual = await import("../src/mainview/stores");
const hook = <S,>(store: { getState(): S }) =>
  Object.assign(
    (selector?: (s: S) => unknown) =>
      selector ? selector(store.getState()) : store.getState(),
    store,
  );
mock.module("../src/mainview/stores", () =>
  Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v?.getState === "function" ? hook(v) : v,
    ]),
  ),
);
const recent = await import("../src/mainview/stores/useRecentLocationsStore");
mock.module("../src/mainview/stores/useRecentLocationsStore", () => ({
  ...recent,
  useRecentLocationsStore: hook(recent.useRecentLocationsStore),
}));
const React = await import("react");
let slots: unknown[] = [],
  cursor = 0;
let effects: Array<() => unknown> = [];
mock.module("react", () => ({
  ...React,
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useState: (initial: unknown) => {
    const state = slots,
      i = cursor++;
    if (!(i in state))
      state[i] = typeof initial === "function" ? initial() : initial;
    return [
      state[i],
      (value: unknown) => {
        state[i] = typeof value === "function" ? value(state[i]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (fn: () => unknown) => effects.push(fn),
}));
let language: "zh" | "en" = "zh";
const tr = (zh: string, en: string) => (language === "zh" ? zh : en);
mock.module("../src/mainview/lib/i18n", () => ({
  t: tr,
  useT: () => tr,
  localize: (s: string) => s,
}));
let mobile = false,
  mobileClosed = 0;
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
const { ShareHistory, ShareHistoryPanel } = await import(
  "../src/mainview/components/share/ShareHistory"
);
const { NavigationWorkspace } = await import(
  "../src/mainview/components/layout/NavigationWorkspace"
);
const { SidebarQuickNav } = await import(
  "../src/mainview/components/layout/SidebarQuickNav"
);
const { AppTitleBar } = await import(
  "../src/mainview/components/layout/AppTitleBar"
);
const { Sheet } = await import("../src/mainview/components/ui/sheet");

type Node = ReactElement<Record<string, unknown>>;
const nodes = (v: unknown): Node[] =>
  !v || typeof v !== "object"
    ? []
    : Array.isArray(v)
      ? v.flatMap(nodes)
      : [
          v as Node,
          ...nodes((v as Node).props?.children),
          ...nodes((v as Node).props?.render),
        ];
const text = (v: unknown): string =>
  typeof v === "string" || typeof v === "number"
    ? String(v)
    : Array.isArray(v)
      ? v.map(text).join("")
      : v && typeof v === "object"
        ? text((v as Node).props?.children)
        : "";
const click = async (node: Node | undefined) => {
  assert(node, "expected clickable node");
  await (node.props.onClick as () => unknown)();
};
const ui = () => actual.useUIStore.getState();
const history = () => actual.useShareHistoryStore.getState();
const render = <T,>(fn: () => T, reset = false) => {
  if (reset) slots = [];
  cursor = 0;
  effects = [];
  return fn();
};
const panel = (reset = false) =>
  render(() => ShareHistoryPanel({ presentation: "workspace" }), reset);
const rows = (tree: unknown) => nodes(tree).filter((n) => n.type === "li");
const ids = (tree: unknown) => rows(tree).map((n) => n.key);
const button = (tree: unknown, prefix: string) =>
  nodes(tree).find((n) => n.props.onClick && text(n).startsWith(prefix));
const common = {
  profileId: "fixture-only",
  bucket: "fixture-bucket",
  key: "folder/file.txt",
  url: "https://fixture.invalid/share",
  createdAt: new Date().toISOString(),
};
const now = Date.now();
const fixtures = [
  {
    ...common,
    id: "public",
    accessMode: "public" as const,
    expiresAt: new Date(now - 3600_000).toISOString(),
  },
  {
    ...common,
    id: "active",
    accessMode: "signed" as const,
    expiresAt: new Date(now + 3600_000).toISOString(),
  },
  {
    ...common,
    id: "expired",
    accessMode: "signed" as const,
    expiresAt: new Date(now - 3600_000).toISOString(),
  },
  { ...common, id: "unknown", expiresAt: null },
];
actual.useUIStore.setState({
  persistShareHistory: false,
  mainSection: "storage",
  shareHistoryOpen: true,
});
actual.useShareHistoryStore.setState({ entries: fixtures });
const navProps = {
  profiles: [],
  favorites: [],
  onSelectBucket: () => {},
  onToggleFavorite: () => {},
  onShowStorage: () => {
    throw Error("shares must not scroll storage");
  },
};
for (language of ["zh", "en"]) {
  const nav = render(() => SidebarQuickNav(navProps));
  const keys = nodes(nav)
    .filter((n) => n.key)
    .map((n) => n.key);
  assert.deepEqual(keys, [
    "storage",
    "favorites",
    "recent",
    "transfers",
    "shares",
  ]);
  const entry = nodes(nav).find((n) => n.key === "shares");
  assert(
    entry &&
      text(entry).includes(tr("分享记录", "Sharing history")) &&
      text(entry).includes("4"),
  );
  actual.useUIStore.setState({ shareHistoryOpen: true });
  await click(entry);
  assert.equal(ui().mainSection, "shares");
  assert.equal(ui().shareHistoryOpen, false);
  assert.equal(
    nodes(render(() => SidebarQuickNav(navProps))).filter(
      (n) => n.props["aria-current"] === "page",
    )[0].key,
    "shares",
  );
  for (let i = 0; i < 3; i++) {
    ui().setShareHistoryOpen(true);
    assert.equal(ui().shareHistoryOpen, false);
  }
  const titlebar = render(() => AppTitleBar());
  const titleEntry = nodes(titlebar).find(
    (n) =>
      n.props["aria-label"] ===
      tr("显示或隐藏分享记录", "Toggle share history"),
  );
  assert.equal(titleEntry?.props["aria-pressed"], true);
  await click(titleEntry);
  assert.equal(ui().shareHistoryOpen, false);
  const workspace = render(() => NavigationWorkspace({ section: "shares" }));
  assert.equal(workspace.props["data-testid"], "navigation-workspace-shares");
  assert(
    nodes(workspace).some(
      (n) => n.type === ShareHistory && n.props.presentation === "workspace",
    ),
  );
  const workspaceContent = render(() =>
    ShareHistory({ presentation: "workspace" }),
  );
  assert(
    !nodes(workspaceContent).some((n) => n.type === Sheet),
    "workspace cannot be a Sheet",
  );
  assert(nodes(workspaceContent).some((n) => n.type === ShareHistoryPanel));
  assert(
    nodes(render(() => ShareHistory({}))).some((n) => n.type === Sheet),
    "default remains the existing sheet",
  );
  let tree = panel(true);
  assert.deepEqual(ids(tree), ["public", "active", "expired", "unknown"]);
  const cleanups = effects
    .map((effect) => effect())
    .filter((v): v is () => void => typeof v === "function");
  assert.deepEqual(
    history().entries.map((e) => e.id),
    fixtures.map((e) => e.id),
    "opening does not silently purge expired history",
  );
  assert.equal(
    ui().persistShareHistory,
    false,
    "viewing history must not enable persistence",
  );
  assert(
    text(tree).includes(tr("公开 · 无固定到期", "Public · No fixed expiry")),
  );
  assert(text(tree).includes(tr("有效期未知", "Expiration unknown")));
  assert(text(tree).includes(language === "zh" ? "设置" : "Settings"));
  const readonlyText = text(tree);
  assert(
    language === "en"
      ? readonlyText.includes("Saving sharing history is off")
      : readonlyText.includes("未开启"),
  );
  await click(button(tree, tr("有效（", "Active (")));
  tree = panel();
  assert.deepEqual(ids(tree), ["public", "active"]);
  await click(button(tree, tr("已过期（", "Expired (")));
  tree = panel();
  assert.deepEqual(ids(tree), ["expired"]);
  assert(
    !nodes(rows(tree)[0]).some(
      (n) => n.props.title === tr("复制链接", "Copy link"),
    ),
    "expired links are not copyable",
  );
  await click(button(tree, tr("全部（", "All (")));
  tree = panel();
  const publicRow = rows(tree).find((n) => n.key === "public");
  assert(publicRow);
  const copyButton = nodes(publicRow).find(
    (n) => n.props.title === tr("复制链接", "Copy link"),
  );
  await click(copyButton);
  assert.equal(copied.at(-1), common.url);
  assert.equal(notices.at(-1), tr("链接已复制！", "Link copied!"));
  copyFails = true;
  await click(copyButton);
  assert.equal(notices.at(-1), tr("复制失败", "Copy failed"));
  copyFails = false;
  for (const cleanup of cleanups) cleanup();
  assert.equal(
    timers.size,
    0,
    "expiry-refresh interval is cleaned up on unmount",
  );
  actual.useShareHistoryStore.setState({ entries: [] });
  assert(
    text(panel(true)).includes(tr("暂无分享记录", "No sharing history yet")),
  );
  actual.useShareHistoryStore.setState({ entries: fixtures });
}
language = "en";
mobile = true;
await click(
  nodes(render(() => SidebarQuickNav(navProps))).find(
    (n) => n.key === "shares",
  ),
);
assert.equal(mobileClosed, 1);
mobile = false;
ui().setMainSection("storage");
ui().setShareHistoryOpen(true);
assert.equal(ui().shareHistoryOpen, true);
const titleEntry = nodes(render(() => AppTitleBar())).find(
  (n) => n.props["aria-label"] === "Toggle share history",
);
await click(titleEntry);
assert.equal(ui().shareHistoryOpen, false);
await click(titleEntry);
assert.equal(
  ui().shareHistoryOpen,
  false,
  "stale callback remains a close, not a second opener",
);
ui().setShareHistoryOpen(true);
ui().setMainSection("favorites");
assert.equal(ui().shareHistoryOpen, false);
let tree = panel(true);
await click(button(tree, "Active ("));
actual.useShareHistoryStore.setState({ entries: [fixtures[2]] });
assert(text(panel()).includes("No matching entries"));
actual.useShareHistoryStore.setState({ entries: fixtures });
tree = panel(true);
await click(
  nodes(rows(tree).find((n) => n.key === "unknown")).find(
    (n) => n.props.title === "Remove",
  ),
);
assert.deepEqual(
  history().entries.map((e) => e.id),
  ["public", "active", "expired"],
);
await click(button(panel(), "Clear expired ("));
assert.deepEqual(
  history().entries.map((e) => e.id),
  ["public", "active"],
  "manual cleanup keeps public links even with old timestamp",
);
await click(button(panel(), "Clear all"));
assert.deepEqual(history().entries, []);
// Actual clock tick re-filters the active view without deleting persisted records.
const realNow = Date.now;
let fakeNow = now;
Date.now = () => fakeNow;
actual.useShareHistoryStore.setState({
  entries: [{ ...fixtures[1], expiresAt: new Date(now + 1000).toISOString() }],
});
tree = panel(true);
const cleanup = effects
  .map((e) => e())
  .filter((v): v is () => void => typeof v === "function");
await click(button(tree, "Active ("));
assert.equal(rows(panel()).length, 1);
fakeNow += 60_000;
for (const tick of timers.values()) tick();
assert.equal(rows(panel()).length, 0);
assert.equal(history().entries.length, 1);
for (const fn of cleanup) fn();
assert.equal(timers.size, 0);
Date.now = realNow;
assert.equal(ui().persistShareHistory, false);
assert.equal(
  rpcCalls.length,
  0,
  "navigation, copying and local cleanup must not contact cloud",
);
console.log(
  "PASS share workspace: bilingual fifth navigation/count/mobile, real store/titlebar duplicate-sheet gates, full workspace vs default sheet, empty/filter states including public and unknown, clipboard success/failure, no automatic cleanup or persistence opt-in, explicit remove/expired/all cleanup, expiry clock re-filter and timer cleanup; no network",
);
