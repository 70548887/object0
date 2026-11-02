// Isolated hook lifecycle harness with fake timers, native RPC, and React hook
// slots. It is not a browser test. No real account, filesystem, or cloud I/O.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";

const refs: Array<{ current: unknown }> = [];
let hookSlot = 0;
const cleanups: Array<() => void> = [];
mock.module("react", () => ({
  useRef: (initial: unknown) => {
    const index = hookSlot++;
    refs[index] ??= { current: initial };
    return refs[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (setup: () => (() => void) | undefined) => {
    if (cleanups.length === 0) {
      const cleanup = setup();
      if (cleanup) cleanups.push(cleanup);
    }
  },
}));
mock.module("../src/mainview/lib/i18n", () => ({
  t: (zh: string) => zh,
  localize: (text: string) => text,
  useT: () => {},
}));
type DeletePayload = {
  profileId: string;
  bucket: string;
  keys: string[];
  expectedProfileRevision?: string;
};
const requests: DeletePayload[] = [];
const completions: Array<() => void> = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: (method: string, payload: DeletePayload) => {
    assert.equal(method, "objects:delete");
    requests.push(structuredClone(payload));
    return new Promise<unknown>((resolve) =>
      completions.push(() =>
        resolve({
          results: payload.keys.map((key) => ({ key, success: true })),
        }),
      ),
    );
  },
}));
const undoActions: Array<() => void> = [];
mock.module("../src/mainview/components/common/Toast", () => ({
  toast: {
    success: () => {},
    error: () => {},
    info: () => {},
    warning: (
      _text: string,
      options?: { action?: { onClick: () => void } },
    ) => {
      if (options?.action) undoActions.push(options.action.onClick);
    },
  },
}));
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const timers = new Map<number, () => void>();
let sequence = 0;
globalThis.setTimeout = ((callback: () => void) => {
  const id = ++sequence;
  timers.set(id, callback);
  return id;
}) as typeof setTimeout;
globalThis.clearTimeout = ((id: number) =>
  timers.delete(id)) as typeof clearTimeout;
try {
  const { usePendingDelete } = await import(
    "../src/mainview/components/objects/usePendingDelete"
  );
  let refreshA = 0;
  let refreshB = 0;
  const render = (
    profileId: string,
    bucket: string,
    keys: string[],
    refresh: () => void,
    profileRevision?: string,
  ) => {
    hookSlot = 0;
    // biome-ignore lint/correctness/useHookAtTopLevel: isolated fake hook-slot lifecycle harness, not a rendered React component.
    return usePendingDelete({
      profileId,
      bucket,
      selectedKeys: new Set(keys),
      clearSelection: () => {},
      refresh,
      ...(profileRevision === undefined ? {} : { profileRevision }),
    });
  };
  const flushPromises = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  // A pending undo window survives a render. Starting B must not submit A's
  // keys under B's identity, and finishing A must not refresh B's view.
  await render("account-a", "bucket-a", ["a-only.txt"], () => refreshA++)();
  const cancelledTimerA = [...timers.values()][0];
  await render("account-b", "bucket-b", ["b-only.txt"], () => refreshB++)();
  assert.deepEqual(requests[0], {
    profileId: "account-a",
    bucket: "bucket-a",
    keys: ["a-only.txt"],
  });
  completions[0]();
  await flushPromises();
  assert.equal(refreshA, 0);
  assert.equal(refreshB, 0);
  // A timeout callback already queued before clearTimeout must not clear the
  // newer B pending job or issue A for a second time.
  cancelledTimerA();
  await flushPromises();
  assert.equal(requests.length, 1);
  const timerB = [...timers.values()][0];
  timerB();
  await flushPromises();
  assert.deepEqual(requests[1], {
    profileId: "account-b",
    bucket: "bucket-b",
    keys: ["b-only.txt"],
  });
  completions[1]();
  await flushPromises();
  assert.equal(refreshB, 1);

  // Timer completion while the user browses another bucket stays bound to the
  // original scope, without triggering its stale refresh callback.
  await render("account-b", "first-bucket", ["first.txt"], () => refreshA++)();
  const originalTimer = [...timers.values()].at(-1);
  assert.ok(originalTimer);
  render("account-b", "second-bucket", ["second.txt"], () => refreshB++);
  originalTimer();
  await flushPromises();
  assert.deepEqual(requests[2], {
    profileId: "account-b",
    bucket: "first-bucket",
    keys: ["first.txt"],
  });
  completions[2]();
  await flushPromises();
  assert.equal(refreshA, 0);
  assert.equal(refreshB, 1);

  // Undo from an old scope cancels only its job, never refreshes a new scope.
  await render("account-a", "bucket-a", ["undo.txt"], () => refreshA++)();
  const undo = undoActions.at(-1);
  assert.ok(undo);
  render("account-b", "bucket-b", ["other.txt"], () => refreshB++);
  undo();
  await flushPromises();
  assert.equal(refreshA, 0);
  assert.equal(refreshB, 1);
  assert.equal(requests.length, 3);
  // Staying in the same bucket but navigating to another prefix must refresh
  // the latest view, not invoke the scheduling render's old-prefix callback.
  await render("account-a", "same-bucket", ["same.txt"], () => refreshA++)();
  const sameScopeTimer = [...timers.values()].at(-1);
  assert.ok(sameScopeTimer);
  render("account-a", "same-bucket", [], () => refreshB++);
  sameScopeTimer();
  await flushPromises();
  completions[3]();
  await flushPromises();
  assert.equal(refreshA, 0);
  assert.equal(refreshB, 2);
  const beforeRevisionChange = requests.length;
  await render(
    "same-id",
    "same-bucket",
    ["old-revision.txt"],
    () => refreshA++,
    "revision-1",
  )();
  const oldRevisionTimer = [...timers.values()].at(-1);
  assert.ok(oldRevisionTimer);
  render("same-id", "same-bucket", [], () => refreshB++, "revision-2");
  oldRevisionTimer();
  await flushPromises();
  assert.equal(
    requests.length,
    beforeRevisionChange,
    "a pending delete must not use replacement credentials for the same profile id",
  );
  // A different visible account is not proof that the original account's
  // revision changed. Keep the original A snapshot and let Rust validate it.
  await render(
    "revision-owner",
    "owner-bucket",
    ["owner.txt"],
    () => refreshA++,
    "owner-v1",
  )();
  const ownerTimer = [...timers.values()].at(-1);
  assert.ok(ownerTimer);
  render(
    "another-account",
    "another-bucket",
    [],
    () => refreshB++,
    "another-v9",
  );
  ownerTimer();
  await flushPromises();
  assert.deepEqual(requests.at(-1), {
    profileId: "revision-owner",
    bucket: "owner-bucket",
    keys: ["owner.txt"],
    expectedProfileRevision: "owner-v1",
  });
  completions.at(-1)?.();
  await flushPromises();
  assert.equal(refreshA, 0);
  assert.equal(refreshB, 2);
  for (const cleanup of cleanups) cleanup();
  console.log(
    "PASS: delayed/flush deletes preserve original account+bucket+keys, stale timer callbacks cannot consume newer work, and stale completion/undo cannot refresh another scope",
  );
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
