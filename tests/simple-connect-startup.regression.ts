import { mock } from "bun:test";
import assert from "node:assert/strict";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => {
      memory.set(k, v);
    },
    removeItem: (k: string) => {
      memory.delete(k);
    },
  },
});
const calls: Array<{ method: string; payload: unknown }> = [];
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
const { useTabStore } = await import("../src/mainview/stores/useTabStore");
const { useUIStore } = await import("../src/mainview/stores/useUIStore");
const s = () => useVaultStore.getState();
const profile = {
  id: "p",
  name: "Fixture",
  provider: "qiniu" as const,
  createdAt: "t",
  updatedAt: "r1",
  hasR2AnalyticsToken: false,
  qiniu: { mode: "public" as const },
};
const ready = {
  ready: true,
  legacyImportRequired: false,
  legacyAvailable: false,
  storageMode: "plaintext",
  configPath: "C:\\fixture\\accounts.local.json",
  profiles: [profile],
  version: 5,
  hasRecoveryKey: false,
};
function reset() {
  calls.length = 0;
  useVaultStore.setState({
    loading: false,
    exists: false,
    unlocked: false,
    profiles: [],
    storageMode: "plaintext",
    legacyImportRequired: false,
    legacyAvailable: false,
    importingLegacy: false,
    switchingToPlaintext: false,
    error: null,
    pendingRecoveryKey: null,
    pendingRecoveryBackupPath: null,
  });
  useProfileStore.getState().clearBuckets();
}
reset();
reply = (m) =>
  m === "vault:open-local"
    ? ready
    : m === "jobs:restore"
      ? { restored: 0, unreadable: 0 }
      : m === "jobs:list"
        ? []
        : undefined;
await s().checkStatus();
assert.equal(s().unlocked, true);
assert.equal(s().vaultVersion, 5);
assert.equal(s().hasRecoveryKey, false);
assert.deepEqual(s().profiles, [profile]);
assert(
  !calls.some((c) =>
    /keychain|vault:setup|vault:unlock|vault:status/.test(c.method),
  ),
);
reset();
reply = (m, p) =>
  m === "vault:open-local"
    ? (p as { skipLegacyImport?: boolean }).skipLegacyImport
      ? { ...ready, profiles: [], legacyAvailable: true }
      : {
          ...ready,
          ready: false,
          profiles: [],
          legacyImportRequired: true,
          legacyAvailable: true,
        }
    : m === "jobs:restore"
      ? { restored: 0, unreadable: 0 }
      : m === "jobs:list"
        ? []
        : undefined;
await s().checkStatus();
assert.equal(s().unlocked, false);
assert.equal(s().legacyImportRequired, true);
assert.equal(await s().openLocalAccounts(true), true);
assert.deepEqual(s().profiles, []);
assert.equal(s().legacyAvailable, true);
reset();
reply = (m) =>
  m === "vault:import-legacy"
    ? { ...ready, legacyAvailable: true }
    : m === "jobs:restore"
      ? { restored: 0, unreadable: 0 }
      : m === "jobs:list"
        ? []
        : undefined;
assert.equal(
  await s().importLegacyAccounts("synthetic-original-password"),
  true,
);
assert.equal(s().legacyImportRequired, false);
assert.deepEqual(s().profiles, [profile]);
assert(!calls.some((c) => c.method === "vault:recover-key"));
reset();
reply = () => {
  throw new Error("raw fixture AK/SK details");
};
assert.equal(
  await s().importLegacyAccounts("synthetic-original-password"),
  false,
);
assert.deepEqual(s().profiles, []);
assert(!s().error?.includes("AK/SK"));
reset();
let resolve: (v: unknown) => void = () => {};
reply = (m) =>
  m === "vault:open-local"
    ? new Promise((done) => {
        resolve = done;
      })
    : undefined;
const opening = s().checkStatus();
await s().lock();
resolve(ready);
await opening;
assert.equal(s().unlocked, true); // Plaintext lock is intentionally unavailable, so no session changes.
// A new explicit local-open request supersedes an older one even without lock.
reset();
const resolves: Array<(v: unknown) => void> = [];
reply = (m) =>
  m === "vault:open-local"
    ? new Promise((done) => resolves.push(done))
    : m === "jobs:restore"
      ? { restored: 0, unreadable: 0 }
      : m === "jobs:list"
        ? []
        : undefined;
const old = s().checkStatus();
const newer = s().checkStatus();
resolves[1]({ ...ready, profiles: [] });
await newer;
resolves[0](ready);
await old;
assert.deepEqual(s().profiles, []);
// Adoption seeds the already-fetched bucket list without another list RPC.
calls.length = 0;
const previousTab = {
  id: "old-tab",
  profileId: "other-account",
  bucket: "old-bucket",
  prefix: "",
  title: "Old tab",
};
useTabStore.setState({ tabs: [previousTab], activeTabId: previousTab.id });
useUIStore.getState().openTransferDialog({ keys: ["old-file"] });
useUIStore.getState().openShareDialog({
  profileId: "other-account",
  bucket: "old-bucket",
  key: "old-file",
});
useProfileStore
  .getState()
  .adoptConnectedProfile(profile, [{ name: "native-bucket" }]);
assert.equal(useProfileStore.getState().activeProfileId, "p");
assert.deepEqual(useProfileStore.getState().buckets, [
  { name: "native-bucket" },
]);
assert.equal(calls.length, 0);
assert.equal(useTabStore.getState().activeTabId, null);
assert.deepEqual(useTabStore.getState().tabs, [previousTab]);
assert.equal(useUIStore.getState().transferDialogOpen, false);
assert.equal(useUIStore.getState().shareTarget, null);
console.log(
  "SIMPLE_CONNECT_STARTUP_PASS: default plaintext, optional one-time legacy import, no normal authentication RPCs, late startup rejection and seeded bucket adoption; fixtures only",
);
