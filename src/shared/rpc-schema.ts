import type {
  FolderSyncConflictEvent,
  FolderSyncDiff,
  FolderSyncErrorEvent,
  FolderSyncRule,
  FolderSyncRuleInput,
  FolderSyncState,
  FolderSyncStatusEvent,
} from "./folder-sync.types";
import type { JobCompleteEvent, JobInfo, ProgressEvent } from "./job.types";
import type {
  ProfileInfo,
  ProfileInput,
  QiniuProfileConfig,
} from "./profile.types";
import type {
  QiniuBucketContext,
  QiniuBucketDetails,
  QiniuDirectoryShareResult,
  QiniuDomainReport,
  QiniuDownloadOptions,
  QiniuMutationResult,
  QiniuRegionInfo,
  QiniuShareListResult,
  QiniuShareSessionInfo,
} from "./qiniu.types";
import type {
  BucketInfo,
  BucketUsage,
  CopyReq,
  CrossTransferReq,
  DownloadArchiveReq,
  DownloadFolderReq,
  DownloadReq,
  MoveReq,
  ObjectListReq,
  ObjectListRes,
  ObjectTextReadReq,
  ObjectTextReadRes,
  ObjectTextWriteReq,
  ObjectTextWriteRes,
  S3StatResult,
  ShareReq,
  ShareRes,
  SyncDiff,
  SyncReq,
  UploadReq,
} from "./s3.types";

type ProfileUpdateReq = Omit<
  ProfileInput,
  "accessKeyId" | "secretAccessKey" | "sessionToken"
> & {
  id: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string | null;
};

export type KeychainUnlockFailureReason =
  | "vault_missing"
  | "no_stored_passphrase"
  | "stale_stored_passphrase"
  | "keychain_unavailable";

export type VaultStorageMode = "encrypted" | "plaintext";
export interface LocalAccountsOpenResult {
  ready: boolean;
  legacyImportRequired: boolean;
  legacyAvailable: boolean;
  storageMode: "plaintext";
  configPath: string;
  profiles: ProfileInfo[];
  version: 5;
  hasRecoveryKey: false;
}

// ── RPC Schema: maps method names → request/response types ──
export interface RPCSchema {
  "system:set-language": { req: { locale: "zh-CN" | "en" }; res: undefined };
  // ── Vault ──
  "vault:open-local": {
    req: { skipLegacyImport?: boolean };
    res: LocalAccountsOpenResult;
  };
  "vault:import-legacy": {
    req: { passphrase: string };
    res: LocalAccountsOpenResult;
  };
  "vault:status": {
    req: undefined;
    res: {
      exists: boolean;
      unlocked: boolean;
      hasRecoveryKey: boolean;
      version?: number | null;
      storageMode?: VaultStorageMode;
      configPath?: string;
    };
  };
  "vault:setup": {
    req: { passphrase: string; remember?: boolean };
    res: { success: boolean; recoveryKey?: string };
  };
  "vault:enable-plaintext": {
    req: { confirmPlaintext: true };
    res: {
      success: true;
      profiles: ProfileInfo[];
      storageMode: "plaintext";
      configPath: string;
    };
  };
  "vault:unlock": {
    req: { passphrase: string; remember?: boolean };
    res: { success: boolean; profiles: ProfileInfo[]; hasRecoveryKey: boolean };
  };
  "vault:auto-unlock": {
    req: undefined;
    res: {
      success: boolean;
      profiles: ProfileInfo[];
      hasRecoveryKey: boolean;
      reason?: KeychainUnlockFailureReason;
      detail?: string;
      storageMode?: VaultStorageMode;
      configPath?: string;
    };
  };
  "vault:unlock-keychain": {
    req: undefined;
    res: {
      success: boolean;
      profiles: ProfileInfo[];
      hasRecoveryKey: boolean;
      reason?: KeychainUnlockFailureReason;
      detail?: string;
      storageMode?: VaultStorageMode;
      configPath?: string;
    };
  };
  "vault:lock": { req: undefined; res: undefined };
  "vault:keychain-status": {
    req: undefined;
    res: {
      hasStoredPassphrase: boolean;
      available?: boolean;
      error?: string;
    };
  };
  "vault:keychain-clear": {
    req: undefined;
    res: { success: boolean; hadStoredPassphrase: boolean };
  };
  "vault:recover-key": {
    req: { recoveryKey: string };
    res: { success: boolean; profiles: ProfileInfo[] };
  };
  "vault:change-passphrase": {
    req: { newPassphrase: string; remember?: boolean };
    res: { success: boolean; recoveryKey: string };
  };
  "vault:rotate-recovery-key": {
    req: { passphrase: string; confirmInvalidateOldKey: true };
    res: { recoveryKey: string; backupPath: string };
  };
  "vault:add-recovery-key": {
    req: undefined;
    res: { recoveryKey: string };
  };
  "vault:has-recovery-key": {
    req: undefined;
    res: { hasRecoveryKey: boolean };
  };
  "vault:reset": {
    req: undefined;
    res: { success: boolean };
  };

