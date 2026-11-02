// Isolated fixture IPC only. No user accounts, files, credentials or cloud calls.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import type {
  JobInfo,
  JobLocation,
  ProgressEvent,
} from "../src/shared/job.types";

const requests: Array<{ method: string; resolve: (value: unknown) => void }> =
  [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: (method: string) =>
    new Promise((resolve) => requests.push({ method, resolve })),
}));
const { useJobStore } = await import("../src/mainview/stores/useJobStore");
const s = () => useJobStore.getState();
function lastRequest() {
  const request = requests.at(-1);
  assert(request, "Expected fixture IPC request");
  return request;
}
const destination: JobLocation = {
  profileId: "account-a",
  profileName: "Queue-time name A",
  provider: "r2",
  bucket: "same-bucket",
  key: "folder/same.txt",
};
const source: JobLocation = {
  profileId: "account-b",
  profileName: "Queue-time name B",
  provider: "qiniu",
  bucket: "same-bucket",
  key: "source/same.txt",
};
const progress = (
  id = "one",
  extra: Partial<ProgressEvent> = {},
): ProgressEvent => ({
  jobId: id,
  type: "upload",
  status: "running",
  fileName: "same.txt",
  bytesTransferred: 1,
  bytesTotal: 2,
  percentage: 50,
  speed: 1,
  eta: 1,
  attempt: 1,
  ...extra,
});
const job = (id = "one", extra: Partial<JobInfo> = {}): JobInfo => ({
  id,
  type: "upload",
  status: "running",
  fileName: "same.txt",
  description: "fixture",
  bytesTransferred: 1,
  bytesTotal: 2,
  percentage: 50,
  speed: 1,
  eta: 1,
  createdAt: "t",
  attempt: 1,
  ...extra,
});

s().resetJobs();
s().updateFromProgress(progress("one", { destination }));
s().updateFromProgress(progress("two", { destination: source }));
assert.deepEqual(
  s().jobs.find((j) => j.id === "one")?.destination,
  destination,
);
assert.deepEqual(s().jobs.find((j) => j.id === "two")?.destination, source);
s().updateFromProgress(progress());
assert.deepEqual(
  s().jobs.find((j) => j.id === "one")?.destination,
  destination,
);
s().updateFromComplete({
  jobId: "one",
  status: "completed",
  success: true,
  attempt: 1,
});
assert.deepEqual(
  s().jobs.find((j) => j.id === "one")?.destination,
  destination,
);
// Complete events fill a previously unlocated known row; unknown jobs do not
// acquire a guessed task type solely from a source/destination field.
useJobStore.setState({ jobs: [job("complete-first")] });
s().updateFromComplete({
  jobId: "complete-first",
  status: "completed",
  success: true,
  attempt: 1,
  source,
  destination,
});
assert.deepEqual(s().jobs[0].source, source);
assert.deepEqual(s().jobs[0].destination, destination);
s().updateFromComplete({
  jobId: "unknown-complete",
  status: "completed",
  success: true,
  destination,
});
assert(!s().jobs.some((j) => j.id === "unknown-complete"));

// A missing-field legacy jobs:list cannot erase metadata; a rename or conflicting
// account with the same bucket/key cannot rewrite historical snapshots.
let refresh = s().refreshJobs();
lastRequest().resolve([job("complete-first", { status: "completed" })]);
await refresh;
assert.deepEqual(s().jobs[0].destination, destination);
refresh = s().refreshJobs();
lastRequest().resolve([
  job("complete-first", {
    status: "completed",
    destination: { ...destination, profileName: "Renamed current profile" },
  }),
]);
await refresh;
assert.deepEqual(s().jobs[0].destination, destination);
refresh = s().refreshJobs();
lastRequest().resolve([
  job("complete-first", {
    status: "completed",
    destination: { ...source, key: destination.key },
  }),
]);
await refresh;
assert.deepEqual(s().jobs[0].destination, destination);
// Reload/persisted snapshots without a previous UI row adopt their own metadata.
s().resetJobs();
refresh = s().refreshJobs();
lastRequest().resolve([job("restored", { status: "completed", destination })]);
await refresh;
assert.deepEqual(s().jobs[0].destination, destination);
s().updateFromProgress(
  progress("restored", { attempt: 0, destination: source }),
);
assert.deepEqual(s().jobs[0].destination, destination);
// A late list cannot overwrite a newer event snapshot.
s().resetJobs();
refresh = s().refreshJobs();
s().updateFromProgress(progress("late", { destination }));
lastRequest().resolve([job("late", { destination: source })]);
await refresh;
assert.deepEqual(s().jobs[0].destination, destination);
// Clearing a finished record retains existing anti-resurrection behavior.
s().updateFromComplete({
  jobId: "late",
  success: true,
  status: "completed",
  attempt: 1,
});
const clear = s().clearCompleted();
lastRequest().resolve({ removed: [{ jobId: "late", attempt: 1 }], errors: [] });
await clear;
s().updateFromProgress(progress("late", { destination: source }));
assert.equal(s().jobs.length, 0);
console.log(
  "JOB_LOCATION_STORE_PASS: queue-time account snapshots survive progress/complete/list/restore; legacy gaps and stale attempts never substitute a current or different account; fixture IPC only",
);
