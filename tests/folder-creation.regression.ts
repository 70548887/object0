// Real destination guard and folder admission; fixture IPC only.
import { mock } from "bun:test";
import assert from "node:assert/strict";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
const calls: Array<{ method: string; payload: unknown }> = [];
let finish: (value: { jobId: string }) => void = () => {};
mock.module("../src/mainview/lib/rpc-client", () => ({
  onEvent: () => () => {},
  rpcCall: (method: string, payload: unknown) => {
    calls.push({ method, payload });
    assert.equal(method, "transfer:upload");
    return new Promise<{ jobId: string }>((resolve) => {
      finish = resolve;
    });
  },
}));
const stores = await import("../src/mainview/stores");
const { captureFolderScope, folderKey, queueFolder } = await import(
  "../src/mainview/components/objects/folder-creation"
);
const profile = {
  id: "fixture",
  name: "Fixture",
  provider: "r2" as const,
  updatedAt: "revision-1",
  createdAt: "t",
  hasR2AnalyticsToken: false,
  hasSessionToken: false,
};
stores.useVaultStore.setState({ unlocked: true, profiles: [profile] });
stores.useProfileStore.setState({
  activeProfileId: profile.id,
  activeProfile: profile,
});
stores.useBucketStore.setState({ selectedBucket: "bucket" });
stores.useObjectStore.setState({ currentPrefix: "parent/" });
const scope = captureFolderScope();
assert(scope);
assert.equal(folderKey(scope, " 中文+%?# "), "parent/中文+%?#/");
for (const name of [
  "",
  ".",
  "..",
  "a/b",
  "a\\b",
  "a\0b",
  "a\nb",
  "x".repeat(1024),
])
  assert.throws(() => folderKey(scope, name));
const pending = queueFolder(scope, "notes");
assert.deepEqual(calls, [
  {
    method: "transfer:upload",
    payload: {
      profileId: "fixture",
      expectedProfileRevision: "revision-1",
      bucket: "bucket",
      key: "parent/notes/",
      localPath: "",
    },
  },
]);
// A completed admission is a job ID, never a successful storage write or a
// refresh of the now-selected other directory.
stores.useObjectStore.setState({ currentPrefix: "elsewhere/" });
finish({ jobId: "folder-job" });
assert.equal(await pending, "folder-job");
assert.equal(calls.length, 1);
await assert.rejects(queueFolder(scope, "notes"));
stores.useObjectStore.setState({ currentPrefix: "parent/" });
stores.useVaultStore.setState({
  profiles: [{ ...profile, updatedAt: "revision-2" }],
});
await assert.rejects(queueFolder(scope, "notes"));
stores.useVaultStore.setState({ profiles: [profile], unlocked: false });
await assert.rejects(queueFolder(scope, "notes"));
assert.equal(captureFolderScope(), null);
stores.useVaultStore.setState({ profiles: [profile], unlocked: true });
stores.useBucketStore.setState({ selectedBucket: "different" });
await assert.rejects(queueFolder(scope, "notes"));
assert.equal(calls.length, 1);
stores.useBucketStore.setState({ selectedBucket: "bucket" });
stores.useVaultStore.setState({
  profiles: [{ ...profile, provider: "qiniu", qiniu: { mode: "private" } }],
});
const privateScope = captureFolderScope();
assert(privateScope);
await assert.rejects(queueFolder(privateScope, "notes"));
assert.equal(calls.length, 1);
stores.useVaultStore.setState({ profiles: [profile] });
const refused = queueFolder(scope, "notes");
finish({ jobId: "" });
await assert.rejects(refused);
console.log(
  "FOLDER_CREATION_PASS: frozen account/revision/bucket/prefix; single-name validation; zero-byte marker queued not claimed completed; no stale refresh; locked/private/change refusal; realCloud=false",
);
