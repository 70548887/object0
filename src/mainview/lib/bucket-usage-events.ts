export const BUCKET_USAGE_INVALIDATED = "object0:bucket-usage-invalidated";

export interface BucketUsageInvalidation {
  profileId: string;
  bucket: string;
}

export function invalidateBucketUsage(detail: BucketUsageInvalidation): void {
  window.dispatchEvent(new CustomEvent(BUCKET_USAGE_INVALIDATED, { detail }));
}
