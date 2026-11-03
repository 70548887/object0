// Actual component/provider handlers with memory-only stores and fixture IPC.
// CSS geometry and Sheet focus/keyboard behavior are verified in the browser.
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
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: new EventTarget(),
});
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: { cookie: "" },
});
const calls: Array<[string, unknown]> = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  onEvent: () => () => {},
  rpcCall: async (name: string, payload: unknown) => {
    calls.push([name, payload]);
    return name === "objects:list"
      ? { objects: [], prefixes: [], isTruncated: false }
      : { jobIds: ["fixture-job"] };
  },
}));
const messages: string[] = [];
mock.module("../src/mainview/components/common/Toast", () => ({
  toast: Object.fromEntries(
    ["success", "error", "warning", "info"].map((name) => [
      name,
      (message: string) => messages.push(message),
    ]),
  ),
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
let language: "zh" | "en" = "zh";
const translate = (zh: string, en: string) => (language === "zh" ? zh : en);
mock.module("../src/mainview/lib/i18n", () => ({
  t: translate,
  localize: (text: string) => text,
  useT: () => translate,
}));
let mobile = true;
mock.module("../src/mainview/hooks/useIsMobile", () => ({
  useIsMobile: () => mobile,
}));
const react = await import("react");
let slots: unknown[] = [];
let cursor = 0;
let context: unknown;
let effects: Array<() => unknown> = [];
mock.module("react", () => ({
  ...react,
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useContext: () => context,
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => {
    const state = slots;
    const index = cursor++;
    if (!(index in state))
      state[index] = typeof initial === "function" ? initial() : initial;
    return [
      state[index],
      (value: unknown) => {
        state[index] =
          typeof value === "function" ? value(state[index]) : value;
      },
    ];
  },
  useEffect: (fn: () => unknown) => effects.push(fn),
}));
const { TopBar } = await import("../src/mainview/components/layout/TopBar");
const { AppTitleBar } = await import(
  "../src/mainview/components/layout/AppTitleBar"
);
const { SidebarProvider, Sidebar, SidebarTrigger } = await import(
  "../src/mainview/components/ui/sidebar"
);
const { ObjectToolbar } = await import(
  "../src/mainview/components/objects/ObjectToolbar"
);
const { OBJECT_TOOLBAR_EVENTS } = await import(
  "../src/mainview/lib/object-toolbar-events"
);
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
const render = (fn: () => ReactElement, state: unknown[] = []) => {
  slots = state;
  cursor = 0;
  effects = [];
  return nodes(fn());
};
const find = (tree: Node[], prop: string, value: unknown) => {
  const node = tree.find((item) => item.props?.[prop] === value);
  assert(node, `${prop}=${String(value)}`);
  return node;
};
const click = (node: Node) => {
  assert.notEqual(node.props.disabled, true, "control must be enabled");
  (node.props.onClick as (event: unknown) => void)({});
};
const p = {
  id: "fixture-profile",
  name: "Fixture",
  provider: "r2" as const,
  createdAt: "t",
  updatedAt: "r1",
  hasR2AnalyticsToken: false,
};
actual.useVaultStore.setState({ unlocked: true, profiles: [p] });
actual.useProfileStore.setState({ activeProfileId: p.id, activeProfile: p });
actual.useBucketStore.setState({ selectedBucket: "fixture-bucket" });
actual.useTabStore.setState({
  tabs: [
    {
      id: "fixture-tab",
      profileId: p.id,
      profileName: p.name,
      bucket: "fixture-bucket",
      prefix: "",
    },
  ],
  activeTabId: "fixture-tab",
});
actual.useUIStore.setState({ platform: "windows" });

for (const lang of ["zh", "en"] as const) {
  language = lang;
  mobile = true;
  const providerState: unknown[] = [];
  const provider = () => {
    const tree = render(() => SidebarProvider({}), providerState);
    context = tree[0].props.value;
  };
  provider();
  assert.equal(Sidebar({}).props.open, false, "mobile Sheet starts closed");
  // Retain every existing global/file assertion across the two real components.
  const top = [...render(AppTitleBar), ...render(TopBar)];
  const opener = find(
    top,
    "aria-label",
    translate("显示或隐藏侧栏", "Toggle sidebar"),
  );
  assert.equal(
    opener.type,
    SidebarTrigger,
    "reuse real sidebar provider toggle",
  );
  assert(String(opener.props.className).includes("md:hidden"));
  click(SidebarTrigger(opener.props) as Node);
  provider();
  assert.equal(
    Sidebar({}).props.open,
    true,
    "external TopBar opener opens Sheet",
  );
  click(SidebarTrigger(opener.props) as Node);
  provider();
  assert.equal(Sidebar({}).props.open, false, "same provider closes Sheet");
  mobile = false;
  const oldDesktopOpen = (context as { open: boolean }).open;
  provider();
  click(SidebarTrigger(opener.props) as Node);
  provider();
  assert.equal((context as { open: boolean }).open, !oldDesktopOpen);
  for (const [zh, en] of [
    ["切换主题", "Toggle theme"],
    ["显示或隐藏分享记录", "Toggle share history"],
    ["显示或隐藏任务面板", "Toggle jobs panel"],
    ["显示或隐藏实时同步面板", "Toggle live folder sync panel"],
    ["显示或隐藏设置面板", "Toggle settings panel"],
    ["搜索文件和文件夹", "Search files and folders"],
  ])
    find(top, "aria-label", translate(zh, en));
  for (const name of [
    "KeyboardShortcutsDialog",
    "WindowControls",
    "ObjectToolbar",
  ])
    assert(
      top.some(
        (node) => typeof node.type === "function" && node.type.name === name,
      ),
    );

  actual.useObjectStore.setState({
    selectedKeys: new Set(["fixture.txt"]),
    filters: {
      ...actual.useObjectStore.getState().filters,
      search: "long-filter-".repeat(30),
    },
  });
  const toolbarState: unknown[] = [];
  let toolbar = render(ObjectToolbar, toolbarState);
  assert(String(toolbar[0].props.className).includes("flex-wrap"));
  for (const label of [
    translate("文件操作", "File actions"),
    translate("文件列表控件", "File list controls"),
  ]) {
    const group = find(toolbar, "aria-label", label);
    assert(String(group.props.className).includes("flex-wrap"));
    assert(String(group.props.className).includes("min-w-0"));
  }
  const cleanup = effects
    .map((effect) => effect())
    .filter((value) => typeof value === "function") as Array<() => void>;
  click(
    find(
      toolbar,
      "aria-label",
      translate("切换到网格视图", "Switch to grid view"),
    ),
  );
  assert.equal(actual.useUIStore.getState().viewMode, "grid");
  toolbar = render(ObjectToolbar, toolbarState);
  assert.equal(
    find(
      toolbar,
      "aria-label",
      translate("切换到网格视图", "Switch to grid view"),
    ).props["aria-pressed"],
    true,
  );
  click(
    find(
      toolbar,
      "aria-label",
      translate("切换到列表视图", "Switch to list view"),
    ),
  );
  assert.equal(actual.useUIStore.getState().viewMode, "table");
  click(find(toolbar, "aria-label", translate("清除筛选", "Clear filters")));
  assert.equal(actual.useObjectStore.getState().filters.search, "");
  actual.useUIStore.getState().setObjectSearchOpen(false);
  window.dispatchEvent(new Event(OBJECT_TOOLBAR_EVENTS.OPEN_SEARCH));
  assert(actual.useUIStore.getState().objectSearchOpen);
  click(find(toolbar, "title", translate("上传文件", "Upload files")));
  click(
    find(toolbar, "title", translate("下载选中项", "Download selected items")),
  );
  click(find(toolbar, "title", translate("新建文件夹", "New folder")));
  toolbar = render(ObjectToolbar, toolbarState);
  assert(
    toolbar.some(
      (node) =>
        typeof node.type === "function" &&
        node.type.name === "CreateFolderDialog" &&
        node.props.open === true,
    ),
  );
  window.dispatchEvent(new Event(OBJECT_TOOLBAR_EVENTS.SHARE_SELECTION));
  assert.deepEqual(actual.useUIStore.getState().shareTarget, {
    key: "fixture.txt",
    bucket: "fixture-bucket",
    profileId: p.id,
  });
  for (const fn of cleanup) fn();
}
await Promise.resolve();
assert.equal(
  calls.filter(([name]) => name === "transfer:pick-and-upload").length,
  2,
);
assert.equal(calls.filter(([name]) => name === "transfer:download").length, 2);

// Wrapping must not accidentally enable disabled Qiniu operations, even when
// shortcuts invoke the same handlers without a disabled button's protection.
language = "en";
const qiniu = {
  ...p,
  provider: "qiniu" as const,
  hasSessionToken: false,
  qiniu: { mode: "private" as const },
};
actual.useVaultStore.setState({ profiles: [qiniu] });
actual.useProfileStore.setState({ activeProfile: qiniu });
actual.useObjectStore.setState({ selectedKeys: new Set(["folder/"]) });
const restricted = render(ObjectToolbar);
const before = calls.length;
const cleanups = effects
  .map((effect) => effect())
  .filter((value) => typeof value === "function") as Array<() => void>;
for (const event of [
  OBJECT_TOOLBAR_EVENTS.UPLOAD_FILES,
  OBJECT_TOOLBAR_EVENTS.DOWNLOAD_SELECTION,
  OBJECT_TOOLBAR_EVENTS.OPEN_SYNC,
  OBJECT_TOOLBAR_EVENTS.OPEN_TRANSFER,
  OBJECT_TOOLBAR_EVENTS.DELETE_SELECTION,
])
  window.dispatchEvent(new Event(event));
await Promise.resolve();
assert.equal(calls.length, before, "blocked shortcuts issue no fixture IPC");
assert(messages.length > 0);
for (const text of ["Upload", "Download", "Sync", "Delete"]) {
  const button = restricted.find(
    (node) =>
      Array.isArray(node.props?.children) && node.props.children.includes(text),
  );
  assert(button, text);
  assert.equal(button.props.disabled, true, text);
}
for (const fn of cleanups) fn();
console.log(
  "UI_RESPONSIVE_PASS: real TopBar/SidebarTrigger/SidebarProvider closed-open-closed Sheet transitions; bilingual controls retained; adaptive groups; list/grid/filter/search/upload/download/create/share handlers; restricted Qiniu buttons and shortcut guards; fixture IPC only; browser layout/focus verification separate",
);
