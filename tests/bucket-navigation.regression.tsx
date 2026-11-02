// Production navigation/store behavior with fixture IPC and hook snapshots.
// Run independently so mocked hooks cannot contaminate other test suites.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { ReactElement } from "react";
import type { ProfileInfo } from "../src/shared/profile.types";
import type { BucketInfo } from "../src/shared/s3.types";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
});
const requests: Array<{ method: string; payload: unknown }> = [];
let listReply: () => Promise<BucketInfo[]> = async () => [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  onEvent: () => () => {},
  rpcCall: async (method: string, payload: unknown) => {
    requests.push({ method, payload });
    if (method === "buckets:list") return await listReply();
    if (method === "objects:list")
      return { objects: [], prefixes: [], isTruncated: false };
    throw new Error(`Unexpected fixture RPC ${method}`);
  },
}));
const actual = await import("../src/mainview/stores");
const {
  useTabStore,
  useProfileStore,
  useBucketStore,
  useObjectStore,
  useVaultStore,
} = actual;
const hook = <S,>(store: { getState(): S }) =>
  Object.assign(
    (selector?: (state: S) => unknown) =>
      selector ? selector(store.getState()) : store.getState(),
    store,
  );
mock.module("../src/mainview/stores", () => ({
  ...actual,
  useTabStore: hook(useTabStore),
  useProfileStore: hook(useProfileStore),
  useBucketStore: hook(useBucketStore),
  useObjectStore: hook(useObjectStore),
  useVaultStore: hook(useVaultStore),
  useUIStore: hook(actual.useUIStore),
}));
const react = await import("react");
let effects: Array<() => unknown> = [];
mock.module("react", () => ({
  ...react,
  useEffect: (effect: () => unknown) => effects.push(effect),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => [
    typeof initial === "function" ? initial() : initial,
    () => {},
  ],
  useRef: (initial: unknown) => ({ current: initial }),
}));
mock.module("../src/mainview/lib/i18n", () => ({
  t: (zh: string) => zh,
  localize: (text: string) => text,
  useT: () => (zh: string) => zh,
}));
const { TabBar } = await import("../src/mainview/components/layout/TabBar");
const { ContentArea } = await import(
  "../src/mainview/components/layout/ContentArea"
);
const { Tabs } = await import("../src/mainview/components/ui/tabs");
const { useS3Buckets } = await import("../src/mainview/hooks/useS3Buckets");
const { useS3Objects, updateNavigationTab } = await import(
  "../src/mainview/hooks/useS3Objects"
);
const { ObjectBrowser } = await import(
  "../src/mainview/components/objects/ObjectBrowser"
);
const { ObjectBreadcrumb } = await import(
  "../src/mainview/components/objects/ObjectBreadcrumb"
);
const { BreadcrumbLink } = await import(
  "../src/mainview/components/ui/breadcrumb"
);
const { useObjectTableKeyboard } = await import(
  "../src/mainview/components/objects/useObjectTableKeyboard"
);
const profile: ProfileInfo = {
  id: "qiniu-fixture",
  name: "Qiniu fixture",
  provider: "qiniu",
  createdAt: "fixture-time",
  updatedAt: "fixture-revision",
  hasR2AnalyticsToken: false,
  qiniu: { mode: "public" },
};
const buckets: BucketInfo[] = [
  { name: "native-bucket", s3Name: "s3-alias", regionId: "z0" },
];
const tabs = [
  {
    id: "invalid",
    profileId: profile.id,
    profileName: profile.name,
    bucket: "old-bucket-a",
    prefix: "",
  },
  {
    id: "native",
    profileId: profile.id,
    profileName: profile.name,
    bucket: "native-bucket",
    prefix: "",
  },
  {
    id: "alias",
    profileId: profile.id,
    profileName: profile.name,
    bucket: "s3-alias",
    prefix: "folder/",
  },
  {
    id: "other",
    profileId: "other-account",
    profileName: "Other",
    bucket: "other-bucket",
    prefix: "",
  },
];
function seed() {
  useProfileStore.getState().clearBuckets();
  useObjectStore.getState().reset();
  useBucketStore.getState().setSelectedBucket(null);
  useTabStore.setState({
    tabs: tabs.map((tab) => ({ ...tab })),
    activeTabId: "invalid",
  });
  useVaultStore.setState({ profiles: [profile], unlocked: true });
  requests.length = 0;
}
function assertReconciled() {
  const actualTabs = useTabStore.getState().tabs;
  assert(!actualTabs.some((tab) => tab.id === "invalid"));
  assert.equal(
    actualTabs.find((tab) => tab.id === "native")?.bucket,
    "native-bucket",
  );
  assert.equal(
    actualTabs.find((tab) => tab.id === "alias")?.bucket,
    "native-bucket",
  );
  assert.equal(actualTabs.find((tab) => tab.id === "alias")?.prefix, "folder/");
  assert.deepEqual(
    actualTabs.find((tab) => tab.id === "other"),
    tabs[3],
  );
}
function renderEffects() {
  effects = [];
  ContentArea();
  for (const effect of effects) effect();
  // ContentArea validates/synchronizes navigation; the mounted browser owns
  // automatic listing. Follow the real rendered gate rather than invoking a
  // browser while discovery is pending or the account/tab is unavailable.
  effects = [];
  const content = ContentArea();
  if (walkTree(content).some((node) => node.type === ObjectBrowser))
    ObjectBrowser();
  for (const effect of effects) effect();
}
function objectCalls() {
  return requests.filter((request) => request.method === "objects:list");
}

