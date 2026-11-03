// Real update state machine and component handlers, local fixture IPC only.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import type {
  UpdateCheckResult,
  UpdateInfo,
  UpdateSnapshot,
} from "../src/shared/updater.types";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
mock.module("../src/mainview/lib/i18n", () => ({
  t: (zh: string) => zh,
  useT: () => (zh: string) => zh,
  localize: (value: string) => value,
  intlLocale: () => "zh-CN",
}));
const { UpdateSession, safeUpdatePage } = await import(
  "../src/mainview/components/updates/update-session"
);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const info: UpdateInfo = {
  currentVersion: "1.7.0-preview.2",
  buildHash: "fixture-dirty",
  development: true,
  packageKind: "installer",
  platform: "windows-x86_64",
  repository: "70548887/object0",
  releaseUrl: "https://github.com/70548887/object0/releases",
  signingConfigured: true,
  blockedReason: null,
};
const checkResult = (
  channel: "stable" | "preview" = "stable",
): UpdateCheckResult => ({
  info,
  channel,
  checkedAt: "2026-11-02T09:00:00Z",
  release: {
    id: "signed-descriptor-1",
    version: "1.8.0",
    channel: "stable",
    publishedAt: "2026-11-02T08:00:00Z",
    notes: "<img src=x onerror=alert(1)>\nFixture release notes",
    releaseUrl: "https://github.com/70548887/object0/releases/tag/v1.8.0",
    packageKind: "installer",
    assetName: "fixture-setup.exe",
    size: 10,
    canDownload: true,
    blockedReason: null,
  },
  message: "found",
});
const snap = (stage: UpdateSnapshot["stage"], attempt = 1): UpdateSnapshot => ({
  releaseId: "signed-descriptor-1",
  attempt,
  stage,
  downloaded: 5,
  total: 10,
  error: null,
});
const checks: Array<ReturnType<typeof deferred<UpdateCheckResult>>> = [];
const downloads: Array<ReturnType<typeof deferred<UpdateSnapshot>>> = [];
const applies: string[] = [];
const cancels: string[] = [];
const remembered: string[] = [];
let blockers: string[] = [];
const session = new UpdateSession({
  info: async () => info,
  check: () => {
    const value = deferred<UpdateCheckResult>();
    checks.push(value);
    return value.promise;
  },
  download: () => {
    const value = deferred<UpdateSnapshot>();
    downloads.push(value);
    return value.promise;
  },
  cancel: async (id) => {
    cancels.push(id);
    return snap("cancelled");
  },
  apply: async (id) => {
    applies.push(id);
    return { accepted: true };
  },
  exitBlockers: () => blockers,
  rememberChannel: (channel) => remembered.push(channel),
});
await session.loadInfo();
assert.equal(
  checks.length,
  0,
  "reading local version never checks or downloads",
);
let checking = session.check();
checks[0].reject(new Error("fixture network error"));
await checking;
assert.equal(session.getSnapshot().result, null);
assert.match(session.getSnapshot().error ?? "", /network/);
checking = session.check();
await session.changeChannel("preview");
checks[1].resolve(checkResult("stable"));
await checking;
assert.equal(
  session.getSnapshot().result,
  null,
  "late old-channel success is ignored",
);
checking = session.check();
checks[2].resolve(checkResult("preview"));
await checking;
assert.equal(session.release?.id, "signed-descriptor-1");
assert(session.downloadAllowed);
let downloading = session.download();
assert.equal(downloads.length, 1);
await session.download();
assert.equal(
  downloads.length,
  1,
  "duplicate click cannot start another download",
);
session.progress({ ...snap("ready"), releaseId: "wrong-release" });
assert(!session.ready);
session.progress(snap("verifying"));
assert(!session.ready);
await session.cancel();
downloads[0].resolve(snap("ready"));
await downloading;
assert.equal(
  session.getSnapshot().snapshot?.stage,
  "cancelled",
  "late completion cannot revive a cancelled download",
);
downloading = session.download();
session.progress(snap("ready", 1));
assert(!session.ready, "retry ignores old attempts");
session.progress(snap("ready", 2));
assert(
  !session.ready,
  "ready events alone cannot enable installation before the RPC acknowledges the exact attempt",
);
session.progress(snap("downloading", 2));
downloads[1].resolve(snap("ready", 2));
await downloading;
assert(session.ready);
session.progress(snap("downloading", 2));
assert(session.ready, "ready cannot regress due to a queued progress message");
blockers = ["unsaved fixture draft"];
assert.equal(await session.apply(), false);
assert.equal(applies.length, 0);
blockers = [];
assert.equal(await session.apply(), true);
assert.deepEqual(applies, ["signed-descriptor-1"]);
assert.equal(session.getSnapshot().snapshot?.stage, "installing");
assert.equal(cancels.length, 1);
assert.deepEqual(remembered, ["preview"]);

