// Isolated fake React lifecycle + mock RPC; never mounts a real app or reads credentials.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import type { ProfileInfo } from "../src/shared/profile.types";
import type { BucketUsage } from "../src/shared/s3.types";

const realReact = await import("react");
type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
const slots: Slot[] = [];
let position = 0;
const effects: (() => void)[] = [];
const same = (a?: unknown[], b?: unknown[]) =>
  !!a &&
  !!b &&
  a.length === b.length &&
  a.every((value, i) => Object.is(value, b[i]));
mock.module("react", () => ({
  ...realReact,
  useRef: (initial: unknown) => {
    const i = position++;
    slots[i] ??= { value: { current: initial } };
    return slots[i].value;
  },
  useState: (initial: unknown) => {
    const i = position++;
    slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
    return [
      slots[i].value,
      (next: unknown) => {
        slots[i].value =
          typeof next === "function" ? next(slots[i].value) : next;
      },
    ];
  },
  useCallback: (callback: unknown, deps: unknown[]) => {
    const i = position++;
    if (!slots[i] || !same(slots[i].deps, deps))
      slots[i] = { value: callback, deps };
    return slots[i].value;
  },
  useEffect: (effect: () => undefined | (() => void), deps: unknown[]) => {
    const i = position++;
    const previous = slots[i];
    if (previous && same(previous.deps, deps)) return;
    slots[i] = { deps };
    effects.push(() => {
      previous?.cleanup?.();
      const cleanup = effect();
      if (cleanup) slots[i].cleanup = cleanup;
    });
  },
}));

interface Pending {
  profileId: string;
  bucket: string;
  resolve: (value: BucketUsage) => void;
}
const pending: Pending[] = [];
const cancellations: string[] = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: (
    method: string,
    input: { profileId: string; bucket: string; requestId: string },
  ) => {
    if (method === "buckets:usage-cancel") {
      cancellations.push(input.requestId);
      return Promise.resolve();
    }
    assert.equal(method, "buckets:usage");
    return new Promise<BucketUsage>((resolve) =>
      pending.push({ ...input, resolve }),
    );
  },
  onEvent: () => () => {},
}));
let nextTimer = 1;
const timers = new Map<number, { callback: () => unknown; delay: number }>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    setTimeout: (callback: () => unknown, delay: number) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});
const { useBucketUsage } = await import("../src/mainview/hooks/useBucketUsage");
const profile = (
  id: string,
  provider: "qiniu" | "r2" = "qiniu",
): ProfileInfo => ({
  id,
  name: id,
  provider,
  hasR2AnalyticsToken: false,
  createdAt: "fixture",
  updatedAt: "revision-1",
});
function render(current: ProfileInfo, bucket = "bucket") {
  position = 0;
  // biome-ignore lint/correctness/useHookAtTopLevel: isolated fake React lifecycle intentionally invokes the real hook in a deterministic harness.
  const result = useBucketUsage(current, bucket, true);
  for (const effect of effects.splice(0)) effect();
  return result;
}
function debounce() {
  for (const [id, timer] of timers) {
    if (timer.delay === 300) {
      timers.delete(id);
      void timer.callback();
    }
  }
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const newest = () => pending[pending.length - 1];
function data(id: string, source: "scan" | "r2" = "scan"): BucketUsage {
  const now = new Date().toISOString();
  return {
    profileId: id,
    bucket: "bucket",
    source,
    bytes: 1234,
    objectCount: 2,
    measuredAt: now,
    fetchedAt: now,
    complete: true,
  };
}

// A's success or failure may not become B's view after a switch/cancellation.
render(profile("a"));
debounce();
const a = newest();
render(profile("b"));
debounce();
const b = newest();
assert.ok(cancellations.length > 0);
b.resolve(data("b"));
await settle();
assert.equal(render(profile("b")).data?.profileId, "b");
a.resolve(data("a"));
await settle();
assert.equal(render(profile("b")).data?.profileId, "b");

// A partial official result is visible as unknown, never cached as a complete zero.
render(profile("partial"));
debounce();
const partialRequest = newest();
partialRequest.resolve({
  ...data("partial"),
  source: "qiniu",
  bytes: null,
  objectCount: null,
  measuredAt: null,
  complete: false,
  qiniuAnalytics: {
    complete: false,
    measuredAt: null,
    classes: [],
    warning: "missing class metrics",
  },
});
await settle();
let state = render(profile("partial"));
assert.equal(state.data?.bytes, null);
assert.equal(state.data?.complete, false);
render(profile("b"));
const count = pending.length;
render(profile("partial"));
debounce();
assert.equal(pending.length, count + 1);

// Complete scan fallback is separately sourced and can be cached while official diagnostics remain partial.
newest().resolve({
  ...data("partial"),
  qiniuAnalytics: { complete: false, measuredAt: null, classes: [] },
});
await settle();
state = render(profile("partial"));
assert.equal(state.data?.source, "scan");
assert.equal(state.data?.bytes, 1234);
render(profile("b"));
const cachedCount = pending.length;
render(profile("partial"));
debounce();
assert.equal(pending.length, cachedCount);
assert.equal(render(profile("partial")).data?.source, "scan");

// An invalid current response retains the last good total as stale; it does not fabricate zero.
state = render(profile("partial"));
state.refresh();
render(profile("partial"));
debounce();
newest().resolve({ ...data("partial"), bytes: -1 });
await settle();
state = render(profile("partial"));
assert.equal(state.data?.bytes, 1234);
assert.equal(state.stale, true);
assert.ok(state.error);

// Provider is part of the cache identity even if a caller has not changed the revision.
render(profile("partial", "r2"));
debounce();
const switched = newest();
assert.equal(switched.profileId, "partial");
switched.resolve(data("partial", "r2"));
await settle();
assert.equal(render(profile("partial", "r2")).data?.source, "r2");

for (const slot of slots) slot.cleanup?.();
assert.ok(cancellations.length > 0);
console.log(
  "QINIU_USAGE_HOOK_REGRESSION_PASS: scope cancellation, partial-cache rejection, separate scan provenance, invalid-response stale preservation and provider cache isolation; no real RPC",
);
