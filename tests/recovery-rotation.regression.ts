import { mock } from "bun:test";
import assert from "node:assert/strict";

type Call = { method: string; payload: unknown };
const calls: Call[] = [];
let reply: (method: string, payload: unknown) => unknown | Promise<unknown> =
  () => undefined;
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: async (method: string, payload: unknown) => {
    calls.push({ method, payload });
    return await reply(method, payload);
  },
}));
const { useVaultStore } = await import("../src/mainview/stores/useVaultStore");
const state = () => useVaultStore.getState();
const profile = {
  id: "fixture",
  name: "Fixture account",
  provider: "r2" as const,
  hasR2AnalyticsToken: false,
  createdAt: "t",
  updatedAt: "r1",
};
function reset() {
  calls.length = 0;
  useVaultStore.setState({
    storageMode: "encrypted",
    unlocked: true,
    loading: false,
    profiles: [profile],
    needsPassphraseChange: false,
    pendingRecoveryKey: null,
    pendingRecoveryBackupPath: null,
    rotatingRecoveryKey: false,
    hasRecoveryKey: false,
    vaultVersion: 3,
    error: null,
  });
}
reset();
assert.equal(await state().rotateRecoveryKey("", true), false);
assert.equal(await state().rotateRecoveryKey("synthetic-pass", false), false);
assert.equal(calls.length, 0);
useVaultStore.setState({ unlocked: false });
assert.equal(await state().rotateRecoveryKey("synthetic-pass", true), false);
assert.equal(calls.length, 0);

reset();
reply = () => {
  throw new Error(
    "当前密码验证失败，恢复密钥未更换 / Current password verification failed; the recovery key was not changed",
  );
};
assert.equal(
  await state().rotateRecoveryKey("wrong-synthetic-pass", true),
  false,
);
assert.match(state().error ?? "", /当前密码验证失败/);
assert.equal(state().pendingRecoveryKey, null);
assert.equal(state().rotatingRecoveryKey, false);
assert.deepEqual(state().profiles, [profile]);

reset();
reply = () => ({
  recoveryKey: "synthetic-new-recovery-key",
  backupPath: "C:\\fixture\\vault.enc.pre-rotation.bak",
});
assert.equal(
  await state().rotateRecoveryKey("synthetic-current-pass", true),
  true,
);
assert.equal(state().pendingRecoveryKey, "synthetic-new-recovery-key");
assert.equal(
  state().pendingRecoveryBackupPath,
  "C:\\fixture\\vault.enc.pre-rotation.bak",
);
assert.equal(state().hasRecoveryKey, true);
assert.equal(state().vaultVersion, 3);
assert.deepEqual(state().profiles, [profile]);
assert.equal(
  await state().rotateRecoveryKey("synthetic-current-pass", true),
  false,
);
assert.equal(calls.length, 1);
state().clearPendingRecoveryKey();
assert.equal(state().pendingRecoveryKey, null);
assert.equal(state().pendingRecoveryBackupPath, null);

reset();
useVaultStore.setState({
  pendingRecoveryKey: "displayed-secret",
  pendingRecoveryBackupPath: "C:\\fixture\\backup",
});
let unlockLock: (value: unknown) => void = () => {};
reply = (method) =>
  method === "vault:lock"
    ? new Promise((done) => {
        unlockLock = done;
      })
    : undefined;
const locking = state().lock();
assert.equal(state().pendingRecoveryKey, null);
assert.equal(state().pendingRecoveryBackupPath, null);
assert.equal(calls[0]?.method, "vault:lock");
unlockLock(undefined);
await locking;
assert.equal(state().unlocked, false);

reset();
let resolve: (value: unknown) => void = () => {};
reply = (method) =>
  method === "vault:rotate-recovery-key"
    ? new Promise((done) => {
        resolve = done;
      })
    : undefined;
const rotating = state().rotateRecoveryKey("synthetic-current-pass", true);
assert.equal(state().rotatingRecoveryKey, true);
assert.equal(
  await state().rotateRecoveryKey("synthetic-current-pass", true),
  false,
);
await state().lock();
assert.equal(state().unlocked, false);
assert.equal(state().pendingRecoveryKey, null);
// Even a new unlocked session cannot inherit the old request's new secret.
useVaultStore.setState({ unlocked: true });
resolve({
  recoveryKey: "late-secret-must-not-surface",
  backupPath: "C:\\fixture\\backup",
});
assert.equal(await rotating, false);
assert.equal(state().pendingRecoveryKey, null);
assert.equal(state().pendingRecoveryBackupPath, null);
assert.match(state().error ?? "", /可能已完成/);
assert(!JSON.stringify(state()).includes("late-secret-must-not-surface"));
assert.equal(
  calls.filter((call) => call.method === "vault:rotate-recovery-key").length,
  1,
);

reset();
reply = () => {
  throw new Error("unsafe raw synthetic-current-pass secret-key detail");
};
assert.equal(
  await state().rotateRecoveryKey("synthetic-current-pass", true),
  false,
);
assert(!state().error?.includes("synthetic-current-pass"));
assert(!state().error?.includes("secret-key"));
assert.match(state().error ?? "", /勿假定旧密钥仍有效/);
console.log(
  "RECOVERY_ROTATION_UI_PASS: manual confirmation, fixed errors, key handoff, preserved profile/password metadata, no automatic retries and lock-generation secret rejection; mocks only",
);
