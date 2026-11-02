// Run in its own process: bun tests/profile-refresh.regression.ts
// All requests are mocked. No vault, account credentials, or cloud is accessed.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import type { ProfileInfo } from "../src/shared/profile.types";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});
let response: ProfileInfo[] = [];
let deferProfileResponse = false;
const profileResponses: Array<(value: ProfileInfo[]) => void> = [];
const bucketResponses: Array<(value: unknown[]) => void> = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: async (method: string) => {
    if (method === "profile:list")
      return deferProfileResponse
        ? new Promise<ProfileInfo[]>((resolve) =>
            profileResponses.push(resolve),
          )
        : response;
    if (method === "vault:lock") return null;
    if (method === "buckets:list")
      return new Promise((resolve) => bucketResponses.push(resolve));
    throw new Error(`Unexpected mocked method: ${method}`);
  },
}));
const { useVaultStore } = await import("../src/mainview/stores/useVaultStore");
const { useProfileStore } = await import(
  "../src/mainview/stores/useProfileStore"
);
const { useObjectStore } = await import(
  "../src/mainview/stores/useObjectStore"
);
const { useBucketStore } = await import(
  "../src/mainview/stores/useBucketStore"
);
const { useTabStore } = await import("../src/mainview/stores/useTabStore");
const { useUIStore } = await import("../src/mainview/stores/useUIStore");
const old: ProfileInfo = {
  id: "account",
  name: "Old R2",
  provider: "r2",
  updatedAt: "old",
  createdAt: "t",
  hasR2AnalyticsToken: false,
  hasSessionToken: false,
};
const edited: ProfileInfo = {
  ...old,
  name: "Edited Qiniu",
  provider: "qiniu",
  updatedAt: "new",
  qiniu: { mode: "public" },
};
useVaultStore.setState({
  unlocked: true,
  profiles: [old],
  storageMode: "encrypted",
});
useProfileStore.getState().setActiveProfile(old);
const previousBucketResponse = bucketResponses.at(-1);
useBucketStore.getState().setSelectedBucket("old-bucket");
useObjectStore.setState({
  objects: [{ key: "old.txt", size: 1, etag: "v1", lastModified: "t" }],
  selectedKeys: new Set(["old.txt"]),
});
useUIStore.getState().setDetailKey("old.txt");
useUIStore.getState().openTransferDialog({ keys: ["old.txt"] });
useUIStore
  .getState()
  .openShareDialog({ profileId: old.id, bucket: "old-bucket", key: "old.txt" });
useTabStore.setState({
  tabs: [
    {
      id: "old-tab",
      profileId: old.id,
      profileName: old.name,
      bucket: "old-bucket",
      prefix: "",
    },
    {
      id: "other-tab",
      profileId: "other",
      profileName: "Other",
      bucket: "other-bucket",
      prefix: "",
    },
  ],
  activeTabId: "old-tab",
});
response = [edited];
await useVaultStore.getState().refreshProfiles();
assert.equal(useProfileStore.getState().activeProfile?.provider, "qiniu");
assert.equal(useProfileStore.getState().activeProfile?.updatedAt, "new");
assert.equal(useProfileStore.getState().activeProfile?.name, "Edited Qiniu");
assert.equal(useBucketStore.getState().selectedBucket, null);
assert.equal(useObjectStore.getState().objects.length, 0);
assert.equal(useObjectStore.getState().selectedKeys.size, 0);
assert.equal(useUIStore.getState().detailKey, null);
assert.equal(useUIStore.getState().transferDialogOpen, false);
assert.equal(useUIStore.getState().shareDialogOpen, false);
assert.deepEqual(
  useTabStore.getState().tabs.map((tab) => tab.id),
  ["other-tab"],
);
assert.equal(useTabStore.getState().activeTabId, null);
previousBucketResponse?.([{ name: "must-not-return" }]);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(useProfileStore.getState().buckets, []);
assert.equal(bucketResponses.length, 2);
bucketResponses.at(-1)?.([{ name: "new-bucket" }]);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(useProfileStore.getState().buckets, [{ name: "new-bucket" }]);

// Refreshing unchanged credentials must not reset a current selection or issue
// a second bucket discovery. An inactive account edit cannot change this scope.
useBucketStore.getState().setSelectedBucket("new-bucket");
const count = bucketResponses.length;
response = [edited, { ...old, id: "other", updatedAt: "edited-other" }];
await useVaultStore.getState().refreshProfiles();
assert.equal(useBucketStore.getState().selectedBucket, "new-bucket");
assert.equal(bucketResponses.length, count);

// Removing the active account clears its view rather than selecting another
// account or leaving live actions attached to a deleted identity.
response = [];
await useVaultStore.getState().refreshProfiles();
assert.equal(useProfileStore.getState().activeProfileId, null);
assert.equal(useProfileStore.getState().activeProfile, null);
assert.equal(useBucketStore.getState().selectedBucket, null);
deferProfileResponse = true;
const olderRefresh = useVaultStore.getState().refreshProfiles();
const newestRefresh = useVaultStore.getState().refreshProfiles();
profileResponses[1]([edited]);
await newestRefresh;
profileResponses[0]([old]);
await olderRefresh;
assert.equal(useVaultStore.getState().profiles[0].provider, "qiniu");
const preLockRefresh = useVaultStore.getState().refreshProfiles();
await useVaultStore.getState().lock();
// Even if another local unlock happens before an older native read settles,
// the pre-lock generation must remain invalid.
useVaultStore.setState({ unlocked: true, profiles: [] });
profileResponses[2]([old]);
await preLockRefresh;
assert.deepEqual(useVaultStore.getState().profiles, []);
for (const file of [
  "../src/mainview/components/objects/DetailPanel.tsx",
  "../src/mainview/components/qiniu/QiniuDetailsActions.tsx",
]) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  assert.match(
    source,
    /JSON\.stringify\(\[profileId, profileRevision, bucket,/,
  );
}
console.log(
  "PASS: profile revisions reconcile active identity, invalidate old views/requests, preserve other scopes, and clear removed accounts; no cloud requests",
);