  // ── Profiles ──
  "profile:list": { req: undefined; res: ProfileInfo[] };
  "profile:connect-qiniu": {
    req: {
      requestId: string;
      accessKeyId: string;
      secretAccessKey: string;
      name?: string;
    };
    res: {
      profile: ProfileInfo;
      buckets: BucketInfo[];
      accountConnected: true;
      bucketReadsVerified: false;
      downloadVerified: false;
    };
  };
  "profile:connect-qiniu-cancel": {
    req: { requestId: string };
    res: undefined;
  };
  "qiniu:download-options": {
    req: { profileId: string; bucket: string };
    res: QiniuDownloadOptions;
  };
  "profile:credential": {
    req: {
      profileId: string;
      field: "accessKeyId" | "secretAccessKey";
    };
    res: { value: string };
  };
  "profile:add": { req: ProfileInput; res: ProfileInfo };
  "profile:update": {
    req: ProfileUpdateReq;
    res: ProfileInfo;
  };
  "profile:remove": { req: { id: string }; res: undefined };
  "profile:test": {
    req: {
      profileId?: string;
      expectedProfileRevision?: string;
      clearSessionToken?: boolean;
      provider: string;
      endpoint?: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
      defaultBucket?: string;
      qiniu?: QiniuProfileConfig;
    };
    res: {
      success: boolean;
      bucketCount: number;
      buckets?: Array<{
        name: string;
        regionId?: string;
        s3Name?: string;
        permission?: "readonly" | "readwrite";
      }>;
      error?: string;
      checks?: Array<{
        name:
          | "authentication"
          | "bucketAccess"
          | "regionDiscovery"
          | "downloadDomain";
        status: "ok" | "warning" | "error" | "unsupported";
        message?: string;
      }>;
    };
  };
  "profile:test-saved": {
    req: { profileId: string };
    res: {
      success: boolean;
      bucketCount: number;
      buckets?: Array<{
        name: string;
        regionId?: string;
        s3Name?: string;
        permission?: "readonly" | "readwrite";
      }>;
      error?: string;
      checks?: Array<{
        name:
          | "authentication"
          | "bucketAccess"
          | "regionDiscovery"
          | "downloadDomain";
        status: "ok" | "warning" | "error" | "unsupported";
        message?: string;
      }>;
    };
  };

