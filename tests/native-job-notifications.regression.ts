// Isolated hook/event lifecycle harness. Notification and RPC are local doubles.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import type { JobCompleteEvent, JobInfo } from "../src/shared/job.types";

const listeners = new Map<string, (event: never) => void>();
const cleanups: Array<() => void> = [];
const notifications: Array<{ title: string; body?: string }> = [];
const refreshes: Array<unknown> = [];
let unlocked = true;
mock.module("../src/mainview/lib/rpc-client", () => ({
  rpcCall: async (method: string) =>
    method === "jobs:clear" ? { removed: [{ jobId: "job", attempt: 5 }] } : [],
  onEvent: (name: string, callback: (event: never) => void) => {
    listeners.set(name, callback);
    return () => listeners.delete(name);
  },
}));
const { useJobStore } = await import("../src/mainview/stores/useJobStore");
const jobFacade = Object.assign(
  (selector: (state: ReturnType<typeof useJobStore.getState>) => unknown) =>
    selector(useJobStore.getState()),
  { getState: useJobStore.getState },
);
const actualReact = await import("react");
mock.module("react", () => ({
  ...actualReact,
  useEffect: (setup: () => unknown) => {
    const cleanup = setup();
    if (typeof cleanup === "function") cleanups.push(cleanup as () => void);
  },
}));
mock.module("../src/mainview/lib/i18n", () => ({
  useT: () => (zh: string) => zh,
  localize: (value: string) => value,
}));
mock.module("../src/mainview/stores", () => ({
  useJobStore: jobFacade,
  useBucketStore: { getState: () => ({ selectedBucket: "bucket-a" }) },
  useProfileStore: { getState: () => ({ activeProfileId: "profile-a" }) },
  useObjectStore: {
    getState: () => ({
      currentPrefix: "folder/",
      loadObjects: (...values: unknown[]) => refreshes.push(values),
    }),
  },
  useUIStore: { getState: () => ({ desktopNotifications: true }) },
  useVaultStore: { getState: () => ({ unlocked }) },
}));
Object.defineProperty(globalThis, "Notification", {
  configurable: true,
  value: class {
    static permission = "granted";
    constructor(title: string, options: { body?: string }) {
      notifications.push({ title, body: options.body });
    }
  },
});
const { useJobProgress } = await import("../src/mainview/hooks/useJobProgress");
// biome-ignore lint/correctness/useHookAtTopLevel: isolated hook harness substitutes useEffect and every store hook above.
useJobProgress();
const fixture = (attempt?: number): JobInfo => ({
  id: "job",
  type: "upload",
  status: "running",
  resumable: true,
  attempt,
  fileName: "file.bin",
  description: "fixture",
  bytesTransferred: 5,
  bytesTotal: 10,
  percentage: 50,
  speed: 1,
  eta: 1,
  createdAt: "fixture",
});
const emit = (event: JobCompleteEvent) =>
  listeners.get("job:complete")?.(event as never);

useJobStore.setState({ jobs: [fixture(1)] });
emit({ jobId: "job", status: "paused", success: false, attempt: 1 });
assert.equal(useJobStore.getState().jobs[0].status, "paused");
emit({ jobId: "job", status: "interrupted", success: false, attempt: 1 });
emit({ jobId: "job", status: "cancelled", success: false, attempt: 1 });
assert.equal(notifications.length, 0);
assert.equal(refreshes.length, 0);
useJobStore.setState({ jobs: [fixture(2)] });
emit({
  jobId: "job",
  status: "completed",
  success: true,
  attempt: 1,
  profileId: "profile-a",
  bucket: "bucket-a",
});
assert.equal(useJobStore.getState().jobs[0].status, "running");
assert.equal(notifications.length, 0);
emit({
  jobId: "job",
  status: "completed",
  success: true,
  attempt: 2,
  profileId: "other-profile",
  bucket: "bucket-a",
});
assert.equal(notifications.length, 1);
assert.equal(refreshes.length, 0);
useJobStore.setState({ jobs: [fixture(3)] });
emit({
  jobId: "job",
  status: "completed",
  success: true,
  attempt: 3,
  profileId: "profile-a",
  bucket: "bucket-a",
});
assert.equal(notifications.length, 2);
assert.deepEqual(refreshes, [["profile-a", "bucket-a", "folder/"]]);
useJobStore.setState({ jobs: [{ ...fixture(), status: "cancelled" }] });
emit({ jobId: "job", success: false });
assert.equal(useJobStore.getState().jobs[0].status, "cancelled");
assert.equal(notifications.length, 2);
useJobStore.setState({ jobs: [{ ...fixture(), status: "completed" }] });
emit({ jobId: "job", success: false });
assert.equal(useJobStore.getState().jobs[0].status, "completed");
assert.equal(notifications.length, 2);
useJobStore.setState({ jobs: [{ ...fixture(5), status: "completed" }] });
await useJobStore.getState().clearCompleted();
assert.equal(useJobStore.getState().jobs.length, 0);
emit({
  jobId: "job",
  status: "completed",
  success: true,
  attempt: 5,
  profileId: "profile-a",
  bucket: "bucket-a",
});
listeners.get("job:progress")?.({
  jobId: "job",
  type: "upload",
  status: "completed",
  attempt: 5,
} as never);
assert.equal(useJobStore.getState().jobs.length, 0);
assert.equal(notifications.length, 2);
assert.equal(refreshes.length, 1);
unlocked = false;
useJobStore.getState().resetJobs();
emit({ jobId: "job", status: "completed", success: true, attempt: 9 });
listeners.get("job:progress")?.({
  jobId: "job",
  type: "upload",
  status: "running",
  attempt: 9,
} as never);
assert.equal(useJobStore.getState().jobs.length, 0);
assert.equal(notifications.length, 2);
assert.equal(refreshes.length, 1);
for (const cleanup of cleanups) cleanup();
assert.equal(listeners.size, 0);
console.log(
  "PASS: held/cancelled/stale-attempt events do not produce failed/completed notifications, confirmed completion refreshes only matching scopes, and hook cleanup removes listeners",
);
