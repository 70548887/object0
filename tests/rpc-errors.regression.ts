// Run in a separate process: bun tests/rpc-errors.regression.ts
import { mock } from "bun:test";
import { strict as assert } from "node:assert";

let rejection: unknown;
let fail = true;
mock.module("@tauri-apps/api/core", () => ({
  invoke: async () => {
    if (fail) throw rejection;
    return { exists: true, unlocked: false, hasRecoveryKey: false };
  },
}));
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const { rpcCall } = await import("../src/mainview/lib/rpc-client");
for (const value of [
  "读取对象列表失败：AccessDenied（HTTP 403）",
  new Error("网络连接超时"),
  { message: "存储桶不存在" },
]) {
  rejection = value;
  const expected = typeof value === "string" ? value : value.message;
  await assert.rejects(
    rpcCall("vault:status", undefined),
    (error: unknown) => error instanceof Error && error.message === expected,
  );
}
rejection = { request: { credential: "must-not-be-serialized" } };
await assert.rejects(
  rpcCall("vault:status", undefined),
  (error: unknown) =>
    error instanceof Error && !error.message.includes("must-not-be-serialized"),
);
fail = false;
assert.equal((await rpcCall("vault:status", undefined)).exists, true);
console.log("PASS: 5 RPC error normalization checks; no cloud requests");