// Missing signing/package identity can show releases but must not download.
const disabled = new UpdateSession({
  info: async () => info,
  check: async () => ({
    ...checkResult(),
    info: {
      ...info,
      signingConfigured: false,
      blockedReason: "fixture signing unavailable",
    },
  }),
  download: async () => {
    throw new Error("must not download");
  },
  cancel: async () => snap("cancelled"),
  apply: async () => {
    throw new Error("must not install");
  },
  exitBlockers: () => [],
  rememberChannel() {},
});
await disabled.check();
assert(disabled.release);
assert(!disabled.downloadAllowed);
await disabled.download();
assert.equal(disabled.getSnapshot().snapshot, null);
assert.equal(await disabled.apply(), false);
for (const bad of [
  "http://github.com/70548887/object0/releases",
  "https://github.com/other/repo/releases",
  "https://github.com.evil.example/70548887/object0/releases",
  "https://user:secret@github.com/70548887/object0/releases",
  "javascript:alert(1)",
])
  assert.equal(safeUpdatePage(bad), null);
assert(
  safeUpdatePage("https://github.com/70548887/object0/releases/tag/v1.8.0"),
);

// Native may finish just before cancel obtains its lock and reject cancel as
// STALE. Cancelling invalidates the old download RPC, so restoring its active
// snapshot would strand the UI forever. Explicit failed + user retry is safe;
// neither a discarded RPC nor an event can authorize installation.
const cancelRaceFailures: string[] = [];
for (const cancelAction of ["cancel", "change-channel"] as const) {
  for (const responseOrder of [
    "before-rejection",
    "after-rejection",
  ] as const) {
    for (const eventOrder of [
      "none",
      "before-cancel",
      "during-cancel",
      "after-rejection",
    ] as const) {
      for (const recovery of ["check-then-download", "download"] as const) {
        const label = `${cancelAction}/${responseOrder}/${eventOrder}/${recovery}`;
        const firstDownload = deferred<UpdateSnapshot>();
        const retryDownload = deferred<UpdateSnapshot>();
        const cancel = deferred<UpdateSnapshot>();
        let checkCalls = 0;
        let downloadCalls = 0;
        let applyCalls = 0;
        const race = new UpdateSession({
          info: async () => info,
          check: async () => {
            checkCalls++;
            return checkResult();
          },
          download: () => {
            downloadCalls++;
            return downloadCalls === 1
              ? firstDownload.promise
              : retryDownload.promise;
          },
          cancel: () => cancel.promise,
          apply: async () => {
            applyCalls++;
            return { accepted: true };
          },
          exitBlockers: () => [],
          rememberChannel() {},
        });
        await race.check();
        const pendingDownload = race.download();
        if (eventOrder === "before-cancel") race.progress(snap("ready"));
        const pendingCancel =
          cancelAction === "cancel"
            ? race.cancel()
            : race.changeChannel("preview");
        if (eventOrder === "during-cancel") race.progress(snap("ready"));
        if (responseOrder === "before-rejection") {
          firstDownload.resolve(snap("ready"));
          await pendingDownload;
        }
        cancel.reject(
          new Error(
            "STALE: Update selection changed; check again (native ready)",
          ),
        );
        await pendingCancel;
        if (eventOrder === "after-rejection") race.progress(snap("ready"));
        if (responseOrder === "after-rejection") {
          firstDownload.resolve(snap("ready"));
          await pendingDownload;
        }
        console.log(
          "CANCEL_RACE_STATE=" +
            JSON.stringify({
              label,
              stage: race.getSnapshot().snapshot?.stage,
              busy: race.busy,
              ready: race.ready,
              error: race.getSnapshot().error,
            }),
        );
        try {
          assert.equal(race.getSnapshot().snapshot?.stage, "failed", label);
          assert.equal(
            race.busy,
            false,
            `${label}: no orphaned active request`,
          );
          assert.equal(
            race.ready,
            false,
            `${label}: discarded RPC cannot install`,
          );
          assert.match(race.getSnapshot().error ?? "", /STALE/, label);
          assert.equal(race.release?.id, "signed-descriptor-1", label);
          assert.equal(race.getSnapshot().channel, "stable", label);
          assert.equal(await race.apply(), false, label);
          assert.equal(applyCalls, 0, `${label}: no native installation`);
          assert.equal(checkCalls, 1, `${label}: no automatic check`);
          assert.equal(downloadCalls, 1, `${label}: no automatic download`);
          // Even an event queued after both RPCs settled cannot resurrect busy.
          race.progress(snap("ready"));
          assert.equal(race.busy, false, label);
          assert.equal(race.ready, false, label);
          if (recovery === "check-then-download") {
            await race.check();
            assert.equal(checkCalls, 2, `${label}: explicit check is admitted`);
          }
          const retry = race.download();
          assert.equal(
            downloadCalls,
            2,
            `${label}: explicit retry is admitted`,
          );
          race.progress({ ...snap("ready", 2), releaseId: "wrong-release" });
          race.progress(snap("ready", 1));
          assert.equal(
            race.ready,
            false,
            `${label}: wrong release/old attempt`,
          );
          assert.equal(
            race.getSnapshot().snapshot?.stage,
            "downloading",
            label,
          );
          assert.equal(race.getSnapshot().snapshot?.attempt, 2, label);
          race.progress(snap("ready", 2));
          assert.equal(
            race.ready,
            false,
            `${label}: event still needs RPC ack`,
          );
          retryDownload.resolve(snap("ready", 2));
          await retry;
          assert(
            race.ready,
            `${label}: current retry RPC acknowledges readiness`,
          );
          assert.equal(race.busy, false, label);
          assert.equal(applyCalls, 0, `${label}: retry does not auto-install`);
        } catch (error) {
          cancelRaceFailures.push(`${label}: ${String(error)}`);
        }
      }
    }
  }
}
assert.deepEqual(cancelRaceFailures, [], "all STALE cancel races must recover");

