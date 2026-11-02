import { mock } from "bun:test";
import assert from "node:assert/strict";

const calls: { method: string; input: unknown }[] = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: async (method: string, input: unknown) => {
    calls.push({ method, input });
    return undefined;
  },
}));
const { useQiniuShareStore } = await import(
  "../src/mainview/stores/useQiniuShareStore"
);
const state = () => useQiniuShareStore.getState();
const session = {
  sessionId: "a",
  bucketName: "bucket",
  prefix: "shared/",
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  readOnly: true as const,
};
state().adoptSession({ ...session, ...{ secretKey: "must-not-be-retained" } });
assert.deepEqual(state().session, session);
assert(!JSON.stringify(state().session).includes("must-not-be-retained"));
state().adoptSession({ ...session, sessionId: "b" });
assert.deepEqual(calls, [
  { method: "qiniu:share-close", input: { sessionId: "a" } },
]);
state().openLogin();
state().openCreate({
  profileId: "profile",
  profileRevision: "v1",
  bucketName: "bucket",
  prefix: "shared/",
});
state().reset();
assert.equal(state().session, null);
assert.equal(state().createTarget, null);
assert.equal(state().loginOpen, false);
assert.deepEqual(calls[1], {
  method: "qiniu:share-close",
  input: { sessionId: "b" },
});
state().reset();
assert.equal(calls.length, 2);
state().adoptSession({ ...session, sessionId: "c" });
state().closeSession();
assert.equal(state().session, null);
assert.deepEqual(calls[2], {
  method: "qiniu:share-close",
  input: { sessionId: "c" },
});
console.log(
  "QINIU_SHARE_STORE_REGRESSION_PASS: allowlisted memory-only state, replacement, explicit close and lock/unmount reset",
);
