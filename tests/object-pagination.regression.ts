// Run in its own process: bun tests/object-pagination.regression.ts
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import type { ObjectListReq, ObjectListRes } from "../src/shared/s3.types";

type Pending = {
  request: ObjectListReq;
  resolve: (value: ObjectListRes) => void;
  reject: (error: unknown) => void;
};
const pending: Pending[] = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: (_method: string, request: ObjectListReq) =>
    new Promise<ObjectListRes>((resolve, reject) =>
      pending.push({ request, resolve, reject }),
    ),
}));
const { useObjectStore } = await import(
  "../src/mainview/stores/useObjectStore"
);
const state = () => useObjectStore.getState();
const page = (nextCursor?: string): ObjectListRes => ({
  objects: [],
  prefixes: [{ prefix: "目录/" }],
  isTruncated: Boolean(nextCursor),
  nextCursor,
});
const last = () => pending[pending.length - 1];

let call = state().loadObjects("account", "bucket", "", 100);
last().resolve(page("opaque/+first="));
await call;
assert.equal(
  state().nextCursor,
  "opaque/+first=",
  "directory-only page retains its continuation token",
);

call = state().loadObjects("account", "bucket", "", 100, state().nextCursor);
assert.equal(last().request.cursor, "opaque/+first=");
assert.ok(
  !("startAfter" in last().request),
  "object keys never substitute for continuation tokens",
);
last().resolve(page("opaque/+second="));
await call;
assert.equal(state().nextCursor, "opaque/+second=");

call = state().loadObjects("account", "bucket", "", 100, state().nextCursor);
last().resolve(page("opaque/+first="));
await call;
assert.ok(state().error, "a cursor cycle stops pagination");

const count = pending.length;
await state().loadObjects(
  "other-account",
  "bucket",
  "",
  100,
  "opaque/+second=",
);
assert.equal(
  pending.length,
  count,
  "cross-account cursor reuse is rejected before RPC",
);

call = state().loadObjects("account", "bucket", "", 100);
last().resolve({ objects: [], prefixes: [], isTruncated: true });
await call;
assert.ok(
  state().error,
  "missing continuation token is an error, not a complete listing",
);

call = state().loadObjects("account", "bucket", "", 100);
const stale = last();
state().reset();
stale.resolve(page("stale"));
await call;
assert.equal(
  state().nextCursor,
  undefined,
  "reset invalidates an in-flight response",
);
assert.deepEqual(state().prefixes, []);

call = state().loadObjects("account", "bucket", "", 100);
last().resolve(page("old-folder"));
await call;
state().navigateToPrefix("new/");
await state().loadObjects("account", "bucket", "new/", 100, "old-folder");
assert.ok(state().error, "cursor cannot cross prefix navigation");

console.log(
  "PASS: 7 object pagination scope/cycle/reset regressions; no cloud requests",
);