  // ── Buckets ──
  "buckets:list": { req: { profileId: string }; res: BucketInfo[] };
  "buckets:usage": {
    req: {
      profileId: string;
      bucket: string;
      requestId: string;
      force?: boolean;
    };
    res: BucketUsage;
  };
  "buckets:usage-cancel": { req: { requestId: string }; res: undefined };
  "qiniu:regions": { req: { profileId: string }; res: QiniuRegionInfo[] };
  "qiniu:share-create": {
    req: {
      profileId: string;
      expectedProfileRevision: string;
      bucketName: string;
      prefix: string;
      durationSeconds: number;
      readOnly: true;
    };
    res: QiniuDirectoryShareResult;
  };
  "qiniu:share-login": {
    req: {
      url: string;
      extractionCode: string;
      privateEnvironmentId?: string;
      expectedPrivateEnvironmentRevision?: string;
    };
    res: QiniuShareSessionInfo;
  };
  "qiniu:share-list": {
    req: { sessionId: string; prefix: string; cursor?: string };
    res: QiniuShareListResult;
  };
  "qiniu:share-download": {
    req: { sessionId: string; key: string };
    res: { cancelled: boolean; bytes?: number };
  };
  "qiniu:share-close": { req: { sessionId: string }; res: undefined };
  "qiniu:bucket-context": {
    req: { profileId: string; bucket: string };
    res: QiniuBucketContext;
  };
  "qiniu:bucket-details": {
    req: { profileId: string; bucket: string };
    res: QiniuBucketDetails;
  };
  "qiniu:bucket-domains": {
    req: { profileId: string; bucket: string };
    res: QiniuDomainReport;
  };
  "qiniu:bucket-create": {
    req: {
      profileId: string;
      name: string;
      regionId: string;
      access: "private";
    };
    res: { name: string; privateVerified: boolean };
  };
  "qiniu:bucket-delete": {
    req: { profileId: string; bucket: string; confirmName: string };
    res: undefined;
  };
  "qiniu:bucket-remark": {
    req: { profileId: string; bucket: string; remark: string };
    res: undefined;
  };
  "qiniu:object-change-type": {
    req: {
      profileId: string;
      expectedProfileRevision: string;
      bucket: string;
      keys: string[];
      value: number;
      costConfirmed: boolean;
    };
    res: { results: QiniuMutationResult[] };
  };
  "qiniu:object-restore": {
    req: {
      profileId: string;
      expectedProfileRevision: string;
      bucket: string;
      keys: string[];
      value: number;
      costConfirmed: boolean;
    };
    res: { results: QiniuMutationResult[] };
  };

  // ── Objects ──
  "objects:list": { req: ObjectListReq; res: ObjectListRes };
  "objects:read-text": { req: ObjectTextReadReq; res: ObjectTextReadRes };
  "objects:write-text": { req: ObjectTextWriteReq; res: ObjectTextWriteRes };
  "objects:delete": {
    req: {
      profileId: string;
      bucket: string;
      keys: string[];
      expectedProfileRevision?: string;
    };
    res: { results: Array<{ key: string; success: boolean; error?: string }> };
  };
  "objects:rename": {
    req: {
      profileId: string;
      bucket: string;
      oldKey: string;
      newKey: string;
      verificationReadbackConfirmed?: boolean;
    };
    res: undefined;
  };
  "objects:stat": {
    req: { profileId: string; bucket: string; key: string };
    res: S3StatResult;
  };

  // ── Transfers ──
  "transfer:upload": { req: UploadReq; res: { jobId: string } };
  "transfer:pick-and-upload": {
    req: {
      profileId: string;
      expectedProfileRevision?: string;
      bucket: string;
      prefix: string;
    };
    res: { jobIds: string[] };
  };
  "transfer:pick-and-upload-folder": {
    req: {
      profileId: string;
      expectedProfileRevision?: string;
      bucket: string;
      prefix: string;
    };
    res: { jobIds: string[] };
  };
  "transfer:download": { req: DownloadReq; res: { jobId: string } };
  "transfer:download-folder": {
    req: DownloadFolderReq;
    res: { jobIds: string[] };
  };
  "transfer:copy": { req: CopyReq; res: { jobId: string } };
  "transfer:move": { req: MoveReq; res: { jobId: string } };
  "transfer:cross-bucket": {
    req: CrossTransferReq;
    res: { jobIds: string[] };
  };
  "transfer:download-archive": {
    req: DownloadArchiveReq;
    res: { jobId: string };
  };

  // ── Sync ──
  "sync:preview": { req: SyncReq; res: SyncDiff };
  "sync:execute": {
    req: SyncReq & { previewToken: string };
    res: { jobId: string };
  };

  // ── Jobs ──
  "jobs:list": { req: undefined; res: JobInfo[] };
  "jobs:cancel": { req: { jobId: string }; res: undefined };
  "jobs:pause": { req: { jobId: string }; res: undefined };
  "jobs:resume": { req: { jobId: string }; res: undefined };
  "jobs:retry": { req: { jobId: string }; res: undefined };
  "jobs:restore": {
    req: undefined;
    res: { restored: number; unreadable: number };
  };
  "jobs:clear": {
    req: undefined;
    res: {
      removed: Array<{ jobId: string; attempt: number }>;
      errors: Array<{ jobId?: string; error: string }>;
    };
  };
  "jobs:get-concurrency": { req: undefined; res: { concurrency: number } };
  "jobs:set-concurrency": {
    req: { concurrency: number };
    res: { concurrency: number };
  };

