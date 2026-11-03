// Real stores/components with delayed fixture IPC and dependency-aware hook
// snapshots. This is not DOM/Windows acceptance and never contacts a cloud.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import type { ObjectListReq, ObjectListRes } from "../src/shared/s3.types";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
});
type Pending = {
  request: ObjectListReq;
  resolve(value: ObjectListRes): void;
  reject(error: Error): void;
};
const requests: Pending[] = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  onEvent: () => () => {},
  rpcCall: (method: string, request: ObjectListReq) => {
    assert.equal(method, "objects:list");
    return new Promise<ObjectListRes>((resolve, reject) => {
      requests.push({ request, resolve, reject });
    });
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
type Slot = { deps?: readonly unknown[]; value?: unknown };
type Frame = { slots: Slot[]; index: number };
const frames = new Map<string, Frame>();
let frame: Frame;
let effects: Array<() => unknown> = [];
function changed(
  before: readonly unknown[] | undefined,
  after?: readonly unknown[],
) {
  return (
    !before ||
    !after ||
    before.length !== after.length ||
    before.some((value, index) => !Object.is(value, after[index]))
  );
}
function memo<T>(factory: () => T, deps?: readonly unknown[]): T {
  const index = frame.index++;
  const previous = frame.slots[index];
  if (!previous || changed(previous.deps, deps)) {
    frame.slots[index] = { deps, value: factory() };
  }
  return frame.slots[index].value as T;
}
const react = await import("react");
mock.module("react", () => ({
  ...react,
  useCallback: <T,>(callback: T, deps: readonly unknown[]) =>
    memo(() => callback, deps),
  useMemo: memo,
  useRef: <T,>(value: T) => memo(() => ({ current: value }), []),
  useState: <T,>(initial: T) => [memo(() => initial, []), () => {}],
  useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
    const index = frame.index++;
    if (changed(frame.slots[index]?.deps, deps)) effects.push(effect);
    frame.slots[index] = { deps };
  },
}));
mock.module("../src/mainview/lib/i18n", () => ({
  t: (zh: string) => zh,
  localize: (value: string) => value,
  useT: () => (zh: string) => zh,
  intlLocale: () => "zh-CN",
}));
const { ObjectBrowser } = await import(
  "../src/mainview/components/objects/ObjectBrowser"
);
const { ObjectBreadcrumb } = await import(
  "../src/mainview/components/objects/ObjectBreadcrumb"
);
const { ContentArea } = await import(
  "../src/mainview/components/layout/ContentArea"
);
const { useObjectTableKeyboard } = await import(
  "../src/mainview/components/objects/useObjectTableKeyboard"
);
const { useS3Objects } = await import("../src/mainview/hooks/useS3Objects");
const { BreadcrumbLink } = await import(
  "../src/mainview/components/ui/breadcrumb"
);

function render<T>(name: string, component: () => T): T {
  frame = frames.get(name) ?? { slots: [], index: 0 };
  frames.set(name, frame);
  frame.index = 0;
  return component();
}
function flushEffects() {
  const pending = effects;
  effects = [];
  for (const effect of pending) effect();
}
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const node = value as Node;
  return [node, ...nodes(node.props?.children)];
}
function interactiveRows(value: unknown) {
  return nodes(value).filter(
    (node) =>
      typeof node.type === "function" &&
      ["ObjectTable", "ObjectGrid"].includes(node.type.name),
  );
}
const state = () => actual.useObjectStore.getState();
const last = () => requests[requests.length - 1];
const browser = () => render("browser", ObjectBrowser);
const actions = () => render("actions", useS3Objects);
const object = (key: string) => ({
  key,
  size: 1,
  etag: "fixture",
  lastModified: "t",
});
const page = (key?: string): ObjectListRes => ({
  objects: key ? [object(key)] : [],
  prefixes: [],
  isTruncated: false,
});
async function settle(reply: ObjectListRes) {
  last().resolve(reply);
  await Promise.resolve();
  await Promise.resolve();
}
function assertCleared() {
  assert.deepEqual(state().objects, []);
  assert.deepEqual(state().prefixes, []);
  assert.equal(state().selectedKeys.size, 0);
  assert.equal(state().nextCursor, undefined);
  assert.equal(state().isTruncated, false);
  assert.deepEqual(state().pageHistory, []);
  assert.equal(state().error, null);
  assert.equal(state().loading, true);
  assert.equal(actual.useUIStore.getState().detailKey, null);
  assert.equal(actual.useUIStore.getState().transferTarget, null);
  assert.equal(actual.useUIStore.getState().shareTarget, null);
}
const profile = {
  id: "fixture-account",
  name: "Fixture",
  provider: "r2" as const,
  updatedAt: "revision-1",
  createdAt: "t",
  hasR2AnalyticsToken: false,
};
actual.useVaultStore.setState({ unlocked: true, profiles: [profile] });
actual.useProfileStore.setState({
  activeProfileId: profile.id,
  activeProfile: profile,
});
actual.useBucketStore.getState().setSelectedBucket("bucket");
actual.useTabStore.setState({
  tabs: [
    {
      id: "tab",
      profileId: profile.id,
      profileName: profile.name,
      bucket: "bucket",
      prefix: "parent/",
    },
  ],
  activeTabId: "tab",
});
actual.useUIStore.setState({ viewMode: "table", pageSize: 100 });
state().reset();
state().navigateToPrefix("parent/");