// The original defect: null was converted to undefined, making Base UI choose
// the first old tab automatically after a successful account connection.
seed();
useTabStore.setState({ activeTabId: null });
const tree = TabBar() as ReactElement<{
  children: ReactElement<{
    value: unknown;
    onValueChange(value: unknown): void;
  }>;
}>;
assert(tree);
const tabRoot = tree.props.children;
assert.equal(tabRoot.type, Tabs);
assert.equal(
  tabRoot.props.value,
  null,
  "No selection must remain a controlled null, never undefined",
);
tabRoot.props.onValueChange(null);
assert.equal(useTabStore.getState().activeTabId, null);
tabRoot.props.onValueChange("missing-tab");
assert.equal(useTabStore.getState().activeTabId, null);

// A successful connection adopts its list without a second discovery and
// removes only the current Qiniu account's unavailable historical scopes.
seed();
useProfileStore.getState().adoptConnectedProfile(profile, buckets);
assertReconciled();
assert.equal(useProfileStore.getState().bucketsLoaded, true);
assert.equal(useTabStore.getState().activeTabId, null);
assert.equal(useBucketStore.getState().selectedBucket, null);
assert.equal(requests.length, 0);

// Refresh success validates scopes, but an auth/network error must never be
// interpreted as a successful empty account list or prune historical tabs.
seed();
let resolveList!: (value: BucketInfo[]) => void;
listReply = () =>
  new Promise((resolve) => {
    resolveList = resolve;
  });
useProfileStore.getState().setActiveProfile(profile);
assert.equal(useProfileStore.getState().bucketsLoaded, false);
assert(useTabStore.getState().tabs.some((tab) => tab.id === "invalid"));
resolveList(buckets);
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
assertReconciled();
assert.equal(useProfileStore.getState().bucketsLoaded, true);
const preserved = useTabStore.getState().tabs.map((tab) => ({ ...tab }));
listReply = async () => {
  throw new Error("fixture forbidden 403");
};
await useProfileStore.getState().loadBuckets(profile.id);
assert.deepEqual(useTabStore.getState().tabs, preserved);
assert.equal(useProfileStore.getState().error, "fixture forbidden 403");

// Late results must not reconcile or remove scopes in a newer profile.
seed();
listReply = () =>
  new Promise((resolve) => {
    resolveList = resolve;
  });
useProfileStore.getState().setActiveProfile(profile);
const staleResolve = resolveList;
const other = { ...profile, id: "other-account", name: "Other" };
useProfileStore
  .getState()
  .adoptConnectedProfile(other, [{ name: "other-bucket" }]);
const beforeLate = useTabStore.getState().tabs.map((tab) => ({ ...tab }));
staleResolve([]);
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(useTabStore.getState().tabs, beforeLate);
assert.equal(useProfileStore.getState().activeProfileId, other.id);

