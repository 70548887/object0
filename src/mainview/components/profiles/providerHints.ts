import type { ProfileInput } from "@shared/profile.types";
import { t } from "@/lib/i18n";

export type Provider = ProfileInput["provider"];

interface ProviderHint {
  endpoint?: string;
  region?: string;
  accessKey?: string;
  secretKey?: string;
}

// Per-provider placeholder/help text shown next to the credential fields.
export const PROVIDER_HINTS: Record<Provider, ProviderHint> = {
  aws: {
    get region() {
      return t("例如 us-east-1、eu-west-2", "e.g. us-east-1, eu-west-2");
    },
    get accessKey() {
      return t("以 AKIA... 开头", "Starts with AKIA...");
    },
    get secretKey() {
      return t(
        "从 IAM 控制台获取的 40 位访问密钥",
        "40-character secret from IAM console",
      );
    },
  },
  r2: {
    get endpoint() {
      return t(
        "将 <account-id> 替换为你的 Cloudflare 账号 ID",
        "Replace <account-id> with your Cloudflare account ID",
      );
    },
    get region() {
      return t(
        "通常使用 auto，可保留默认值",
        "Usually auto — leave as-is or use auto",
      );
    },
    get accessKey() {
      return t(
        "从 Cloudflare 控制台的 R2 API 令牌获取",
        "From R2 API Tokens in Cloudflare dashboard",
      );
    },
    get secretKey() {
      return t(
        "从 Cloudflare 控制台的 R2 API 令牌获取",
        "From R2 API Tokens in Cloudflare dashboard",
      );
    },
  },
  spaces: {
    get endpoint() {
      return t(
        "将 <region> 替换为 Spaces 区域，例如 nyc3",
        "Replace <region> with your Space region, e.g. nyc3",
      );
    },
    get region() {
      return t("例如 nyc3、sfo3、ams3", "e.g. nyc3, sfo3, ams3");
    },
    get accessKey() {
      return t(
        "从 DigitalOcean API → Spaces Keys 获取",
        "From DigitalOcean API → Spaces Keys",
      );
    },
    get secretKey() {
      return t(
        "从 DigitalOcean API → Spaces Keys 获取",
        "From DigitalOcean API → Spaces Keys",
      );
    },
  },
  minio: {
    get endpoint() {
      return t("默认：http://localhost:9000", "Default: http://localhost:9000");
    },
    get region() {
      return t("MinIO 通常使用 us-east-1", "Usually us-east-1 for MinIO");
    },
    get accessKey() {
      return t(
        "MinIO 管理员用户名或访问密钥 ID",
        "MinIO root user or access key",
      );
    },
    get secretKey() {
      return t(
        "MinIO 管理员密码或访问密钥",
        "MinIO root password or secret key",
      );
    },
  },
  gcs: {
    get region() {
      return t(
        "例如 us-central1、europe-west1",
        "e.g. us-central1, europe-west1",
      );
    },
    get accessKey() {
      return t(
        "从 GCS 互操作性设置获取的 HMAC 密钥 ID",
        "HMAC key from GCS interoperability settings",
      );
    },
    get secretKey() {
      return t(
        "从 GCS 互操作性设置获取的 HMAC 访问密钥",
        "HMAC secret from GCS interoperability settings",
      );
    },
  },
  backblaze: {
    get endpoint() {
      return t(
        "将 <region> 替换为存储桶区域，例如 us-west-004",
        "Replace <region> with your bucket region, e.g. us-west-004",
      );
    },
    get region() {
      return t(
        "必须与存储桶区域一致，例如 us-west-004",
        "Must match your bucket region, e.g. us-west-004",
      );
    },
    get accessKey() {
      return t(
        "从 B2 应用密钥中获取 applicationKeyId",
        "applicationKeyId from B2 App Keys",
      );
    },
    get secretKey() {
      return t(
        "从 B2 应用密钥中获取 applicationKey",
        "applicationKey from B2 App Keys",
      );
    },
  },
  custom: {
    get endpoint() {
      return t(
        "S3 兼容接口的完整 URL",
        "Full URL of your S3-compatible endpoint",
      );
    },
    get region() {
      return t("服务商要求的区域", "Region required by your provider");
    },
    get accessKey() {
      return t(
        "S3 兼容服务的访问密钥 ID",
        "Access key for your S3-compatible service",
      );
    },
    get secretKey() {
      return t(
        "S3 兼容服务的访问密钥",
        "Secret key for your S3-compatible service",
      );
    },
  },
};
