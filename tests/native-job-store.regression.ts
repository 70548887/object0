// Isolated RPC mocks; no native runtime, cloud, real file or credential used.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import type { JobInfo, ProgressEvent } from "../src/shared/job.types";

type Request = {
  method: string;
  payload: unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};
const requests: Request[] = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: (method: string, payload: unknown) =>
    new Promise((resolve, reject) =>
      requests.push({ method, payload, resolve, reject }),
    ),
}));
const { useJobStore, wasClearedJobAttempt } = await import(
  "../src/mainview/stores/useJobStore"
);
const state = () => useJobStore.getState();
const last = () => requests[requests.length - 1];
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const fixture = (
  status: JobInfo["status"] = "running",
  attempt = 1,
): JobInfo => ({
  id: "native-job",
  type: "upload",
  status,
  resumable: true,
  attempt,
  fileName: "fixture.bin",
  description: "fixture",
  bytesTransferred: 5,
  bytesTotal: 10,
  percentage: 50,
  speed: 10,
  eta: 2,
  createdAt: "2026-10-31T00:00:00Z",
});
const event = (status: JobInfo["status"], attempt = 1): ProgressEvent => ({
  jobId: "native-job",
  type: "upload",
  status,
  resumable: true,
  attempt,
  fileName: "fixture.bin",
  bytesTransferred: 5,
  bytesTotal: 10,
  percentage: 50,
  speed: 10,
  eta: 2,
});
const current = () => state().jobs[0];

state().resetJobs();
useJobStore.setState({ jobs: [fixture()] });
state().updateFromProgress(event("paused"));
assert.equal(current().status, "paused");
assert.equal(current().speed, 0);
assert.equal(current().eta, 0);
state().updateFromComplete({
  jobId: "native-job",
  success: false,
  attempt: 1,
  error: "legacy ambiguous",
});
assert.equal(current().status, "paused");
assert.equal(current().completedAt, undefined);
state().updateFromComplete({
  jobId: "native-job",
  success: false,
  status: "interrupted",
  attempt: 1,
});
assert.equal(current().status, "interrupted");
assert.equal(current().percentage, 50);
state().updateFromProgress(event("queued", 2));
state().updateFromProgress(event("running", 2));
state().updateFromComplete({
  jobId: "native-job",
  success: false,
  status: "failed",
  attempt: 1,
});
state().updateFromProgress(event("paused", 1));
assert.equal(current().status, "running");
assert.equal(current().attempt, 2);
state().updateFromProgress(event("paused", 2));
state().updateFromProgress(event("running", 2));
assert.equal(current().status, "paused");
state().updateFromProgress(event("queued", 3));
state().updateFromProgress(event("running", 3));
state().updateFromComplete({
  jobId: "native-job",
  success: true,
  status: "completed",
  attempt: 3,
});
assert.equal(current().status, "completed");
assert.equal(current().percentage, 100);
state().updateFromProgress(event("running", 2));
state().updateFromComplete({ jobId: "native-job", success: false, attempt: 3 });
assert.equal(current().status, "completed");
state().resetJobs();
useJobStore.setState({ jobs: [fixture()] });
state().updateFromComplete({
  jobId: "native-job",
  success: false,
  status: "cancelled",
  attempt: 1,
});
state().updateFromComplete({ jobId: "native-job", success: false, attempt: 1 });
assert.equal(current().status, "cancelled");

