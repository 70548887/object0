// Direct production DropZone callbacks with mocked Tauri/DOM/IPC. No real files,
// account configuration or storage services are accessed.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReactElement } from "react";

export async function runNativeDropFixture(root: string, probeOnly = false) {
  const fromRoot = (path: string) => resolve(root, path);
  const realReact = await import("react");
  type Effect = { deps?: unknown[]; cleanup?: () => void };
  let slots: unknown[] = [];
  let effects = new Map<number, Effect>();
  let cursor = 0;
  let dirty = false;
  let setups: Array<() => void> = [];
  mock.module("react", () => ({
    ...realReact,
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots))
        slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (value: unknown) => {
          const next =
            typeof value === "function" ? value(slots[index]) : value;
          if (!Object.is(next, slots[index])) {
            slots[index] = next;
            dirty = true;
          }
        },
      ];
    },
    useRef: (value: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: value };
      return slots[index];
    },
    useMemo: (factory: () => unknown) => factory(),
    useCallback: (callback: unknown) => callback,
    useEffect: (setup: () => (() => void) | undefined, deps?: unknown[]) => {
      const index = cursor++;
      const previous = effects.get(index);
      if (
        !previous ||
        !deps ||
        deps.length !== previous.deps?.length ||
        deps.some((value, item) => !Object.is(value, previous.deps?.[item]))
      ) {
        effects.set(index, { deps });
        setups.push(() => {
          previous?.cleanup?.();
          effects.set(index, { deps, cleanup: setup() });
        });
      }
    },
  }));
  mock.module(fromRoot("src/mainview/lib/i18n.ts"), () => ({
    t: (zh: string) => zh,
    localize: (value: string) => value,
    useT: () => (zh: string) => zh,
  }));
  mock.module(fromRoot("src/mainview/lib/icons.ts"), () => ({
    IconCloudArrowUp: () => null,
  }));
  const profile = {
    id: "profile",
    name: "Fixture R2",
    provider: "r2",
    updatedAt: "revision-1",
    createdAt: "t",
    hasR2AnalyticsToken: false,
    hasSessionToken: false,
  };
  let currentProfile: Record<string, unknown> = { ...profile };
  let prefix = "folder/";
  let bucket: string | null = "fixture-bucket";
  let unlocked = true;
  let modal = false;
  let panels = 0;
  const messages: Array<{ kind: string; text: string }> = [];
  const ui = () => ({
    shareDialogOpen: modal,
    settingsOpen: modal,
    syncDialogOpen: false,
    syncChooserOpen: false,
    transferDialogOpen: false,
    shareHistoryOpen: false,
    folderSyncPanelOpen: false,
    objectSearchOpen: false,
    setJobPanelOpen: () => {
      panels++;
    },
  });
  const asStore = <S,>(getState: () => S) =>
    Object.assign(
      (selector?: (state: S) => unknown) =>
        selector ? selector(getState()) : getState(),
      { getState },
    );
  mock.module(fromRoot("src/mainview/stores/index.ts"), () => ({
    useProfileStore: asStore(() => ({
      activeProfileId: currentProfile.id,
      activeProfile: currentProfile,
      bucketsLoaded: true,
    })),
    useVaultStore: asStore(() => ({ unlocked, profiles: [currentProfile] })),
    useBucketStore: asStore(() => ({ selectedBucket: bucket })),
    useObjectStore: asStore(() => ({ currentPrefix: prefix })),
    useUIStore: asStore(ui),
  }));
  mock.module(fromRoot("src/mainview/components/common/Toast.tsx"), () => ({
    toast: Object.fromEntries(
      ["success", "warning", "error", "info"].map((kind) => [
        kind,
        (text: string) => messages.push({ kind, text }),
      ]),
    ),
  }));
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const pending: Array<{
    resolve: (value: unknown) => void;
    reject: (value: unknown) => void;
  }> = [];
  let defer = false;
  mock.module(fromRoot("src/mainview/lib/rpc-client.ts"), () => ({
    rpcCall: (method: string, payload: Record<string, unknown>) => {
      calls.push({ method, payload });
      if (defer)
        return new Promise((resolve, reject) =>
          pending.push({ resolve, reject }),
        );
      return Promise.resolve({ jobId: `job-${calls.length}` });
    },
  }));
  type Payload = {
    type: string;
    paths?: string[];
    position?: {
      x: number;
      y: number;
      toLogical: (scale: number) => { x: number; y: number };
    };
  };
  type Handler = (event: { payload: Payload }) => unknown;
  const listeners: Array<{
    handler: Handler;
    active: boolean;
    sdkType?: string;
  }> = [];
  const unlisteners: Array<() => void> = [];
  let listenerCount = 0;
  let unlistenCount = 0;
  let delayListener = false;
  let rejectListener = false;
  let failEvent: string | null = null;
  let native = true;
  mock.module("@tauri-apps/api/core", () => ({
    isTauri: () => native,
    invoke: async () => undefined,
    transformCallback: () => 0,
  }));
  mock.module("@tauri-apps/api/webview", () => ({
    getCurrentWebview: () => ({
      listen: (event: string, handler: Handler) => {
        const sdkType = event.replace("tauri://drag-", "");
        if (sdkType === "enter") listenerCount++;
        if (rejectListener || event === failEvent)
          return Promise.reject(
            new Error("fixture native registration failure"),
          );
        const row = { handler, active: true, sdkType };
        listeners.push(row);
        const unlisten = () => {
          if (row.active) {
            row.active = false;
            unlistenCount++;
          }
        };
        if (delayListener)
          return new Promise<() => void>((resolve) =>
            unlisteners.push(() => resolve(unlisten)),
          );
        return Promise.resolve(unlisten);
      },
      onDragDropEvent: (handler: Handler) => {
        listenerCount++;
        if (rejectListener)
          return Promise.reject(
            new Error("fixture native registration failure"),
          );
        const row = { handler, active: true };
        listeners.push(row);
        const unlisten = () => {
          if (row.active) {
            row.active = false;
            unlistenCount++;
          }
        };
        if (delayListener)
          return new Promise<() => void>((resolve) =>
            unlisteners.push(() => resolve(unlisten)),
          );
        return Promise.resolve(unlisten);
      },
    }),
  }));
  mock.module("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({ scaleFactor: async () => 2 }),
  }));
  const outside = { closest: () => null, getClientRects: () => [1] };
  const blocker = {
    closest: () => blocker,
    getClientRects: () => [1],
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
  };
  let covered = false;
  const zone = {
    getBoundingClientRect: () => ({
      left: 100,
      top: 100,
      right: 900,
      bottom: 700,
      width: 800,
      height: 600,
    }),
    contains: (value: unknown) => value === zone,
    closest: () => (modal ? blocker : null),
    isConnected: true,
    hasAttribute: () => false,
    getAttribute: () => null,
  };
  const globals = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
  ].map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { devicePixelRatio: 2, innerWidth: 1000, innerHeight: 800 },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState: "visible",
      hidden: false,
      elementFromPoint: (x: number, y: number) =>
        modal || covered
          ? blocker
          : x >= 100 && x < 900 && y >= 100 && y < 700
            ? zone
            : outside,
      elementsFromPoint: () => (modal || covered ? [blocker] : [zone]),
      querySelector: () => (modal ? blocker : null),
      querySelectorAll: () => (modal ? [blocker] : []),
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "fixture" },
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: Object,
  });
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    value: Object,
  });
  type Node = ReactElement<Record<string, unknown>>;
  const { DropZone } = await import(
    pathToFileURL(fromRoot("src/mainview/components/objects/DropZone.tsx")).href
  );
  let tree: Node | null = null;
  function currentTree(): Node {
    assert(tree);
    return tree;
  }
  function render() {
    for (let limit = 0; limit < 20; limit++) {
      dirty = false;
      cursor = 0;
      setups = [];
      tree = DropZone({ children: "fixture contents" });
      const ref = tree.props.ref;
      if (ref && typeof ref === "object")
        (ref as { current: unknown }).current = zone;
      else if (typeof ref === "function") ref(zone);
      for (const setup of setups) setup();
      if (!dirty) return;
    }
    throw new Error("DropZone hook state did not settle");
  }
  async function settle() {
    for (let i = 0; i < 15; i++) {
      await Promise.resolve();
      if (dirty) render();
    }
  }
  async function emit(
    type: string,
    paths = ["C:\\fixture\\one.txt"],
    x = 400,
    y = 400,
  ) {
    const position = {
      x,
      y,
      toLogical: (scale: number) => ({ x: x / scale, y: y / scale }),
    };
    for (const listener of [...listeners])
      if (listener.active && (!listener.sdkType || listener.sdkType === type))
        listener.handler({
          payload: type === "leave" ? { type } : { type, paths, position },
        });
    await settle();
  }
  function unmount() {
    for (const effect of effects.values()) effect.cleanup?.();
    effects.clear();
  }
  function reset() {
    unmount();
    slots = [];
    cursor = 0;
    dirty = false;
    setups = [];
    currentProfile = { ...profile };
    prefix = "folder/";
    bucket = "fixture-bucket";
    unlocked = true;
    modal = false;
    covered = false;
    defer = false;
    delayListener = false;
    rejectListener = false;
    failEvent = null;
    calls.length = 0;
    pending.length = 0;
    messages.length = 0;
    panels = 0;
    render();
  }
  const domEvent = () => ({
    preventDefault() {},
    stopPropagation() {},
    dataTransfer: {
      files: [{ path: "C:\\fixture\\one.txt", size: 1 }],
      types: ["Files"],
    },
    clientX: 200,
    clientY: 200,
  });
  try {
    render();
    await settle();
    const beforeListeners = listenerCount;
    await emit("enter");
    await emit("drop");
    if (probeOnly) {
      console.log(`NATIVE_LISTENERS=${beforeListeners}`);
      console.log(
        `UPLOAD_REQUESTS=${calls.filter((call) => call.method === "transfer:upload").length}`,
      );
      console.log(
        `PICKER_REQUESTS=${calls.filter((call) => call.method.includes("pick")).length}`,
      );
      console.log(`REAL_FILES_OR_CLOUD=false`);
      return;
    }
    assert.equal(beforeListeners, 1, "Exactly one native subscription");
    assert.equal(calls.length, 1);
    // A second independent OS gesture while a batch RPC is pending must
    // receive an explicit rejection; never silently lose a requested file.
    reset();
    await settle();
    defer = true;
    await emit("enter", ["C:\\fixture\\first-batch.txt"]);
    await emit("drop", ["C:\\fixture\\first-batch.txt"]);
    assert.equal(calls.length, 1);
    await emit("enter", ["C:\\fixture\\second-batch.txt"]);
    await emit("drop", ["C:\\fixture\\second-batch.txt"]);
    assert.equal(calls.length, 1);
    assert(
      messages.some(
        (item) =>
          item.kind === "warning" && item.text.includes("本次拖入未接收"),
      ),
    );
    const notices = messages.length;
    const duplicateDrop = currentTree().props.onDrop;
    if (typeof duplicateDrop === "function") await duplicateDrop(domEvent());
    await settle();
    assert.equal(
      messages.length,
      notices,
      "Duplicate DOM notification is not another gesture",
    );
    pending[0].resolve({ jobId: "first-batch" });
    await settle();
    assert.equal(calls.length, 1);
    reset();
    await settle();
    defer = true;
    await emit("enter", ["C:\\fixture\\first-batch.txt"]);
    await emit("drop", ["C:\\fixture\\first-batch.txt"]);
    await emit("enter", ["C:\\fixture\\second-batch.txt"]);
    pending[0].resolve({ jobId: "first-batch" });
    await settle();
    const afterFirstFinished = messages.length;
    // No over event: the first batch finishes while the pointer is stationary.
    await emit("drop", ["C:\\fixture\\second-batch.txt"]);
    assert.equal(calls.length, 1);
    assert(
      messages
        .slice(afterFirstFinished)
        .some(
          (item) =>
            item.kind === "warning" && item.text.includes("本次拖入未接收"),
        ),
    );
    reset();
    await settle();
    await emit("enter");
    await emit("drop");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      method: "transfer:upload",
      payload: {
        profileId: "profile",
        expectedProfileRevision: "revision-1",
        bucket: "fixture-bucket",
        key: "folder/one.txt",
        localPath: "C:\\fixture\\one.txt",
      },
    });
    assert.equal(panels, 1);
    assert.match(
      String(currentTree().props.className),
      /(?:h-full|min-h-0|flex)/,
    );
    // Native mode cannot also submit the DOM event for the same OS gesture.
    const handleDomDrop = currentTree().props.onDrop;
    if (typeof handleDomDrop === "function") await handleDomDrop(domEvent());
    await settle();
    assert.equal(calls.length, 1);
    reset();
    await settle();
    await emit("enter", ["C:\\fixture\\one.txt", "D:\\fixture\\two.txt"]);
    await emit("drop", ["C:\\fixture\\one.txt", "D:\\fixture\\two.txt"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].payload.key, "folder/two.txt");
    // The same drop path is queued once; backend errors are per-file and do
    // not report an entire partly failed batch as successful.
    reset();
    await settle();
    await emit("enter", ["C:\\fixture\\one.txt", "C:\\fixture\\one.txt"]);
    await emit("drop", ["C:\\fixture\\one.txt", "C:\\fixture\\one.txt"]);
    assert.equal(calls.length, 1);
    reset();
    await settle();
    defer = true;
    await emit("enter", ["C:\\fixture\\one.txt", "D:\\fixture\\two.txt"]);
    await emit("drop", ["C:\\fixture\\one.txt", "D:\\fixture\\two.txt"]);
    assert.equal(calls.length, 1);
    pending[0].reject(new Error("fixture file is unavailable"));
    await settle();
    assert.equal(calls.length, 2);
    pending[1].resolve({ jobId: "second-job" });
    await settle();
    assert.equal(panels, 1);
    assert(messages.some((item) => item.kind === "error"));
    assert(
      messages.some(
        (item) => item.kind === "warning" && item.text.includes("1"),
      ),
    );
    assert(!messages.some((item) => item.kind === "success"));
    reset();
    await settle();
    await emit("enter");
    await emit("leave");
    await emit("drop");
    assert.equal(calls.length, 0);
    // A drop observed without the initial OS enter gesture is not adopted,
    // e.g. when changing tabs remounted the component during an active drag.
    reset();
    await settle();
    await emit("drop");
    assert.equal(calls.length, 0);
    reset();
    await settle();
    await emit("enter", undefined, 20, 20);
    await emit("drop", undefined, 20, 20);
    assert.equal(calls.length, 0);
    reset();
    await settle();
    await emit("enter");
    bucket = "other-bucket";
    render();
    await emit("drop");
    assert.equal(calls.length, 0);
    reset();
    await settle();
    modal = true;
    await emit("enter");
    await emit("drop");
    assert.equal(calls.length, 0);
    reset();
    await settle();
    covered = true;
    await emit("enter");
    await emit("drop");
    assert.equal(calls.length, 0);
    reset();
    await settle();
    await emit("enter");
    prefix = "changed/";
    render();
    await emit("drop");
    assert.equal(calls.length, 0);
    reset();
    await settle();
    await emit("enter");
    currentProfile = { ...profile, updatedAt: "edited" };
    render();
    await emit("drop");
    assert.equal(calls.length, 0);
    reset();
    await settle();
    await emit("enter");
    unlocked = false;
    await emit("drop");
    assert.equal(calls.length, 0);
    reset();
    await settle();
    currentProfile = {
      ...profile,
      provider: "qiniu",
      qiniu: { mode: "private" },
    };
    render();
    await emit("enter");
    await emit("drop");
    assert.equal(calls.length, 0);
    reset();
    await settle();
    await emit("enter", ["C:\\a\\same.txt", "D:\\b\\same.txt"]);
    await emit("drop", ["C:\\a\\same.txt", "D:\\b\\same.txt"]);
    assert.equal(calls.length, 0);
    reset();
    await settle();
    defer = true;
    await emit("enter", ["C:\\fixture\\one.txt", "D:\\fixture\\two.txt"]);
    await emit("drop", ["C:\\fixture\\one.txt", "D:\\fixture\\two.txt"]);
    assert.equal(calls.length, 1);
    prefix = "new-scope/";
    render();
    pending[0].resolve({ jobId: "held-job" });
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(panels, 0);
    reset();
    await settle();
    native = false;
    render();
    const browserEnter = currentTree().props.onDragEnter;
    const browserDrop = currentTree().props.onDrop;
    assert.equal(typeof browserEnter, "function");
    assert.equal(typeof browserDrop, "function");
    const browserEvent = {
      ...domEvent(),
      dataTransfer: {
        types: ["Files"],
        files: [{ name: "no-local-path.txt", size: 1 }],
      },
    };
    (browserEnter as (event: unknown) => void)(browserEvent);
    render();
    (browserDrop as (event: unknown) => void)(browserEvent);
    await settle();
    assert.equal(calls.length, 0);
    assert(messages.some((message) => message.kind === "warning"));
    native = true;
    unmount();
    slots = [];
    effects = new Map();
    rejectListener = true;
    render();
    await settle();
    assert.equal(calls.length, 0);
    const findText = (value: unknown): string => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map(findText).join("");
      if (value && typeof value === "object" && "props" in value)
        return findText((value as Node).props.children);
      return "";
    };
    assert(findText(currentTree()).includes("拖放初始化失败"));
    // Exercise the real four-step helper, failing only the third low-level
    // listener. Earlier successful registrations must immediately roll back.
    reset();
    unmount();
    slots = [];
    effects = new Map();
    failEvent = "tauri://drag-drop";
    render();
    await settle();
    const partialRows = listeners.filter((listener) => listener.sdkType);
    assert(partialRows.length >= 2);
    assert(!partialRows.some((listener) => listener.active));
    assert(findText(currentTree()).includes("拖放初始化失败"));
    for (const listener of partialRows) {
      listener.handler({
        payload: {
          type: "enter",
          paths: ["C:\\fixture\\one.txt"],
          position: { x: 400, y: 400, toLogical: () => ({ x: 200, y: 200 }) },
        },
      });
    }
    await settle();
    assert(!findText(currentTree()).includes("松开鼠标即可上传文件"));
    assert.equal(calls.length, 0);
    unmount();
    assert(!partialRows.some((listener) => listener.active));
    rejectListener = false;
    reset();
    await settle();
    const oldListener = listeners.at(-1);
    assert(oldListener);
    unmount();
    await oldListener.handler({
      payload: {
        type: "drop",
        paths: ["C:\\fixture\\one.txt"],
        position: { x: 400, y: 400, toLogical: () => ({ x: 200, y: 200 }) },
      },
    });
    await settle();
    assert.equal(calls.length, 0);
    slots = [];
    effects = new Map();
    delayListener = true;
    render();
    unmount();
    for (const finish of unlisteners) finish();
    await settle();
    assert(unlistenCount > 0);
    assert(
      !listeners.some((listener) => listener.active),
      "Late listener registration must be cleaned",
    );
    console.log(
      "NATIVE_DROP_PASS: real DropZone native callback queues exact current scope once; DPI/bounds/modal/stale/lock/provider gates; multi-file and cleanup fixtures only",
    );
  } finally {
    unmount();
    for (const [name, previous] of globals) {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}
