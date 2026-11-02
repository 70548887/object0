// Independent process: no real RPC or cloud writes.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";

let accepted = false;
let calls = 0;
let lastPayload: unknown;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { confirm: () => accepted },
});
mock.module("@tauri-apps/api/core", () => ({
  invoke: async (_method: string, input: { payload: unknown }) => {
    calls++;
    lastPayload = input.payload;
    return null;
  },
}));
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const { rpcCall } = await import("../src/mainview/lib/rpc-client");
const request = { profileId: "test", bucket: "test", oldKey: "a", newKey: "b" };
await assert.rejects(rpcCall("objects:rename", request));
assert.equal(calls, 0, "declining must not invoke the backend");
accepted = true;
await rpcCall("objects:rename", request);
assert.equal(calls, 1);
assert.equal(
  (lastPayload as { verificationReadbackConfirmed: boolean })
    .verificationReadbackConfirmed,
  true,
);
assert.equal(
  "verificationReadbackConfirmed" in request,
  false,
  "caller payload must not be mutated",
);
console.log(
  "PASS: confirmation decline blocks RPC; acceptance passes explicit acknowledgement; no cloud requests",
);
