// Real CommandPalette element tree and onSelect callbacks with memory-only stores.
// UI leaves are not DOM-rendered; no native bridge or cloud service is contacted.
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
const calls: unknown[] = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  onEvent: () => () => {},
  rpcCall: async (...args: unknown[]) => {
    calls.push(args);
    return {};
  },
}));
const warnings: string[] = [];
mock.module("../src/mainview/components/common/Toast", () => ({
  toast: { warning: (message: string) => warnings.push(message) },
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
const react = await import("react");
mock.module("react", () => ({
  ...react,
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useState: (initial: unknown) => [
    typeof initial === "function" ? initial() : initial,
    () => {},
  ],
  useEffect: () => {},
}));
const { CommandPalette } = await import(
  "../src/mainview/components/common/CommandPalette"
);
const { CommandItem } = await import("../src/mainview/components/ui/command");
const { OBJECT_TOOLBAR_EVENTS } = await import(
  "../src/mainview/lib/object-toolbar-events"
);
type Node = ReactElement<Record<string, unknown>>;
const nodes = (value: unknown): Node[] =>
  !value || typeof value !== "object"
    ? []
    : Array.isArray(value)
      ? value.flatMap(nodes)
      : [value as Node, ...nodes((value as Node).props?.children)];
const render = () => nodes(CommandPalette());
const commands = (tree: Node[]) =>
  tree.filter((node) => node.type === CommandItem);
const find = (tree: Node[], key: string) => {
  const command = commands(tree).find((node) => node.key === key);
  assert(command, `command ${key} exists`);
  return command;
};
const select = (command: Node) => (command.props.onSelect as () => void)();
const p = {
  id: "fixture",
  name: "Fixture account",
  provider: "r2" as const,
  createdAt: "t",
  updatedAt: "r1",
  hasR2AnalyticsToken: false,
};
actual.useVaultStore.setState({
  unlocked: true,
  profiles: [p],
  storageMode: "plaintext",
});
actual.useProfileStore.setState({ activeProfileId: p.id, activeProfile: p });
actual.useBucketStore.setState({ selectedBucket: "fixture-bucket" });
actual.useObjectStore.setState({ selectedKeys: new Set(["fixture.txt"]) });
const events: string[] = [];
for (const name of Object.values(OBJECT_TOOLBAR_EVENTS))
  window.addEventListener(name, () => events.push(name));

for (const lang of ["zh", "en"] as const) {
  language = lang;
  actual.useUIStore.getState().setMainSection("storage");
  actual.useUIStore.setState({ syncChooserOpen: false });
  const storageTree = render();
  assert(
    commands(storageTree).some((node) => String(node.key).startsWith("obj-")),
    "storage retains real object commands",
  );
  const chooseSync = find(storageTree, "choose-sync-type");
  select(chooseSync);
  assert.equal(
    actual.useUIStore.getState().syncChooserOpen,
    true,
    "storage retains choose-sync-type callback",
  );
  actual.useUIStore.getState().closeSyncChooser();
  select(find(storageTree, "obj-search"));
  assert.equal(
    events.at(-1),
    OBJECT_TOOLBAR_EVENTS.OPEN_SEARCH,
    "storage retains real toolbar dispatch callback",
  );

  for (const section of ["favorites", "recent", "transfers"] as const) {
    actual.useUIStore.getState().setMainSection(section);
    actual.useUIStore.setState({
      settingsOpen: false,
      folderSyncPanelOpen: false,
      syncChooserOpen: false,
    });
    const nonStorageTree = render();
    assert(
      !commands(nonStorageTree).some((node) =>
        String(node.key).startsWith("obj-"),
      ),
      `${section} hides all object commands`,
    );
    assert(
      !commands(nonStorageTree).some((node) => node.key === "choose-sync-type"),
      `${section} hides bucket sync chooser`,
    );
    assert(
      !nodes(nonStorageTree).some(
        (node) =>
          typeof node.props.children === "string" &&
          node.props.children === `${p.name} / fixture-bucket`,
      ),
      "palette does not display stale bucket context",
    );
    const beforeEvents = events.length;
    // Invoke a callback captured while storage was active, after navigation.
    select(chooseSync);
    assert.equal(
      actual.useUIStore.getState().syncChooserOpen,
      false,
      `${section} refuses captured storage sync callback`,
    );
    assert.equal(events.length, beforeEvents);
    select(find(nonStorageTree, "open-settings"));
    assert.equal(
      actual.useUIStore.getState().settingsOpen,
      true,
      "global settings command retained",
    );
    const theme = actual.useThemeStore.getState().theme;
    select(find(nonStorageTree, "toggle-theme"));
    assert.notEqual(
      actual.useThemeStore.getState().theme,
      theme,
      "global theme command retained",
    );
    select(find(nonStorageTree, "toggle-live-folder-sync"));
    assert.equal(
      actual.useUIStore.getState().folderSyncPanelOpen,
      true,
      "global live folder sync command retained",
    );
  }
}
assert.equal(
  calls.length,
  0,
  "palette commands never contact real or fixture RPC",
);
assert.equal(warnings.length, 0, "normal r2 fixture has no Qiniu warning path");
console.log(
  "WORKSPACE_COMMAND_GUARD_PASS: zh/en real CommandPalette hides obj-* and choose-sync-type outside storage; captured storage sync callback refuses favorites/recent/transfers; storage chooser/search and global settings/theme/live-sync handlers retained; memory stores, no cloud/native RPC",
);