state().resetJobs();
useJobStore.setState({ jobs: [fixture()] });
let refresh = state().refreshJobs();
const pendingRefresh = last();
state().updateFromProgress(event("paused"));
pendingRefresh.resolve([fixture()]);
await refresh;
assert.equal(current().status, "paused");
assert.equal(state().loading, false);
refresh = state().refreshJobs();
last().resolve([fixture("running", 1)]);
await refresh;
assert.equal(current().status, "paused");
refresh = state().refreshJobs();
const mixedSnapshot = last();
state().updateFromProgress(event("interrupted"));
mixedSnapshot.resolve([
  fixture(),
  { ...fixture("paused"), id: "newly-restored" },
]);
await refresh;
assert.equal(
  state().jobs.find((job) => job.id === "native-job")?.status,
  "interrupted",
);
assert.equal(
  state().jobs.find((job) => job.id === "newly-restored")?.status,
  "paused",
);
// Clearing a finished job while a snapshot is in flight must not resurrect it.
useJobStore.setState({
  jobs: [
    { ...fixture("completed"), id: "done-before-refresh" },
    fixture("paused"),
  ],
});
const snapshotBeforeClear = state().refreshJobs();
const clearingSnapshot = last();
const clearDuringRefresh = state().clearCompleted();
last().resolve(undefined);
await clearDuringRefresh;
clearingSnapshot.resolve([
  { ...fixture("completed"), id: "done-before-refresh" },
  fixture("paused"),
]);
await snapshotBeforeClear;
assert.equal(
  state().jobs.some((job) => job.id === "done-before-refresh"),
  false,
);
const older = state().refreshJobs();
const oldRequest = last();
const newer = state().refreshJobs();
const newRequest = last();
newRequest.resolve([fixture("interrupted")]);
await newer;
oldRequest.resolve([fixture()]);
await older;
assert.equal(current().status, "interrupted");
refresh = state().refreshJobs();
const preLock = last();
state().resetJobs();
preLock.resolve([fixture()]);
await refresh;
assert.equal(state().jobs.length, 0);

useJobStore.setState({ jobs: [fixture()] });
const pause = state().pauseJob("native-job");
assert.equal(last().method, "jobs:pause");
assert(state().pendingJobIds.has("native-job"));
assert.equal(current().status, "running");
last().reject(new Error("pause was refused"));
await assert.rejects(pause, /pause was refused/);
assert.equal(current().status, "running");
assert.equal(state().error, "pause was refused");
assert(!state().pendingJobIds.has("native-job"));
const resume = state().resumeJob("native-job");
last().resolve(undefined);
await settle();
assert.equal(last().method, "jobs:list");
last().resolve([fixture("queued", 2)]);
await resume;
assert.equal(current().attempt, 2);
assert.equal(current().status, "queued");

useJobStore.setState({
  jobs: [fixture("paused"), { ...fixture("completed"), id: "done" }],
});
const clearFailed = state().clearCompleted();
last().reject(new Error("disk refused clear"));
await assert.rejects(clearFailed);
assert.equal(state().jobs.length, 2);
const clear = state().clearCompleted();
last().resolve(undefined);
await clear;
assert.equal(state().jobs.length, 1);
assert.equal(current().status, "paused");
const methodsBeforeRestore = requests.length;
const restore = state().restoreJobs();
assert.equal(last().method, "jobs:restore");
last().resolve({ restored: 2, unreadable: 1 });
await settle();
assert.equal(last().method, "jobs:list");
last().resolve([fixture("interrupted", 4)]);
assert.deepEqual(await restore, { restored: 2, unreadable: 1 });
assert.deepEqual(
  requests.slice(methodsBeforeRestore).map((item) => item.method),
  ["jobs:restore", "jobs:list"],
);
assert.equal(current().status, "interrupted");

