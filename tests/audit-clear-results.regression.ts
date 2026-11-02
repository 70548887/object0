// Isolated in-memory IPC fixtures. No native process, vault or cloud access.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import type { JobInfo, ProgressEvent } from "../src/shared/job.types";

const requests: Array<{
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}> = [];
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: (method: string) => {
    assert.equal(method, "jobs:clear");
    return new Promise((resolve, reject) => requests.push({ resolve, reject }));
  },
}));
const { useJobStore, wasClearedJobAttempt } = await import(
  "../src/mainview/stores/useJobStore"
);
const state = () => useJobStore.getState();
const last = () => requests[requests.length - 1];
const job = (
  id: string,
  status: JobInfo["status"] = "completed",
  attempt = 1,
): JobInfo => ({
  id,
  status,
  attempt,
  type: "upload",
  resumable: true,
  fileName: `${id}.bin`,
  description: "fixture",
  bytesTransferred: 1,
  bytesTotal: 1,
  percentage: 100,
  speed: 0,
  eta: 0,
  createdAt: "2026-11-01T00:00:00Z",
});
const event = (id: string, attempt: number): ProgressEvent => ({
  jobId: id,
  type: "upload",
  status: "running",
  resumable: true,
  attempt,
  fileName: `${id}.bin`,
  bytesTransferred: 0,
  bytesTotal: 1,
  percentage: 0,
  speed: 0,
  eta: 0,
});

state().resetJobs();
useJobStore.setState({
  jobs: [job("success"), job("failed"), job("newer", "running", 2)],
});
const partial = state().clearCompleted();
last().resolve({
  removed: [
    { jobId: "success", attempt: 1 },
    { jobId: "newer", attempt: 1 },
  ],
  errors: [
    {
      jobId: "failed",
      error: "记录暂时不可删除 / Record is temporarily not removable",
    },
  ],
});
await partial;
assert.deepEqual(
  state().jobs.map((value) => value.id),
  ["failed", "newer"],
);
assert.match(state().error ?? "", /失败|could not be cleared/);
assert.equal(wasClearedJobAttempt("success", 1), true);
state().updateFromProgress(event("success", 1));
assert.equal(
  state().jobs.some((value) => value.id === "success"),
  false,
);
assert.equal(state().jobs.find((value) => value.id === "newer")?.attempt, 2);
const retry = state().clearCompleted();
last().resolve({ removed: [{ jobId: "failed", attempt: 1 }], errors: [] });
await retry;
assert.deepEqual(
  state().jobs.map((value) => value.id),
  ["newer"],
);
assert.equal(state().error, null);

// Confirmed removals must survive an unrecognized error subreport too.
state().resetJobs();
useJobStore.setState({ jobs: [job("success"), job("retained")] });
const malformedError = state().clearCompleted();
last().resolve({
  removed: [{ jobId: "success", attempt: 1 }],
  errors: [{ error: 42 }],
});
await malformedError;
assert.deepEqual(
  state().jobs.map((value) => value.id),
  ["retained"],
);
assert.match(state().error ?? "", /无法确认|could not be verified/);

// Late clear responses cannot clear a replacement vault's rows or errors.
const obsolete = state().clearCompleted();
state().resetJobs();
useJobStore.setState({ jobs: [job("replacement")] });
last().resolve({
  removed: [{ jobId: "replacement", attempt: 1 }],
  errors: [{ error: "old failure" }],
});
await obsolete;
assert.deepEqual(
  state().jobs.map((value) => value.id),
  ["replacement"],
);
assert.equal(state().error, null);

state().resetJobs();
console.log(
  "AUDIT_CLEAR_RESULTS_PASS: confirmed successes survive partial failures, failed records retry, newer attempts and vault generations remain protected; no real IPC",
);