// A genuinely successful cancellation also discards ready events/responses,
// whether they arrive while cancellation is pending or after its acknowledgement.
for (const readyBeforeCancelAck of [false, true]) {
  const download = deferred<UpdateSnapshot>();
  const cancel = deferred<UpdateSnapshot>();
  let applyCalls = 0;
  const cancelled = new UpdateSession({
    info: async () => info,
    check: async () => checkResult(),
    download: () => download.promise,
    cancel: () => cancel.promise,
    apply: async () => {
      applyCalls++;
      return { accepted: true };
    },
    exitBlockers: () => [],
    rememberChannel() {},
  });
  await cancelled.check();
  const pendingDownload = cancelled.download();
  const pendingCancel = cancelled.cancel();
  if (readyBeforeCancelAck) {
    cancelled.progress(snap("ready"));
    download.resolve(snap("ready"));
    await pendingDownload;
  }
  cancel.resolve(snap("cancelled"));
  await pendingCancel;
  if (!readyBeforeCancelAck) {
    download.resolve(snap("ready"));
    await pendingDownload;
  }
  cancelled.progress(snap("ready"));
  assert.equal(cancelled.getSnapshot().snapshot?.stage, "cancelled");
  assert.equal(cancelled.busy, false);
  assert.equal(cancelled.ready, false);
  assert.equal(await cancelled.apply(), false);
  assert.equal(
    applyCalls,
    0,
    "late ready after successful cancel cannot install",
  );
}

// Info errors captured before a later successful check cannot clobber it.
const lateInfo = deferred<UpdateInfo>();
const infoRace = new UpdateSession({
  info: () => lateInfo.promise,
  check: async () => checkResult(),
  download: async () => snap("ready"),
  cancel: async () => snap("cancelled"),
  apply: async () => ({ accepted: true }),
  exitBlockers: () => [],
  rememberChannel() {},
});
const infoLoading = infoRace.loadInfo();
await infoRace.check();
lateInfo.reject(new Error("old info failure"));
await infoLoading;
assert.equal(infoRace.getSnapshot().error, null);
assert(infoRace.release);

