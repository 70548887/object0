// Isolated hook-slot/fake-clock test. No browser or real cloud calls.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";

const refs: Array<{ current: unknown }> = [];
let slot = 0;
const actualReact = await import("react");
mock.module("react", () => ({
  ...actualReact,
  useRef: (initial: unknown) => {
    const index = slot++;
    refs[index] ??= { current: initial };
    return refs[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
}));
mock.module("../src/mainview/lib/i18n", () => ({
  t: (zh: string) => zh,
  localize: (value: string) => value,
  useT: () => {},
}));
type Payload = {
  profileId: string;
  bucket: string;
  keys: string[];
  expectedProfileRevision?: string;
};
const requests: Payload[] = [];
const pending: Array<(report: unknown) => void> = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: (method: string, payload: Payload) => {
    assert.equal(method, "objects:delete");
    requests.push(structuredClone(payload));
    return new Promise<unknown>((resolve) => pending.push(resolve));
  },
}));
type Event = {
  kind: string;
  title: string;
  options?: {
    action?: { label: string; onClick: () => void };
    description?: unknown;
  };
};
const events: Event[] = [];
mock.module("../src/mainview/components/common/Toast", () => ({
  toast: Object.fromEntries(
    ["success", "error", "info", "warning"].map((kind) => [
      kind,
      (title: string, options?: Event["options"]) =>
        events.push({ kind, title, options }),
    ]),
  ),
}));
const oldSetTimeout = globalThis.setTimeout;
const oldClearTimeout = globalThis.clearTimeout;
const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);
const copied: string[] = [];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    clipboard: {
      writeText: async (value: string) => {
        copied.push(value);
      },
    },
  },
});
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
  const refreshes = { a: 0, b: 0 };
  const render = (profileId: "a" | "b", keys: string[]) => {
    slot = 0;
    // biome-ignore lint/correctness/useHookAtTopLevel: deliberately isolated hook-slot test, not a React component.
    return usePendingDelete({
      profileId,
      profileRevision: `${profileId}-v1`,
      bucket: `${profileId}-bucket`,
      selectedKeys: new Set(keys),
      clearSelection: () => {},
      refresh: () => refreshes[profileId]++,
    });
  };
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const start = async (keys: string[]) => {
    await render("a", keys)();
    const timer = [...timers.values()].at(-1);
    assert.ok(timer);
    timer();
    await flush();
  };
  await start(["good.txt", "denied.txt"]);
  pending.at(-1)?.({
    results: [
      { key: "good.txt", success: true },
      { key: "denied.txt", success: false, error: "Access denied" },
    ],
  });
  await flush();
  assert.equal(
    events.filter((event) => event.kind === "success").length,
    0,
    "partial result must not display an all-success toast",
  );
  assert.match(events.at(-1)?.title ?? "", /成功 1.*失败 1/);
  assert.equal(events.at(-1)?.options?.action?.label, "复制失败明细");
  assert.equal(
    refreshes.a,
    1,
    "partial mutation still refreshes the original visible scope",
  );
  const requestsBeforeCopy = requests.length;
  await events.at(-1)?.options?.action?.onClick();
  assert.match(copied[0], /a-bucket/);
  assert.match(copied[0], /denied\.txt.*Access denied/);
  assert.doesNotMatch(copied[0], /good\.txt/);
  assert.equal(
    requests.length,
    requestsBeforeCopy,
    "copying failure details must not retry a deletion",
  );

  await start(["one.txt", "two.txt"]);
  pending.at(-1)?.({ results: [] });
  await flush();
  assert.match(events.at(-1)?.title ?? "", /成功 0.*失败 2/);
  assert.equal(events.at(-1)?.kind, "error");

  await start(["one.txt", "two.txt"]);
  pending.at(-1)?.({ results: [{ key: "one.txt", success: true }] });
  await flush();
  assert.match(events.at(-1)?.title ?? "", /成功 1.*失败 1/);

  await start(["both-failed.txt"]);
  pending.at(-1)?.({
    results: [
      { key: "both-failed.txt", success: false, error: "Permission denied" },
    ],
  });
  await flush();
  assert.match(events.at(-1)?.title ?? "", /成功 0.*失败 1/);
  assert.equal(events.at(-1)?.kind, "error");

  const beforeA = refreshes.a;
  const beforeB = refreshes.b;
  await start(["old-account.txt"]);
  render("b", []);
  pending.at(-1)?.({
    results: [
      { key: "old-account.txt", success: false, error: "Access denied" },
    ],
  });
  await flush();
  assert.deepEqual(requests.at(-1), {
    profileId: "a",
    bucket: "a-bucket",
    keys: ["old-account.txt"],
    expectedProfileRevision: "a-v1",
  });
  assert.equal(refreshes.a, beforeA);
  assert.equal(refreshes.b, beforeB);
  assert.match(events.at(-1)?.title ?? "", /成功 0.*失败 1/);
  console.log(
    "PASS: partial/all-failed/empty/missing delete results never report all-success; original account scope and revision remain bound",
  );
} finally {
  globalThis.setTimeout = oldSetTimeout;
  globalThis.clearTimeout = oldClearTimeout;
  if (originalNavigator)
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
}