// Orphan persisted tabs never send requests or attach their bucket to an
// unrelated currently selected account.
seed();
useProfileStore.getState().adoptConnectedProfile(profile, buckets);
useTabStore.setState({ activeTabId: "other" });
renderEffects();
assert.equal(objectCalls().length, 0);
assert.equal(useBucketStore.getState().selectedBucket, null);

// Qiniu restored tabs must wait for a successful list before object browsing.
seed();
useProfileStore.setState({
  activeProfileId: profile.id,
  activeProfile: profile,
  buckets: [],
  bucketsLoading: true,
  bucketsLoaded: false,
});
useTabStore.setState({ activeTabId: "native" });
renderEffects();
assert.equal(objectCalls().length, 0);
useProfileStore.getState().adoptConnectedProfile(profile, buckets);
useTabStore.setState({ activeTabId: "native" });
renderEffects();
assert(
  objectCalls().some(
    (request) =>
      (request.payload as { bucket: string }).bucket === "native-bucket",
  ),
);
assert(
  !objectCalls().some(
    (request) =>
      (request.payload as { bucket: string }).bucket === "old-bucket-a",
  ),
);

// Side-bar and favorite entry points only request navigation. They cannot
// bypass ContentArea's discovery gate with an eager objects:list request.
seed();
useProfileStore.getState().adoptConnectedProfile(profile, buckets);
function BucketActionsHarness() {
  return useS3Buckets();
}
const bucketActions = BucketActionsHarness();
bucketActions.selectBucket("native-bucket");
assert.equal(requests.length, 0);
assert.equal(useBucketStore.getState().selectedBucket, null);
assert.equal(
  useTabStore
    .getState()
    .tabs.find((tab) => tab.id === useTabStore.getState().activeTabId)?.bucket,
  "native-bucket",
);
bucketActions.selectFavoriteBucket(profile.id, "unavailable-favorite");
assert.equal(requests.length, 0);
renderEffects();
assert.equal(objectCalls().length, 0);
assert.equal(useTabStore.getState().activeTabId, null);
const tabCount = useTabStore.getState().tabs.length;
bucketActions.selectFavoriteBucket("removed-account", "orphan-favorite");
assert.equal(useTabStore.getState().tabs.length, tabCount);
assert.equal(requests.length, 0);
useTabStore.setState({ activeTabId: "native" });
bucketActions.switchProfile(null);
assert.equal(useTabStore.getState().activeTabId, null);
assert.equal(useProfileStore.getState().activeProfileId, null);

// A previous browser render must not copy its old prefix into a newly active
// tab. After the content effect, old rows/selections/actions are gone before
// the replacement request resolves under the new bucket.
seed();
useProfileStore
  .getState()
  .adoptConnectedProfile(profile, [{ name: "bucket-a" }, { name: "bucket-b" }]);
useTabStore.setState({
  tabs: [
    {
      id: "tab-a",
      profileId: profile.id,
      profileName: profile.name,
      bucket: "bucket-a",
      prefix: "a/",
    },
    {
      id: "tab-b",
      profileId: profile.id,
      profileName: profile.name,
      bucket: "bucket-b",
      prefix: "b/",
    },
  ],
  activeTabId: "tab-a",
});
useBucketStore.getState().setSelectedBucket("bucket-a");
useObjectStore.setState({
  currentPrefix: "a/",
  objects: [{ key: "a/old.txt", size: 1, lastModified: "t", etag: "fixture" }],
  selectedKeys: new Set(["a/old.txt"]),
});
actual.useUIStore.getState().setDetailKey("a/old.txt");
actual.useUIStore.getState().openTransferDialog({ keys: ["a/old.txt"] });
actual.useUIStore.getState().openShareDialog({
  profileId: profile.id,
  bucket: "bucket-a",
  key: "a/old.txt",
});
useTabStore.getState().setActiveTab("tab-b");
effects = [];
ObjectBrowser();
for (const effect of effects) effect();
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-b")?.prefix,
  "b/",
);
renderEffects();
assert.equal(useBucketStore.getState().selectedBucket, "bucket-b");
assert.equal(useObjectStore.getState().currentPrefix, "b/");
assert.deepEqual(useObjectStore.getState().objects, []);
assert.equal(useObjectStore.getState().selectedKeys.size, 0);
assert.equal(actual.useUIStore.getState().detailKey, null);
assert.equal(actual.useUIStore.getState().transferDialogOpen, false);
assert.equal(actual.useUIStore.getState().shareTarget, null);
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-a")?.prefix,
  "a/",
);
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-b")?.prefix,
  "b/",
);