const cached = new UpdateSession({
  info: async () => info,
  check: async () => checkResult(),
  download: async () => snap("ready"),
  cancel: async () => snap("cancelled"),
  apply: async () => ({ accepted: true }),
  exitBlockers: () => [],
  rememberChannel() {},
});
await cached.check();
await cached.download();
assert(cached.ready);
await cached.check();
assert(!cached.ready);
await cached.download();
assert(
  cached.ready,
  "this generation's RPC may reuse a pinned verified cache without trusting a stale event",
);
cached.progress(snap("cancelled"));
assert(cached.ready);

const installFailure = new UpdateSession({
  info: async () => info,
  check: async () => checkResult(),
  download: async () => snap("ready"),
  cancel: async () => snap("cancelled"),
  apply: async () => {
    throw new Error("fixture install rejected");
  },
  exitBlockers: () => [],
  rememberChannel() {},
});
await installFailure.check();
await installFailure.download();
assert(installFailure.ready);
assert.equal(await installFailure.apply(), false);
assert(
  !installFailure.ready,
  "a native install rejection invalidates the local ready acknowledgement",
);
assert.equal(installFailure.getSnapshot().snapshot?.stage, "failed");

let guardChecks = 0;
let wrongInstallCalls = 0;
const appearedDraft = new UpdateSession({
  info: async () => info,
  check: async () => checkResult(),
  download: async () => snap("ready"),
  cancel: async () => snap("cancelled"),
  apply: async () => {
    wrongInstallCalls++;
    return { accepted: true };
  },
  exitBlockers: () => (++guardChecks > 1 ? ["draft appeared before IPC"] : []),
  rememberChannel() {},
});
await appearedDraft.check();
await appearedDraft.download();
assert.equal(await appearedDraft.apply(), false);
assert.equal(wrongInstallCalls, 0);
assert(
  appearedDraft.ready,
  "a pre-IPC UI blocker does not invalidate the native cache",
);

// Real store guards and actual UpdateDialog buttons. No browser/installation.
const calls: Array<{
  method: string;
  payload: unknown;
  resolve(value: unknown): void;
}> = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  onEvent: () => () => {},
  rpcCall: (method: string, payload: unknown) =>
    new Promise((resolve) => calls.push({ method, payload, resolve })),
}));
const actual = await import("../src/mainview/stores");
const wrap = (store: { getState(): unknown }) =>
  Object.assign(
    (selector?: (state: unknown) => unknown) =>
      selector ? selector(store.getState()) : store.getState(),
    store,
  );
mock.module("../src/mainview/stores", () =>
  Object.fromEntries(
    Object.entries(actual).map(([name, store]) => [
      name,
      typeof store?.getState === "function" ? wrap(store) : store,
    ]),
  ),
);
type Slot = { value: unknown };
const slots: Slot[] = [];
let cursor = 0;
const react = await import("react");
mock.module("react", () => ({
  ...react,
  useCallback: (callback: unknown) => callback,
  useDebugValue() {},
  useEffect() {},
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) =>
    snapshot(),
  useState: (initial: unknown) => {
    const at = cursor++;
    slots[at] ??= { value: initial };
    return [
      slots[at].value,
      (value: unknown) => {
        slots[at].value = value;
      },
    ];
  },
}));
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
const actualPreferences = await import(
  "../src/mainview/stores/useUpdaterPreferencesStore"
);
mock.module("../src/mainview/stores/useUpdaterPreferencesStore", () => ({
  useUpdaterPreferencesStore: wrap(
    actualPreferences.useUpdaterPreferencesStore,
  ),
}));
const { updateSession } = await import(
  "../src/mainview/components/updates/update-client"
);
const { UpdateDialog, UpdateEntry } = await import(
  "../src/mainview/components/updates/UpdateDialog"
);
const { updateExitBlockers, reportEditorExitState } = await import(
  "../src/mainview/components/updates/update-exit-guard"
);
actual.useUIStore.setState({ textEditorTarget: null, updateDialogOpen: false });
actual.useJobStore.setState({ jobs: [] });
actual.useFolderSyncStore.setState({ statuses: new Map() });
assert.deepEqual(updateExitBlockers(false), []);
reportEditorExitState("fixture-editor", { dirty: true, busy: false });
assert(updateExitBlockers(false).some((value) => value.includes("草稿")));
reportEditorExitState("fixture-editor", null);
actual.useJobStore.setState({
  jobs: [{ id: "queued", status: "queued" }] as never,
});
assert(updateExitBlockers(false).some((value) => value.includes("任务")));
actual.useJobStore.setState({ jobs: [] });
actual.useFolderSyncStore.setState({
  statuses: new Map([
    ["r", { ruleId: "r", status: "watching", filesWatching: 1 }],
  ]),
});
assert(updateExitBlockers(false).some((value) => value.includes("同步")));
actual.useFolderSyncStore.setState({ statuses: new Map() });
const documentBefore = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    querySelectorAll: () => [
      {
        closest: () => null,
        hasAttribute: () => false,
        getAttribute: () => "true",
      },
    ],
  },
});
assert(
  updateExitBlockers().some((value) => value.includes("弹窗")),
  "an open form hidden behind the update modal still blocks exit",
);
if (documentBefore)
  Object.defineProperty(globalThis, "document", documentBefore);
