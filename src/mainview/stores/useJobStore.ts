import type {
  JobCompleteEvent,
  JobInfo,
  JobStatus,
  ProgressEvent,
} from "@shared/job.types";
import { create } from "zustand";
import { mergeJobLocation } from "@/components/jobs/job-location";
import { localize, t } from "@/lib/i18n";
import { rpcCall } from "@/lib/rpc-client";

interface RestoreResult {
  restored: number;
  unreadable: number;
}
interface JobState {
  jobs: JobInfo[];
  loading: boolean;
  restoring: boolean;
  pendingJobIds: ReadonlySet<string>;
  error: string | null;
  refreshJobs: () => Promise<boolean>;
  cancelJob: (jobId: string) => Promise<void>;
  pauseJob: (jobId: string) => Promise<void>;
  resumeJob: (jobId: string) => Promise<void>;
  retryJob: (jobId: string) => Promise<void>;
  restoreJobs: () => Promise<RestoreResult>;
  clearCompleted: () => Promise<void>;
  resetJobs: () => void;
  updateFromProgress: (event: ProgressEvent) => void;
  updateFromComplete: (event: JobCompleteEvent) => void;
}

const TERMINAL = new Set<JobStatus>(["completed", "failed", "cancelled"]);
export const isFinishedJob = (status: JobStatus) => TERMINAL.has(status);
export function resumableJobActions(job: JobInfo): {
  pause: boolean;
  resume: boolean;
  retry: boolean;
  cancel: boolean;
} {
  const active = job.status === "running" || job.status === "queued";
  const held = job.status === "paused" || job.status === "interrupted";
  const cancellation = job.cancelRequested === true;
  return {
    pause: !!job.resumable && active && !cancellation,
    resume: !!job.resumable && job.status === "paused" && !cancellation,
    retry:
      !!job.resumable && (cancellation ? held : job.status === "interrupted"),
    cancel: !cancellation && (active || (!!job.resumable && held)),
  };
}
function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : t("任务操作失败，请刷新后重试", "Job action failed. Refresh and retry");
}
function staleAttempt(existing: JobInfo, attempt: number | undefined) {
  return (attempt ?? 0) < (existing.attempt ?? 0);
}
function mergeCancelIntent(
  known: boolean | undefined,
  incoming: boolean | undefined,
) {
  return known === true || incoming === true ? true : (incoming ?? known);
}

// A delayed jobs:list cannot replace newer native events/actions or a cleared
// vault runtime. Status is never optimistically changed to success.
let refreshGeneration = 0;
let stateRevision = 0;
let runtimeGeneration = 0;
const jobRevisions = new Map<string, number>();
const clearedAttempts = new Map<string, number>();
/** Late worker publications must not resurrect a record already cleared by
 * the user. A genuinely newer attempt remains eligible. */
