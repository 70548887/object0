export interface QiniuCapability {
  state: "supported" | "unknown" | "forbidden" | "unsupported" | "unavailable";
  reason?: string;
}

export interface QiniuRegionOption {
  id: string;
  label: string;
}

export interface QiniuStorageClassOption {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
}

export type QiniuRestoreState =
  | "normal"
  | "frozen"
  | "restoring"
  | "restored"
  | "expired"
  | "unknown"
  | "mixed";

export function isQiniuCapabilityAllowed(capability: QiniuCapability): boolean {
  return capability.state === "supported";
}
