// Run in its own process: bun tests/bucket-usage-rpc.regression.ts
// Module mocks remain isolated from other test suites and no cloud requests run.

import { mock } from "bun:test";
import { strict as assert } from "node:assert";

type Scope = { profileId: string; bucket: string };
type Listener = (event: { payload: Scope }) => void;
const nativeListeners = new Map<string, Listener>();
const scope = { profileId: "regression-account", bucket: "regression-bucket" };
let outcome: "success" | "partial-failure" | "validation-failure" = "success";

mock.module("@tauri-apps/api/event", () => ({
  listen: async (name: string, listener: Listener) => {
    nativeListeners.set(name, listener);
    return () => nativeListeners.delete(name);
  },
}));
mock.module("@tauri-apps/api/core", () => ({
  invoke: async () => {
    if (outcome === "validation-failure") {
      throw new Error("local validation failed before any write");
    }
    // The native scope guard emits even if a second rename stage rejects.
    nativeListeners.get("bucket-usage:changed")?.({ payload: scope });
    if (outcome === "partial-failure") {
      throw new Error("copy completed; delete stage failed");
    }
    return null;
  },
}));

const { onEvent, rpcCall } = await import("../src/mainview/lib/rpc-client");
const events: Scope[] = [];
const unsubscribe = onEvent("bucket-usage:changed", (event) =>
  events.push(event),
);
const rename = { ...scope, oldKey: "old.txt", newKey: "new.txt" };

await rpcCall("objects:rename", rename);
assert.deepEqual(events, [scope], "successful rename must invalidate once");

events.length = 0;
outcome = "partial-failure";
await assert.rejects(rpcCall("objects:rename", rename), (error: unknown) =>
  String(error).includes("delete stage failed"),
);
assert.deepEqual(
  events,
  [scope],
  "partial rename failure must still forward the native invalidation",
);

events.length = 0;
outcome = "success";
await rpcCall("objects:delete", { ...scope, keys: ["file.txt"] });
assert.deepEqual(
  events,
  [scope],
  "delete must forward exactly one native event",
);

events.length = 0;
outcome = "validation-failure";
await assert.rejects(rpcCall("objects:rename", rename));
assert.deepEqual(
  events,
  [],
  "pre-write validation failure must not invalidate",
);

unsubscribe();
nativeListeners.get("bucket-usage:changed")?.({ payload: scope });
assert.deepEqual(events, [], "unsubscribed handlers must not receive events");
console.log("PASS: 5 usage event bridge checks; no cloud requests");
