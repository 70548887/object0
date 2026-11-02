import { t } from "@/lib/i18n";

// ── S3 Provider types ──
export type Provider =
  | "aws"
  | "r2"
  | "spaces"
  | "minio"
  | "gcs"
  | "backblaze"
  | "qiniu"
  | "custom";

export const PROVIDER_LABELS: Record<Provider, string> = {
  aws: "Amazon S3",
  r2: "Cloudflare R2",
  spaces: "DigitalOcean Spaces",
  minio: "MinIO",
  gcs: "Google Cloud Storage",
  backblaze: "Backblaze B2",
  get qiniu() {
    return t("七牛云 Kodo", "Qiniu Kodo");
  },
  get custom() {
    return t("自定义 S3 兼容存储", "Custom S3-Compatible");
  },
};

export const PROVIDER_ENDPOINTS: Partial<Record<Provider, string>> = {
  r2: "https://<account-id>.r2.cloudflarestorage.com",
  spaces: "https://<region>.digitaloceanspaces.com",
  minio: "http://localhost:9000",
  gcs: "https://storage.googleapis.com",
  backblaze: "https://s3.<region>.backblazeb2.com",
};

export const PROVIDER_REGIONS: Record<Provider, string> = {
  aws: "us-east-1",
  r2: "auto",
  spaces: "nyc3",
  minio: "us-east-1",
  gcs: "us-central1",
  backblaze: "us-west-004",
  qiniu: "auto",
  custom: "us-east-1",
};

export interface QiniuRegionConfig {
  id: string;
  label?: string;
  s3Endpoint: string;
}

export interface QiniuBucketBinding {
  nativeName: string;
  s3Name: string;
  s3RegionId: string;
  s3Endpoint: string;
  kodoRegionId?: string;
}

// No credential material belongs in endpoint configuration. AK/SK and optional
// session tokens stay in the existing encrypted credential fields.
export interface QiniuProfileConfig {
  mode: "public" | "private";
  ucUrl?: string;
  regions?: QiniuRegionConfig[];
  downloadDomain?: string;
  sharePortal?: string;
  /** Explicit native share-service trust; private sharing remains experimental. */
  shareApiUrl?: string;
  trustedCaPath?: string;
  /** Explicit scope, not fallback after an authentication failure. */
  bucketBindings?: QiniuBucketBinding[];
}

// ── Full profile (stored encrypted in vault) ──
export interface Profile {
  id: string;
  name: string;
  provider: Provider;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint?: string;
  region?: string;
  defaultBucket?: string;
  r2AnalyticsToken?: string;
  qiniu?: QiniuProfileConfig;
  createdAt: string;
  updatedAt: string;
}

// ── Profile info sent to UI (no secrets) ──
export interface ProfileInfo {
  id: string;
  name: string;
  provider: Provider;
  endpoint?: string;
  region?: string;
  defaultBucket?: string;
  hasR2AnalyticsToken: boolean;
  /** Credential mode only; never contains the token itself. */
  hasSessionToken?: boolean;
  qiniu?: QiniuProfileConfig;
  createdAt: string;
  updatedAt: string;
}

// ── Profile input for creating/updating ──
export interface ProfileInput {
  name: string;
  provider: Provider;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  endpoint?: string;
  region?: string;
  defaultBucket?: string;
  r2AnalyticsToken?: string;
  clearR2AnalyticsToken?: boolean;
  qiniu?: QiniuProfileConfig;
  /** Write-only: verifies the existing recovery snapshot during first migration. */
  migrationRecoveryKey?: string;
}

// ── Strip secrets from profile for UI ──
export function toProfileInfo(profile: Profile): ProfileInfo {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    endpoint: profile.endpoint,
    region: profile.region,
    defaultBucket: profile.defaultBucket,
    hasR2AnalyticsToken: Boolean(profile.r2AnalyticsToken),
    hasSessionToken: Boolean(profile.sessionToken?.trim()),
    qiniu: profile.qiniu,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}
