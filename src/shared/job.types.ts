import type { Provider } from "./profile.types";

/** Safe queue-time location snapshot. Never contains credentials/endpoints. */
export interface JobLocation {
  profileId: string;
  profileName?: string;
  provider?: Provider;
  bucket: string;
  key?: string;
  prefix?: string;
}

// ── Job types ──
export type JobType =
  | "upload"
  | "download"
  | "copy"
  | "move"
  | "sync"
  | "delete"
  | "archive"
  | "folder-sync";

export type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

// ── Job info ──
export interface JobInfo {
  source?: JobLocation;
  destination?: JobLocation;
  id: string;
  type: JobType;
  status: JobStatus;
  fileName: string;
  description: string;
  bytesTransferred: number;
  bytesTotal: number;
  percentage: number;
  speed: number;
  eta: number;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** True only for a task durably persisted by the native backend. */
  resumable?: boolean;
  attempt?: number;
  /** Durable intent: subsequent resume/retry performs cancellation cleanup only. */
  cancelRequested?: boolean;
}

// ── Progress event (pushed from Bun → UI) ──
export interface ProgressEvent {
  source?: JobLocation;
  destination?: JobLocation;
  jobId: string;
  type: JobType;
  status: JobStatus;
  fileName: string;
  bytesTransferred: number;
  bytesTotal: number;
  percentage: number;
  speed: number;
  eta: number;
  error?: string;
  resumable?: boolean;
  attempt?: number;
  cancelRequested?: boolean;
}

// ── Job complete event ──
export interface JobCompleteEvent {
  source?: JobLocation;
  destination?: JobLocation;
  jobId: string;
  fileName?: string;
  success: boolean;
  error?: string;
  status?: JobStatus;
  attempt?: number;
  profileId?: string;
  bucket?: string;
}
