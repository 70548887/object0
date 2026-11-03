export type UpdateChannel = "stable" | "preview";
export type UpdatePackageKind = "installer" | "portable" | "unknown";
export interface LastUpdateResult {
  version: string;
  status:
    | "launching"
    | "installed-awaiting-ui-confirmation"
    | "failed"
    | "completed";
  message: string;
}
export interface UpdateInfo {
  currentVersion: string;
  buildHash: string;
  development: boolean;
  packageKind: UpdatePackageKind;
  platform: string;
  repository: string;
  releaseUrl: string;
  signingConfigured: boolean;
  blockedReason: string | null;
  lastUpdateResult?: LastUpdateResult | null;
}
export interface UpdateRelease {
  id: string;
  version: string;
  channel: UpdateChannel;
  publishedAt: string;
  notes: string;
  releaseUrl: string;
  packageKind: UpdatePackageKind;
  assetName: string | null;
  size: number | null;
  canDownload: boolean;
  blockedReason: string | null;
}
export interface UpdateCheckResult {
  info: UpdateInfo;
  channel: UpdateChannel;
  checkedAt: string;
  release: UpdateRelease | null;
  message: string;
}
export type UpdateStage =
  | "idle"
  | "downloading"
  | "verifying"
  | "ready"
  | "cancelled"
  | "failed"
  | "installing";
export interface UpdateSnapshot {
  releaseId: string | null;
  attempt: number;
  stage: UpdateStage;
  downloaded: number;
  total: number | null;
  error: string | null;
}
