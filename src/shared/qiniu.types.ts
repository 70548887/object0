export type QiniuCapabilityState =
  | "supported"
  | "forbidden"
  | "unsupported"
  | "unknown"
  | "unavailable";
export interface QiniuCapabilityInfo {
  state: QiniuCapabilityState;
  reason?: string;
}
export interface QiniuStorageClass {
  fileType: number;
  kodoName: string;
  s3Name?: string;
}
export interface QiniuRegionInfo {
  kodoRegionId?: string;
  s3RegionId: string;
  label?: string;
  s3Urls: string[];
  rsUrls: string[];
  storageClasses: QiniuStorageClass[];
  expiresAt: number;
}
export interface QiniuBucketContext {
  bucket: {
    name: string;
    s3Name?: string;
    kodoRegionId?: string;
    permission?: "readonly" | "readwrite";
    remark?: string;
  };
  region: QiniuRegionInfo;
  s3BucketName?: string;
  backendMode: "kodo" | "s3";
}
export interface QiniuBucketDetails {
  isPrivate: boolean;
  protected: boolean;
  permission?: "readonly" | "readwrite";
  regionId?: string;
}
export interface QiniuDomain {
  name: string;
  protocol: "http" | "https";
  kind: string;
  apiScope: string;
  isPrivate?: boolean;
  protected?: boolean;
  configured: boolean;
}
export interface QiniuDomainReport {
  domains: QiniuDomain[];
  origins: QiniuCapabilityInfo;
  cdn: QiniuCapabilityInfo;
  bucketInfo: QiniuCapabilityInfo;
}
export interface QiniuMutationResult {
  key: string;
  success: boolean;
  error?: string;
}
export interface QiniuDownloadOptions {
  domains: Array<{
    url: string;
    kind: string;
    available: boolean;
    accessMode?: "public" | "signed";
    reason?: string;
  }>;
  selectedDomain?: string;
  maxShareSeconds: number;
  policyNote: string;
}

/** The only directory-share session fields permitted across IPC. */
export interface QiniuShareSessionInfo {
  sessionId: string;
  bucketName: string;
  prefix: string;
  expiresAt: string;
  readOnly: true;
}

/** Native login binds a selected private environment to its saved revision. */
export interface QiniuShareLoginInput {
  url: string;
  extractionCode: string;
  privateEnvironmentId?: string;
  expectedPrivateEnvironmentRevision?: string;
}

/** Local configuration metadata, never federation credentials. */
export interface QiniuSharePrivateEnvironment {
  id: string;
  label: string;
  revision?: string;
  configFingerprint?: string;
  portalOrigin?: string;
  apiOrigin?: string;
  insecure?: boolean;
  disabled?: boolean;
  reason?: string;
}

/** Memory-only origin of an adopted session; not part of the IPC session DTO. */
export interface QiniuShareSessionSource {
  profileSetFingerprint: string;
  privateEnvironmentId?: string;
  privateEnvironmentRevision?: string;
  privateEnvironmentFingerprint?: string;
}

export interface QiniuDirectoryShareResult {
  url: string;
  extractionCode: string;
  bucketName: string;
  prefix: string;
  expiresAt: string;
  readOnly: true;
}

export interface QiniuShareListResult {
  objects: Array<{
    key: string;
    size: number;
    lastModified?: string;
    etag?: string;
    storageClass?: string;
  }>;
  prefixes: string[];
  isTruncated: boolean;
  nextCursor?: string;
}