// First render owns one request; a data-only render does not load again.
browser();
flushEffects();
assert.equal(requests.length, 1);
await settle({
  ...page("parent/old.txt"),
  prefixes: [{ prefix: "parent/child/" }],
  isTruncated: true,
  nextCursor: "old-cursor",
});
const oldTable = interactiveRows(browser())[0];
flushEffects();
assert(oldTable);
assert.equal(requests.length, 1);
actual.useUIStore.getState().setDetailKey("parent/old.txt");
actual.useUIStore.getState().openTransferDialog({ keys: ["parent/old.txt"] });
actual.useUIStore.getState().openShareDialog({
  profileId: profile.id,
  bucket: "bucket",
  key: "parent/old.txt",
});
state().toggleSelect("parent/old.txt");
state().setFilters({ search: "" });
state().loadObjects(profile.id, "bucket", "parent/", 100, "old-cursor");
const oldPending = last();
const beforeNavigation = requests.length;
// This is the actual ObjectTable callback supplied by the browser.
(oldTable.props.onNavigate as (prefix: string) => void)("parent/child/");
assertCleared();
assert.equal(
  requests.length,
  beforeNavigation,
  "navigation itself never lists",
);
(oldTable.props.onToggleSelect as (key: string) => void)("parent/old.txt");
assert.equal(
  state().selectedKeys.size,
  0,
  "late selection cannot revive a removed row",
);
assert.equal(
  interactiveRows(browser()).length,
  0,
  "loading has no table/grid for old rows",
);
flushEffects();
assert.equal(
  requests.length,
  beforeNavigation + 1,
  "exactly one list for folder entry",
);
const childPending = last();
oldPending.resolve(page("parent/late.txt"));
await Promise.resolve();
await Promise.resolve();
assertCleared();
childPending.reject(new Error("fixture forbidden 403"));
await Promise.resolve();
await Promise.resolve();
assert.equal(state().error, "fixture forbidden 403");
assert.equal(state().loading, false);
assert.equal(interactiveRows(browser()).length, 0);
flushEffects();
assert.equal(
  requests.length,
  beforeNavigation + 1,
  "failure render does not retry automatically",
);

// Retry uses explicit refresh, and an empty folder can navigate back once.
actions().refresh();
assert.equal(requests.length, beforeNavigation + 2);
await settle(page());
browser();
flushEffects();
const beforeBack = requests.length;
actions().goBack();
assertCleared();
browser();
flushEffects();
assert.equal(requests.length, beforeBack + 1);
assert.equal(last().request.prefix, "parent/");
await settle({ ...page(), prefixes: [{ prefix: "parent/child/" }] });
const directoryOnly = interactiveRows(browser());
flushEffects();
assert.equal(
  directoryOnly.length,
  1,
  "a directory-only result remains navigable",
);

