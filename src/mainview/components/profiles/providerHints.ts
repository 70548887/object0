import type { ProfileInput, QiniuProfileConfig } from "@shared/profile.types";
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
  qiniu: {
    get region() {
      return t(
        "按空间自动发现区域；私有云可配置手工区域作为补充。",
        "Regions are discovered per bucket; private clouds can supply manual region overrides.",
      );
    },
    get accessKey() {
      return t(
        "七牛控制台或 IAM 的 AccessKey",
        "AccessKey from Qiniu console or IAM",
      );
    },
    get secretKey() {
      return t(
        "与 AccessKey 对应的 SecretKey",
        "SecretKey paired with the AccessKey",
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

function endpointProblem(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      !/^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]+\/?$/i.test(value) ||
      Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      !["https:", "http:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      return t(
        "地址必须是 HTTP(S) 源地址，且不能包含路径、用户名、密码、查询参数或片段。",
        "Use an HTTP(S) origin without a path, username, password, query or fragment.",
      );
    }
    return null;
  } catch {
    return t(
      "请输入完整的 HTTP(S) 地址，例如 https://uc.example.com。",
      "Enter a complete HTTP(S) URL, for example https://uc.example.com.",
    );
  }
}

export function validateQiniuProfileConfig(config: QiniuProfileConfig): {
  error: string | null;
  insecure: boolean;
} {
  if (config.mode === "private" && !config.ucUrl?.trim()) {
    return {
      error: t(
        "私有云必须填写 UC 管理地址。",
        "A UC management URL is required for private clouds.",
      ),
      insecure: false,
    };
  }
  if (config.shareApiUrl?.trim() && config.mode !== "private") {
    return {
      error: t(
        "自定义分享 API 地址仅适用于私有云。",
        "A custom share API URL is available only for private clouds.",
      ),
      insecure: false,
    };
  }
  if (
    config.shareApiUrl?.trim() &&
    (!config.sharePortal?.trim() || !config.regions?.length)
  ) {
    return {
      error: t(
        "启用私有目录分享需填写分享门户，并至少配置一个手工区域及其 S3 地址。",
        "Private directory sharing requires a share portal and at least one manual region with its S3 URL.",
      ),
      insecure: false,
    };
  }
  const endpoints = [config.ucUrl, config.sharePortal, config.shareApiUrl];
  if ((config.bucketBindings?.length ?? 0) > 32)
    return {
      error: t(
        "限定空间最多 32 个。",
        "At most 32 scoped buckets are allowed.",
      ),
      insecure: false,
    };
  const bindingNames = new Set<string>();
  for (const binding of config.bucketBindings ?? []) {
    const { nativeName, s3Name, s3RegionId, s3Endpoint } = binding;
    if (
      ![nativeName, s3Name, s3RegionId, s3Endpoint].every((value) =>
        value.trim(),
      )
    ) {
      return {
        error: t(
          "限定空间必须填写原生名称、S3 ID、区域和地址。",
          "Scoped buckets require native name, S3 ID, region and endpoint.",
        ),
        insecure: false,
      };
    }
    if (
      [nativeName, s3Name].some(
        (value) => value.length > 255 || /[\\/\s?#\0]/.test(value),
      ) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(s3RegionId)
    ) {
      return {
        error: t(
          "限定空间名称、S3 ID 或区域格式无效。",
          "Invalid scoped bucket name, S3 ID or region.",
        ),
        insecure: false,
      };
    }
    if (bindingNames.has(nativeName) || bindingNames.has(s3Name)) {
      return {
        error: t(
          "限定空间的名称或 S3 ID 重复/冲突。",
          "Scoped bucket names or S3 IDs conflict.",
        ),
        insecure: false,
      };
    }
    bindingNames.add(nativeName);
    bindingNames.add(s3Name);
    const problem = endpointProblem(s3Endpoint);
    if (problem) return { error: problem, insecure: false };
    const url = new URL(s3Endpoint);
    if (config.mode === "public") {
      const official = [
        "qiniuapi.com",
        "qiniucs.com",
        "qiniup.com",
        "qbox.me",
        "qiniu.com",
        "qiniuio.com",
      ];
      if (
        url.protocol !== "https:" ||
        (url.port && url.port !== "443") ||
        !official.some(
          (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
        )
      ) {
        return {
          error: t(
            "公有云 S3 绑定必须使用七牛官方 HTTPS 地址。",
            "Public-cloud S3 bindings require an official Qiniu HTTPS origin.",
          ),
          insecure: false,
        };
      }
    } else if (
      config.regions?.length &&
      !config.regions.some(
        (region) =>
          region.id === s3RegionId &&
          !endpointProblem(region.s3Endpoint) &&
          new URL(region.s3Endpoint).origin === url.origin,
      )
    ) {
      return {
        error: t(
          "限定空间的区域和 S3 地址必须匹配手工区域配置。",
          "The scoped bucket region and endpoint must match a configured manual region.",
        ),
        insecure: false,
      };
    }
    endpoints.push(s3Endpoint);
  }
  const ids = new Set<string>();
  for (const region of config.regions ?? []) {
    if (
      config.shareApiUrl?.trim() &&
      !/^[A-Za-z0-9_-]{1,128}$/.test(region.id.trim())
    ) {
      return {
        error: t(
          "私有分享的区域 ID 必须为 1～128 位英文字母、数字、连字符或下划线。",
          "Private-share region IDs must contain 1–128 ASCII letters, digits, hyphens or underscores.",
        ),
        insecure: false,
      };
    }
    if (!region.id.trim() || !region.s3Endpoint.trim()) {
      return {
        error: t(
          "每个手工区域都必须填写区域 ID 和 S3 地址。",
          "Each manual region requires a region ID and S3 URL.",
        ),
        insecure: false,
      };
    }
    if (ids.has(region.id.trim())) {
      return {
        error: t("手工区域 ID 不能重复。", "Manual region IDs must be unique."),
        insecure: false,
      };
    }
    ids.add(region.id.trim());
    endpoints.push(region.s3Endpoint);
  }
  for (const endpoint of endpoints) {
    if (!endpoint?.trim()) continue;
    const error = endpointProblem(endpoint.trim());
    if (error) return { error, insecure: false };
    if (
      config.mode === "public" &&
      new URL(endpoint.trim()).protocol !== "https:"
    ) {
      return {
        error: t(
          "公有云地址必须使用 HTTPS。",
          "Public-cloud URLs must use HTTPS.",
        ),
        insecure: false,
      };
    }
  }
  if (config.downloadDomain?.trim()) {
    const error = endpointProblem(config.downloadDomain.trim());
    if (error) return { error, insecure: false };
    const url = new URL(config.downloadDomain.trim());
    if (config.mode === "public" && url.port)
      return {
        error: t(
          "公有云下载域名只支持 HTTP/HTTPS 各自的默认端口 80/443。",
          "Public download domains require the default HTTP/HTTPS ports 80/443.",
        ),
        insecure: false,
      };
  }
  return {
    error: null,
    insecure: [...endpoints, config.downloadDomain].some((endpoint) => {
      if (!endpoint?.trim()) return false;
      return new URL(endpoint.trim()).protocol === "http:";
    }),
  };
}