  // ── Favorites ──
  "favorites:load": { req: undefined; res: string[] };
  "favorites:save": { req: { favorites: string[] }; res: undefined };

  // ── Share ──
  "share:generate": { req: ShareReq; res: ShareRes };

  // ── Folder Sync ──
  "folder-sync:list-rules": { req: undefined; res: FolderSyncRule[] };
  "folder-sync:add-rule": { req: FolderSyncRuleInput; res: FolderSyncRule };
  "folder-sync:update-rule": {
    req: FolderSyncRuleInput & { id: string };
    res: FolderSyncRule;
  };
  "folder-sync:remove-rule": { req: { id: string }; res: undefined };
  "folder-sync:toggle-rule": {
    req: { id: string; enabled: boolean };
    res: FolderSyncRule;
  };
  "folder-sync:sync-now": { req: { id: string }; res: undefined };
  "folder-sync:get-status": {
    req: undefined;
    res: FolderSyncState[];
  };
  "folder-sync:preview": {
    req: { id: string };
    res: FolderSyncDiff;
  };
  "folder-sync:pick-folder": { req: undefined; res: { path: string | null } };
  "folder-sync:start-all": { req: undefined; res: undefined };
  "folder-sync:stop-all": { req: undefined; res: undefined };
  "folder-sync:pause-all": { req: undefined; res: undefined };
  "folder-sync:resume-all": { req: undefined; res: undefined };

  // ── Updater ──
  "updates:info": { req: undefined; res: import("./updater.types").UpdateInfo };
  "updates:check": {
    req: { channel: import("./updater.types").UpdateChannel };
    res: import("./updater.types").UpdateCheckResult;
  };
  "updates:download": {
    req: { releaseId: string };
    res: import("./updater.types").UpdateSnapshot;
  };
  "updates:cancel": {
    req: { releaseId: string };
    res: import("./updater.types").UpdateSnapshot;
  };
  "updates:apply": {
    req: { releaseId: string; exitConfirmed: true; draftsSaved: true };
    res: { accepted: boolean };
  };
  "updater:check": {
    req: undefined;
    res: {
      version: string;
      hash: string;
      updateAvailable: boolean;
      updateReady: boolean;
      error: string;
    };
  };
  "updater:download": { req: undefined; res: { success: boolean } };
  "updater:apply": { req: undefined; res: undefined };
  "updater:local-info": {
    req: undefined;
    res: {
      version: string;
      hash: string;
      baseUrl: string;
      channel: string;
      name: string;
      identifier: string;
    };
  };

  // ── System ──
  "system:platform": {
    req: undefined;
    res: { os: "macos" | "windows" | "linux" };
  };
}

// ── Event types (Bun → Webview push) ──
export interface RPCEvents {
  "updates:progress": import("./updater.types").UpdateSnapshot;
  "bucket-usage:changed": { profileId: string; bucket: string };
  "job:progress": ProgressEvent;
  "job:complete": JobCompleteEvent;
  "update:available": {
    version: string;
    updateAvailable: boolean;
    updateReady: boolean;
  };
  "folder-sync:status": FolderSyncStatusEvent;
  "folder-sync:conflict": FolderSyncConflictEvent;
  "folder-sync:error": FolderSyncErrorEvent;
}

// ── RPC message envelope ──
export interface RPCRequest<M extends keyof RPCSchema = keyof RPCSchema> {
  id: string;
  method: M;
  payload: RPCSchema[M]["req"];
}

export interface RPCResponse<M extends keyof RPCSchema = keyof RPCSchema> {
  id: string;
  method: M;
  result?: RPCSchema[M]["res"];
  error?: string;
}

export interface RPCEventMessage<E extends keyof RPCEvents = keyof RPCEvents> {
  event: E;
  data: RPCEvents[E];
}