const oldAction = state().retryJob("native-job");
const actionBeforeLock = last();
state().resetJobs();
const newAction = state().retryJob("other-job");
const actionAfterLock = last();
actionBeforeLock.resolve(undefined);
await oldAction;
assert(state().pendingJobIds.has("other-job"));
actionAfterLock.resolve(undefined);
await settle();
last().resolve([]);
await newAction;
assert.equal(state().jobs.length, 0);
// Cancellation intent persists across newer progress/list snapshots and commit
// reconciliation; an old false/absent field cannot restore upload controls.
state().resetJobs();
useJobStore.setState({ jobs: [fixture("interrupted", 7)] });
state().updateFromProgress({
  ...event("interrupted", 7),
  cancelRequested: true,
});
assert.equal(current().cancelRequested, true);
refresh = state().refreshJobs();
last().resolve([{ ...fixture("interrupted", 7), cancelRequested: false }]);
await refresh;
assert.equal(current().cancelRequested, true);
state().updateFromProgress({ ...event("running", 8), cancelRequested: false });
assert.equal(current().cancelRequested, true);
state().updateFromProgress({
  ...event("interrupted", 6),
  cancelRequested: false,
});
assert.equal(current().attempt, 8);
assert.equal(current().cancelRequested, true);
state().updateFromComplete({
  jobId: "native-job",
  status: "completed",
  success: true,
  attempt: 8,
});
assert.equal(current().status, "completed");
assert.equal(current().cancelRequested, true);
// A completed record can be cleared before its worker's last publication.
// Neither late progress/completion nor a later stale list may revive it.
state().resetJobs();
useJobStore.setState({ jobs: [fixture("completed", 5)] });
const clearBeforeLatePublish = state().clearCompleted();
last().resolve(undefined);
await clearBeforeLatePublish;
assert.equal(state().jobs.length, 0);
state().updateFromProgress(event("completed", 5));
assert.equal(
  state().jobs.length,
  0,
  "a cleared attempt must not reappear from late progress",
);
state().updateFromComplete({
  jobId: "native-job",
  status: "completed",
  success: true,
  attempt: 5,
});
assert.equal(state().jobs.length, 0);
state().updateFromProgress(event("running", 4));
assert.equal(state().jobs.length, 0);
refresh = state().refreshJobs();
last().resolve([fixture("completed", 5)]);
await refresh;
assert.equal(state().jobs.length, 0);
assert.equal(wasClearedJobAttempt("native-job", 5), true);
assert.equal(wasClearedJobAttempt("native-job", 4), true);
assert.equal(wasClearedJobAttempt("native-job", 6), false);
state().updateFromProgress(event("running", 6));
assert.equal(current().attempt, 6);
assert.equal(current().status, "running");
refresh = state().refreshJobs();
last().resolve([fixture("completed", 5)]);
await refresh;
assert.equal(current().attempt, 6);
assert.equal(current().status, "running");
state().updateFromComplete({
  jobId: "native-job",
  status: "completed",
  success: true,
  attempt: 5,
});
assert.equal(current().status, "running");
state().resetJobs();
assert.equal(wasClearedJobAttempt("native-job", 5), false);
state().updateFromProgress(event("running", 1));
assert.equal(current().attempt, 1);
// Native persistence may be terminal before its UI publication arrives. The
// explicit removed list is authoritative even when this row still says running.
state().resetJobs();
useJobStore.setState({ jobs: [fixture("running", 9)] });
const persistedClear = state().clearCompleted();
last().resolve({ removed: [{ jobId: "native-job", attempt: 9 }] });
await persistedClear;
assert.equal(
  state().jobs.length,
  0,
  "backend-confirmed removed attempts must clear even a stale running row",
);
state().updateFromProgress(event("completed", 9));
assert.equal(state().jobs.length, 0);
state().updateFromComplete({
  jobId: "native-job",
  status: "completed",
  success: true,
  attempt: 9,
});
assert.equal(state().jobs.length, 0);
state().updateFromProgress(event("running", 10));
assert.equal(current().attempt, 10);
const lowerClear = state().clearCompleted();
last().resolve({ removed: [{ jobId: "native-job", attempt: 9 }] });
await lowerClear;
assert.equal(current().attempt, 10);
useJobStore.setState({ jobs: [fixture("completed", 11)] });
const explicitEmptyClear = state().clearCompleted();
last().resolve({ removed: [] });
await explicitEmptyClear;
assert.equal(current().attempt, 11);
const malformedClear = state().clearCompleted();
last().resolve({
  removed: [
    { jobId: "native-job", attempt: 11 },
    { jobId: "native-job", attempt: 11 },
  ],
});
await assert.rejects(malformedClear);
assert.equal(current().attempt, 11);
console.log(
  "PASS: native paused/interrupted/cancelled states, per-attempt stale events, late refresh/reset safety, action errors, held-record clearing and manual restore semantics; no cloud requests",
);
