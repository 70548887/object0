import { mock } from "bun:test";
import assert from "node:assert/strict";

// The state-only probe uses in-memory preference storage, never a real user
// profile, browser storage or on-disk credential file.
const preferenceMemory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => preferenceMemory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      preferenceMemory.set(key, value);
    },
    removeItem: (key: string) => {
      preferenceMemory.delete(key);
    },
    clear: () => preferenceMemory.clear(),
    key: (index: number) => [...preferenceMemory.keys()][index] ?? null,
    get length() {
      return preferenceMemory.size;
    },
  },
});

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
const { useProfileStore } = await import(
  "../src/mainview/stores/useProfileStore"
);
const state = () => useVaultStore.getState();
const profile = {
  id: "p",
  name: "Fixture",
  provider: "qiniu" as const,
  hasR2AnalyticsToken: false,
  createdAt: "t",
  updatedAt: "r1",
  qiniu: { mode: "public" as const },
};
function reset(patch: Record<string, unknown> = {}) {
  calls.length = 0;
  useVaultStore.setState({
    exists: true,
    unlocked: true,
    loading: false,
    profiles: [profile],
    storageMode: "encrypted",
    configPath: null,
    switchingToPlaintext: false,
    rotatingRecoveryKey: false,
    needsPassphraseChange: false,
    pendingRecoveryKey: null,
    pendingRecoveryBackupPath: null,
    vaultVersion: 3,
    hasRecoveryKey: true,
    error: null,
    ...patch,
  });
}
const success = {
  success: true,
  profiles: [profile],
  storageMode: "plaintext",
  configPath: "C:\\fixture\\accounts.local.json",
};

reset();
assert.equal(await state().enablePlaintext(false), false);
assert.equal(calls.length, 0);
reset({ unlocked: false });
assert.equal(await state().enablePlaintext(true), false);
assert.equal(calls.length, 0);
reset({ rotatingRecoveryKey: true });
assert.equal(await state().enablePlaintext(true), false);
assert.equal(calls.length, 0);
reset({ pendingRecoveryKey: "pending-synthetic-key" });
assert.equal(await state().enablePlaintext(true), false);
assert.equal(calls.length, 0);

reset();
reply = () => {
  throw new Error("raw error with fixture-ak and fixture-sk");
};
assert.equal(await state().enablePlaintext(true), false);
assert.equal(state().storageMode, "encrypted");
assert.deepEqual(state().profiles, [profile]);
assert.equal(state().hasRecoveryKey, true);
assert(!state().error?.includes("fixture-ak"));
assert(!state().error?.includes("fixture-sk"));

reset({ exists: false, unlocked: false, profiles: [] });
reply = (method) =>
  method === "vault:enable-plaintext"
    ? success
    : method === "profile:list"
      ? [profile]
      : method === "jobs:restore"
        ? { restored: 0, unreadable: 0 }
        : method === "jobs:list"
          ? []
          : undefined;
assert.equal(await state().enablePlaintext(true), true);
assert.deepEqual(
  calls.find((c) => c.method === "vault:enable-plaintext")?.payload,
  { confirmPlaintext: true },
);
assert.equal(state().storageMode, "plaintext");
assert.equal(state().vaultVersion, 5);
assert.equal(state().hasRecoveryKey, false);
assert.equal(state().pendingRecoveryKey, null);
assert.deepEqual(state().profiles, [profile]);
await state()
  .refreshProfiles()
  .catch(() => {});
// Any profile refresh in plaintext must not infer encrypted V4 from Qiniu.
assert.equal(state().vaultVersion, 5);
calls.length = 0;
await state().lock();
assert.equal(state().unlocked, true);
assert.equal(calls.length, 0);
assert.equal(await state().rotateRecoveryKey("unused", true), false);
assert.equal(await state().changePassphrase("unused"), false);
assert.equal(await state().resetVault(), false);

reset({ unlocked: false });
reply = (method) =>
  method === "vault:open-local"
    ? {
        ...success,
        ready: true,
        legacyImportRequired: false,
        legacyAvailable: false,
        version: 5,
        hasRecoveryKey: false,
      }
    : method === "jobs:restore"
      ? { restored: 0, unreadable: 0 }
      : method === "jobs:list"
        ? []
        : undefined;
await state().checkStatus();
assert.equal(state().unlocked, true);
assert.equal(state().storageMode, "plaintext");
assert.equal(state().hasRecoveryKey, false);
assert.equal(state().vaultVersion, 5);
assert(
  !calls.some((c) =>
    [
      "vault:unlock-keychain",
      "vault:enable-plaintext",
      "vault:unlock",
    ].includes(c.method),
  ),
);

reset({ unlocked: false });
reply = (method) =>
  method === "vault:open-local"
    ? {
        ready: false,
        legacyImportRequired: true,
        legacyAvailable: true,
        version: 5,
        hasRecoveryKey: false,
        storageMode: "plaintext",
        configPath: success.configPath,
        profiles: [],
      }
    : undefined;
await state().checkStatus();
assert.equal(state().unlocked, false);
assert.equal(state().storageMode, "plaintext");
assert.equal(state().legacyImportRequired, true);
assert(!calls.some((c) => c.method === "vault:enable-plaintext"));

reset({
  storageMode: "plaintext",
  vaultVersion: 5,
  configPath: success.configPath,
  hasRecoveryKey: false,
});
useProfileStore.setState({
  activeProfileId: profile.id,
  activeProfile: profile,
  buckets: [{ name: "fixture-bucket" }],
});
reply = () => {
  throw new Error("unsafe fixture-ak fixture-sk failed status");
};
await state().checkStatus();
assert.equal(state().unlocked, false);
assert.deepEqual(state().profiles, []);
assert.equal(state().storageMode, "plaintext");
assert.equal(state().vaultVersion, 5);
assert.equal(state().configPath, success.configPath);
assert.equal(useProfileStore.getState().activeProfileId, null);
assert.equal(useProfileStore.getState().activeProfile, null);
assert.deepEqual(useProfileStore.getState().buckets, []);
assert.deepEqual(
  calls.map((c) => c.method),
  ["vault:open-local"],
);
assert.match(state().error ?? "", /不会回退/);
assert(!state().error?.includes("fixture-ak"));
assert(!state().error?.includes("fixture-sk"));

// Default local startup fails closed even if the prior in-memory mode was encrypted.
reset();
reply = () => {
  throw new Error("fixed encrypted status failure");
};
await state().checkStatus();
assert.equal(state().unlocked, false);
assert.deepEqual(state().profiles, []);
assert.equal(state().storageMode, "plaintext");
assert(!state().error?.includes("fixed encrypted status failure"));

reset();
let resolve: (value: unknown) => void = () => {};
reply = (method) =>
  method === "vault:enable-plaintext"
    ? new Promise((done) => {
        resolve = done;
      })
    : undefined;
const switching = state().enablePlaintext(true);
assert.equal(state().switchingToPlaintext, true);
assert.equal(await state().enablePlaintext(true), false);
await state().lock();
assert.equal(state().unlocked, false);
resolve(success);
assert.equal(await switching, false);
assert.equal(state().storageMode, "encrypted");
assert.equal(state().unlocked, false);
assert.match(state().error ?? "", /可能已完成/);
assert.equal(
  calls.filter((c) => c.method === "vault:enable-plaintext").length,
  1,
);
console.log(
  "PLAINTEXT_MODE_UI_PASS: explicit consent, keyless onboarding/reopen, no automatic encrypted migration, preserved failure state and stale-session rejection; no real storage",
);
