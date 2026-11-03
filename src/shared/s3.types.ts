// ── S3 Object ──
export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
  etag: string;
  storageClass?: string;
  restoreStatus?: number;
}

// ── Object listing sort ──
export type SortField = "key" | "size" | "lastModified";
export type SortDirection = "asc" | "desc";

// ── Common prefix (folder) ──
export interface S3Prefix {
  prefix: string;
}

// ── Bucket info ──
export interface BucketInfo {
  name: string;
  creationDate?: string;
  regionId?: string;
  s3Name?: string;
  permission?: "readonly" | "readwrite";
  remark?: string;
}

export interface QiniuClassUsage {
  storageClass: string;
  bytes: number | null;
  objectCount: number | null;
  measuredAt: string | null;
  state: "available" | "partial" | "forbidden" | "unsupported" | "unavailable";
  reason?: string;
}

export interface QiniuUsageAnalytics {
  complete: boolean;
  measuredAt: string | null;
  classes: QiniuClassUsage[];
  warning?: string;
}

// Only an incomplete object scan is a lower bound. Missing official metrics
// stay null; they must not be displayed or cached as a zero-valued total.
export interface BucketUsage {
  profileId: string;
  bucket: string;
  bytes: number | null;
  objectCount: number | null;
  metadataBytes?: number;
  source: "r2" | "scan" | "qiniu";
  measuredAt: string | null;
  fetchedAt: string;
  complete: boolean;
  scannedPages?: number;
  warning?: string;
  qiniuAnalytics?: QiniuUsageAnalytics;
}

// ── Object list request ──
export interface ObjectListReq {
  profileId: string;
  bucket: string;
  prefix?: string;
  maxKeys?: number;
  // Opaque provider cursor; never derive it from a displayed object key.
  cursor?: string;
  sortField?: "key" | "size" | "lastModified";
  sortDir?: "asc" | "desc";
}

// ── Object list response ──
export interface ObjectListRes {
  objects: S3Object[];
  prefixes: S3Prefix[];
  isTruncated: boolean;
  nextCursor?: string;
  totalCount?: number;
}

// ── S3 stat result ──
export interface S3StatResult {
  size: number;
  etag: string;
  lastModified: string;
  type: string;
  metadata?: Record<string, string>;
  storageType?: number;
  restoreStatus?: number;
}

// Controlled UTF-8 text editing. ETags remain opaque, quoted identities.
export interface ObjectTextReadReq {
  profileId: string;
  expectedProfileRevision: string;
  bucket: string;
  key: string;
}

export interface ObjectTextReadRes {
  content: string;
  etag: string;
  contentType: string;
  byteLength: number;
}

export interface ObjectTextWriteReq extends ObjectTextReadReq {
  content: string;
  expectedEtag?: string;
  createOnly: boolean;
}

export interface ObjectTextWriteRes {
  etag: string | null;
  byteLength: number;
}

// ── Upload request ──
export interface UploadReq {
  profileId: string;
  expectedProfileRevision?: string;
  bucket: string;
  key: string;
  localPath: string;
}

// ── Download request ──
export interface DownloadReq {
  profileId: string;
  bucket: string;
  key: string;
  localPath: string;
  downloadDomain?: string;
  expectedProfileRevision?: string;
}

// ── Download folder request ──
export interface DownloadFolderReq {
  profileId: string;
  bucket: string;
  prefix: string;
}

// ── Download as archive request ──
export interface DownloadArchiveReq {
  profileId: string;
  bucket: string;
  keys: string[];
  prefix?: string;
  archiveName?: string;
}

// ── Copy request ──
export interface CopyReq {
  sourceProfileId: string;
  sourceBucket: string;
  sourceKey: string;
  destProfileId: string;
  destBucket: string;
  destKey: string;
  verificationReadbackConfirmed?: boolean;
}

// ── Move request ──
export interface MoveReq extends CopyReq {
  verificationReadbackConfirmed?: boolean;
}

// ── Cross-bucket transfer request (batch: files + folders) ──
export type TransferMode = "copy" | "move";

export interface CrossTransferReq {
  sourceProfileId: string;
  sourceBucket: string;
  keys: string[]; // object keys and/or folder prefixes (ending in /)
  sourcePrefix: string; // current prefix context for building relative paths
  destProfileId: string;
  destBucket: string;
  destPrefix: string;
  mode: TransferMode;
  verificationReadbackConfirmed?: boolean;
}

// ── Sync request ──
export interface SyncReq {
  sourceProfileId: string;
  sourceBucket: string;
  sourcePrefix: string;
  destProfileId: string;
  destBucket: string;
  destPrefix: string;
  mode: SyncMode;
}

export type SyncMode = "mirror" | "additive" | "overwrite";

// ── Sync diff ──
export interface SyncDiff {
  previewToken: string;
  toAdd: SyncDiffEntry[];
  toUpdate: SyncDiffEntry[];
  toDelete: SyncDiffEntry[];
  unchanged: number;
}

export interface SyncDiffEntry {
  key: string;
  sourceSize?: number;
  destSize?: number;
  sourceEtag?: string;
  destEtag?: string;
  sourceLastModified?: string;
  destLastModified?: string;
  selected: boolean;
}

// ── Filters ──
export type FileTypeFilter =
  | "all"
  | "folders"
  | "images"
  | "documents"
  | "archives"
  | "other";

export type SizeFilter = "any" | "lt1mb" | "1to10mb" | "10to100mb" | "gt100mb";

export interface DateFilter {
  type: "any" | "today" | "week" | "month" | "custom";
  from?: string;
  to?: string;
}

export interface ObjectFilters {
  fileType: FileTypeFilter;
  size: SizeFilter;
  date: DateFilter;
  search: string;
}

// ── Share request ──
export interface ShareReq {
  profileId: string;
  bucket: string;
  key: string;
  expiresIn: number; // seconds
  downloadDomain?: string;
  expectedProfileRevision?: string;
}

// ── Share response ──
export interface ShareRes {
  url: string;
  expiresAt: string | null; // Public URLs have no client-enforced expiry.
  accessMode?: "public" | "signed";
  key: string;
}

// ── Share history entry ──
export interface ShareHistoryEntry {
  id: string;
  profileId: string;
  bucket: string;
  key: string;
  url: string;
  expiresAt: string | null;
  accessMode?: "public" | "signed";
  createdAt: string;
}