// Folder actions persist only the scope they actually navigate. Merely
// activating another tab never overwrites that tab's stored folder.
function ObjectActionsHarness() {
  return useS3Objects();
}
const objectActionsB = ObjectActionsHarness();
objectActionsB.navigate("b/child/");
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-b")?.prefix,
  "b/child/",
);
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-a")?.prefix,
  "a/",
);
objectActionsB.goBack();
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-b")?.prefix,
  "b/",
);
useTabStore.getState().setActiveTab("tab-a");
renderEffects();
assert.equal(useBucketStore.getState().selectedBucket, "bucket-a");
assert.equal(useObjectStore.getState().currentPrefix, "a/");
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-b")?.prefix,
  "b/",
);
const objectActionsA = ObjectActionsHarness();
objectActionsA.navigate("a/child/");
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-a")?.prefix,
  "a/child/",
);
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-b")?.prefix,
  "b/",
);
objectActionsA.goBack();
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-a")?.prefix,
  "a/",
);

// The shared explicit-navigation helper never edits a different account or
// bucket, even when a callback was captured before the active tab changed.
updateNavigationTab("wrong-account", "bucket-a", "wrong/");
updateNavigationTab(profile.id, "bucket-b", "wrong/");
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-a")?.prefix,
  "a/",
);
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-b")?.prefix,
  "b/",
);

// Breadcrumb callbacks are real component handlers, not source assertions.
useObjectStore.setState({ currentPrefix: "a/child/", prefixHistory: ["a/"] });
useTabStore.getState().updateTabPrefix("tab-a", "a/child/");
type TreeNode = ReactElement<Record<string, unknown>>;
function walkTree(value: unknown): TreeNode[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(walkTree);
  const node = value as TreeNode;
  return [node, ...walkTree(node.props?.children)];
}
const breadcrumb = ObjectBreadcrumb({
  profileName: profile.name,
  bucket: "bucket-a",
});
const links = walkTree(breadcrumb).filter(
  (node) => node.type === BreadcrumbLink,
);
assert.equal(links.length, 2);
(links[1].props.onClick as () => void)();
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-a")?.prefix,
  "a/",
);
assert.equal(useObjectStore.getState().currentPrefix, "a/");
(links[0].props.onClick as () => void)();
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-a")?.prefix,
  "",
);
assert.equal(useObjectStore.getState().currentPrefix, "");
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-b")?.prefix,
  "b/",
);

// Backspace's table keyboard handler persists the parent directory too.
useObjectStore.setState({ currentPrefix: "a/child/", prefixHistory: ["a/"] });
useTabStore.getState().updateTabPrefix("tab-a", "a/child/");
function KeyboardHarness() {
  return useObjectTableKeyboard({
    objects: [],
    prefixes: [],
    sorted: [],
    selectedKeys: new Set(),
    renamingKey: null,
    profileId: profile.id,
    bucket: "bucket-a",
    onToggleSelect() {},
    onNavigate() {},
    onClearSelection() {},
    onSelectAll() {},
    startRename() {},
  });
}
const keyboard = KeyboardHarness();
let prevented = false;
keyboard.handleTableKeyDown({
  key: "Backspace",
  ctrlKey: false,
  metaKey: false,
  preventDefault() {
    prevented = true;
  },
} as Parameters<typeof keyboard.handleTableKeyDown>[0]);
assert.equal(prevented, true);
assert.equal(useObjectStore.getState().currentPrefix, "a/");
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-a")?.prefix,
  "a/",
);
assert.equal(
  useTabStore.getState().tabs.find((tab) => tab.id === "tab-b")?.prefix,
  "b/",
);

console.log(
  "BUCKET_NAVIGATION_PASS: controlled empty tab selection; verified Qiniu list reconciliation and aliases; failed/stale list preservation; orphan and pending-list navigation blocked; native browsing retained; fixture IPC only",
);