// Forward restores the exact scope and still leaves automatic loading to the
// browser. Returning back keeps the original parent-directory fixture intact.
const beforeForward = requests.length;
actions().goForward();
assertCleared();
assert.equal(requests.length, beforeForward);
browser();
flushEffects();
assert.equal(requests.length, beforeForward + 1);
assert.equal(last().request.prefix, "parent/child/");
await settle(page());
actions().goBack();
browser();
flushEffects();
await settle({ ...page(), prefixes: [{ prefix: "parent/child/" }] });

// Same-prefix navigation is a no-op, not an abandoned pending scope.
const sameHistory = [...state().prefixHistory];
const sameCount = requests.length;
actions().navigate("parent/");
browser();
flushEffects();
assert.equal(requests.length, sameCount);
assert.equal(state().loading, false);
assert.deepEqual(state().prefixHistory, sameHistory);
assert.deepEqual(state().prefixes, [{ prefix: "parent/child/" }]);

// Breadcrumb and keyboard entry points also defer to the same browser owner.
actions().navigate("parent/child/");
browser();
flushEffects();
await settle(page("parent/child/new.txt"));
const breadcrumb = render("breadcrumb", () =>
  ObjectBreadcrumb({ profileName: profile.name, bucket: "bucket" }),
);
const parentLink = nodes(breadcrumb).filter(
  (node) => node.type === BreadcrumbLink,
)[1];
const beforeBreadcrumb = requests.length;
(parentLink.props.onClick as () => void)();
assertCleared();
browser();
flushEffects();
assert.equal(requests.length, beforeBreadcrumb + 1);
assert.equal(last().request.prefix, "parent/");
await settle(page("parent/new.txt"));
actions().navigate("parent/child/");
browser();
flushEffects();
await settle(page("parent/child/new.txt"));
const keyboard = render("keyboard", () =>
  useObjectTableKeyboard({
    objects: [],
    prefixes: [],
    sorted: [],
    selectedKeys: new Set(),
    renamingKey: null,
    profileId: profile.id,
    bucket: "bucket",
    onToggleSelect() {},
    onNavigate() {},
    onClearSelection() {},
    onSelectAll() {},
    startRename() {},
  }),
);
flushEffects();
const beforeKeyboard = requests.length;
keyboard.handleTableKeyDown({
  key: "Backspace",
  ctrlKey: false,
  metaKey: false,
  preventDefault() {},
} as Parameters<typeof keyboard.handleTableKeyDown>[0]);
assertCleared();
browser();
flushEffects();
assert.equal(requests.length, beforeKeyboard + 1);
await settle(page("parent/keyboard.txt"));

// Page size reloads once; manual refresh and paging are still functional.
const beforeSize = requests.length;
actual.useUIStore.getState().setPageSize(250);
browser();
flushEffects();
assert.equal(requests.length, beforeSize + 1);
assert.equal(last().request.maxKeys, 250);
await settle({ ...page(), isTruncated: true, nextCursor: "opaque" });
actions().nextPage();
assert.equal(last().request.cursor, "opaque");
await settle(page("parent/page-two.txt"));

// Tab synchronization itself must not list. The matching browser render does.
actual.useTabStore.setState({
  tabs: [
    {
      id: "other-tab",
      profileId: profile.id,
      profileName: profile.name,
      bucket: "other-bucket",
      prefix: "other/",
    },
  ],
  activeTabId: "other-tab",
});
const beforeTab = requests.length;
render("content", ContentArea);
flushEffects();
assert.equal(requests.length, beforeTab);
browser();
flushEffects();
assert.equal(requests.length, beforeTab + 1);
assert.equal(last().request.bucket, "other-bucket");
assert.equal(last().request.prefix, "other/");
await settle(page("other/new.txt"));

// An already captured effect cannot restart a former tab's request.
actual.useUIStore.getState().setPageSize(100);
browser(); // capture without committing effects
actual.useTabStore.setState({ activeTabId: null });
const beforeStaleEffect = requests.length;
flushEffects();
assert.equal(requests.length, beforeStaleEffect);

console.log(
  "OBJECT_NAVIGATION_PASS: immediate scope clearing; no stale table/grid/selection; late response ignored; failure/retry; empty and directory-only; same-prefix no-op; one list for folder/back/breadcrumb/keyboard/tab/page-size; pagination and manual refresh; stale effect rejected; realCloud=false",
);
