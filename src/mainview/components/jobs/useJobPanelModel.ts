import type { JobInfo } from "@shared/job.types";
import { useMemo } from "react";

const VIRTUALIZE_AFTER_COUNT = 80;
export type JobGroup = "active" | "waiting" | "completed";
export type VirtualJobRow =
  | { kind: "section"; id: string; label: JobGroup; queuedCount?: number }
  | { kind: "job"; id: string; group: JobGroup; job: JobInfo };

export function buildJobPanelModel(jobs: JobInfo[]) {
  const runningJobs = jobs.filter((job) => job.status === "running");
  const queuedJobs = jobs.filter((job) => job.status === "queued");
  const activeJobs = jobs.filter(
    (job) => job.status === "running" || job.status === "queued",
  );
  const waitingJobs = jobs.filter(
    (job) => job.status === "paused" || job.status === "interrupted",
  );
  const completedJobs = jobs.filter(
    (job) =>
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled",
  );
  const totalBytes = runningJobs.reduce(
    (sum, job) => sum + (job.bytesTotal || 0),
    0,
  );
  const transferredBytes = runningJobs.reduce(
    (sum, job) => sum + (job.bytesTransferred || 0),
    0,
  );
  const bulkSpeed = runningJobs.reduce((sum, job) => sum + (job.speed || 0), 0);
  const groups: Array<[JobGroup, JobInfo[]]> = [
    ["active", activeJobs],
    ["waiting", waitingJobs],
    ["completed", completedJobs],
  ];
  const count = groups.filter(([, items]) => items.length > 0).length;
  const virtualRows: VirtualJobRow[] = [];
  for (const [group, items] of groups) {
    if (!items.length) continue;
    if (count > 1)
      virtualRows.push({
        kind: "section",
        id: `section-${group}`,
        label: group,
        queuedCount: group === "active" ? queuedJobs.length : undefined,
      });
    for (const job of items)
      virtualRows.push({ kind: "job", id: `${group}-${job.id}`, group, job });
  }
  return {
    activeJobs,
    waitingJobs,
    runningJobs,
    queuedJobs,
    completedJobs,
    totalBytes,
    transferredBytes,
    bulkSpeed,
    bulkPercent:
      totalBytes > 0 ? Math.round((transferredBytes / totalBytes) * 100) : 0,
    succeededCount: jobs.filter((job) => job.status === "completed").length,
    failedCount: jobs.filter((job) => job.status === "failed").length,
    virtualRows,
    shouldVirtualize: virtualRows.length >= VIRTUALIZE_AFTER_COUNT,
  };
}
export function useJobPanelModel(jobs: JobInfo[]) {
  return useMemo(() => buildJobPanelModel(jobs), [jobs]);
}
