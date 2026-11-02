import { localize, t } from "@/lib/i18n";

export interface ConnectionCheck {
  name:
    | "authentication"
    | "bucketAccess"
    | "regionDiscovery"
    | "downloadDomain";
  status: "ok" | "warning" | "error" | "unsupported";
  message?: string;
}

export interface ConnectionTestResponse {
  success: boolean;
  bucketCount: number;
  error?: string;
  checks?: ConnectionCheck[];
}

export interface ConnectionTestPresentation {
  /** This remains the native result, not a promotion of partial verification. */
  ok: boolean;
  tone: "success" | "warning" | "error";
  msg: string;
  checks?: ConnectionCheck[];
}

const requiredChecks = [
  "authentication",
  "bucketAccess",
  "regionDiscovery",
] as const;

/** Translate only known native diagnostics, never split arbitrary provider text. */
export function connectionCheckMessage(check: ConnectionCheck): string {
  switch (check.message) {
    case "尚未选择空间，未验证对象列表权限 / No bucket selected; object listing permission is unverified":
    case "尚未选择空间，未验证对象列表权限 / No bucket selected, object listing permission is unverified":
      return t(
        "尚未选择默认空间，空间读取权限尚未验证。可在账号表单点击“读取空间”后选择，或手动填写默认空间并重新测试。",
        "No default bucket is selected, so bucket reads are not verified. In the account form, read and choose a bucket, or enter a default bucket manually and test again.",
      );
    case "未配置自定义下载域名；默认域名可能受文件类型限制 / No custom download domain; default domain restrictions may apply":
      return t(
        "未配置自定义下载域名（可选），不影响保存账号或空间列表。下载能力需针对所选空间和可用地址单独验证。",
        "A custom download domain is optional and does not block saving or bucket listing. Verify downloads separately for the selected bucket and an available address.",
      );
    case "域名已配置，访问能力需针对空间验证 / Domain configured; verify access for the selected bucket":
      return t(
        "下载域名已配置，实际下载访问仍需针对所选空间验证。",
        "A download domain is configured; download access still needs verification for the selected bucket.",
      );
    default:
      return localize(check.message ?? "");
  }
}

/** Optional/unperformed checks are not an authentication or network failure. */
export function connectionTestPresentation(
  provider: string,
  result: ConnectionTestResponse,
): ConnectionTestPresentation {
  const checks = result.checks;
  const failed = () => ({
    ok: false,
    tone: "error" as const,
    msg:
      result.error ??
      t(
        "连接失败，请检查诊断和账号配置。",
        "Connection failed. Review the diagnostics and account configuration.",
      ),
    checks,
  });
  if (provider !== "qiniu" || !Array.isArray(checks)) {
    return result.success
      ? {
          ok: true,
          tone: "success",
          msg: t(
            `连接成功，发现 ${result.bucketCount} 个存储桶`,
            `Connected. Found ${result.bucketCount} buckets`,
          ),
          checks,
        }
      : failed();
  }
  const critical = requiredChecks.map((name) =>
    checks.find((check) => check.name === name),
  );
  if (critical.some((check) => check?.status === "error")) return failed();
  const authenticated = critical[0]?.status === "ok";
  const allVerified = critical.every((check) => check?.status === "ok");
  if (result.success && allVerified) {
    return {
      ok: true,
      tone: "success",
      msg: t(
        `账号认证和空间读取验证通过，发现 ${result.bucketCount} 个空间。下载域名能力单独验证。`,
        `Account authentication and bucket reads passed. Found ${result.bucketCount} buckets. Download-domain capability is verified separately.`,
      ),
      checks,
    };
  }
  if (authenticated) {
    return {
      ok: false,
      tone: "warning",
      msg:
        critical[1]?.status === "warning"
          ? t(
              "账号认证已通过，空间读取尚未验证；完成下方保存条件后，可保存账号再选择空间。也可填写默认空间后重新测试。",
              "Account authentication passed; bucket reads are not verified yet. Complete the save requirements below, then save the account and select a bucket, or enter a default bucket and test again.",
            )
          : t(
              "账号认证已通过，但部分空间或区域能力尚未完整验证。请查看分项诊断；这不是已确认的密钥错误。",
              "Account authentication passed, but some bucket or region capabilities are not fully verified. Review the individual checks; this is not a confirmed credential failure.",
            ),
      checks,
    };
  }
  return failed();
}

export interface ProfileSaveRequirements {
  saving: boolean;
  name: string;
  provider: string;
  qiniuValidationError?: string | null;
  needsQiniuMigration: boolean;
  backupAcknowledged: boolean;
  needsMigrationRecoveryKey: boolean;
  recoveryKeyProvided: boolean;
  isEditing: boolean;
  accessKeyProvided: boolean;
  secretKeyProvided: boolean;
}

/** Same requirements as Save's disabled expression; never takes test results. */
export function profileSaveBlockers(input: ProfileSaveRequirements): string[] {
  const reasons: string[] = [];
  if (input.saving)
    reasons.push(t("正在保存，请稍候。", "Saving. Please wait."));
  if (!input.name.trim())
    reasons.push(t("请填写账号名称。", "Enter an account name."));
  if (input.provider === "qiniu") {
    if (input.qiniuValidationError) reasons.push(input.qiniuValidationError);
    if (input.needsQiniuMigration && !input.backupAcknowledged)
      reasons.push(
        t(
          "请勾选“我已了解密码库升级和回退方式”。",
          "Acknowledge the vault upgrade and downgrade requirements.",
        ),
      );
    if (input.needsMigrationRecoveryKey && !input.recoveryKeyProvided)
      reasons.push(
        t(
          "请输入云仓密码库的现有恢复密钥，用于验证旧恢复快照；不是七牛 SecretKey。不要将恢复密钥发到聊天中。",
          "Enter the existing Yuncang vault recovery key to verify its old recovery snapshot, not the Qiniu SecretKey. Do not send the recovery key in chat.",
        ),
      );
  }
  if (
    !input.isEditing &&
    (!input.accessKeyProvided || !input.secretKeyProvided)
  )
    reasons.push(
      t(
        "请填写访问密钥 ID 和访问密钥。",
        "Enter the access key ID and secret access key.",
      ),
    );
  return reasons;
}
