// Run in an isolated process: bun tests/profile-switch.regression.ts
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import type { ProfileInfo } from "../src/shared/profile.types";
import type { BucketInfo } from "../src/shared/s3.types";

type PendingRequest = {
  profileId: string;
  resolve: (buckets: BucketInfo[]) => void;
  reject: (error: unknown) => void;
};
const requests: PendingRequest[] = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: (_method: string, { profileId }: { profileId: string }) =>
    new Promise<BucketInfo[]>((resolve, reject) => {
      requests.push({ profileId, resolve, reject });
    }),
}));

const { useProfileStore } = await import(
  "../src/mainview/stores/useProfileStore"
);
const store = () => useProfileStore.getState();
const profile = (id: string): ProfileInfo => ({
  id,
  name: id,
  provider: "r2",
  hasR2AnalyticsToken: false,
  createdAt: "2026-10-31T00:00:00Z",
  updatedAt: "2026-10-31T00:00:00Z",
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const newest = () => requests[requests.length - 1];

// A finishes after B: A's response must not replace B's buckets.
store().setActiveProfile(profile("a"));
const oldSuccess = newest();
store().setActiveProfile(profile("b"));
const newSuccess = newest();
newSuccess.resolve([{ name: "b-bucket" }]);
await settle();
oldSuccess.resolve([{ name: "a-bucket" }]);
await settle();
assert.equal(store().activeProfileId, "b");
assert.deepEqual(store().buckets, [{ name: "b-bucket" }]);
assert.equal(store().bucketsLoading, false);

// An error from A must not overwrite B's success or stop B's pending spinner.
store().setActiveProfile(profile("a"));
const oldFailure = newest();
store().setActiveProfile(profile("b"));
const currentPending = newest();
oldFailure.reject(new Error("a is offline"));
await settle();
assert.equal(store().error, null);
assert.equal(store().bucketsLoading, true);
currentPending.resolve([{ name: "b-current" }]);
await settle();
assert.deepEqual(store().buckets, [{ name: "b-current" }]);

// Clearing selection invalidates both pending results and errors.
store().setActiveProfile(profile("a"));
const clearedSuccess = newest();
store().clearBuckets();
clearedSuccess.resolve([{ name: "must-not-reappear" }]);
await settle();
assert.equal(store().activeProfileId, null);
assert.deepEqual(store().buckets, []);
assert.equal(store().bucketsLoading, false);
assert.equal(store().error, null);

store().setActiveProfile(profile("a"));
const clearedFailure = newest();
store().setActiveProfile(null);
clearedFailure.reject(new Error("must-not-reappear"));
await settle();
assert.equal(store().activeProfileId, null);
assert.deepEqual(store().buckets, []);
assert.equal(store().bucketsLoading, false);
assert.equal(store().error, null);

// Concurrent refreshes for the same account are also latest-request-wins.
store().setActiveProfile(profile("b"));
const firstRefresh = newest();
const refreshed = store().loadBuckets("b");
const lastRefresh = newest();
lastRefresh.resolve([{ name: "latest-refresh" }]);
await refreshed;
firstRefresh.resolve([{ name: "obsolete-refresh" }]);
await settle();
assert.deepEqual(store().buckets, [{ name: "latest-refresh" }]);

// A delayed click to refresh an inactive account must not issue a new RPC.
const countBeforeStaleRefresh = requests.length;
await store().loadBuckets("a");
assert.equal(requests.length, countBeforeStaleRefresh);
assert.deepEqual(store().buckets, [{ name: "latest-refresh" }]);

console.log("PASS: 6 account-switch request race checks; no cloud requests");
