// Functional fixtures for the real text state machine, menu callbacks and dialog
// handlers. No DOM/Windows or real-cloud acceptance is claimed.
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
let locale = "zh";
mock.module("../src/mainview/lib/i18n", () => ({
  t: (zh: string, en: string) => (locale === "en" ? en : zh),
  useT: () => (zh: string, en: string) => (locale === "en" ? en : zh),
  localize: (value: string) => value,
  intlLocale: () => "zh-CN",
}));
type Request = {
  method: string;
  payload: Record<string, unknown>;
  resolve(value: unknown): void;
  reject(error: Error): void;
};
const requests: Request[] = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  onEvent: () => () => {},
  rpcCall: (method: string, payload: Record<string, unknown>) =>
    new Promise((resolve, reject) =>
      requests.push({ method, payload, resolve, reject }),
    ),
}));
mock.module("../src/mainview/components/common/Toast", () => ({
  toast: { warning() {}, success() {}, error() {}, info() {} },
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
type Slot = {
  deps?: readonly unknown[];
  value?: unknown;
  cleanup?: () => void;
};
type Frame = { slots: Slot[]; index: number };
const frames = new Map<string, Frame>();
let frame: Frame;
let effects: Array<() => void> = [];
const changed = (before?: readonly unknown[], after?: readonly unknown[]) =>
  !before ||
  !after ||
  before.length !== after.length ||
  before.some((value, index) => !Object.is(value, after[index]));
function memo<T>(factory: () => T, deps?: readonly unknown[]): T {
  const index = frame.index++;
  const previous = frame.slots[index];
  if (!previous || changed(previous.deps, deps))
    frame.slots[index] = { deps, value: factory() };
  return frame.slots[index].value as T;
}
const react = await import("react");
mock.module("react", () => ({
  ...react,
  useCallback: <T,>(value: T, deps: readonly unknown[]) =>
    memo(() => value, deps),
  useMemo: memo,
  useRef: <T,>(value: T) => memo(() => ({ current: value }), []),
  useState: <T,>(initial: T) => {
    const current = frame;
    const index = frame.index++;
    if (!current.slots[index]) current.slots[index] = { value: initial };
    return [
      current.slots[index].value,
      (value: T) => {
        current.slots[index].value = value;
      },
    ];
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
  useEffect: (
    effect: () => (() => void) | undefined,
    deps?: readonly unknown[],
  ) => {
    const current = frame;
    const index = frame.index++;
    const before = current.slots[index];
    if (changed(before?.deps, deps))
      effects.push(() => {
        before?.cleanup?.();
        const cleanup = effect();
        current.slots[index].cleanup = cleanup;
      });
    current.slots[index] = { deps, cleanup: before?.cleanup };
  },
}));
function render<T>(name: string, component: () => T): T {
  frame = frames.get(name) ?? { slots: [], index: 0 };
  frames.set(name, frame);
  frame.index = 0;
  return component();
}
function flushEffects() {
  const current = effects;
  effects = [];
  for (const effect of current) effect();
}
const tick = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const node = value as Node;
  return [node, ...nodes(node.props?.children)];
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  return value && typeof value === "object"
    ? text((value as Node).props?.children)
    : "";
}
function named(tree: unknown, name: string) {
  const result = nodes(tree).find(
    (node) => typeof node.type === "function" && node.type.name === name,
  );
  assert(result, name);
  return result;
}
function action(tree: unknown, label: string) {
  const node = nodes(tree).find(
    (item) =>
      typeof item.props?.onClick === "function" &&
      text(item.props.children) === label,
  );
  assert(node, label);
  return node.props.onClick as () => void;
}
const model = await import(
  "../src/mainview/components/objects/text-editor-model"
);
const {
  TextEditorSession,
  validateTextName,
  validateTextContent,
  TEXT_EDITOR_MAX_BYTES,
} = model;
type Target =
  import("../src/mainview/components/objects/text-editor-model").TextEditorTarget;
type Ports =
  import("../src/mainview/components/objects/text-editor-model").TextEditorPorts;
const scope = {
  profileId: "fixture-r2",
  expectedProfileRevision: "revision-1",
  provider: "r2" as const,
  bucket: "fixture-bucket",
  prefix: "中文/+%?#/",
  profileName: "Fixture R2",
};
const target = (values: Partial<Target> = {}): Target => ({
  ...scope,
  id: "new",
  mode: "create",
  extension: "md",
  ...values,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(values: Partial<Target> = {}) {
  const writes: Parameters<Ports["write"]>[0][] = [];
  const reads: Parameters<Ports["read"]>[0][] = [];
  let current = true;
  let refreshes = 0;
  const read = deferred<Awaited<ReturnType<Ports["read"]>>>();
  const write = deferred<Awaited<ReturnType<Ports["write"]>>>();
  const session = new TextEditorSession(target(values), {
    confirmScope: () => {
      if (!current) throw new Error("fixture scope changed");
    },
    isScopeCurrent: () => current,
    read: (input) => {
      reads.push(input);
      return read.promise;
    },
    write: (input) => {
      writes.push(input);
      return write.promise;
    },
    refresh: () => {
      refreshes++;
    },
  });
  return {
    session,
    reads,
    writes,
    read,
    write,
    setCurrent: (value: boolean) => {
      current = value;
    },
    refreshes: () => refreshes,
  };
}

// Filename/path and Unicode byte bounds are enforced before any IPC.
for (const name of [
  "../x.md",
  "a/b.txt",
  "a\\b.md",
  ".txt",
  ".md",
  " x.md",
  "x.md ",
  "x.bin",
  "a\u0000.txt",
])
  assert(validateTextName(name), name);
for (const name of ["a.txt", "中文+%?#.md", ".hidden.markdown", "README.MD"])
  assert.equal(validateTextName(name), null, name);
assert.equal(validateTextContent("🙂\n中文"), null);
assert.equal(validateTextContent("a".repeat(TEXT_EDITOR_MAX_BYTES)), null);
assert(validateTextContent("中".repeat(Math.ceil(TEXT_EDITOR_MAX_BYTES / 3))));
assert(validateTextContent("\uD800"));
assert(validateTextContent("binary\u0000"));
assert(validateTextContent("\u0085"));

// Actual createOnly payload and single-flight saves, including zero-byte files.
{
  const f = fixture();
  f.session.setName("notes.md");
  f.session.setContent("# 中文\nhello +%?#");
  const saving = f.session.save();
  assert.equal(f.writes.length, 1);
  assert.equal(await f.session.save(), false);
  assert.deepEqual(f.writes[0], {
    profileId: scope.profileId,
    expectedProfileRevision: scope.expectedProfileRevision,
    bucket: scope.bucket,
    key: `${scope.prefix}notes.md`,
    content: "# 中文\nhello +%?#",
    createOnly: true,
  });
  f.session.setContent("must not change while saving");
  assert.equal(f.session.getSnapshot().content, "# 中文\nhello +%?#");
  f.write.resolve({ etag: '"new"', byteLength: 22 });
  assert.equal(await saving, true);
  assert.equal(f.refreshes(), 1);
  assert.equal(f.session.dirty, false);
  assert.equal(f.session.createOnly, false);
}
{
  const f = fixture({ extension: "txt" });
  const saving = f.session.save();
  assert.equal(f.writes[0].content, "");
  f.write.resolve({ etag: null, byteLength: 0 });
  await saving;
  assert(f.session.needsReload);
  f.session.setContent("kept");
  assert.equal(await f.session.save(), false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.session.getSnapshot().content, "kept");
  const loading = f.session.read();
  f.read.resolve({
    content: "",
    etag: '"remote"',
    contentType: "text/plain",
    byteLength: 0,
  });
  await loading;
  assert.equal(f.session.needsReload, false);
}

// Existing R2 uses the original ETag. A conflict retains the exact draft.
{
  const f = fixture({ mode: "edit", key: `${scope.prefix}old.md` });
  const loading = f.session.read();
  f.read.resolve({
    content: "original",
    etag: '"v1"',
    contentType: "text/markdown",
    byteLength: 8,
  });
  await loading;
  f.session.setContent("unsaved draft");
  const saving = f.session.save();
  assert.equal(f.writes[0].expectedEtag, '"v1"');
  assert.equal(f.writes[0].createOnly, false);
  f.write.reject(new Error("fixture 412 conflict"));
  assert.equal(await saving, false);
  assert.equal(f.session.getSnapshot().content, "unsaved draft");
  assert(f.session.dirty);
  assert.match(f.session.getSnapshot().error ?? "", /412/);
}
{
  const f = fixture({ mode: "edit", key: `${scope.prefix}old.txt` });
  const loading = f.session.read();
  f.read.resolve({
    content: "a",
    etag: 'W/"bad"',
    contentType: "text/plain",
    byteLength: 1,
  });
  await loading;
  assert.equal(f.session.getSnapshot().loaded, false);
  assert.equal(await f.session.save(), false);
  assert.equal(f.writes.length, 0);
}

// Immutable destination, changed scope, failed reads and late responses.
{
  const f = fixture();
  f.session.setContent("retained");
  f.setCurrent(false);
  assert.equal(await f.session.save(), false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.session.getSnapshot().content, "retained");
}
{
  const f = fixture();
  f.session.setContent("original destination");
  const saving = f.session.save();
  f.setCurrent(false);
  f.write.resolve({ etag: '"v2"', byteLength: 20 });
  await saving;
  assert.equal(f.writes[0].bucket, scope.bucket);
  assert.equal(f.writes[0].key, `${scope.prefix}untitled.md`);
  assert.equal(f.refreshes(), 0);
}
{
  const f = fixture({ mode: "edit", key: "x.txt" });
  const loading = f.session.read();
  f.session.dispose();
  f.read.resolve({
    content: "late",
    etag: '"v1"',
    contentType: "text/plain",
    byteLength: 4,
  });
  await loading;
  assert.equal(f.session.getSnapshot().content, "");
}
{
  const f = fixture({ mode: "edit", key: "x.txt" });
  const loading = f.session.read();
  f.read.reject(new Error("fixture read failed"));
  await loading;
  assert.equal(f.session.getSnapshot().loaded, false);
  assert.match(f.session.getSnapshot().error ?? "", /read failed/);
}
for (const values of [
  { provider: "qiniu" as const },
  { provider: "aws" as const, mode: "edit" as const, key: "x.txt" },
]) {
  const f = fixture(values);
  await f.session.read();
  assert.equal(f.reads.length, 0);
  assert.equal(await f.session.save(), false);
  assert.equal(f.writes.length, 0);
}
{
  const f = fixture({ provider: "aws" });
  const saving = f.session.save();
  f.write.resolve({ etag: '"created"', byteLength: 0 });
  await saving;
  assert.equal(f.writes[0].createOnly, true);
  assert(f.session.blockedReason);
  assert.equal(await f.session.save(), false);
  assert.equal(f.writes.length, 1);
}

// Real stores and actual UI callbacks.
const profile = {
  id: scope.profileId,
  name: scope.profileName,
  provider: scope.provider,
  createdAt: "t",
  updatedAt: scope.expectedProfileRevision,
  hasR2AnalyticsToken: false,
};
actual.useVaultStore.setState({ unlocked: true, profiles: [profile] });
actual.useProfileStore.setState({
  activeProfileId: profile.id,
  activeProfile: profile,
});
actual.useBucketStore.getState().setSelectedBucket(scope.bucket);
actual.useObjectStore.setState({
  currentPrefix: scope.prefix,
  objects: [
    { key: `${scope.prefix}old.md`, size: 8, etag: '"v1"', lastModified: "t" },
  ],
  loading: false,
});
const { TextEditorDialog } = await import(
  "../src/mainview/components/objects/TextEditorDialog"
);
const { ObjectWorkspace, isWorkspaceBlankTarget } = await import(
  "../src/mainview/components/objects/ObjectWorkspace"
);
const { ObjectContextMenu } = await import(
  "../src/mainview/components/objects/ObjectContextMenu"
);

let closed = 0;
const uiTarget = target({ id: "ui-create" });
const dialog = () =>
  render("dialog", () =>
    TextEditorDialog({
      target: uiTarget,
      onClose: () => {
        closed++;
      },
    }),
  );
let tree = dialog();
flushEffects();
tree = dialog();
(named(tree, "Input").props.onChange as (e: unknown) => void)({
  target: { value: "ui.md" },
});
(named(tree, "Textarea").props.onChange as (e: unknown) => void)({
  target: { value: "unsaved text" },
});
tree = dialog();
action(tree, "关闭")();
tree = dialog();
assert(text(tree).includes("有未保存内容"));
assert.equal(closed, 0);
const beforeKeys = requests.length;
let prevented = false;
let stopped = false;
(named(tree, "DialogContent").props.onKeyDown as (event: unknown) => void)({
  ctrlKey: true,
  metaKey: false,
  key: "s",
  nativeEvent: { isComposing: false },
  preventDefault() {
    prevented = true;
  },
  stopPropagation() {
    stopped = true;
  },
});
assert(prevented && stopped);
assert.equal(requests.length, beforeKeys, "confirmation blocks shortcut saves");
action(tree, "保留草稿")();
tree = dialog();
(named(tree, "DialogContent").props.onKeyDown as (event: unknown) => void)({
  ctrlKey: true,
  metaKey: false,
  key: "s",
  nativeEvent: { isComposing: true },
  preventDefault() {},
  stopPropagation() {},
});
assert.equal(requests.length, beforeKeys, "IME cannot save");
action(tree, "创建并保存")();
tree = dialog();
assert.equal(requests.length, beforeKeys + 1);
assert.equal(requests.at(-1)?.method, "objects:write-text");
assert.equal(requests.at(-1)?.payload.createOnly, true);
(named(tree, "Dialog").props.onOpenChange as (open: boolean) => void)(false);
assert.equal(closed, 0, "saving cannot close even via overlay");
requests.at(-1)?.reject(new Error("fixture 409 same-name conflict"));
await tick();
tree = dialog();
assert.equal(named(tree, "Textarea").props.value, "unsaved text");
action(tree, "关闭")();
tree = dialog();
action(tree, "丢弃并关闭")();
assert.equal(closed, 1);

// Opening a different editor cannot accept a late read from the former one.
const first = target({
  id: "first",
  mode: "edit",
  key: `${scope.prefix}old.md`,
});
render("edit", () => TextEditorDialog({ target: first, onClose() {} }));
flushEffects();
const oldRead = requests.at(-1);
assert.equal(oldRead?.method, "objects:read-text");
const second = target({
  id: "second",
  mode: "edit",
  key: `${scope.prefix}other.md`,
});
render("edit", () => TextEditorDialog({ target: second, onClose() {} }));
flushEffects();
const newRead = requests.at(-1);
assert.notEqual(newRead, oldRead);
oldRead?.resolve({
  content: "wrong old response",
  etag: '"old"',
  contentType: "text/plain",
  byteLength: 18,
});
newRead?.resolve({
  content: "new file",
  etag: '"new"',
  contentType: "text/plain",
  byteLength: 8,
});
await tick();
let editing = render("edit", () =>
  TextEditorDialog({ target: second, onClose() {} }),
);
assert.equal(named(editing, "Textarea").props.value, "new file");
(named(editing, "Textarea").props.onChange as (event: unknown) => void)({
  target: { value: "keep on reload" },
});
editing = render("edit", () =>
  TextEditorDialog({ target: second, onClose() {} }),
);
const beforeReload = requests.length;
action(editing, "重新读取")();
editing = render("edit", () =>
  TextEditorDialog({ target: second, onClose() {} }),
);
assert(text(editing).includes("重新读取将丢弃"));
assert.equal(requests.length, beforeReload);
action(editing, "保留草稿")();
actual.useBucketStore.getState().setSelectedBucket("different-bucket");
editing = render("edit", () =>
  TextEditorDialog({ target: second, onClose() {} }),
);
assert.equal(named(editing, "Textarea").props.value, "keep on reload");
assert(text(editing).includes("目标账号或目录已变化"));
const save = nodes(editing).find(
  (node) =>
    text(node.props?.children) === "保存" &&
    typeof node.props?.onClick === "function",
);
assert.equal(save?.props.disabled, true);
actual.useBucketStore.getState().setSelectedBucket(scope.bucket);

// Blank target predicate excludes rows/inputs/portals without swallowing them.
const wrapper = {
  contains: (element: { inside?: boolean }) => element.inside !== false,
} as unknown as HTMLElement;
const blank = {
  closest: (selector: string) =>
    selector.startsWith("[data-slot=") ? wrapper : null,
};
const row = { closest: () => ({}) };
const input = {
  closest: (selector: string) =>
    selector.startsWith("[data-slot=") ? wrapper : {},
};
const portal = { inside: false, closest: () => wrapper };
assert(isWorkspaceBlankTarget(blank as unknown as EventTarget, wrapper));
for (const value of [row, input, portal])
  assert.equal(
    isWorkspaceBlankTarget(value as unknown as EventTarget, wrapper),
    false,
  );
const workspace = () =>
  render("workspace", () => ObjectWorkspace({ children: "fixture browser" }));
let workspaceTree = workspace();
flushEffects();
let basePrevented = false;
(
  named(workspaceTree, "ContextMenuTrigger").props.onContextMenu as (
    event: unknown,
  ) => void
)({
  target: input,
  currentTarget: wrapper,
  defaultPrevented: false,
  preventBaseUIHandler() {
    basePrevented = true;
  },
  stopPropagation() {},
});
assert(basePrevented);
(
  named(workspaceTree, "ContextMenuTrigger").props.onContextMenu as (
    event: unknown,
  ) => void
)({
  target: blank,
  currentTarget: wrapper,
  defaultPrevented: false,
  preventBaseUIHandler() {
    throw new Error("blank should open");
  },
  stopPropagation() {},
});
workspaceTree = workspace();
const create = action(workspaceTree, "新建文本文件 (.txt)");
actual.useUIStore.getState().closeTextEditor();
create();
assert.equal(actual.useUIStore.getState().textEditorTarget?.extension, "txt");
assert.equal(
  actual.useUIStore.getState().textEditorTarget?.prefix,
  scope.prefix,
);
actual.useUIStore.getState().closeTextEditor();
actual.useObjectStore.setState({ currentPrefix: "changed/" });
create();
assert.equal(
  actual.useUIStore.getState().textEditorTarget,
  null,
  "old menu cannot retarget to another folder",
);
actual.useObjectStore.setState({ currentPrefix: scope.prefix });
const itemMenu = ObjectContextMenu({
  objectKey: `${scope.prefix}old.md`,
  isFolder: false,
  onRename() {},
});
action(itemMenu, "编辑文本")();
assert.equal(
  actual.useUIStore.getState().textEditorTarget?.key,
  `${scope.prefix}old.md`,
);
const originalTarget = actual.useUIStore.getState().textEditorTarget;
actual.useUIStore
  .getState()
  .openTextEditor(target({ id: "must-not-replace-draft" }));
assert.equal(actual.useUIStore.getState().textEditorTarget, originalTarget);
actual.useUIStore.getState().closeTextEditor();

// Locale/theme-neutral class names are shared with existing primitives; English
// labels and provider restrictions are verified without a browser theme claim.
locale = "en";
const english = render("english", () =>
  TextEditorDialog({ target: target({ id: "en" }), onClose() {} }),
);
assert(text(english).includes("New text file"));
assert(model.textEditorBlockReason("qiniu")?.includes("Qiniu"));
assert(model.textEditorBlockReason("aws", true)?.includes("only for R2"));
console.log(
  "TEXT_EDITOR_PASS: blank menu and row editor handlers; immutable scope; conditional create/edit; Unicode/1MiB; conflict retention; no duplicate save; dirty close/reload confirmation; shortcut+IME; stale responses; provider gates; fixture IPC only; realCloud=false",
);
