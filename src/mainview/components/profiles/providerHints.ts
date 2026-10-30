import type { ProfileInput } from "@shared/profile.types";

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
    region: "例如 us-east-1、eu-west-2",
    accessKey: "以 AKIA... 开头",
    secretKey: "从 IAM 控制台获取的 40 位访问密钥",
  },
  r2: {
    endpoint: "将 <account-id> 替换为你的 Cloudflare 账号 ID",
    region: "通常使用 auto，可保留默认值",
    accessKey: "从 Cloudflare 控制台的 R2 API 令牌获取",
    secretKey: "从 Cloudflare 控制台的 R2 API 令牌获取",
  },
  spaces: {
    endpoint: "将 <region> 替换为 Spaces 区域，例如 nyc3",
    region: "例如 nyc3、sfo3、ams3",
    accessKey: "从 DigitalOcean API → Spaces Keys 获取",
    secretKey: "从 DigitalOcean API → Spaces Keys 获取",
  },
  minio: {
    endpoint: "默认：http://localhost:9000",
    region: "MinIO 通常使用 us-east-1",
    accessKey: "MinIO 管理员用户名或访问密钥 ID",
    secretKey: "MinIO 管理员密码或访问密钥",
  },
  gcs: {
    region: "例如 us-central1、europe-west1",
    accessKey: "从 GCS 互操作性设置获取的 HMAC 密钥 ID",
    secretKey: "从 GCS 互操作性设置获取的 HMAC 访问密钥",
  },
  backblaze: {
    endpoint: "将 <region> 替换为存储桶区域，例如 us-west-004",
    region: "必须与存储桶区域一致，例如 us-west-004",
    accessKey: "从 B2 应用密钥中获取 applicationKeyId",
    secretKey: "从 B2 应用密钥中获取 applicationKey",
  },
  custom: {
    endpoint: "S3 兼容接口的完整 URL",
    region: "服务商要求的区域",
    accessKey: "S3 兼容服务的访问密钥 ID",
    secretKey: "S3 兼容服务的访问密钥",
  },
};