else Reflect.deleteProperty(globalThis, "document");
const render = () => {
  cursor = 0;
  return UpdateDialog();
};
type Node = { type?: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const node = value as Node;
  return [node, ...nodes(node.props?.children)];
}
function text(value: unknown): string {
  if (value === null || value === undefined || typeof value === "boolean")
    return "";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  return text((value as Node).props?.children);
}
function action(tree: unknown, label: string) {
  const node = nodes(tree).find(
    (node) =>
      typeof node.props.onClick === "function" &&
      text(node.props.children) === label,
  );
  assert(node, label);
  return node;
}
const entry = UpdateEntry({});
(entry.props.onClick as () => void)();
assert(actual.useUIStore.getState().updateDialogOpen);
let tree = render();
(action(tree, "检查更新").props.onClick as () => void)();
assert.equal(calls.at(-1)?.method, "updates:check");
assert.equal(calls.length, 1);
calls.at(-1)?.resolve({
  ...checkResult(),
  info: {
    ...info,
    signingConfigured: false,
    blockedReason: "signing unconfigured",
  },
  release: {
    ...checkResult().release,
    canDownload: false,
    blockedReason: "signing unconfigured",
  },
});
await Promise.resolve();
await Promise.resolve();
tree = render();
assert(text(tree).includes("1.8.0"));
assert(text(tree).includes("signing unconfigured"));
assert.equal(action(tree, "下载更新").props.disabled, true);
assert(text(tree).includes("<img src=x onerror=alert(1)>"));
assert(
  nodes(tree).some(
    (node) =>
      String(node.props.className).includes("min-h-0 min-w-0") &&
      String(node.props.className).includes("overflow-x-hidden"),
  ),
  "update body keeps vertical scrolling without a horizontal scroll strip",
);
assert(
  !nodes(tree).some((node) => node.type === "img"),
  "release notes remain plain text, not HTML",
);
assert.equal(updateSession.getSnapshot().snapshot, null);
for (const [status, version, expected] of [
  ["failed", "1.8.0", "上次更新失败"],
  ["completed", info.currentVersion, "上次更新已完成"],
  ["launching", "1.8.0", "尚未确认当前版本启动"],
] as const) {
  const history = updateSession.check();
  calls.at(-1)?.resolve({
    ...checkResult(),
    release: null,
    info: {
      ...info,
      lastUpdateResult: {
        status,
        version,
        message: "fixture diagnostic, no actual installation",
      },
    },
  });
  await history;
  assert(text(render()).includes(expected));
  assert(text(render()).includes("fixture diagnostic"));
}
const compactEntry = UpdateEntry({ compact: true });
assert(
  nodes(compactEntry).some((node) =>
    String(node.props.className).includes("@[720px]/statusbar:inline"),
  ),
);
console.log(
  "UPDATER_UI_PASS: real version/check/download/apply state machine; no auto-download; signing/package gates; channel and info races; immutable release/attempt; 32 STALE cancel/channel races recover by explicit retry; successful cancel/late-ready protection; exit task/sync/draft guards; actual dialog handlers; safe notes/links; fixture IPC only",
);
