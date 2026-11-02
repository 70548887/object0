import { mock } from "bun:test";
import assert from "node:assert/strict";

const calls: Array<{ method: string; payload: unknown }> = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: async (method: string, payload: unknown) => {
    calls.push({ method, payload });
    return undefined;
  },
}));
const { useQiniuShareStore } = await import(
  "../src/mainview/stores/useQiniuShareStore"
);
const state = () => useQiniuShareStore.getState();
const session = {
  sessionId: "local-private-session",
  bucketName: "native-name",
  prefix: "shared/",
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  readOnly: true as const,
};
state().adoptSession(
  { ...session, ...{ secretKey: "never-retain" } },
  {
    profileSetFingerprint: "saved-roster",
    privateEnvironmentId: "private",
    privateEnvironmentRevision: "r1",
    privateEnvironmentFingerprint: "saved-config",
    ...{ sessionToken: "never-retain" },
  },
);
assert.deepEqual(state().session, session);
assert.deepEqual(state().sessionSource, {
  profileSetFingerprint: "saved-roster",
  privateEnvironmentId: "private",
  privateEnvironmentRevision: "r1",
  privateEnvironmentFingerprint: "saved-config",
});
assert(!JSON.stringify(state().sessionSource).includes("never-retain"));
state().closeSession();
assert.equal(state().session, null);
assert.equal(state().sessionSource, null);
assert.deepEqual(calls, [
  { method: "qiniu:share-close", payload: { sessionId: session.sessionId } },
]);
state().adoptSession(session, { profileSetFingerprint: "saved-roster" });
state().reset();
assert.equal(state().sessionSource, null);
assert.equal(calls.length, 2);
console.log(
  "PRIVATE_SHARE_LOGIN_REGRESSION_PASS: native session DTO and local source remain allowlisted, memory-only and are cleared together",
);
