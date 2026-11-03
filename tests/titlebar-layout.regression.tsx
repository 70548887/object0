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
const mobile = false;
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

const nativeWindow = await import("@tauri-apps/api/window");
const windowCalls = { minimize: 0, maximize: 0, close: 0 };
mock.module("@tauri-apps/api/window", () => ({
  ...nativeWindow,
  getCurrentWindow: () => ({
    minimize: () => {
      windowCalls.minimize++;
    },
    toggleMaximize: () => {
      windowCalls.maximize++;
    },
    close: () => {
      windowCalls.close++;
    },
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));
const { AppTitleBar } = await import(
  "../src/mainview/components/layout/AppTitleBar"
);
const { TopBar } = await import("../src/mainview/components/layout/TopBar");
const { MainLayout } = await import(
  "../src/mainview/components/layout/MainLayout"
);
const { Sidebar: AccountSidebar } = await import(
  "../src/mainview/components/layout/Sidebar"
);
const { WindowControls } = await import(
  "../src/mainview/components/layout/WindowControls"
);
const {
  SidebarProvider,
  Sidebar: SidebarPrimitive,
  SidebarHeader,
  SidebarInset,
  SidebarTrigger,
} = await import("../src/mainview/components/ui/sidebar");
const { ObjectToolbar } = await import(
  "../src/mainview/components/objects/ObjectToolbar"
);
const { Popover } = await import("../src/mainview/components/ui/popover");
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
const direct = (node: Node): Node[] =>
  [node.props?.children]
    .flat(Infinity)
    .filter((child) => child && typeof child === "object") as Node[];
const text = (value: unknown): string =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : Array.isArray(value)
        ? value.map(text).join("")
        : value && typeof value === "object"
          ? text((value as Node).props?.children)
          : "";
const render = (fn: () => ReactElement, state: unknown[] = []) => {
  slots = state;
  cursor = 0;
  effects = [];
  return nodes(fn());
};
const find = (tree: Node[], key: string, value: unknown) => {
  const node = tree.find((item) => item.props?.[key] === value);
  assert(node, `${key}=${String(value)}`);
  return node;
};
const click = (node: Node) => {
  assert.notEqual(node.props.disabled, true);
  (node.props.onClick as (event: unknown) => void)({});
};
const p = {
  id: "fixture",
  name: "Fixture account",
  provider: "r2" as const,
  createdAt: "t",
  updatedAt: "r1",
  hasR2AnalyticsToken: false,
};
actual.useVaultStore.setState({ unlocked: true, profiles: [p] });
actual.useProfileStore.setState({ activeProfileId: p.id, activeProfile: p });
actual.useBucketStore.setState({ selectedBucket: "fixture-bucket" });
actual.useTabStore.setState({ tabs: [], activeTabId: null });
actual.useUIStore.setState({
  mainSection: "storage",
  sidebarCollapsed: false,
  settingsOpen: false,
  shareHistoryOpen: false,
  folderSyncPanelOpen: false,
});

// The actual layout owns one full-width title before both sidebar and content.
const layout = render(MainLayout)[0];
assert.equal(layout.type, SidebarProvider);
const layoutChildren = direct(layout);
assert.equal(layoutChildren[0].type, AppTitleBar);
const body = layoutChildren[1];
assert.equal(body.type, "div");
for (const name of ["relative", "min-h-0", "flex-1"])
  assert(String(body.props.className).split(/\s+/).includes(name), name);
assert(nodes(body).some((node) => node.type === AccountSidebar));
const inset = nodes(body).find((node) => node.type === SidebarInset);
assert(inset);
assert(nodes(inset).some((node) => node.type === TopBar));
assert(!nodes(inset).some((node) => node.type === AppTitleBar));
assert.equal(
  nodes(layout).filter((node) => node.type === AppTitleBar).length,
  1,
);

// Non-storage sections render their own workspace, never an old bucket pane.
for (const section of ["favorites", "recent", "transfers", "shares"] as const) {
  actual.useUIStore.getState().setMainSection(section);
  const alternate = render(MainLayout);
  assert.equal(alternate.filter((node) => node.type === AppTitleBar).length, 1);
  const workspace = alternate.find(
    (node) =>
      typeof node.type === "function" &&
      node.type.name === "NavigationWorkspace",
  );
  assert(workspace);
  assert.equal(workspace.props.section, section);
  for (const name of ["ContentArea", "TopBar", "TabBar", "StatusBar"]) {
    assert(
      !alternate.some(
        (node) => typeof node.type === "function" && node.type.name === name,
      ),
      `${section} isolates ${name}`,
    );
  }
}
actual.useUIStore.getState().setMainSection("storage");
assert(render(MainLayout).some((node) => node.type === TopBar));

// A stale jobs-popover state cannot duplicate the full transfers workspace.
actual.useUIStore.getState().setMainSection("transfers");
actual.useUIStore.setState({ jobPanelOpen: true });
const transferTitle = render(AppTitleBar);
const transferPopover = transferTitle.find((node) => node.type === Popover);
assert(transferPopover);
assert.equal(
  transferPopover.props.open,
  false,
  "transfers workspace suppresses a stale open jobs popover",
);
assert.equal(
  find(transferTitle, "aria-label", "显示或隐藏任务面板").props["aria-pressed"],
  true,
);
(transferPopover.props.onOpenChange as (open: boolean) => void)(true);
assert.equal(
  actual.useUIStore.getState().jobPanelOpen,
  false,
  "real popover callback cannot reopen duplicate jobs in transfers",
);
actual.useUIStore.getState().setMainSection("storage");
const storageTitle = render(AppTitleBar);
const storagePopover = storageTitle.find((node) => node.type === Popover);
assert(storagePopover);
assert.equal(storagePopover.props.open, false);
assert.equal(
  find(storageTitle, "aria-label", "显示或隐藏任务面板").props["aria-pressed"],
  false,
);
(storagePopover.props.onOpenChange as (open: boolean) => void)(true);
assert.equal(
  actual.useUIStore.getState().jobPanelOpen,
  true,
  "storage retains the jobs popover handler",
);
assert.equal(
  render(AppTitleBar).find((node) => node.type === Popover)?.props.open,
  true,
);
(storagePopover.props.onOpenChange as (open: boolean) => void)(false);
assert.equal(actual.useUIStore.getState().jobPanelOpen, false);

for (const lang of ["zh", "en"] as const) {
  language = lang;
  actual.useProfileStore.setState({ activeProfile: p, activeProfileId: p.id });
  actual.useVaultStore.setState({ profiles: [p] });
  for (const platform of ["windows", "linux", "macos"] as const) {
    actual.useUIStore.setState({ platform });
    const title = render(AppTitleBar);
    const files = render(TopBar);
    assert(
      text(title[0]).includes(
        translate(
          "云仓 (Yuncang) · 多云对象存储管理器",
          "Yuncang · Multi-cloud object storage manager",
        ),
      ),
    );
    assert(
      !text(files[0]).includes(
        translate(
          "云仓 (Yuncang) · 多云对象存储管理器",
          "Yuncang · Multi-cloud object storage manager",
        ),
      ),
      "file toolbar has no duplicate title",
    );
    assert.equal(
      title.filter((node) => node.type === WindowControls).length,
      platform === "macos" ? 0 : 1,
    );
    assert.equal(
      files.filter((node) => node.type === WindowControls).length,
      0,
    );
    assert(
      !files.some((node) =>
        Object.hasOwn(node.props, "data-tauri-drag-region"),
      ),
      "file/address toolbar is never a title drag surface",
    );
    assert(
      title.some((node) => Object.hasOwn(node.props, "data-tauri-drag-region")),
    );
    if (platform === "macos")
      assert(
        title.some((node) =>
          String(node.props?.className).includes("pl-[72px]"),
        ),
        "native traffic lights have clearance",
      );
    // Real title's native double-click handler must ignore every child control.
    const dblclick = title[0].props.onDoubleClick as (event: unknown) => void;
    const before = windowCalls.maximize;
    dblclick({ target: { hasAttribute: () => false } });
    assert.equal(
      windowCalls.maximize,
      before,
      "interactive child double-click never maximizes",
    );
    dblclick({ target: { hasAttribute: () => true } });
    assert.equal(windowCalls.maximize, before + (platform === "linux" ? 1 : 0));
    const global = find(
      title,
      "aria-label",
      translate("全局工具", "Global tools"),
    );
    assert(String(global.props.className).includes("no-drag"));
    for (const node of nodes(global)) {
      if (node.props.onClick || node.props.render)
        assert(!Object.hasOwn(node.props, "data-tauri-drag-region"));
    }
    const mobileTrigger = title.find((node) => node.type === SidebarTrigger);
    assert(
      mobileTrigger &&
        String(mobileTrigger.props.className).includes("no-drag"),
    );
    const addressIndex = direct(files[0]).findIndex((node) =>
      nodes(node).some(
        (item) =>
          item.props?.["aria-label"] ===
          translate("搜索文件和文件夹", "Search files and folders"),
      ),
    );
    const toolbarIndex = direct(files[0]).findIndex(
      (node) => node.type === ObjectToolbar,
    );
    assert(
      addressIndex >= 0 && toolbarIndex > addressIndex,
      "address/search row is before the object action toolbar",
    );
  }
  for (const profile of [p, null]) {
    actual.useProfileStore.setState({
      activeProfile: profile,
      activeProfileId: profile?.id ?? null,
    });
    actual.useVaultStore.setState({ profiles: profile ? [p] : [] });
    const sidebar = render(AccountSidebar);
    assert.equal(sidebar[0].type, SidebarPrimitive);
    for (const cls of ["absolute", "inset-y-0", "h-full"])
      assert(String(sidebar[0].props.className).split(/\s+/).includes(cls));
    const header = sidebar.find((node) => node.type === SidebarHeader);
    assert(header);
    assert(
      !text(header).includes("云仓") && !text(header).includes("Yuncang"),
      "sidebar header has no large duplicate brand",
    );
    assert(
      text(header).includes(
        profile ? p.name : translate("选择存储账号", "Select a profile"),
      ),
    );
    const triggers = nodes(header).filter(
      (node) => node.type === SidebarTrigger,
    );
    assert.equal(
      triggers.length,
      2,
      "one account-card collapse button and one collapsed-only restore button",
    );
    const card = nodes(header).find(
      (node) =>
        String(node.props?.className).includes("border-border/70") &&
        direct(node).some((child) => child.type === SidebarTrigger),
    );
    assert(card);
    const cardChildren = direct(card);
    assert.equal(
      cardChildren.at(-1)?.type,
      SidebarTrigger,
      "small collapse control is the account card's rightmost child",
    );
    assert(String(triggers[0].props.className).split(/\s+/).includes("size-6"));
    assert(
      String(card.props.className).includes(
        "group-data-[collapsible=icon]:hidden",
      ),
    );
    assert(
      String(triggers[1].props.className).includes(
        "group-data-[collapsible=icon]:flex",
      ),
    );
    // The actual provider/trigger handlers, not a test-authored toggle, close
    // then restore the same controlled store for both selected/empty accounts.
    const providerState: unknown[] = [];
    const provider = () => {
      const main = render(MainLayout)[0];
      const tree = render(() => SidebarProvider(main.props), providerState);
      context = tree[0].props.value;
    };
    actual.useUIStore.setState({ sidebarCollapsed: false });
    provider();
    click(SidebarTrigger(triggers[0].props) as Node);
    assert.equal(actual.useUIStore.getState().sidebarCollapsed, true);
    provider();
    assert.equal(
      render(() => SidebarPrimitive(sidebar[0].props))[0].props["data-state"],
      "collapsed",
    );
    click(SidebarTrigger(triggers[1].props) as Node);
    assert.equal(actual.useUIStore.getState().sidebarCollapsed, false);
    provider();
    assert.equal(
      render(() => SidebarPrimitive(sidebar[0].props))[0].props["data-state"],
      "expanded",
    );
  }
}
// Execute real window button callbacks against a native-window fixture only.
language = "en";
const controls = render(WindowControls);
assert(String(controls[0].props.className).includes("no-drag"));
const previous = { ...windowCalls };
for (const label of ["Minimize window", "Maximize window", "Close window"])
  click(find(controls, "aria-label", label));
assert.equal(windowCalls.minimize, previous.minimize + 1);
assert.equal(windowCalls.maximize, previous.maximize + 1);
assert.equal(windowCalls.close, previous.close + 1);
assert.equal(
  calls.length,
  0,
  "layout/fixture handlers issue no cloud or real RPC calls",
);
console.log(
  "TITLEBAR_REGRESSION_PASS: real layout places one full-width title before sidebar/content; address before file actions; isolated favorites/recent/transfers/shares workspaces and duplicate jobs-popover guard; zh/en Windows/Linux/macOS chrome; native control handlers and non-drag child double-click; compact right-side account toggle/empty account/collapse restore; memory stores and fixture IPC only",
);