export function wasClearedJobAttempt(
  jobId: string,
  attempt: number | undefined,
): boolean {
  const cleared = clearedAttempts.get(jobId);
  return cleared !== undefined && (attempt ?? 0) <= cleared;
}
function touchJob(id: string) {
  jobRevisions.set(id, ++stateRevision);
}
export const useJobStore = create<JobState>()((set, get) => {
  const action = async (
    method: "jobs:pause" | "jobs:resume" | "jobs:retry" | "jobs:cancel",
    jobId: string,
  ) => {
    if (get().pendingJobIds.has(jobId)) return;
    const generation = runtimeGeneration;
    touchJob(jobId);
    set((state) => ({
      pendingJobIds: new Set([...state.pendingJobIds, jobId]),
      error: null,
    }));
    try {
      await rpcCall(method, { jobId });
      if (generation !== runtimeGeneration) return;
      await get().refreshJobs();
    } catch (error: unknown) {
      if (generation !== runtimeGeneration) return;
      set({ error: message(error) });
      throw error instanceof Error ? error : new Error(message(error));
    } finally {
      if (generation === runtimeGeneration)
        set((state) => ({
          pendingJobIds: new Set(
            [...state.pendingJobIds].filter((id) => id !== jobId),
          ),
        }));
    }
  };
  return {
    jobs: [],
    loading: false,
    restoring: false,
    pendingJobIds: new Set(),
    error: null,
    resetJobs: () => {
      ++refreshGeneration;
      ++stateRevision;
      ++runtimeGeneration;
      jobRevisions.clear();
      clearedAttempts.clear();
      set({
        jobs: [],
        loading: false,
        restoring: false,
        pendingJobIds: new Set(),
        error: null,
      });
    },
    refreshJobs: async () => {
      const request = ++refreshGeneration;
      const revision = stateRevision;
      set({ loading: true });
      try {
        const jobs = await rpcCall("jobs:list", undefined);
        if (request !== refreshGeneration) return false;
        set((state) => {
          const current = new Map(state.jobs.map((job) => [job.id, job]));
          const returned = new Set(jobs.map((job) => job.id));
          const merged: JobInfo[] = [];
          for (const snapshot of jobs) {
            const existing = current.get(snapshot.id);
            if (wasClearedJobAttempt(snapshot.id, snapshot.attempt)) {
              if (
                existing &&
                !wasClearedJobAttempt(existing.id, existing.attempt)
              )
                merged.push(existing);
              continue;
            }
            if ((jobRevisions.get(snapshot.id) ?? 0) > revision) {
              // Missing current state is a clearCompleted tombstone, not an
              // invitation for an older snapshot to resurrect a finished job.
              if (existing) merged.push(existing);
              continue;
            }
            const heldAttempt =
              existing &&
              (existing.status === "paused" ||
                existing.status === "interrupted") &&
              (snapshot.status === "queued" || snapshot.status === "running") &&
              (snapshot.attempt ?? 0) <= (existing.attempt ?? 0);
            if (
              existing &&
              (staleAttempt(existing, snapshot.attempt) ||
                heldAttempt ||
                ((existing.status === "completed" ||
                  existing.status === "cancelled") &&
                  snapshot.status !== existing.status))
            )
              merged.push(existing);
            else
              merged.push({
                ...snapshot,
                source: mergeJobLocation(existing?.source, snapshot.source),
                destination: mergeJobLocation(
                  existing?.destination,
                  snapshot.destination,
                ),
                cancelRequested: mergeCancelIntent(
                  existing?.cancelRequested,
                  snapshot.cancelRequested,
                ),
              });
          }
          const arrived = state.jobs.filter(
            (job) =>
              !returned.has(job.id) &&
              (jobRevisions.get(job.id) ?? 0) > revision,
          );
          return { jobs: [...arrived, ...merged], loading: false, error: null };
        });
        return true;
      } catch (error: unknown) {
        if (request === refreshGeneration)
          set({ loading: false, error: message(error) });
        return false;
      }
    },
    cancelJob: (id) => action("jobs:cancel", id),
    pauseJob: (id) => action("jobs:pause", id),
    resumeJob: (id) => action("jobs:resume", id),
    retryJob: (id) => action("jobs:retry", id),
    restoreJobs: async () => {
      const generation = runtimeGeneration;
      ++stateRevision;
      set({ restoring: true, error: null });
      try {
        const result = await rpcCall("jobs:restore", undefined);
        if (generation !== runtimeGeneration)
          return { restored: 0, unreadable: 0 };
        await get().refreshJobs();
        return result;
      } catch (error: unknown) {
        if (generation === runtimeGeneration) set({ error: message(error) });
        throw error instanceof Error ? error : new Error(message(error));
      } finally {
        if (generation === runtimeGeneration) set({ restoring: false });
      }
    },
    clearCompleted: async () => {
      const generation = runtimeGeneration;
      ++stateRevision;
      set({ error: null });
      try {
        const report:
          | {
              removed?: Array<{ jobId: string; attempt: number }>;
              errors?: Array<{ jobId?: string; error: string }>;
            }
          | undefined = await rpcCall("jobs:clear", undefined);
        if (generation !== runtimeGeneration) return;
        const explicit = report !== undefined;
        const removed = report?.removed;
        if (
          explicit &&
          (!Array.isArray(removed) ||
            removed.some(
              (item) =>
                !item ||
                typeof item.jobId !== "string" ||
                !item.jobId ||
                !Number.isSafeInteger(item.attempt) ||
                item.attempt < 0,
            ) ||
            new Set(removed.map((item) => item.jobId)).size !== removed.length)
        ) {
          throw new Error(
            t(
              "清理结果无法确认，任务记录已保留，请刷新核对",
              "The clear result could not be verified. Task records were retained; refresh and check",
            ),
          );
        }
        const failures = report?.errors;
        const validFailures =
          failures === undefined ||
          (Array.isArray(failures) &&
            failures.length <= 1000 &&
            failures.every(
              (failure) =>
                failure &&
                typeof failure.error === "string" &&
                failure.error.length <= 4000 &&
                (failure.jobId === undefined ||
                  (typeof failure.jobId === "string" &&
                    failure.jobId.length > 0)),
            ));
        const partialWarning = !validFailures
          ? t(
              "部分清理结果无法确认；已确认成功项已清除，其余记录保留，请刷新后重试。",
              "Some cleanup results could not be verified. Confirmed successes were removed; other records remain. Refresh and retry.",
            )
          : failures?.length
            ? t(
                `部分任务清理失败，失败记录已保留，可重试：${failures
                  .slice(0, 5)
                  .map(
                    (failure) =>
                      `${failure.jobId ? `${failure.jobId}: ` : ""}${localize(failure.error)}`,
                  )
                  .join(
                    "；",
                  )}${failures.length > 5 ? `（另 ${failures.length - 5} 项）` : ""}`,
                `Some task records could not be cleared and were retained. Retry: ${failures
                  .slice(0, 5)
                  .map(
                    (failure) =>
                      `${failure.jobId ? `${failure.jobId}: ` : ""}${localize(failure.error)}`,
                  )
                  .join(
                    "; ",
                  )}${failures.length > 5 ? ` (${failures.length - 5} more)` : ""}`,
              )
            : null;
        if (generation === runtimeGeneration)
          set((state) => {
            // New backends identify durable removals even if a last Completed
            // publication has not reached the UI. Undefined is legacy fallback.
            const cleared = explicit
              ? (removed ?? [])
              : state.jobs
                  .filter((job) => isFinishedJob(job.status))
                  .map((job) => ({ jobId: job.id, attempt: job.attempt ?? 0 }));
            for (const item of cleared) {
              touchJob(item.jobId);
              clearedAttempts.set(
                item.jobId,
                Math.max(clearedAttempts.get(item.jobId) ?? 0, item.attempt),
              );
            }
            return {
              jobs: state.jobs.filter(
                (job) => !wasClearedJobAttempt(job.id, job.attempt),
              ),
              error: partialWarning,
            };
          });
      } catch (error: unknown) {
        if (generation !== runtimeGeneration) return;
        set({ error: message(error) });
        throw error instanceof Error ? error : new Error(message(error));
      }
    },
    updateFromProgress: (event) => {
      if (wasClearedJobAttempt(event.jobId, event.attempt)) return;
      set((state) => {
        const jobs = [...state.jobs];
        const index = jobs.findIndex((job) => job.id === event.jobId);
        const existing = jobs[index];
        if (existing && staleAttempt(existing, event.attempt)) return {};
        if (
          existing &&
          (existing.status === "completed" ||
            existing.status === "cancelled") &&
          event.status !== existing.status
        )
          return {};
        const nextAttempt =
          !!existing && (event.attempt ?? 0) > (existing.attempt ?? 0);
        if (
          existing &&
          !nextAttempt &&
          (existing.status === "paused" || existing.status === "interrupted") &&
          (event.status === "running" || event.status === "queued")
        )
          return {};
        touchJob(event.jobId);
        const stopped =
          event.status === "paused" ||
          event.status === "interrupted" ||
          isFinishedJob(event.status);
        const updated: JobInfo = {
          id: event.jobId,
          type: event.type,
          status: event.status,
          fileName: event.fileName,
          description: existing?.description ?? "",
          source: mergeJobLocation(existing?.source, event.source),
          destination: mergeJobLocation(
            existing?.destination,
            event.destination,
          ),
          bytesTransferred: event.bytesTransferred,
          bytesTotal: event.bytesTotal,
          percentage: event.percentage,
          speed: stopped ? 0 : event.speed,
          eta: stopped ? 0 : event.eta,
          error: event.error,
          resumable: event.resumable ?? existing?.resumable,
          attempt: event.attempt ?? existing?.attempt,
          cancelRequested: mergeCancelIntent(
            existing?.cancelRequested,
            event.cancelRequested,
          ),
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          startedAt:
            (nextAttempt ? undefined : existing?.startedAt) ??
            (event.status === "running" ? new Date().toISOString() : undefined),
          completedAt: isFinishedJob(event.status)
            ? existing?.completedAt
            : undefined,
        };
        if (index === -1) jobs.unshift(updated);
        else jobs[index] = updated;
        return { jobs };
      });
    },
    updateFromComplete: (event) => {
      if (wasClearedJobAttempt(event.jobId, event.attempt)) return;
      set((state) => ({
        jobs: state.jobs.map((job) => {
          if (job.id !== event.jobId || staleAttempt(job, event.attempt))
            return job;
          // Legacy success=false cannot distinguish pause, interruption or cancel.
          if (
            !event.status &&
            (job.status === "paused" ||
              job.status === "interrupted" ||
              job.status === "cancelled")
          )
            return job;
          if (job.status === "completed" && !event.status && !event.success)
            return job;
          if (
            (job.status === "completed" || job.status === "cancelled") &&
            event.status &&
            event.status !== job.status
          )
            return job;
          const status =
            event.status ?? (event.success ? "completed" : "failed");
          if (status === "completed" && !event.success) return job;
          touchJob(job.id);
          return {
            ...job,
            source: mergeJobLocation(job.source, event.source),
            destination: mergeJobLocation(job.destination, event.destination),
            status,
            attempt: event.attempt ?? job.attempt,
            percentage: status === "completed" ? 100 : job.percentage,
            speed: 0,
            eta: 0,
            error: event.error,
            completedAt: isFinishedJob(status)
              ? new Date().toISOString()
              : undefined,
          };
        }),
      }));
    },
  };
});
